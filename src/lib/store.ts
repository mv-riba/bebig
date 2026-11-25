// Local-first data store.
// - Every write goes to local state immediately (instant feedback, works offline) and is appended to an outbox.
// - A SyncBackend (see sync.ts) drains the outbox to the server and applies remote changes.
// - Client-generated UUIDs + idempotent upserts prevent duplicate entries when an op is retried.
// - Concurrent edits resolve last-write-wins on updated_at (row-level), with created_by/updated_by kept for audit.
// - In local mode, tabs on the same device sync via BroadcastChannel, which also demonstrates shared access.

import { useSyncExternalStore, useRef } from 'react';
import type {
  User, BabyProfile, BabyAccess, FeedingEntry, PooEntry, SleepEntry, GrowthMeasurement, FeedTimer, RunningTimer, UserPrefs, Role, TrackerDef, ExtraEntry,
} from './types';
import type { PlusStatus } from './plans';
import { formatTime } from './time';

export type Table = 'feeds' | 'poos' | 'sleeps' | 'growth' | 'babies' | 'access' | 'trackers' | 'extras' | 'timers';
/** A timer tap (sleep, breastfeeding or extras), sent to the server as an action (applied in order, first Stop
 *  wins) rather than as the whole row. `side` is for switching breast side, `entry_id` is the entry a Stop saves. */
export type SleepActionKind = 'start' | 'stop' | 'pause' | 'resume' | 'discard';
export type TimerActionKind = SleepActionKind | 'side';
export interface SleepAction { kind: TimerActionKind; at: string; side?: 'left' | 'right' | null; entry_id?: string }
export type TimerAction = SleepAction;
export interface OutboxOp { op_id: string; table: Table; row: any; queued_at: string; action?: SleepAction }
export interface AuditEvent { at: string; user_id: string; action: string; detail?: string }
interface LocalCredential { user_id: string; salt: string; hash: string }

export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; created_at: string; kind?: 'fact' | 'estimate' | 'safety' | 'info' | 'plus' }

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
  timers: Record<string, RunningTimer>; // breastfeeding and extras timers by timer_id, shared with the other caregivers
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
    growth: {}, trackers: {}, extras: {}, timers: {}, prefs: {}, selectedBaby: {}, chats: {}, outbox: [], syncFailed: [], audit: [], lastSyncedAt: null, plus: {}, paused: [],
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = { ...empty(), ...JSON.parse(raw) }; s.trackers ??= {}; s.extras ??= {}; s.timers ??= {}; s.syncFailed ??= []; s.plus ??= {}; s.paused ??= []; adoptDeviceTimers(s); return s; }
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
  register(email: string, password: string, display_name: string, captchaToken?: string): Promise<{ user_id: string; email: string; display_name: string }>;
  signIn(email: string, password: string, captchaToken?: string): Promise<{ user_id: string; email: string; display_name: string }>;
  reset(email: string, captchaToken?: string): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
  updateName(name: string): Promise<void>;
  leaveBaby(baby_id: string): Promise<void>;
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
      Object.values(s.timers).forEach(fix);
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

export async function register(email: string, password: string, display_name: string, captchaToken?: string) {
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters, include upper and lower case letters, a number, and a symbol.');
  if (remote) return adoptRemoteUser(await remote.register(email, password, display_name.trim(), captchaToken));
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

export async function signIn(email: string, password: string, captchaToken?: string) {
  email = email.trim().toLowerCase();
  if (remote) return adoptRemoteUser(await remote.signIn(email, password, captchaToken));
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

export async function resetPassword(email: string, newPassword: string, captchaToken?: string) {
  email = email.trim().toLowerCase();
  if (remote) return remote.reset(email, captchaToken);
  const c = state.credentials[email];
  if (!c) return; // never reveal whether an account exists
  if (newPassword.length < 8) throw new Error('Password must be at least 8 characters, include upper and lower case letters, a number, and a symbol.');
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

function queue(s: State, table: Table, row: any, action?: SleepAction) {
  s.outbox.push({ op_id: uuid(), table, row: structuredClone(row), queued_at: nowIso(), ...(action ? { action } : {}) });
}

// ---------------- Notices (messages from sync for the person using the app, shown as toasts) ----------------
export interface Notice { text: string; action?: { label: string; run: () => void } }
const noticeListeners = new Set<(n: Notice) => void>();
export function onNotice(fn: (n: Notice) => void) { noticeListeners.add(fn); return () => { noticeListeners.delete(fn); }; }
const notify = (n: Notice) => noticeListeners.forEach(l => l(n));

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
    delete s.babies[baby_id]; delete s.plus[baby_id];
    for (const [k, tm] of Object.entries(s.timers)) if (tm.baby_id === baby_id) delete s.timers[k];
    Object.keys(s.chats).forEach(k => { if (k.endsWith(':' + baby_id)) delete s.chats[k]; });
    // changes still waiting for this baby would only be refused after the delete (and retried forever)
    s.outbox = s.outbox.filter(o => o.row.baby_id !== baby_id);
    s.syncFailed = (s.syncFailed || []).filter(o => o.row.baby_id !== baby_id);
    queue(s, 'babies', { baby_id, deleted_at: nowIso() });
    s.audit.push({ at: nowIso(), user_id: uid, action: 'baby.deleted', detail: baby_id });
  });
}

