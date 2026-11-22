// Remote backend: Supabase (GoTrue auth + PostgREST), dependency-free fetch client.
// - Pushes the local outbox with idempotent upserts keyed by client UUIDs (no duplicates on retry).
// - Pulls changes by server_updated_at cursor (server clock, so late offline edits are never missed).
// - Polls every 15 s and on focus/online for near-real-time updates between caregivers.
// Row-level security in the database is the source of truth for access control.
import { config } from './config';
import { getState, setState, setRemoteAuth, currentUserId, adoptRemoteUser, retryFailedSync, setInitialPullDone, requireReauth, mergeBabyInto, requeueBaby, myPrefs, setPlusStatus, setPausedBabies, forgetBabyLocally, type Table } from './store';
import type { PlusStatus } from './plans';
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
// Links (email confirmation, password reset) can carry a session. A link someone else sent could carry *their*
// session, so the app never switches to an account from a link without the user confirming which account it is.
function confirmAccountFromLink(user: { id: string; email: string }): boolean {
  if (auth && auth.user.id === user.id) return true;
  const current = auth ? `\n\nYou'll be signed out of ${auth.user.email} on this device.` : '';
  return confirm(`Continue in Bebig as ${user.email}?${current}\n\nOnly continue if this is your email address.`);
}
function toSession(j: any): AuthSession { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, user: j.user }; }

// Refresh tokens are single-use (Supabase rotates them). Refreshing must therefore happen exactly once:
// one in-flight refresh per page, a cross-tab lock (installed app + browser tab share storage), and a re-read of
// storage in case another tab already refreshed. A truly dead session asks the user to sign in again without
// discarding anything that hasn't synced yet.
const readStored = (): AuthSession | null => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } };
const fresher = (s: AuthSession | null) => !!s && !!auth && s.refresh_token !== auth.refresh_token && s.expires_at > Date.now() + 60000;
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === AUTH_KEY) auth = readStored(); });
let refreshing: Promise<void> | null = null;
async function refresh() {
  const run = async () => {
    const stored = readStored();
    if (fresher(stored)) { auth = stored; return; }
    if (auth && auth.expires_at > Date.now() + 60000) return; // refreshed while we waited for the lock
    try {
      saveAuth(toSession(await gotrue('token?grant_type=refresh_token', { refresh_token: auth!.refresh_token })));
    } catch (e: any) {
      const again = readStored();
      if (fresher(again)) { auth = again; return; }
      if (/already used|invalid refresh token|refresh token not found|session.*(expired|not found)/i.test(e.message || '')) {
        saveAuth(null);
        requireReauth('Please sign in again — your session expired. Nothing you logged on this device is lost; it will sync after you sign in.');
      }
      throw e;
    }
  };
  const locks = (navigator as any).locks;
  return locks?.request ? locks.request('bebig-auth-refresh', run) : run();
}
async function token(): Promise<string> {
  if (!auth) throw new Error('Not signed in');
  if (Date.now() > auth.expires_at - 60000) {
    refreshing ??= refresh().finally(() => { refreshing = null; });
    await refreshing;
  }
  if (!auth) throw new Error('Not signed in');
  return auth.access_token;
}

async function rest(method: string, path: string, body?: any, prefer?: string) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: { apikey: KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 && auth) auth = { ...auth, expires_at: 0 }; // force a refresh on the next call
  if (!r.ok) { const j = await r.json().catch(() => ({})); const e: any = new Error(j.message || `HTTP ${r.status}`); e.status = r.status; e.code = j.code; throw e; }
  return r.status === 204 ? null : r.json().catch(() => null);
}

