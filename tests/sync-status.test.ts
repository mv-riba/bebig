// Sync status on Home: which entries are waiting / refused, who else follows the baby, and when the copy is stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
Object.assign(globalThis as any, { localStorage: mem(), sessionStorage: mem(), BroadcastChannel: undefined });
const store = await import('../src/lib/store.ts');

await store.register('owner@x.fi', 'password1', 'Marija Riba');
const baby = store.createBaby({ name: 'Baby', date_of_birth: '2026-10-01', sex: 'female', timezone: 'Europe/Helsinki', feeding_preference: 'formula', photograph_url: null });

test('new entries are waiting until the server has them; refused ones are failed', () => {
  const id = store.upsertEntry('feeds', { baby_id: baby, feeding_type: 'formula', start_datetime: '2026-11-20T10:00:00Z', quantity_ml: 90, observations: [] });
  let u = store.unsyncedEntries();
  assert.ok(u.waiting.has(id)); assert.ok(!u.failed.has(id));
  store.setState(s => { const op = s.outbox.find(o => o.row.feed_id === id)!; s.outbox = s.outbox.filter(o => o !== op); s.syncFailed.push({ ...op, error: 'x', failed_at: new Date().toISOString() }); });
  u = store.unsyncedEntries();
  assert.ok(u.failed.has(id)); assert.ok(!u.waiting.has(id));
  store.setState(s => { s.syncFailed = []; });
  assert.ok(!store.unsyncedEntries().failed.has(id));
});

test('a finished timer counts as waiting for the entry it saves', () => {
  store.setState(s => { s.outbox.push({ op_id: 't1', table: 'timers', row: { timer_id: 'tm' }, queued_at: new Date().toISOString(), action: { kind: 'stop', at: new Date().toISOString(), entry_id: 'entry-from-timer' } as any }); });
  assert.ok(store.unsyncedEntries().waiting.has('entry-from-timer'));
});

test('other caregivers are named by first name, never the current user', () => {
  assert.equal(store.otherCaregiverNames(baby), '');
  store.setState(s => {
    s.users.u2 = { user_id: 'u2', email: 'c@x', display_name: 'Cristian Riba' } as any;
    s.users.u3 = { user_id: 'u3', email: 'a@x', display_name: 'Anna' } as any;
    s.access.a2 = { access_id: 'a2', baby_id: baby, user_id: 'u2', role: 'caregiver', invitation_status: 'accepted' } as any;
  });
  assert.equal(store.otherCaregiverNames(baby), 'Cristian');
  store.setState(s => { s.access.a3 = { access_id: 'a3', baby_id: baby, user_id: 'u3', role: 'caregiver', invitation_status: 'accepted' } as any; });
  assert.equal(store.otherCaregiverNames(baby), 'Cristian and Anna');
});

test('the copy is stale once a regular 15-second check has been missed', () => {
  const now = Date.now();
  store.setState(s => { s.lastSyncedAt = new Date(now - 15_000).toISOString(); });
  assert.equal(store.isStale(undefined, now), false);
  store.setState(s => { s.lastSyncedAt = new Date(now - 21_000).toISOString(); });
  assert.equal(store.isStale(undefined, now), true);
  store.setState(s => { s.lastSyncedAt = null; });
  assert.equal(store.isStale(undefined, now), true);
});