/** Remove this device's copy of a baby the signed-in user can no longer see (left, revoked, paused or deleted).
 *  Used after leaving and by the sync pull. Other people's data on the server is untouched. */
export function forgetBabyLocally(s: State, baby_id: string, me: string | null) {
  delete s.babies[baby_id]; delete s.plus[baby_id];
  for (const t of ['feeds', 'poos', 'sleeps', 'growth', 'trackers', 'extras', 'timers'] as const) for (const [k, v] of Object.entries(s[t] as any)) if ((v as any).baby_id === baby_id) delete (s[t] as any)[k];
  for (const a of Object.values(s.access)) if (a.baby_id === baby_id && a.user_id === me) delete s.access[a.access_id];
  for (const [u, b] of Object.entries(s.selectedBaby)) if (b === baby_id) delete s.selectedBaby[u];
}

// ---------------- Sharing ----------------

/** A caregiver ends their own access. What they logged stays with the baby. */
export async function leaveBaby(baby_id: string) {
  const uid = currentUserId(); if (!uid) return;
  if (roleFor(baby_id) !== 'caregiver') throw new Error('Only caregivers can leave a profile. The owner can delete it instead.');
  if (remote) {
    await remote.leaveBaby(baby_id); // server first: if it fails, nothing changes on this device
    setState(s => {
      s.outbox = s.outbox.filter(o => o.row.baby_id !== baby_id);
      s.syncFailed = (s.syncFailed || []).filter(o => o.row.baby_id !== baby_id);
      forgetBabyLocally(s, baby_id, uid);
      s.audit.push({ at: nowIso(), user_id: uid, action: 'access.left', detail: baby_id });
    });
    return;
  }
  // local mode: other people on this device still use the records, so only the membership ends
  setState(s => {
    const a = Object.values(s.access).find(x => x.baby_id === baby_id && x.user_id === uid && x.invitation_status === 'accepted');
    if (!a) return;
    a.invitation_status = 'revoked'; a.updated_at = nowIso();
    if (a.keeps_free_access) { a.keeps_free_access = false; refillFreeSlot(s, baby_id); }
    if (s.selectedBaby[uid] === baby_id) delete s.selectedBaby[uid];
    s.audit.push({ at: nowIso(), user_id: uid, action: 'access.left', detail: baby_id });
  });
}

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

export function upsertEntry<K extends Kind>(table: K, row: any, action?: SleepAction): string {
  assertAccess(row.baby_id);
  const uid = currentUserId()!; const t = nowIso();
  const idf = idField[table];
  const id = row[idf] || uuid();
  setState(s => {
    const prev = (s[table] as any)[id];
    const next = { ...prev, ...row, [idf]: id, updated_by: uid, updated_at: t, created_by: prev?.created_by ?? uid, created_at: prev?.created_at ?? t };
    (s[table] as any)[id] = next;
    queue(s, table, next, action);
  });
  return id;
}
export function deleteEntry(table: Kind, id: string) {
  const row = (state[table] as any)[id]; if (!row) return;
  assertAccess(row.baby_id);
  // a deleted tracker's running timer would keep running out of sight (and block that tracker on every phone)
  if (table === 'trackers') discardExtraTimer(id);
  setState(s => {
    const x = (s[table] as any)[id];
    x.deleted_at = nowIso(); x.updated_at = x.deleted_at; x.updated_by = currentUserId();
    queue(s, table, x);
  });
}
export function restoreEntry(table: Kind, id: string) {
  const row = (state[table] as any)[id]; if (!row) return;
  assertAccess(row.baby_id);
  // updated_by must be the person restoring it: the server refuses changes attributed to someone else
  setState(s => { const x = (s[table] as any)[id]; if (x) { x.deleted_at = null; x.updated_at = nowIso(); x.updated_by = currentUserId(); queue(s, table, x); } });
}

