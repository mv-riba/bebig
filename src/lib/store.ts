// Local-first data store.
// - Every write goes to local state immediately (instant feedback, works offline) and is appended to an outbox.
// - A SyncBackend (see sync.ts) drains the outbox to the server and applies remote changes.
// - Client-generated UUIDs + idempotent upserts prevent duplicate entries when an op is retried.
// - Concurrent edits resolve last-write-wins on updated_at (row-level), with created_by/updated_by kept for audit.
// - In local mode, tabs on the same device sync via BroadcastChannel, which also demonstrates shared access.

import { useSyncExternalStore, useRef } from 'react';
import type {
  User, BabyProfile, BabyAccess, FeedingEntry, PooEntry, SleepEntry, GrowthMeasurement, FeedTimer, UserPrefs, Role, TrackerDef, ExtraEntry,
} from './types';
import type { PlusStatus } from './plans';

export type Table = 'feeds' | 'poos' | 'sleeps' | 'growth' | 'babies' | 'access' | 'trackers' | 'extras';
export interface OutboxOp { op_id: string; table: Table; row: any; queued_at: string }
export interface AuditEvent { at: string; user_id: string; action: string; detail?: string }
interface LocalCredential { user_id: string; salt: string; hash: string }

export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; created_at: string; kind?: 'fact' | 'estimate' | 'safety' | 'info' }

export interface State {
  version: 1;
  session: { user_id: string } | null;
  users: Record<string, User>;
  credentials: Record<string, LocalCredential>; // local mode only; Supabase Auth replaces this
  babies: Record<string, BabyProfile>;
  access: Record<string, BabyAccess>;
  feeds: Record<string, FeedingEntry>;
  poos: Record<string, PooEntry>;
  sleeps: Record<string, SleepEntry>;
  growth: Record<string, GrowthMeasurement>;
  trackers: Record<string, TrackerDef>;
  extras: Record<string, ExtraEntry>;
  feedTimers: Record<string, FeedTimer>; // by baby_id
  extraTimers: Record<string, ExtraTimer>; // by tracker_id ("How long" trackers), kept on this device
  prefs: Record<string, UserPrefs>; // by user_id
  selectedBaby: Record<string, string>; // user_id -> baby_id
  chats: Record<string, ChatMessage[]>; // `${user}:${baby}`
  outbox: OutboxOp[];
  syncFailed: (OutboxOp & { error: string; failed_at: string })[]; // rejected by the server; kept for retry, never silently lost
  audit: AuditEvent[];
  lastSyncedAt: string | null;
  plus: Record<string, PlusStatus>; // by baby_id: last known Bebig Plus status (server's, or a local-mode trial)
  paused: PausedBaby[]; // profiles this user belongs to but is paused on (family's Plus ended)
}
export interface PausedBaby { baby_id: string; name: string; owner_name: string | null }

const KEY = 'bebig:v1';
export const uuid = () => (crypto as any).randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});
export const nowIso = () => new Date().toISOString();

export const defaultPrefs = (): UserPrefs => ({
  time_format: '24h', units: 'metric', language: 'en', ai_consent: false,
  notifications: { feeding: false, sleep: false, custom: false, feeding_interval_min: 180 },
});

function empty(): State {
  return {
    version: 1, session: null, users: {}, credentials: {}, babies: {}, access: {}, feeds: {}, poos: {}, sleeps: {},
    growth: {}, trackers: {}, extras: {}, feedTimers: {}, extraTimers: {}, prefs: {}, selectedBaby: {}, chats: {}, outbox: [], syncFailed: [], audit: [], lastSyncedAt: null, plus: {}, paused: [],
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = { ...empty(), ...JSON.parse(raw) }; s.trackers ??= {}; s.extras ??= {}; s.extraTimers ??= {}; s.syncFailed ??= []; s.plus ??= {}; s.paused ??= []; return s; }
  } catch { /* corrupted or unavailable storage */ }
  return empty();
}

let state: State = typeof localStorage !== 'undefined' ? load() : empty();
const listeners = new Set<() => void>();
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bebig') : null;

// Per-tab session: the persisted session is the default, but a tab can sign in as another user (sessionStorage),
// which makes it easy to demo two parents side by side on one machine.
function tabSession(): State['session'] {
  try { const s = sessionStorage.getItem('bebig:session'); if (s) return JSON.parse(s); } catch { /* */ }
  return state.session;
}
let session = tabSession();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota */ }
}
function emit() { listeners.forEach(l => l()); }