const REMOTE: Record<Table, { table: string; id: string }> = {
  babies: { table: 'baby_profiles', id: 'baby_id' }, access: { table: 'baby_access', id: 'access_id' },
  feeds: { table: 'feeding_entries', id: 'feed_id' }, poos: { table: 'poo_entries', id: 'poo_id' },
  sleeps: { table: 'sleep_entries', id: 'sleep_id' }, growth: { table: 'growth_measurements', id: 'measurement_id' },
  trackers: { table: 'extra_trackers', id: 'tracker_id' }, extras: { table: 'extra_entries', id: 'extra_id' },
};
const COLUMNS: Record<Table, string[]> = {
  babies: ['baby_id', 'name', 'date_of_birth', 'time_of_birth', 'sex', 'gestational_age_weeks', 'gestational_age_days', 'timezone', 'photograph_url', 'feeding_preference', 'wet_tracking', 'birth_weight_grams', 'birth_length_mm', 'birth_head_circumference_mm', 'created_by', 'created_at', 'updated_at'],
  access: ['access_id', 'baby_id', 'user_id', 'invited_email', 'role', 'invitation_status', 'invited_by', 'created_at', 'updated_at'],
  feeds: ['feed_id', 'baby_id', 'feeding_type', 'start_datetime', 'end_datetime', 'duration_seconds', 'breast_side', 'left_duration_seconds', 'right_duration_seconds', 'quantity_ml', 'observations', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  poos: ['poo_id', 'baby_id', 'datetime', 'nappy_type', 'colour', 'size', 'texture', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  sleeps: ['sleep_id', 'baby_id', 'start_datetime', 'end_datetime', 'duration_seconds', 'status', 'pauses', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  growth: ['measurement_id', 'baby_id', 'measurement_date', 'weight_grams', 'length_mm', 'head_circumference_mm', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  trackers: ['tracker_id', 'baby_id', 'name', 'icon', 'kind', 'unit', 'preset', 'enabled', 'sort', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
  extras: ['extra_id', 'baby_id', 'tracker_id', 'datetime', 'duration_seconds', 'value_num', 'level', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at'],
};
const pick = (t: Table, row: any) => { const o: any = Object.fromEntries(COLUMNS[t].filter(c => c in row).map(c => [c, row[c] ?? null])); if (t === 'poos' && !o.nappy_type) o.nappy_type = 'poo'; if (t === 'babies' && o.wet_tracking == null) o.wet_tracking = false; return o; };

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
          // rejected (validation / permission): park it so the queue isn't blocked, keep it for retry and tell the user
          console.warn('Sync rejected', op, e);
          setState(s => { s.outbox = s.outbox.filter(o => o.op_id !== op.op_id); s.syncFailed = [...(s.syncFailed || []), { ...op, error: e.message, failed_at: new Date().toISOString() }].slice(-200); s.audit.push({ at: new Date().toISOString(), user_id: me || '', action: 'sync.rejected', detail: `${op.table}: ${e.message}` }); }, false);
        } else throw e;
      }
    }
  } finally { pushing = false; }
}

// ---------- pull ----------
const cursorKey = 'bebig:cursors';
const cursors: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem(cursorKey) || '{}'); } catch { return {}; } })();
const tableErrors: Partial<Record<Table, string>> = {};
async function pull() {
  if (!auth || !navigator.onLine) return;
  const me = auth.user.id;
  const profiles = await rest('GET', 'profiles?select=user_id,email,display_name,created_at,updated_at') as User[];
  const results: Partial<Record<Table, any[]>> = {};
  for (const t of Object.keys(REMOTE) as Table[]) {
    const since = cursors[t] ? `&server_updated_at=gt.${encodeURIComponent(new Date(new Date(cursors[t]).getTime() - 5 * 60000).toISOString())}` : '';
    let rows: any[];
    try { rows = await rest('GET', `${REMOTE[t].table}?select=*${since}&order=server_updated_at.asc&limit=5000`) as any[]; }
    catch (e: any) {
      // one table failing (e.g. a database update not applied yet) must not stop everything else syncing
      if (e.status === 401 || !navigator.onLine) throw e;
      tableErrors[t] = e.message; continue;
    }
    delete tableErrors[t];
    results[t] = rows;
    if (rows.length) cursors[t] = rows[rows.length - 1].server_updated_at;
  }
  // full id list of babies we can see (detect revoked access / deleted babies)
  const visible = new Set(((await rest('GET', 'baby_profiles?select=baby_id')) as any[]).map(r => r.baby_id));
  localStorage.setItem(cursorKey, JSON.stringify(cursors));
  setState(s => {
    for (const p of profiles) s.users[p.user_id] = { ...s.users[p.user_id], ...p };
    const pendingIds = new Set([...s.outbox, ...(s.syncFailed || [])].map(o => o.row[REMOTE[o.table].id]));
    for (const t of Object.keys(results) as Table[]) {
      const idf = REMOTE[t].id; const target = s[t] as Record<string, any>;
      for (const r of results[t]!) {
        if (pendingIds.has(r[idf])) continue; // local change not yet pushed wins until it is
        const local = target[r[idf]];
        // The server copy wins unless it's the very version this device already has and a local edit is newer.
        // Comparing updated_at alone let devices drift apart for good: when a stale edit from another device
        // reached the server later, every device holding a newer local copy kept it while the server kept the old one.
        const serverMoved = !local?.server_updated_at || new Date(r.server_updated_at) > new Date(local.server_updated_at);
        if (!local || serverMoved || new Date(r.updated_at) >= new Date(local.updated_at)) {
          if (t === 'sleeps' && typeof r.pauses === 'string') r.pauses = JSON.parse(r.pauses);
          if (t === 'feeds') { r.observations = r.observations || []; if (r.quantity_ml != null) r.quantity_ml = Number(r.quantity_ml); }
          if (t === 'extras' && r.value_num != null) r.value_num = Number(r.value_num);
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
    // (only babies the server has confirmed before — never a local one that hasn't reached the server yet)
    for (const id of Object.keys(s.babies)) if (!visible.has(id) && !pendingIds.has(id) && (s.babies[id] as any).server_updated_at) forgetBabyLocally(s, id, me);
    s.lastSyncedAt = new Date().toISOString();
  }, false);
}

let timer: any = null;
let syncError: string | null = null;
export const lastSyncError = () => syncError;
/** After a pull: a baby that exists only on this device (and isn't waiting to upload) is merged into the server copy
 *  with the same name and date of birth, or uploaded again if there is none. Nothing is lost either way. */
function repairLocalOnlyBabies() {
  const s = getState(); const me = currentUserId(); if (!me) return;
  const pending = new Set([...s.outbox, ...(s.syncFailed || [])].filter(o => o.table === 'babies').map(o => o.row.baby_id));
  const confirmed = Object.values(s.babies).filter(b => (b as any).server_updated_at);
  for (const b of Object.values(s.babies)) {
    if ((b as any).server_updated_at || pending.has(b.baby_id)) continue;
    const target = confirmed.find(x => x.name.trim().toLowerCase() === b.name.trim().toLowerCase() && x.date_of_birth === b.date_of_birth);
    if (target) mergeBabyInto(b.baby_id, target.baby_id); else requeueBaby(b.baby_id);
  }
}
async function cycle() {
  try {
    await push(); await pull(); repairLocalOnlyBabies(); setInitialPullDone(true); await push(); await refreshPlus();
    const te = Object.entries(tableErrors);
    syncError = te.length ? `Some data couldn’t sync (${te.map(([t]) => t).join(', ')}): ${te[0][1]}` : null;
  }
  catch (e: any) { console.warn('sync', e); syncError = navigator.onLine ? (e?.message || 'Sync failed') : 'Offline'; if (!navigator.onLine) setInitialPullDone(true); }
  setState(() => {}, false);
}
export const syncNow = () => cycle();
// consent given on this device before the server tracked it (the server keeps the first consent time)
const syncAiConsent = () => { if (myPrefs().ai_consent) setAiConsent(true).catch(() => { /* retried next start */ }); };
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
    async updateName(display_name) { await rest('PATCH', `profiles?user_id=eq.${auth!.user.id}`, { display_name: display_name.slice(0, 80) }, 'return=minimal'); },
    async leaveBaby(baby_id) {
      try { await rest('POST', 'rpc/leave_baby', { b: baby_id }); }
      catch (e: any) { throw new Error(e.status === 404 ? 'Leaving isn’t available yet — ask the profile owner to remove you.' : e.message || 'Couldn’t leave. Check your connection and try again.'); }
    },
    onSignedIn() { syncAiConsent(); setInitialPullDone(false); setTimeout(() => setInitialPullDone(true), 12000); for (const k of Object.keys(cursors)) delete cursors[k]; retryFailedSync(); cycle(); },
  });
  // links from auth emails land here with tokens (or an error) in the URL hash
  const h = new URLSearchParams(location.hash.slice(1));
  const note = (m: string) => { try { sessionStorage.setItem('bebig:authmsg', m); } catch { /* */ } };
  // Branded email links point at our own domain: https://bebig.app/?token_hash=…&type=signup|recovery|email_change
  const q = new URLSearchParams(location.search);
  if (q.get('token_hash') && q.get('type')) {
    const token_hash = q.get('token_hash')!, type = q.get('type')!;
    history.replaceState(null, '', location.pathname);
    fetch(`${URL_}/auth/v1/verify`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ token_hash, type }) })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.msg || j.error_description || 'expired'); return j; })
      .then(async j => {
        if (!confirmAccountFromLink(j.user)) return;
        const sess = toSession(j); saveAuth(sess);
        if (type === 'recovery' || type === 'invite') {
          const pw = prompt(type === 'invite' ? 'Welcome to Bebig! Choose a password for your account (at least 8 characters)' : 'Choose a new password (at least 8 characters)');
          if (pw && pw.length >= 8) {
            const r = await fetch(`${URL_}/auth/v1/user`, { method: 'PUT', headers: { apikey: KEY, Authorization: `Bearer ${sess.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
            alert(r.ok ? (type === 'invite' ? 'Password set — you’re signed in.' : 'Password updated.') : 'Sorry, the password could not be changed. Please request a new link.');
          }
        }
        adoptRemoteUser({ user_id: j.user.id, email: j.user.email, display_name: j.user.user_metadata?.display_name || j.user.email.split('@')[0] });
      })
      .catch(() => note('That link has expired or was already used. If you confirmed your email, just sign in — otherwise request a new link.'));
  }
  if (h.get('error_description')) {
    history.replaceState(null, '', location.pathname);
    note(h.get('error_code') === 'otp_expired' ? 'That link has expired or was already used. If you confirmed your email, just sign in — otherwise request a new link.' : h.get('error_description')!.replace(/\+/g, ' '));
  } else if (h.get('access_token') && h.get('type') !== 'recovery') {
    // email confirmation / magic link: sign straight in
    history.replaceState(null, '', location.pathname);
    const at = h.get('access_token')!, rt = h.get('refresh_token') || '', exp = Number(h.get('expires_in') || 3600);
    fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${at}` } }).then(r => r.ok ? r.json() : Promise.reject())
      .then(user => { if (!confirmAccountFromLink(user)) return; saveAuth({ access_token: at, refresh_token: rt, expires_at: Date.now() + exp * 1000, user }); adoptRemoteUser({ user_id: user.id, email: user.email, display_name: user.user_metadata?.display_name || user.email.split('@')[0] }); })
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
  let debounce: any;
  setInterval(() => { if (getState().outbox.length && !pushing) { clearTimeout(debounce); debounce = setTimeout(push, 300); } }, 1000);
  timer = setInterval(kick, 15000);
  // changes the server rejected (e.g. before a database update was applied) are retried every 5 minutes
  setInterval(() => { if (auth && navigator.onLine && getState().syncFailed?.length) { retryFailedSync(); kick(); } }, 5 * 60000);
  if (auth) { syncAiConsent(); if (getState().syncFailed?.length) retryFailedSync(); setTimeout(() => setInitialPullDone(true), 12000); kick(); }
  else if (currentUserId()) {
    // looks signed in on this device, but there is no server session (e.g. signed up before cloud sync existed):
    // ask to sign in again so the data can sync — nothing local is deleted
    requireReauth('Please sign in again to switch on syncing with your other devices. Nothing you logged on this device is lost.');
  }
  return () => clearInterval(timer);
}

// ---------- Bebig Plus ----------
// Status comes from plus_status() (migration 0006). Until that migration is deployed the call fails quietly and the
// app falls back to the built-in early-access date, so nothing breaks.
const plusCheckedAt: Record<string, number> = {};
const PLUS_REFRESH_MS = 5 * 60000;
let pausedCheckedAt = 0;
async function refreshPlus(force = false) {
  if (!auth) return;
  if (force || Date.now() - pausedCheckedAt > PLUS_REFRESH_MS) {
    pausedCheckedAt = Date.now();
    try { setPausedBabies(await rest('POST', 'rpc/my_paused_babies', {}) as any[]); } catch { /* not deployed yet / offline */ }
  }
  const s = getState();
  for (const b of Object.values(s.babies)) {
    if (!(b as any).server_updated_at) continue; // not on the server yet
    if (!force && Date.now() - (plusCheckedAt[b.baby_id] ?? 0) < PLUS_REFRESH_MS) continue;
    plusCheckedAt[b.baby_id] = Date.now();
    try { setPlusStatus(b.baby_id, await rest('POST', 'rpc/plus_status', { b: b.baby_id }) as PlusStatus); }
    catch { /* offline or migration 0006 not deployed yet: keep the last known status */ }
  }
}
export const refreshPlusNow = () => refreshPlus(true);

/** Owner chooses which caregiver keeps access on the free plan. */
export async function chooseFreeCaregiver(access_id: string) {
  await rest('POST', 'rpc/choose_free_caregiver', { p_access_id: access_id });
  await cycle();
}

/** Starts the family's one free trial on the server (it checks eligibility itself). */
export async function startPlusTrial(baby_id: string): Promise<PlusStatus> {
  try {
    const st = await rest('POST', 'rpc/start_plus_trial', { b: baby_id }) as PlusStatus;
    setPlusStatus(baby_id, st); await refreshPlus(true); return st; // refresh the owner's other babies too (one plan per family)
  } catch (e: any) {
    throw new Error(e.status === 404 ? 'Free trials aren’t available yet.' : (e.message || 'Couldn’t start the trial. Please try again.'));
  }
}

/** Records (or withdraws) consent to AI phrasing on the server, which checks it before calling the model. */
export async function setAiConsent(on: boolean) {
  if (!auth) return;
  await rest('PATCH', `profiles?user_id=eq.${auth.user.id}`, { ai_consent_at: on ? new Date().toISOString() : null }, 'return=minimal');
}

/** Optional LLM phrasing of an already-verified answer (requires the user's AI consent). Falls back silently. */
export async function phraseAnswer(baby_id: string, question: string, verified_answer: string, kind: string): Promise<string> {
  try {
    // a slow or stuck function must not swallow the question: after 8 s the verified answer is shown as is
    const r = await fetch(`${URL_}/functions/v1/assistant`, { method: 'POST', signal: AbortSignal.timeout?.(8000), headers: { apikey: KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ baby_id, question, verified_answer, kind }) });
    if (!r.ok) return verified_answer;
    return (await r.json()).content || verified_answer;
  } catch { return verified_answer; }
}

/** Side-by-side counts of what this device holds and what the server holds, for troubleshooting sync. */
export async function diagnostics(): Promise<string> {
  const s = getState(); const me = currentUserId(); const lines: string[] = [];
  const short = (x?: string | null) => (x ? x.slice(0, 8) : '—');
  lines.push(`Bebig ${(await import('./config')).config.version} · cloud sync`);
  lines.push(`Device user: ${short(me)} ${s.users[me ?? '']?.email ?? ''} · server session: ${auth ? short(auth.user.id) + ' ' + auth.user.email : 'NONE'}`);
  lines.push(`Online: ${navigator.onLine} · last synced: ${s.lastSyncedAt ?? 'never'} · waiting: ${s.outbox.length} · rejected: ${s.syncFailed?.length ?? 0}`);
  for (const f of (s.syncFailed ?? []).slice(-3)) lines.push(`  rejected ${f.table}: ${f.error}`);
  const te = Object.entries(tableErrors); for (const [t, e] of te) lines.push(`  table error ${t}: ${e}`);
  if (syncError) lines.push(`Last error: ${syncError}`);
  const mine = Object.values(s.access).filter(a => a.user_id === me && a.invitation_status === 'accepted').map(a => a.baby_id);
  lines.push(`Babies on device: ${Object.values(s.babies).map(b => `${b.name} [${short(b.baby_id)}${(b as any).server_updated_at ? '' : ', not on server'}${mine.includes(b.baby_id) ? '' : ', no access'}${s.selectedBaby[me ?? ''] === b.baby_id ? ', selected' : ''}]`).join('; ') || 'none'}`);
  if (auth) {
    try {
      const sb = await rest('GET', 'baby_profiles?select=baby_id,name') as any[];
      lines.push(`Babies on server: ${sb.map(b => `${b.name} [${short(b.baby_id)}]`).join('; ') || 'none'}`);
      const acc = await rest('GET', `baby_access?select=baby_id,role,invitation_status&user_id=eq.${auth.user.id}`) as any[];
      lines.push(`Server access for this account: ${acc.map(a => `${short(a.baby_id)} ${a.role}/${a.invitation_status}`).join('; ') || 'none'}`);
      for (const b of sb) {
        const parts: string[] = [];
        for (const t of ['feeds', 'poos', 'sleeps', 'growth', 'extras'] as Table[]) {
          const local = Object.values(s[t] as Record<string, any>).filter(r => r.baby_id === b.baby_id && !r.deleted_at).length;
          let remote = '?';
          try {
            const r = await fetch(`${URL_}/rest/v1/${REMOTE[t].table}?baby_id=eq.${b.baby_id}&deleted_at=is.null&select=${REMOTE[t].id}`, { headers: { apikey: KEY, Authorization: `Bearer ${await token()}`, Prefer: 'count=exact', Range: '0-0' } });
            remote = (r.headers.get('content-range') || '').split('/')[1] || String(r.status);
          } catch (e: any) { remote = 'err'; }
          parts.push(`${t} ${local}/${remote}`);
        }
        lines.push(`  ${b.name}: device/server → ${parts.join(', ')}`);
      }
    } catch (e: any) { lines.push(`Server check failed: ${e.message}`); }
  }
  return lines.join('\n');
}