export const live = <T extends { deleted_at?: string | null; baby_id: string }>(rec: Record<string, T>, baby_id: string) =>
  Object.values(rec).filter(r => r.baby_id === baby_id && !r.deleted_at);

// ---------------- Breastfeeding and extras timers (shared with the other caregivers) ----------------
// A running timer is a row in s.timers that every caregiver of the baby sees. Each tap changes this device's copy
// straight away and is queued as an action; the server applies the actions in order (same rules as the sleep timer:
// the first Stop wins, a finished timer can't be reopened) and its answer is taken by applyTimerResult().

/** The running timer for this slot (breastfeeding: one per baby; extras: one per tracker), if any. */
export function runningTimer(s: State, baby_id: string, kind: RunningTimer['kind'], tracker_id: string | null = null): RunningTimer | null {
  return Object.values(s.timers).find(t => t.baby_id === baby_id && t.kind === kind && !t.ended_at && (kind === 'feed' || t.tracker_id === tracker_id)) ?? null;
}
export const feedTimerOf = (baby_id: string, s: State = state): FeedTimer | null => runningTimer(s, baby_id, 'feed');
/** Running extras timers by tracker_id. */
export function extraTimersOf(s: State = state): Record<string, RunningTimer> {
  const o: Record<string, RunningTimer> = {};
  for (const t of Object.values(s.timers)) if (t.kind === 'extra' && !t.ended_at && t.tracker_id) o[t.tracker_id] = t;
  return o;
}
/** Who started a timer, when it wasn't the person using the app (shown on the timer). */
export function timerStartedBy(t: RunningTimer, s: State = state): string | null {
  if (!t.created_by || t.created_by === currentUserId()) return null;
  return s.users[t.created_by]?.display_name || 'Another caregiver';
}

/** The running stretch ends at `at`: its seconds go to the current side. */
function closeSegment(t: RunningTimer, at = Date.now()) {
  if (!t.segment_started_at) return;
  const secs = Math.max(0, (at - new Date(t.segment_started_at).getTime()) / 1000);
  if (t.side === 'left') t.left_seconds += secs; else if (t.side === 'right') t.right_seconds += secs; else t.unsided_seconds += secs;
  t.segment_started_at = null;
}
/** The earliest moment a running timer can have ended without dropping time it already counted. */
export function earliestTimerEnd(t: RunningTimer): number {
  return t.segment_started_at ? Date.parse(t.segment_started_at) : Date.parse(t.started_at) + (t.left_seconds + t.right_seconds + t.unsided_seconds) * 1000;
}
export function feedTimerTotals(ft: RunningTimer, now = Date.now()) {
  let { left_seconds: l, right_seconds: r, unsided_seconds: u } = ft;
  if (ft.segment_started_at) {
    const secs = Math.max(0, (now - new Date(ft.segment_started_at).getTime()) / 1000);
    if (ft.side === 'left') l += secs; else if (ft.side === 'right') r += secs; else u += secs;
  }
  return { left: l, right: r, unsided: u, total: l + r + u };
}

