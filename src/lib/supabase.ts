// Remote backend: Supabase (GoTrue auth + PostgREST), dependency-free fetch client.
// - Pushes the local outbox with idempotent upserts keyed by client UUIDs (no duplicates on retry).
// - Pulls changes by server_updated_at cursor (server clock, so late offline edits are never missed).
// - Polls every 15 s and on focus/online for near-real-time updates between caregivers.
// Row-level security in the database is the source of truth for access control.
import { config } from './config';
import { getState, setState, setRemoteAuth, currentUserId, adoptRemoteUser, type Table } from './store';
import type { User } from './types';

const URL_ = config.supabaseUrl.replace(/\/$/, '');
const KEY = config.supabaseAnonKey;
const AUTH_KEY = 'bebig:auth';

interface AuthSession { access_token: string; refresh_token: string; expires_at: number; user: { id: string; email: string; user_metadata?: any } }
let auth: AuthSession | null = (() => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } })();
const saveAuth = (s: AuthSession | null) => { auth = s; s ? localStorage.setItem(AUTH_KEY, JSON.stringify(s)) : localStorage.removeItem(AUTH_KEY); };

async function gotrue(path: string, body: any) {
  const r = await fetch(`${URL_}/auth/v1/${path}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || 'Authentication failed');
  return j;
}
function toSession(j: any): AuthSession { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, user: j.user }; }

async function token(): Promise<string> {
  if (!auth) throw new Error('Not signed in');
  if (Date.now() > auth.expires_at - 60000) saveAuth(toSession(await gotrue('token?grant_type=refresh_token', { refresh_token: auth.refresh_token })));
  return auth!.access_token;
}

async function rest(method: string, path: string, body?: any, prefer?: string) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: { apikey: KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); const e: any = new Error(j.message || `HTTP ${r.status}`); e.status = r.status; e.code = j.code; throw e; }
  return r.status === 204 ? null : r.json().catch(() => null);
}

const REMOTE: Record<Table, { table: string; id: string }> = {
  babies: { table: 'baby_profiles', id: 'baby_id' }, access: { table: 'baby_access', id: 'access_id' },
  feeds: { table: 'feeding_entries', id: 'feed_id' }, poos: { table: 'poo_entries', id: 'poo_id' },
  sleeps: { table: 'sleep_entries', id: 'sleep_id' }, growth: { table: 'growth_measurements', id: 'measurement_id' },
};
const COLUMNS: Record<Table, string[]> = {
  babies: ['baby_id', 'name', 'date_of_birth', 'time_of_birth', 'sex', 'gestational_age_weeks', 'gestational_age_days', 'timezone', 'photograph_url', 'feeding_preference', 'birth_weight_grams', 'birth_length_mm', 'birth_head_circumference_mm', 'created_by', 'created_at', 'updated_at'],
  access: ['access_id', 'baby_id', 'user_id', 'invited_email', 'role', 'invitation_status', 'invited_by', 'created_at', 'updated_at'],
  feeds: ['feed_id', 'baby_id', 'feeding_type', 'start_datetime', 'end_datetime', 'duration_seconds', 'breast_side', 'left_duration_seconds', 'right_duration_seconds', 'quantity_ml', 'observations', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  poos: ['poo_id', 'baby_id', 'datetime', 'colour', 'size', 'texture', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  sleeps: ['sleep_id', 'baby_id', 'start_datetime', 'end_datetime', 'duration_seconds', 'status', 'pauses', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  growth: ['measurement_id', 'baby_id', 'measurement_date', 'weight_grams', 'length_mm', 'head_circumference_mm', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
};
const pick = (t: Table, row: any) => Object.fromEntries(COLUMNS[t].filter(c => c in row).map(c => [c, row[c] ?? null]));

// ---------- push ----------
let pushing = false;
async function push() {
  if (pushing || !auth || !navigator.onLine) return; pushing = true;
  try {
    while (true) {
      const op = getState().outbox[0]; if (!op) break;
      const { table, id } = REMOTE[op.table]; const me = currentUserId(); const row = op.row;
      try {
        if (op.table === 'babies' && row.deleted_at) await rest('DELETE', `${table}?baby_id=eq.${row.baby_id}`);
        else if (op.table === 'access') {
          if (row.role === 'owner') { /* created by trigger on the server */ }
          else if (row.user_id === me || (row.invitation_status === 'declined' && row.invited_email === auth.user.email)) await rest('POST', 'rpc/respond_invitation', { p_access_id: row.access_id, p_accept: row.invitation_status === 'accepted' });
          else await rest('POST', `${table}?on_conflict=${id}`, pick('access', row), 'resolution=merge-duplicates,return=minimal');
        } else if (op.table !== 'babies' && row.created_by !== me) {
          // editing someone else's entry: plain update (insert policy requires created_by = me)
          const { created_by, created_at, ...patch } = pick(op.table, row) as any;
          await rest('PATCH', `${table}?${id}=eq.${row[id]}`, patch, 'return=minimal');
        } else await rest('POST', `${table}?on_conflict=${id}`, pick(op.table, row), 'resolution=merge-duplicates,return=minimal');
        setState(s => { s.outbox = s.outbox.filter(o => o.op_id !== op.op_id); }, false);
      } catch (e: any) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) {
          // permanent rejection (validation / permission): drop op so the queue isn't blocked; log for audit
          console.warn('Sync rejected', op, e);
          setState(s => { s.outbox = s.outbox.filter(o => o.op_id !== op.op_id); s.audit.push({ at: new Date().toISOString(), user_id: me || '', action: 'sync.rejected', detail: `${op.table}: ${e.message}` }); }, false);
        } else throw e;
      }
    }
  } finally { pushing = false; }
}

// ---------- pull ----------
const cursorKey = 'bebig:cursors';
const cursors: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem(cursorKey) || '{}'); } catch { return {}; } })();
async function pull() {
  if (!auth || !navigator.onLine) return;
  const me = auth.user.id;
  const profiles = await rest('GET', 'profiles?select=user_id,email,display_name,created_at,updated_at') as User[];
  const results: Partial<Record<Table, any[]>> = {};
  for (const t of Object.keys(REMOTE) as Table[]) {
    const since = cursors[t] ? `&server_updated_at=gt.${encodeURIComponent(cursors[t])}` : '';
    const rows = await rest('GET', `${REMOTE[t].table}?select=*${since}&order=server_updated_at.asc&limit=5000`) as any[];
    results[t] = rows;
    if (rows.length) cursors[t] = rows[rows.length - 1].server_updated_at;
  }
  // full id list of babies we can see (detect revoked access / deleted babies)
  const visible = new Set(((await rest('GET', 'baby_profiles?select=baby_id')) as any[]).map(r => r.baby_id));
  localStorage.setItem(cursorKey, JSON.stringify(cursors));
  setState(s => {
    for (const p of profiles) s.users[p.user_id] = { ...s.users[p.user_id], ...p };
    const pendingIds = new Set(s.outbox.map(o => o.row[REMOTE[o.table].id]));
    for (const t of Object.keys(results) as Table[]) {
      const idf = REMOTE[t].id; const target = s[t] as Record<string, any>;
      for (const r of results[t]!) {
        if (pendingIds.has(r[idf])) continue; // local change not yet pushed wins until it is
        const local = target[r[idf]];
        if (!local || new Date(r.updated_at) >= new Date(local.updated_at)) {
          if (t === 'sleeps' && typeof r.pauses === 'string') r.pauses = JSON.parse(r.pauses);
          if (t === 'feeds') { r.observations = r.observations || []; if (r.quantity_ml != null) r.quantity_ml = Number(r.quantity_ml); }
          target[r[idf]] = r;
        }
      }
    }
    // the server creates owner rows itself: drop local duplicates of the same membership
    for (const a of Object.values(s.access)) {
      const dup = Object.values(s.access).find(b => b.access_id !== a.access_id && b.baby_id === a.baby_id && b.user_id && b.user_id === a.user_id && b.role === a.role && (b as any).server_updated_at && !(a as any).server_updated_at);
      if (dup) delete s.access[a.access_id];
    }
    // remove babies we can no longer see (revoked / deleted elsewhere)
    for (const id of Object.keys(s.babies)) if (!visible.has(id) && !pendingIds.has(id)) {
      delete s.babies[id];
      for (const t of ['feeds', 'poos', 'sleeps', 'growth'] as const) for (const [k, v] of Object.entries(s[t] as any)) if ((v as any).baby_id === id) delete (s[t] as any)[k];
      for (const a of Object.values(s.access)) if (a.baby_id === id && a.user_id === me) delete s.access[a.access_id];
    }
    s.lastSyncedAt = new Date().toISOString();
  }, false);
}

let timer: any = null;
async function cycle() { try { await push(); await pull(); await push(); } catch (e) { console.warn('sync', e); } }
export function startRemoteSync() {
  setRemoteAuth({
    async register(email, password, display_name) {
      const j = await gotrue('signup', { email, password, data: { display_name } });
      if (!j.access_token) throw new Error('Check your email to confirm your account, then sign in.');
      saveAuth(toSession(j)); return { user_id: j.user.id, email: j.user.email, display_name };
    },
    async signIn(email, password) {
      const j = await gotrue('token?grant_type=password', { email, password }); saveAuth(toSession(j));
      return { user_id: j.user.id, email: j.user.email, display_name: j.user.user_metadata?.display_name || email.split('@')[0] };
    },
    async reset(email) { await gotrue('recover', { email }); },
    async signOut() { try { await fetch(`${URL_}/auth/v1/logout`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${auth?.access_token}` } }); } catch { /* offline */ } saveAuth(null); localStorage.removeItem(cursorKey); for (const k of Object.keys(cursors)) delete cursors[k]; },
    async deleteAccount() { await rest('POST', 'rpc/delete_my_account', {}); saveAuth(null); },
    async updateName(display_name) { await rest('PATCH', `profiles?user_id=eq.${auth!.user.id}`, { display_name }, 'return=minimal'); },
    onSignedIn() { for (const k of Object.keys(cursors)) delete cursors[k]; cycle(); },
  });
  // links from auth emails land here with tokens (or an error) in the URL hash
  const h = new URLSearchParams(location.hash.slice(1));
  const note = (m: string) => { try { sessionStorage.setItem('bebig:authmsg', m); } catch { /* */ } };
  if (h.get('error_description')) {
    history.replaceState(null, '', location.pathname);
    note(h.get('error_code') === 'otp_expired' ? 'That link has expired or was already used. If you confirmed your email, just sign in — otherwise request a new link.' : h.get('error_description')!.replace(/\+/g, ' '));
  } else if (h.get('access_token') && h.get('type') !== 'recovery') {
    // email confirmation / magic link: sign straight in
    history.replaceState(null, '', location.pathname);
    const at = h.get('access_token')!, rt = h.get('refresh_token') || '', exp = Number(h.get('expires_in') || 3600);
    fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${at}` } }).then(r => r.ok ? r.json() : Promise.reject())
      .then(user => { saveAuth({ access_token: at, refresh_token: rt, expires_at: Date.now() + exp * 1000, user }); adoptRemoteUser({ user_id: user.id, email: user.email, display_name: user.user_metadata?.display_name || user.email.split('@')[0] }); })
      .catch(() => note('Your email is confirmed. Please sign in.'));
  }
  if (h.get('type') === 'recovery' && h.get('access_token')) {
    history.replaceState(null, '', location.pathname);
    const at = h.get('access_token')!;
    setTimeout(async () => {
      const pw = prompt('Choose a new password (at least 8 characters)');
      if (!pw || pw.length < 8) return alert('Password not changed.');
      const r = await fetch(`${URL_}/auth/v1/user`, { method: 'PUT', headers: { apikey: KEY, Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      alert(r.ok ? 'Password updated — please sign in.' : 'Sorry, that link has expired. Request a new one.');
    }, 300);
  }
  const kick = () => cycle();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  let debounce: any; const orig = getState().outbox.length;
  void orig;
  setInterval(() => { if (getState().outbox.length && !pushing) { clearTimeout(debounce); debounce = setTimeout(push, 300); } }, 1000);
  timer = setInterval(kick, 15000);
  if (auth) kick();
  return () => clearInterval(timer);
}

/** Optional LLM phrasing of an already-verified answer (requires the user's AI consent). Falls back silently. */
export async function phraseAnswer(baby_id: string, question: string, verified_answer: string, kind: string): Promise<string> {
  try {
    const r = await fetch(`${URL_}/functions/v1/assistant`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ baby_id, question, verified_answer, kind }) });
    if (!r.ok) return verified_answer;
    return (await r.json()).content || verified_answer;
  } catch { return verified_answer; }
}