export function setState(fn: (s: State) => void, broadcast = true) {
  const next: State = structuredClone(state);
  fn(next);
  state = next;
  persist();
  emit();
  if (broadcast) channel?.postMessage({ type: 'changed' });
}

channel && (channel.onmessage = () => { state = load(); emit(); });
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === KEY) { state = load(); emit(); } });

export function getState() { return state; }
export function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }

export function useStore<T>(selector: (s: State) => T): T {
  // memoise by state identity so selectors may return fresh arrays safely
  const cache = useRef<{ s: State | null; sess: any; v: T }>({ s: null, sess: null, v: undefined as any });
  const get = () => {
    if (cache.current.s !== state || cache.current.sess !== session) cache.current = { s: state, sess: session, v: selector(state) };
    return cache.current.v;
  };
  return useSyncExternalStore(subscribe, get, get);
}

// ---------------- Session & auth (local mode) ----------------

async function hashPw(pw: string, salt: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
export const currentUserId = () => session?.user_id ?? null;
export function currentUser(): User | null { const id = currentUserId(); return id ? state.users[id] ?? null : null; }

function setSession(user_id: string | null) {
  session = user_id ? { user_id } : null;
  try { user_id ? sessionStorage.setItem('bebig:session', JSON.stringify(session)) : sessionStorage.removeItem('bebig:session'); } catch { /* */ }
  setState(s => { s.session = session; }, false);
}

// Remote auth provider (Supabase) — registered by supabase.ts when cloud sync is configured.
export interface RemoteAuth {
  register(email: string, password: string, display_name: string): Promise<{ user_id: string; email: string; display_name: string }>;
  signIn(email: string, password: string): Promise<{ user_id: string; email: string; display_name: string }>;
  reset(email: string): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
  updateName(name: string): Promise<void>;
  onSignedIn(): void;
}
let remote: RemoteAuth | null = null;
export function setRemoteAuth(r: RemoteAuth) { remote = r; }
export const isRemote = () => !!remote;

export function adoptRemoteUser(u: { user_id: string; email: string; display_name: string }) {
  const t = nowIso();
  setState(s => {
    // Data recorded on this device under an older on-device account with the same email (e.g. before cloud sync
    // was switched on) is moved to the real account, so it can sync instead of being stranded.
    const email = u.email.toLowerCase();
    for (const old of Object.values(s.users)) {
      if (old.user_id === u.user_id || old.email !== email) continue;
      const from = old.user_id, to = u.user_id;
      const fix = (r: any) => { for (const k of ['created_by', 'updated_by', 'user_id', 'invited_by']) if (r && r[k] === from) r[k] = to; };
      for (const tb of ['babies', 'access', 'feeds', 'poos', 'sleeps', 'growth', 'trackers', 'extras'] as const) Object.values(s[tb] as Record<string, any>).forEach(fix);
      Object.values(s.feedTimers).forEach(fix);
      s.outbox.forEach(o => fix(o.row)); (s.syncFailed || []).forEach(o => fix(o.row));
      // queue everything this account owns locally that the server has never confirmed
      for (const tb of ['babies', 'feeds', 'poos', 'sleeps', 'growth', 'trackers', 'extras'] as const)
        for (const r of Object.values(s[tb] as Record<string, any>)) if (r.created_by === to && !r.server_updated_at) s.outbox.push({ op_id: uuid(), table: tb, row: structuredClone(r), queued_at: t });
      if (s.prefs[from] && !s.prefs[to]) s.prefs[to] = s.prefs[from];
      if (s.selectedBaby[from] && !s.selectedBaby[to]) s.selectedBaby[to] = s.selectedBaby[from];
      delete s.users[from]; delete s.prefs[from]; delete s.selectedBaby[from]; delete s.credentials[email];
      Object.keys(s.chats).forEach(k => { if (k.startsWith(from + ':')) { s.chats[to + k.slice(from.length)] = s.chats[k]; delete s.chats[k]; } });
      s.audit.push({ at: t, user_id: to, action: 'account.local_data_moved', detail: from });
    }
    // babies must go before their entries
    s.outbox.sort((a, b) => (a.table === 'babies' ? 0 : 1) - (b.table === 'babies' ? 0 : 1));
    s.users[u.user_id] = { created_at: t, ...s.users[u.user_id], user_id: u.user_id, email: u.email.toLowerCase(), display_name: s.users[u.user_id]?.display_name || u.display_name, updated_at: t };
    if (!s.prefs[u.user_id]) s.prefs[u.user_id] = defaultPrefs();
  });
  setSession(u.user_id);
  remote?.onSignedIn();
}

export async function register(email: string, password: string, display_name: string) {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  if (remote) return adoptRemoteUser(await remote.register(email, password, display_name.trim()));
  if (Object.values(state.users).some(u => u.email === email)) throw new Error('An account with this email already exists.');
  const user_id = uuid(); const salt = uuid(); const hash = await hashPw(password, salt); const t = nowIso();
  setState(s => {
    s.users[user_id] = { user_id, email, display_name: display_name.trim() || email.split('@')[0], created_at: t, updated_at: t };
    s.credentials[email] = { user_id, salt, hash };
    s.prefs[user_id] = defaultPrefs();
    s.audit.push({ at: t, user_id, action: 'account.created' });
  });
  setSession(user_id);
}

export async function signIn(email: string, password: string) {
  email = email.trim().toLowerCase();
  if (remote) return adoptRemoteUser(await remote.signIn(email, password));
  const c = state.credentials[email];
  if (!c || (await hashPw(password, c.salt)) !== c.hash) throw new Error('Email or password is incorrect.');
  setSession(c.user_id);
  setState(s => { s.audit.push({ at: nowIso(), user_id: c.user_id, action: 'auth.sign_in' }); });
}
export function signOut() {
  const id = currentUserId(); if (id) setState(s => { s.audit.push({ at: nowIso(), user_id: id, action: 'auth.sign_out' }); });
  if (remote) { remote.signOut(); const keepAudit = state.audit; state = { ...empty(), audit: keepAudit }; persist(); } // never leave another family's cache on a shared device
  setSession(null);
}

export async function resetPassword(email: string, newPassword: string) {
  email = email.trim().toLowerCase();
  if (remote) return remote.reset(email);
  const c = state.credentials[email];
  if (!c) return; // never reveal whether an account exists
  if (newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
  const salt = uuid(); const hash = await hashPw(newPassword, salt);
  setState(s => { s.credentials[email] = { ...c, salt, hash }; s.audit.push({ at: nowIso(), user_id: c.user_id, action: 'auth.password_reset' }); });
}

export function updateAccount(patch: Partial<Pick<User, 'display_name'>>) {
  const id = currentUserId(); if (!id) return;
  setState(s => { Object.assign(s.users[id], patch, { updated_at: nowIso() }); });
  if (remote && patch.display_name) remote.updateName(patch.display_name).catch(() => {});
}

export async function deleteAccount() {
  const id = currentUserId(); if (!id) return;
  if (remote) { await remote.deleteAccount(); state = empty(); persist(); setSession(null); return; }
  const u = state.users[id];
  // Owners must delete or hand over their babies first: delete owned babies entirely.
  const owned = Object.values(state.access).filter(a => a.user_id === id && a.role === 'owner' && a.invitation_status === 'accepted').map(a => a.baby_id);
  owned.forEach(b => deleteBabyData(b));
  setState(s => {
    Object.values(s.access).forEach(a => { if (a.user_id === id) delete s.access[a.access_id]; });
    delete s.users[id]; delete s.credentials[u.email]; delete s.prefs[id]; delete s.selectedBaby[id];
    s.audit.push({ at: nowIso(), user_id: id, action: 'account.deleted' });
  });
  setSession(null);
}

// ---------------- Access control ----------------

export function roleFor(baby_id: string, user_id = currentUserId()): Role | null {
  if (!user_id) return null;
  const a = Object.values(state.access).find(x => x.baby_id === baby_id && x.user_id === user_id && x.invitation_status === 'accepted');
  return a?.role ?? null;
}
function assertAccess(baby_id: string, need: 'write' | 'owner' = 'write') {
  const r = roleFor(baby_id);
  if (!r) throw new Error('You do not have access to this baby profile.');
  if (need === 'owner' && r !== 'owner') throw new Error('Only the profile owner can do this.');
}
export function accessibleBabies(s: State = state): BabyProfile[] {
  const id = session?.user_id; if (!id) return [];
  const ids = new Set(Object.values(s.access).filter(a => a.user_id === id && a.invitation_status === 'accepted').map(a => a.baby_id));
  return Object.values(s.babies).filter(b => ids.has(b.baby_id));
}
export function selectedBaby(s: State = state): BabyProfile | null {
  const id = session?.user_id; if (!id) return null;
  const list = accessibleBabies(s);
  return list.find(b => b.baby_id === s.selectedBaby[id]) ?? list[0] ?? null;
}
export function pendingInvitesForMe(s: State = state): BabyAccess[] {
  const u = session ? s.users[session.user_id] : null; if (!u) return [];
  return Object.values(s.access).filter(a => a.invitation_status === 'pending' && a.invited_email === u.email);
}

function queue(s: State, table: Table, row: any) {
  s.outbox.push({ op_id: uuid(), table, row: structuredClone(row), queued_at: nowIso() });
}

// ---------------- Baby profiles ----------------

export function createBaby(input: Omit<BabyProfile, 'baby_id' | 'created_by' | 'created_at' | 'updated_at'>) {
  const uid = currentUserId(); if (!uid) throw new Error('Not signed in');
  const baby_id = uuid(); const t = nowIso();
  const u = state.users[uid];
  setState(s => {
    s.babies[baby_id] = { ...input, baby_id, created_by: uid, created_at: t, updated_at: t };
    const access_id = uuid();
    s.access[access_id] = { access_id, baby_id, user_id: uid, invited_email: u.email, role: 'owner', invitation_status: 'accepted', invited_by: uid, created_at: t, updated_at: t };
    s.selectedBaby[uid] = baby_id;
    queue(s, 'babies', s.babies[baby_id]); queue(s, 'access', s.access[access_id]);
    s.audit.push({ at: t, user_id: uid, action: 'baby.created', detail: baby_id });
  });
  return baby_id;
}

export function updateBaby(baby_id: string, patch: Partial<BabyProfile>) {
  assertAccess(baby_id);
  setState(s => {
    const { baby_id: _a, created_by: _b, created_at: _c, ...safe } = patch as any;
    Object.assign(s.babies[baby_id], safe, { updated_at: nowIso() });
    queue(s, 'babies', s.babies[baby_id]);
  });
}

export function selectBaby(baby_id: string) { const uid = currentUserId(); if (uid) setState(s => { s.selectedBaby[uid] = baby_id; }, false); }

export function deleteBabyData(baby_id: string) {
  assertAccess(baby_id, 'owner');
  const uid = currentUserId()!;
  setState(s => {
    for (const t of ['feeds', 'poos', 'sleeps', 'growth', 'trackers', 'extras'] as const) {
      for (const [k, v] of Object.entries(s[t] as Record<string, any>)) if (v.baby_id === baby_id) delete (s[t] as any)[k];
    }
    Object.values(s.access).forEach(a => { if (a.baby_id === baby_id) delete s.access[a.access_id]; });
    delete s.feedTimers[baby_id]; delete s.babies[baby_id]; delete s.plus[baby_id];
    Object.keys(s.chats).forEach(k => { if (k.endsWith(':' + baby_id)) delete s.chats[k]; });
    queue(s, 'babies', { baby_id, deleted_at: nowIso() });
    s.audit.push({ at: nowIso(), user_id: uid, action: 'baby.deleted', detail: baby_id });
  });
}

// ---------------- Sharing ----------------

export class PlanLimitError extends Error { readonly planLimit = true; }

// mirrors the server: when the free-slot caregiver leaves, the earliest remaining caregiver takes it
function refillFreeSlot(s: State, baby_id: string) {
  const cg = Object.values(s.access).filter(a => a.baby_id === baby_id && a.role === 'caregiver' && a.invitation_status === 'accepted');
  if (cg.some(a => a.keeps_free_access)) return;
  const first = cg.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.access_id.localeCompare(b.access_id))[0];
  if (first) first.keeps_free_access = true;
}

/** Owner: who keeps access on the free plan. Local state only — with cloud sync the server does it (choose_free_caregiver). */
export function setFreeCaregiverLocally(access_id: string) {
  const a = state.access[access_id]; if (!a) return;
  assertAccess(a.baby_id, 'owner');
  setState(s => { for (const o of Object.values(s.access)) if (o.baby_id === a.baby_id) o.keeps_free_access = o.access_id === access_id; });
}

/** `maxCaregivers`: the family's plan limit (see plans.ts caregiverLimit); the server enforces it as well. */
export function inviteCaregiver(baby_id: string, email: string, role: Role = 'caregiver', maxCaregivers = Infinity) {
  assertAccess(baby_id, 'owner');
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
  const existing = Object.values(state.access).find(a => a.baby_id === baby_id && a.invited_email === email && (a.invitation_status === 'pending' || a.invitation_status === 'accepted'));
  if (existing) throw new Error(existing.invitation_status === 'accepted' ? 'This person already has access.' : 'An invitation is already pending for this email.');
  const caregivers = Object.values(state.access).filter(a => a.baby_id === baby_id && a.role === 'caregiver' && (a.invitation_status === 'pending' || a.invitation_status === 'accepted')).length;
  if (caregivers >= maxCaregivers) throw new PlanLimitError(`The free plan includes ${maxCaregivers} caregiver${maxCaregivers === 1 ? '' : 's'} besides you. Bebig Plus adds the whole family.`);
  const uid = currentUserId()!; const t = nowIso(); const access_id = uuid();
  setState(s => {
    s.access[access_id] = { access_id, baby_id, user_id: null, invited_email: email, role, invitation_status: 'pending', invited_by: uid, created_at: t, updated_at: t };
    queue(s, 'access', s.access[access_id]);
    s.audit.push({ at: t, user_id: uid, action: 'access.invited', detail: email });
  });
}
export function respondToInvite(access_id: string, accept: boolean) {
  const uid = currentUserId(); if (!uid) return;
  const a = state.access[access_id]; const me = state.users[uid];
  if (!a || a.invitation_status !== 'pending' || a.invited_email !== me.email) throw new Error('This invitation is no longer valid.');
  setState(s => {
    const x = s.access[access_id];
    x.invitation_status = accept ? 'accepted' : 'declined'; x.user_id = accept ? uid : null; x.updated_at = nowIso();
    if (accept && x.role === 'caregiver' && !Object.values(s.access).some(o => o.baby_id === x.baby_id && o.keeps_free_access && o.access_id !== x.access_id)) x.keeps_free_access = true;
    if (accept) s.selectedBaby[uid] = x.baby_id;
    queue(s, 'access', x);
    s.audit.push({ at: nowIso(), user_id: uid, action: accept ? 'access.accepted' : 'access.declined', detail: x.baby_id });
  });
}
export function revokeAccess(access_id: string) {
  const a = state.access[access_id]; if (!a) return;
  assertAccess(a.baby_id, 'owner');
  if (a.role === 'owner') throw new Error('The owner’s access cannot be revoked.');
  setState(s => {
    const x = s.access[access_id]; x.invitation_status = 'revoked'; x.updated_at = nowIso();
    if (x.keeps_free_access) { x.keeps_free_access = false; refillFreeSlot(s, x.baby_id); }
    queue(s, 'access', x);
    s.audit.push({ at: nowIso(), user_id: currentUserId()!, action: 'access.revoked', detail: x.invited_email });
  });
}
export function setRole(access_id: string, role: Role) {
  const a = state.access[access_id]; if (!a) return;
  assertAccess(a.baby_id, 'owner');
  if (a.role === 'owner') throw new Error('Transfer of ownership is not supported yet.');
  if (role === 'owner') throw new Error('Only one owner is supported in this version.');
  setState(s => { s.access[access_id].role = role; s.access[access_id].updated_at = nowIso(); queue(s, 'access', s.access[access_id]); });
}

// ---------------- Activity entries ----------------

type Kind = 'feeds' | 'poos' | 'sleeps' | 'growth' | 'trackers' | 'extras';
const idField: Record<Kind, string> = { feeds: 'feed_id', poos: 'poo_id', sleeps: 'sleep_id', growth: 'measurement_id', trackers: 'tracker_id', extras: 'extra_id' };

export function upsertEntry<K extends Kind>(table: K, row: any): string {
  assertAccess(row.baby_id);
  const uid = currentUserId()!; const t = nowIso();
  const idf = idField[table];
  const id = row[idf] || uuid();
  setState(s => {
    const prev = (s[table] as any)[id];
    const next = { ...prev, ...row, [idf]: id, updated_by: uid, updated_at: t, created_by: prev?.created_by ?? uid, created_at: prev?.created_at ?? t };
    (s[table] as any)[id] = next;
    queue(s, table, next);
  });
  return id;
}
export function deleteEntry(table: Kind, id: string) {
  const row = (state[table] as any)[id]; if (!row) return;
  assertAccess(row.baby_id);
  setState(s => {
    const x = (s[table] as any)[id];
    x.deleted_at = nowIso(); x.updated_at = x.deleted_at; x.updated_by = currentUserId();
    queue(s, table, x);
  });
}
export function restoreEntry(table: Kind, id: string) {
  setState(s => { const x = (s[table] as any)[id]; if (x) { x.deleted_at = null; x.updated_at = nowIso(); queue(s, table, x); } });
}

export const live = <T extends { deleted_at?: string | null; baby_id: string }>(rec: Record<string, T>, baby_id: string) =>
  Object.values(rec).filter(r => r.baby_id === baby_id && !r.deleted_at);

// ---------------- Feed timer (persisted) ----------------

export function startFeedTimer(baby_id: string, side: 'left' | 'right' | null) {
  assertAccess(baby_id);
  const t = nowIso();
  setState(s => { s.feedTimers[baby_id] = { baby_id, started_at: t, side, left_seconds: 0, right_seconds: 0, unsided_seconds: 0, segment_started_at: t, created_by: currentUserId()! }; });
}
function closeSegment(ft: FeedTimer, at = Date.now()) {
  if (!ft.segment_started_at) return;
  const secs = (at - new Date(ft.segment_started_at).getTime()) / 1000;
  if (ft.side === 'left') ft.left_seconds += secs; else if (ft.side === 'right') ft.right_seconds += secs; else ft.unsided_seconds += secs;
  ft.segment_started_at = null;
}
export function feedTimerTotals(ft: FeedTimer, now = Date.now()) {
  let { left_seconds: l, right_seconds: r, unsided_seconds: u } = ft;
  if (ft.segment_started_at) {
    const secs = (now - new Date(ft.segment_started_at).getTime()) / 1000;
    if (ft.side === 'left') l += secs; else if (ft.side === 'right') r += secs; else u += secs;
  }
  return { left: l, right: r, unsided: u, total: l + r + u };
}
export function pauseFeedTimer(baby_id: string) { setState(s => { const ft = s.feedTimers[baby_id]; if (ft) closeSegment(ft); }); }
export function resumeFeedTimer(baby_id: string) { setState(s => { const ft = s.feedTimers[baby_id]; if (ft && !ft.segment_started_at) ft.segment_started_at = nowIso(); }); }
export function switchFeedSide(baby_id: string, side: 'left' | 'right' | null) {
  setState(s => { const ft = s.feedTimers[baby_id]; if (!ft) return; const running = !!ft.segment_started_at; closeSegment(ft); ft.side = side; if (running) ft.segment_started_at = nowIso(); });
}
export function discardFeedTimer(baby_id: string) { setState(s => { delete s.feedTimers[baby_id]; }); }

// ---------------- Sleep timer (persisted as an active SleepEntry) ----------------

export function activeSleep(baby_id: string, s: State = state): SleepEntry | null {
  return Object.values(s.sleeps).find(x => x.baby_id === baby_id && !x.deleted_at && x.status !== 'completed') ?? null;
}
export function startSleep(baby_id: string) {
  if (activeSleep(baby_id)) throw new Error('A sleep session is already running.');
  return upsertEntry('sleeps', { baby_id, start_datetime: nowIso(), status: 'active', pauses: [], end_datetime: null, duration_seconds: null });
}
export function sleepElapsed(e: SleepEntry, now = Date.now()) {
  const end = e.end_datetime ? new Date(e.end_datetime).getTime() : now;
  let paused = 0;
  for (const p of e.pauses || []) paused += ((p.end ? new Date(p.end).getTime() : Math.min(now, end)) - new Date(p.start).getTime());
  return Math.max(0, (end - new Date(e.start_datetime).getTime() - paused) / 1000);
}
export function pauseSleep(e: SleepEntry) { upsertEntry('sleeps', { ...e, status: 'paused', pauses: [...(e.pauses || []), { start: nowIso(), end: null }] }); }
export function resumeSleep(e: SleepEntry) {
  const pauses = (e.pauses || []).map(p => p.end ? p : { ...p, end: nowIso() });
  upsertEntry('sleeps', { ...e, status: 'active', pauses });
}
export function stopSleep(e: SleepEntry) {
  const t = nowIso();
  const pauses = (e.pauses || []).map(p => p.end ? p : { ...p, end: t });
  const done = { ...e, end_datetime: t, pauses, status: 'completed' as const };
  done.duration_seconds = Math.round(sleepElapsed(done));
  upsertEntry('sleeps', done);
  return done;
}

// ---------------- Prefs & chat ----------------

export function setPlusStatus(baby_id: string, st: PlusStatus) { setState(s => { s.plus[baby_id] = st; }); }
export function setPausedBabies(list: PausedBaby[]) { if (JSON.stringify(list) !== JSON.stringify(state.paused ?? [])) setState(s => { s.paused = list; }, false); }

export function myPrefs(s: State = state): UserPrefs { const id = session?.user_id; return (id && s.prefs[id]) || defaultPrefs(); }
export function updatePrefs(patch: Partial<UserPrefs>) {
  const id = currentUserId(); if (!id) return;
  setState(s => { s.prefs[id] = { ...defaultPrefs(), ...s.prefs[id], ...patch }; });
}
export function chatKey(baby_id: string) { return `${currentUserId()}:${baby_id}`; }
export function appendChat(baby_id: string, msgs: ChatMessage[]) {
  setState(s => { const k = chatKey(baby_id); s.chats[k] = [...(s.chats[k] || []), ...msgs].slice(-200); }, false);
}
export function clearChat(baby_id: string) { setState(s => { delete s.chats[chatKey(baby_id)]; }, false); }

// ---------------- Export ----------------

export function exportBaby(baby_id: string) {
  assertAccess(baby_id);
  const pick = <T extends { baby_id: string }>(r: Record<string, T>) => Object.values(r).filter(x => x.baby_id === baby_id);
  return {
    exported_at: nowIso(), format: 'bebig-export/1', note: 'All timestamps are UTC (ISO 8601). Use profile.timezone for local display.',
    profile: state.babies[baby_id],
    members: pick(state.access).map(a => ({ email: a.invited_email, role: a.role, status: a.invitation_status })),
    feeding_entries: pick(state.feeds), poo_entries: pick(state.poos), sleep_entries: pick(state.sleeps), growth_measurements: pick(state.growth),
    extra_trackers: pick(state.trackers), extra_entries: pick(state.extras),
  };
}

export function resetAll() { localStorage.removeItem(KEY); sessionStorage.removeItem('bebig:session'); state = empty(); session = null; emit(); channel?.postMessage({ type: 'changed' }); }

/** Move changes the server rejected back into the outbox (e.g. after a server-side fix). */
export function retryFailedSync() {
  setState(s => { s.outbox = [...(s.syncFailed || []).map(({ error, failed_at, ...op }) => op), ...s.outbox]; s.syncFailed = []; }, false);
}

// Whether the first server pull after sign-in has finished (not persisted). Until then a signed-in user with no
// baby on this device is shown a loading state rather than onboarding, to avoid creating a duplicate profile.
let initialPullDone = false;
export function setInitialPullDone(v: boolean) { if (initialPullDone !== v) { initialPullDone = v; setState(() => {}, false); } }
export const isInitialPullDone = () => initialPullDone;

/** Session could not be renewed: show sign-in again but KEEP local data and unsynced changes. */
export function requireReauth(message: string) {
  try { sessionStorage.setItem('bebig:authmsg', message); } catch { /* */ }
  setSession(null);
}
export const unsyncedCount = (s: State = state) => s.outbox.length + (s.syncFailed?.length ?? 0);

// ---------------- Timers for "How long" extra trackers (persisted, survive app close) ----------------
export interface ExtraTimer { baby_id: string; tracker_id: string; started_at: string; acc_seconds: number; segment_started_at: string | null }
export function extraTimerSeconds(t: ExtraTimer, now = Date.now()) {
  return t.acc_seconds + (t.segment_started_at ? Math.max(0, (now - new Date(t.segment_started_at).getTime()) / 1000) : 0);
}
export function startExtraTimer(baby_id: string, tracker_id: string) {
  assertAccess(baby_id); const t = nowIso();
  setState(s => { s.extraTimers[tracker_id] = { baby_id, tracker_id, started_at: t, acc_seconds: 0, segment_started_at: t }; });
}
export function pauseExtraTimer(tracker_id: string) {
  setState(s => { const t = s.extraTimers[tracker_id]; if (t?.segment_started_at) { t.acc_seconds = extraTimerSeconds(t); t.segment_started_at = null; } });
}
export function resumeExtraTimer(tracker_id: string) {
  setState(s => { const t = s.extraTimers[tracker_id]; if (t && !t.segment_started_at) t.segment_started_at = nowIso(); });
}
export function discardExtraTimer(tracker_id: string) { setState(s => { delete s.extraTimers[tracker_id]; }); }
/** Stop and save as an entry: starts when the timer started, lasts the timed (un-paused) seconds. */
export function stopExtraTimer(tracker_id: string, notes: string | null = null) {
  const t = state.extraTimers[tracker_id]; if (!t) return null;
  const secs = Math.max(1, Math.round(extraTimerSeconds(t)));
  const id = upsertEntry('extras', { baby_id: t.baby_id, tracker_id, datetime: t.started_at, duration_seconds: secs, value_num: null, level: null, notes });
  discardExtraTimer(tracker_id);
  return { id, secs };
}

// ---------------- Repair: babies that never reached the server ----------------
const ENTRY_TABLES = ['feeds', 'poos', 'sleeps', 'growth', 'extras'] as const;
function orderOutbox(s: State) {
  const rank: Record<string, number> = { babies: 0, access: 1, trackers: 2 };
  s.outbox.sort((a, b) => (rank[a.table] ?? 3) - (rank[b.table] ?? 3));
}
/** Move everything recorded under `from` (a local-only duplicate) onto `to` (the copy on the server), then remove `from`. */
export function mergeBabyInto(from: string, to: string) {
  setState(s => {
    const t = nowIso(); const src = s.babies[from], dst = s.babies[to]; if (!src || !dst) return;
    // profile details the server copy lacks
    let babyChanged = false;
    for (const k of ['wet_tracking', 'birth_weight_grams', 'birth_length_mm', 'birth_head_circumference_mm', 'gestational_age_weeks', 'gestational_age_days', 'time_of_birth', 'photograph_url'] as const) {
      if ((dst as any)[k] == null || (dst as any)[k] === false) { if ((src as any)[k] != null && (src as any)[k] !== false) { (dst as any)[k] = (src as any)[k]; babyChanged = true; } }
    }
    if (babyChanged) { dst.updated_at = t; queue(s, 'babies', dst); }
    // trackers: same name + kind → the existing one; otherwise move it over
    const existing = Object.values(s.trackers).filter(x => x.baby_id === to && !x.deleted_at);
    const map = new Map<string, string>();
    for (const tr of Object.values(s.trackers).filter(x => x.baby_id === from)) {
      const m = existing.find(x => x.name.trim().toLowerCase() === tr.name.trim().toLowerCase() && x.kind === tr.kind);
      if (m) { map.set(tr.tracker_id, m.tracker_id); if (tr.enabled && !m.enabled) { m.enabled = true; m.updated_at = t; queue(s, 'trackers', m); } delete s.trackers[tr.tracker_id]; }
      else { tr.baby_id = to; tr.updated_at = t; if (!tr.deleted_at) queue(s, 'trackers', tr); }
    }
    const hasActiveSleep = Object.values(s.sleeps).some(x => x.baby_id === to && !x.deleted_at && x.status !== 'completed');
    for (const tb of ENTRY_TABLES) for (const r of Object.values(s[tb] as Record<string, any>)) {
      if (r.baby_id !== from) continue;
      if (tb === 'sleeps' && r.status !== 'completed' && hasActiveSleep) { delete (s.sleeps as any)[r.sleep_id]; continue; } // only one running sleep timer per baby
      r.baby_id = to; if (tb === 'extras' && map.has(r.tracker_id)) r.tracker_id = map.get(r.tracker_id); r.updated_at = t;
      if (!r.deleted_at) queue(s, tb, r);
    }
    if (s.feedTimers[from] && !s.feedTimers[to]) s.feedTimers[to] = { ...s.feedTimers[from], baby_id: to };
    delete s.feedTimers[from];
    for (const [k, et] of Object.entries(s.extraTimers ?? {})) if (et.baby_id === from) { delete s.extraTimers[k]; const nk = map.get(k) ?? k; if (!s.extraTimers[nk]) s.extraTimers[nk] = { ...et, baby_id: to, tracker_id: nk }; }
    for (const a of Object.values(s.access)) if (a.baby_id === from) delete s.access[a.access_id];
    for (const [u, b] of Object.entries(s.selectedBaby)) if (b === from) s.selectedBaby[u] = to;
    for (const k of Object.keys(s.chats)) if (k.endsWith(':' + from)) { const nk = k.slice(0, -from.length) + to; s.chats[nk] = [...(s.chats[nk] || []), ...s.chats[k]]; delete s.chats[k]; }
    // drop queued ops for the removed copy
    s.outbox = s.outbox.filter(o => !(o.table === 'babies' && o.row.baby_id === from) && !(o.table === 'access' && o.row.baby_id === from));
    s.syncFailed = (s.syncFailed || []).filter(o => o.row.baby_id !== from);
    delete s.babies[from];
    s.audit.push({ at: t, user_id: session?.user_id ?? '', action: 'baby.merged_local_duplicate', detail: `${from} -> ${to}` });
    orderOutbox(s);
  });
}
/** Upload a baby (and everything recorded for it) that never reached the server. Idempotent: same ids. */
export function requeueBaby(baby_id: string) {
  setState(s => {
    const b = s.babies[baby_id]; if (!b) return;
    queue(s, 'babies', b);
    for (const tb of ['trackers', ...ENTRY_TABLES] as const) for (const r of Object.values(s[tb] as Record<string, any>)) if (r.baby_id === baby_id) queue(s, tb, r);
    orderOutbox(s);
  });
}