// (uid is passed while the app is still loading, before the session is known)
function newTimer(baby_id: string, kind: RunningTimer['kind'], tracker_id: string | null, side: 'left' | 'right' | null, t: string, uid: string | null = currentUserId()): RunningTimer {
  return { timer_id: uuid(), baby_id, kind, tracker_id: kind === 'extra' ? tracker_id : null, started_at: t, side: kind === 'feed' ? side : null,
    left_seconds: 0, right_seconds: 0, unsided_seconds: 0, segment_started_at: t, ended_at: null, end_kind: null, entry_id: null,
    created_by: uid, updated_by: uid, created_at: t, updated_at: t };
}
/** Puts a timer this device has (but the server doesn't) on the server: a start at its start time, then a pause if paused. */
function requeueTimer(s: State, tm: RunningTimer) {
  const row: RunningTimer = { ...tm, timer_id: uuid(), updated_at: nowIso() }; delete row.server_updated_at;
  s.timers[row.timer_id] = row;
  queue(s, 'timers', row, { kind: 'start', at: row.started_at, side: row.side });
  if (!row.segment_started_at) queue(s, 'timers', row, { kind: 'pause', at: nowIso() });
}
/** Timers saved on this device by an older version of the app (before they were shared) become shared timers. */
function adoptDeviceTimers(s: any) {
  for (const ft of Object.values(s.feedTimers ?? {}) as any[]) {
    if (runningTimer(s, ft.baby_id, 'feed')) continue;
    requeueTimer(s, { ...newTimer(ft.baby_id, 'feed', null, ft.side ?? null, ft.started_at, ft.created_by ?? null), left_seconds: ft.left_seconds || 0, right_seconds: ft.right_seconds || 0,
      unsided_seconds: ft.unsided_seconds || 0, segment_started_at: ft.segment_started_at ?? null, created_by: ft.created_by ?? null, updated_by: ft.created_by ?? null });
  }
  for (const et of Object.values(s.extraTimers ?? {}) as any[]) {
    if (runningTimer(s, et.baby_id, 'extra', et.tracker_id)) continue;
    requeueTimer(s, { ...newTimer(et.baby_id, 'extra', et.tracker_id, null, et.started_at, null), unsided_seconds: et.acc_seconds || 0,
      segment_started_at: et.segment_started_at ?? null, created_by: null, updated_by: null });
  }
  delete s.feedTimers; delete s.extraTimers;
}

/** Applies a tap to this device's copy of the timer and queues it for the server. Does nothing if the timer
 *  has already finished here (the screen may be a moment behind another caregiver). */
function timerTap(timer_id: string | undefined, kind: TimerActionKind, change: (t: RunningTimer, at: string) => boolean | void, extra: Partial<SleepAction> = {}, atIso?: string) {
  const cur = timer_id ? state.timers[timer_id] : null;
  if (!cur || cur.ended_at) return false;
  let done = false;
  setState(s => {
    const t = s.timers[cur.timer_id]; const at = atIso ?? nowIso();
    if (change(t, at) === false) return;
    t.updated_by = currentUserId(); t.updated_at = at;
    queue(s, 'timers', t, { kind, at, ...extra });
    done = true;
  });
  return done;
}
function startTimer(baby_id: string, kind: RunningTimer['kind'], tracker_id: string | null, side: 'left' | 'right' | null) {
  assertAccess(baby_id);
  const running = runningTimer(state, baby_id, kind, tracker_id);
  if (running) return running.timer_id; // already running (perhaps started by another caregiver)
  const t = nowIso(); const row = newTimer(baby_id, kind, tracker_id, side, t);
  setState(s => { s.timers[row.timer_id] = row; queue(s, 'timers', row, { kind: 'start', at: t, side: row.side }); });
  return row.timer_id;
}
const pauseTimer = (id?: string) => timerTap(id, 'pause', (t, at) => { if (!t.segment_started_at) return false; closeSegment(t, Date.parse(at)); });
const resumeTimer = (id?: string) => timerTap(id, 'resume', (t, at) => { if (t.segment_started_at) return false; t.segment_started_at = at; });
const discardTimer = (id?: string) => timerTap(id, 'discard', (t, at) => { closeSegment(t, Date.parse(at)); t.ended_at = at; t.end_kind = 'discarded'; });
/** Stops a timer and saves its entry. Queued as one Stop (with the entry's id) followed by the entry itself, so if
 *  another caregiver's Stop reached the server first, this entry is dropped instead of saving the same feed twice. */
/** `endAt`: when it really ended ("Finished earlier"); default now. */
function stopTimer(id: string, table: 'feeds' | 'extras', entry: any, endAt?: string): string | null {
  const entry_id = uuid();
  const ok = timerTap(id, 'stop', (t, at) => { closeSegment(t, Date.parse(at)); t.ended_at = at; t.end_kind = 'saved'; t.entry_id = entry_id; }, { entry_id }, endAt);
  if (!ok) return null;
  return upsertEntry(table, { ...entry, [idField[table]]: entry_id });
}

export function startFeedTimer(baby_id: string, side: 'left' | 'right' | null) { return startTimer(baby_id, 'feed', null, side); }
export function pauseFeedTimer(baby_id: string) { pauseTimer(feedTimerOf(baby_id)?.timer_id); }
export function resumeFeedTimer(baby_id: string) { resumeTimer(feedTimerOf(baby_id)?.timer_id); }
export function switchFeedSide(baby_id: string, side: 'left' | 'right' | null) {
  timerTap(feedTimerOf(baby_id)?.timer_id, 'side', (t, at) => {
    if (t.side === side) return false;
    const running = !!t.segment_started_at; closeSegment(t, Date.parse(at)); t.side = side; if (running) t.segment_started_at = at;
  }, { side });
}
export function discardFeedTimer(baby_id: string) { discardTimer(feedTimerOf(baby_id)?.timer_id); }
/** Stops the breastfeeding timer and saves the feed. Null if the timer had already finished on this device. */
export function stopFeedTimer(baby_id: string, feed: Partial<FeedingEntry>, endAt?: string) {
  const t = feedTimerOf(baby_id); return t ? stopTimer(t.timer_id, 'feeds', feed, endAt) : null;
}

// ---------------- Sleep timer (persisted as an active SleepEntry) ----------------

export function activeSleep(baby_id: string, s: State = state): SleepEntry | null {
  return Object.values(s.sleeps).find(x => x.baby_id === baby_id && !x.deleted_at && x.status !== 'completed') ?? null;
}
export function startSleep(baby_id: string) {
  if (activeSleep(baby_id)) throw new Error('A sleep session is already running.');
  const t = nowIso();
  return upsertEntry('sleeps', { baby_id, start_datetime: t, status: 'active', pauses: [], end_datetime: null, duration_seconds: null }, { kind: 'start', at: t });
}
export function sleepElapsed(e: SleepEntry, now = Date.now()) {
  const end = e.end_datetime ? new Date(e.end_datetime).getTime() : now;
  let paused = 0;
  for (const p of e.pauses || []) paused += ((p.end ? new Date(p.end).getTime() : Math.min(now, end)) - new Date(p.start).getTime());
  return Math.max(0, (end - new Date(e.start_datetime).getTime() - paused) / 1000);
}
// Timer taps act on the sleep as it is on this device now (another caregiver may have changed it since the
// screen was drawn). The server applies the same action to its copy and has the final say.
const current = (e: SleepEntry) => state.sleeps[e.sleep_id] ?? e;
export function pauseSleep(e: SleepEntry) {
  e = current(e); if (e.status !== 'active' || e.deleted_at) return;
  const t = nowIso();
  upsertEntry('sleeps', { ...e, status: 'paused', pauses: [...(e.pauses || []), { start: t, end: null }] }, { kind: 'pause', at: t });
}
export function resumeSleep(e: SleepEntry) {
  e = current(e); if (e.status !== 'paused' || e.deleted_at) return;
  const t = nowIso();
  const pauses = (e.pauses || []).map(p => p.end ? p : { ...p, end: t });
  upsertEntry('sleeps', { ...e, status: 'active', pauses }, { kind: 'resume', at: t });
}
/** Ends a sleep at `at`: open pauses close then, pauses after it are dropped. */
function endedAt(e: SleepEntry, at: string): SleepEntry {
  const pauses = (e.pauses || []).filter(p => new Date(p.start) < new Date(at)).map(p => !p.end || new Date(p.end) > new Date(at) ? { ...p, end: at } : p);
  const done = { ...e, end_datetime: at, pauses, status: 'completed' as const };
  done.duration_seconds = Math.round(sleepElapsed(done));
  return done;
}
/** A sleep timer can't run past 24 hours: after that it can only be discarded and entered by hand. */
export const SLEEP_TIMER_MAX_MS = 24 * 3600000;
export const sleepTimerTooLong = (e: SleepEntry, now = Date.now()) => !e.end_datetime && now - new Date(e.start_datetime).getTime() > SLEEP_TIMER_MAX_MS;
/** `endAt`: when baby really woke ("Woke up earlier"); default now. */
export function stopSleep(e: SleepEntry, endAt?: string) {
  e = current(e); if (e.status === 'completed' || e.deleted_at) return e;
  const t = endAt ?? nowIso();
  if (Date.parse(t) - Date.parse(e.start_datetime) > SLEEP_TIMER_MAX_MS) throw new Error('This sleep timer has run for more than 24 hours. Enter the real times instead.');
  if (endAt && Date.parse(endAt) <= Date.parse(e.start_datetime)) throw new Error('Wake-up time must be after the sleep started.');
  if (endAt && Date.parse(endAt) > Date.now() + 60000) throw new Error('Wake-up time can’t be in the future.');
  const done = endedAt(e, t);
  upsertEntry('sleeps', done, { kind: 'stop', at: t });
  return done;
}
/** Throws away a running timer. Never deletes a sleep another caregiver has already saved. */
export function discardSleep(e: SleepEntry) {
  e = current(e); if (e.status === 'completed' || e.deleted_at) return;
  const t = nowIso();
  upsertEntry('sleeps', { ...e, deleted_at: t }, { kind: 'discard', at: t });
}

export interface SleepResult { outcome: 'started' | 'joined' | 'stopped' | 'already_stopped' | 'paused' | 'resumed' | 'not_running' | 'discarded'; row: any }
const asSleep = (r: any): SleepEntry => ({ ...r, pauses: typeof r.pauses === 'string' ? JSON.parse(r.pauses) : (r.pauses || []) });
/** The server's answer to a sleep-timer action: take its copy of the sleep, and tell the person if another caregiver got there first. */
export function applySleepResult(op: OutboxOp, res: SleepResult) {
  const me = currentUserId(); const row = asSleep(res.row); const mine = op.row.sleep_id as string;
  const conflict = res.outcome === 'already_stopped' || res.outcome === 'not_running';
  setState(s => {
    s.outbox = s.outbox.filter(o => o.op_id !== op.op_id);
    if (row.sleep_id !== mine) {
      // joined another caregiver's timer: what this device did to its own timer now applies to theirs
      delete s.sleeps[mine];
      for (const o of [...s.outbox, ...(s.syncFailed || [])]) if (o.table === 'sleeps' && o.row.sleep_id === mine) o.row = { ...o.row, sleep_id: row.sleep_id, start_datetime: row.start_datetime, created_by: row.created_by };
    }
    // a later tap still waiting to be sent would be refused too (and announced twice)
    if (conflict) s.outbox = s.outbox.filter(o => !(o.table === 'sleeps' && o.action && o.row.sleep_id === row.sleep_id));
    const waiting = s.outbox.some(o => o.table === 'sleeps' && o.row.sleep_id === row.sleep_id);
    // with more taps waiting, this device's copy is already ahead of the server's
    if (!waiting || conflict || row.sleep_id !== mine) s.sleeps[row.sleep_id] = row;
  }, false);
  const n = sleepNotice(op, res.outcome, row, me);
  if (n) notify(n);
}
function sleepNotice(op: OutboxOp, outcome: SleepResult['outcome'], row: SleepEntry, me: string | null): Notice | null {
  const by = row.updated_by && row.updated_by !== me ? (state.users[row.updated_by]?.display_name || 'Another caregiver') : null;
  const baby = state.babies[row.baby_id]; const tz = baby?.timezone || 'UTC'; const fmt = myPrefs().time_format;
  const at = (iso: string) => formatTime(iso, tz, fmt);
  if (outcome === 'joined') {
    if (row.created_by === me) return null; // our own timer from another device
    const who = state.users[row.created_by!]?.display_name || 'Another caregiver';
    const keptMine = op.action && Math.abs(new Date(op.action.at).getTime() - new Date(row.start_datetime).getTime()) < 1000;
    return { text: keptMine
      ? `${who} had also started a sleep timer, so they’re now one sleep, from your start at ${at(row.start_datetime)}.`
      : `${who} already started this sleep at ${at(row.start_datetime)}, so you’re both timing the same one.` };
  }
  if (!by) return null; // our own earlier tap (a retry or a double tap): nothing to tell
  if (outcome === 'already_stopped' && op.action?.kind === 'stop' && row.end_datetime) {
    const mineAt = op.action.at;
    const useMine = Math.abs(new Date(mineAt).getTime() - new Date(row.end_datetime).getTime()) >= 60000 && new Date(mineAt) > new Date(row.start_datetime);
    return {
      text: `${by} already stopped this sleep at ${at(row.end_datetime)}.`,
      action: useMine ? { label: `Use ${at(mineAt)}`, run: () => { const cur = state.sleeps[row.sleep_id]; if (cur && cur.status === 'completed' && !cur.deleted_at) upsertEntry('sleeps', endedAt(cur, mineAt)); } } : undefined,
    };
  }
  if (outcome === 'not_running') {
    if (row.deleted_at) return { text: `${by} discarded this sleep timer.` };
    if (row.end_datetime) return { text: op.action?.kind === 'discard' ? `${by} already saved this sleep (ended ${at(row.end_datetime)}), so it was kept.` : `${by} already stopped this sleep at ${at(row.end_datetime)}.` };
  }
  return null;
}

export interface TimerResult { outcome: 'started' | 'joined' | 'paused' | 'resumed' | 'side' | 'stopped' | 'already_stopped' | 'not_running' | 'discarded'; row: any }
const asTimer = (r: any): RunningTimer => ({ ...r, left_seconds: Number(r.left_seconds) || 0, right_seconds: Number(r.right_seconds) || 0, unsided_seconds: Number(r.unsided_seconds) || 0 });
/** The server's answer to a breastfeeding / extras timer action: take its copy of the timer, and tell the person
 *  if another caregiver got there first. When someone else's Stop won, the entry this device made is dropped. */
export function applyTimerResult(op: OutboxOp, res: TimerResult) {
  const me = currentUserId(); const row = asTimer(res.row); const mine = op.row.timer_id as string;
  const conflict = res.outcome === 'already_stopped' || res.outcome === 'not_running';
  const myEntry = op.action?.kind === 'stop' && conflict ? op.action.entry_id : undefined;
  const entryTable = row.kind === 'feed' ? 'feeds' : 'extras';
  let entryOnServer = false;
  setState(s => {
    s.outbox = s.outbox.filter(o => o.op_id !== op.op_id);
    if (row.timer_id !== mine) {
      // joined another caregiver's timer: what this device did to its own timer now applies to theirs
      delete s.timers[mine];
      for (const o of [...s.outbox, ...(s.syncFailed || [])]) if (o.table === 'timers' && o.row.timer_id === mine) o.row = { ...o.row, timer_id: row.timer_id };
    }
    if (conflict) s.outbox = s.outbox.filter(o => !(o.table === 'timers' && o.row.timer_id === row.timer_id));
    if (myEntry) {
      // another caregiver saved this timer first: this device's copy of the entry isn't saved too
      const idf = idField[entryTable]; const e = (s[entryTable] as Record<string, any>)[myEntry];
      entryOnServer = !!e?.server_updated_at;
      if (!entryOnServer) {
        delete (s[entryTable] as Record<string, any>)[myEntry];
        s.outbox = s.outbox.filter(o => !(o.table === entryTable && o.row[idf] === myEntry));
        s.syncFailed = (s.syncFailed || []).filter(o => !(o.table === entryTable && o.row[idf] === myEntry));
      }
    }
    const waiting = s.outbox.some(o => o.table === 'timers' && o.row.timer_id === row.timer_id);
    if (!waiting || conflict || row.timer_id !== mine) s.timers[row.timer_id] = row;
  }, false);
  if (myEntry && entryOnServer) deleteEntry(entryTable, myEntry); // it had already reached the server (a late retry)
  const n = timerNotice(op, res.outcome, row, me);
  if (n) notify(n);
}
function timerNotice(op: OutboxOp, outcome: TimerResult['outcome'], row: RunningTimer, me: string | null): Notice | null {
  const name = (u: string | null) => (u && state.users[u]?.display_name) || 'Another caregiver';
  const what = row.kind === 'feed' ? 'breastfeeding timer' : `${state.trackers[row.tracker_id!]?.name ?? 'extras'} timer`;
  const tz = state.babies[row.baby_id]?.timezone || 'UTC'; const at = (iso: string) => formatTime(iso, tz, myPrefs().time_format);
  if (outcome === 'joined' && row.created_by !== me) return { text: `${name(row.created_by)} already started the ${what} at ${at(row.started_at)}, so you’re both timing the same one.` };
  if (!conflict(outcome) || row.updated_by === me) return null; // our own earlier tap (a retry or a double tap)
  const by = name(row.updated_by);
  if (row.end_kind === 'discarded') return { text: `${by} discarded the ${what}.` };
  if (row.end_kind === 'saved' && row.ended_at) {
    const thing = row.kind === 'feed' ? 'this feed' : `this ${state.trackers[row.tracker_id!]?.name ?? 'entry'}`;
    if (op.action?.kind === 'stop') return { text: `${by} already saved ${thing} at ${at(row.ended_at)}, so it wasn’t saved twice.` };
    if (op.action?.kind === 'discard') return { text: `${by} already saved ${thing} at ${at(row.ended_at)}, so it was kept.` };
    return { text: `${by} already stopped the ${what} at ${at(row.ended_at)}.` };
  }
  return null;
}
const conflict = (o: TimerResult['outcome']) => o === 'already_stopped' || o === 'not_running';

/** Finished timers are only kept for a couple of days (to explain a late conflict), then dropped from this device. */
export function pruneFinishedTimers(s: State) {
  const pending = new Set([...s.outbox, ...(s.syncFailed || [])].filter(o => o.table === 'timers').map(o => o.row.timer_id));
  const cutoff = Date.now() - 2 * 86400000;
  for (const [k, t] of Object.entries(s.timers)) if (t.ended_at && Date.parse(t.ended_at) < cutoff && !pending.has(k)) delete s.timers[k];
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
  setState(s => {
    // Retry with the row as it is now on this device, once per row, and skip rows that already have a newer change
    // waiting: replaying the old copy would overwrite later edits on the server (upserts are last-push-wins).
    const ID: Record<Table, string> = { babies: 'baby_id', access: 'access_id', feeds: 'feed_id', poos: 'poo_id', sleeps: 'sleep_id', growth: 'measurement_id', trackers: 'tracker_id', extras: 'extra_id', timers: 'timer_id' };
    // Timer actions are retried as they were (each is one tap, applied in order by the server).
    const key = (o: OutboxOp) => `${o.table}:${o.row[ID[o.table]]}`;
    const waiting = new Set(s.outbox.filter(o => !o.action).map(key));
    const retry: OutboxOp[] = [];
    for (const { error, failed_at, ...op } of (s.syncFailed || []).slice().reverse()) {
      if (op.action) { retry.unshift(op); continue; }
      const k = key(op); if (waiting.has(k)) continue; waiting.add(k);
      const current = (s[op.table] as Record<string, any>)[op.row[ID[op.table]]];
      retry.unshift(current && !(op.table === 'babies' && op.row.deleted_at) ? { ...op, row: structuredClone(current) } : op);
    }
    s.outbox = [...retry, ...s.outbox]; s.syncFailed = []; orderOutbox(s);
  }, false);
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

// ---------------- Timers for "How long" extra trackers (shared, see above) ----------------
export type ExtraTimer = RunningTimer;
export function extraTimerSeconds(t: RunningTimer, now = Date.now()) {
  return t.unsided_seconds + (t.segment_started_at ? Math.max(0, (now - new Date(t.segment_started_at).getTime()) / 1000) : 0);
}
export function startExtraTimer(baby_id: string, tracker_id: string) { return startTimer(baby_id, 'extra', tracker_id, null); }
export function pauseExtraTimer(tracker_id: string) { pauseTimer(extraTimersOf()[tracker_id]?.timer_id); }
export function resumeExtraTimer(tracker_id: string) { resumeTimer(extraTimersOf()[tracker_id]?.timer_id); }
export function discardExtraTimer(tracker_id: string) { discardTimer(extraTimersOf()[tracker_id]?.timer_id); }
/** Stop and save as an entry: starts when the timer started, lasts the timed (un-paused) seconds. */
export function stopExtraTimer(tracker_id: string, notes: string | null = null) {
  const t = extraTimersOf()[tracker_id]; if (!t) return null;
  const secs = Math.max(1, Math.round(extraTimerSeconds(t)));
  if (secs > 24 * 3600) throw new Error('This timer ran for more than 24 hours. Discard it and enter the time manually.');
  const id = stopTimer(t.timer_id, 'extras', { baby_id: t.baby_id, tracker_id, datetime: t.started_at, duration_seconds: secs, value_num: null, level: null, notes });
  return id ? { id, secs } : null;
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
    // running timers move over as new timers (the old ones never reached the server), unless one is already running there
    s.outbox = s.outbox.filter(o => !(o.table === 'timers' && o.row.baby_id === from));
    for (const tm of Object.values(s.timers)) {
      if (tm.baby_id !== from) continue;
      delete s.timers[tm.timer_id];
      const tracker_id = tm.tracker_id ? (map.get(tm.tracker_id) ?? tm.tracker_id) : null;
      if (!tm.ended_at && !runningTimer(s, to, tm.kind, tracker_id)) requeueTimer(s, { ...tm, baby_id: to, tracker_id });
    }
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
