// Local-first store: changes that sync must stay correct when they are undone, deleted or retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
Object.assign(globalThis as any, { localStorage: mem(), sessionStorage: mem(), BroadcastChannel: undefined });
const store = await import('../src/lib/store.ts');

await store.register('owner@x.fi', 'password1', 'Owner');
const owner = store.currentUserId()!;
const baby = store.createBaby({ name: 'Baby', date_of_birth: '2026-10-01', sex: 'female', timezone: 'Europe/Helsinki', feeding_preference: 'formula', photograph_url: null });
const feed = (ml: number, id?: string) => store.upsertEntry('feeds', { feed_id: id, baby_id: baby, feeding_type: 'formula', start_datetime: '2026-11-20T10:00:00Z', quantity_ml: ml, observations: [] });
const opsFor = (id: string) => store.getState().outbox.filter(o => o.row.feed_id === id);

test('undoing a delete is attributed to the person who undid it', async () => {
  const id = feed(90);
  store.inviteCaregiver(baby, 'cg@x.fi');
  const inv = Object.values(store.getState().access).find(a => a.invited_email === 'cg@x.fi')!;
  store.signOut();
  await store.register('cg@x.fi', 'password1', 'Caregiver');
  const cg = store.currentUserId()!;
  store.respondToInvite(inv.access_id, true);
  store.deleteEntry('feeds', id);
  store.signOut(); await store.signIn('owner@x.fi', 'password1');
  store.restoreEntry('feeds', id);
  const row = store.getState().feeds[id];
  assert.equal(row.deleted_at, null);
  assert.equal(row.updated_by, owner, 'server requires updated_by = the signed-in user');
  assert.notEqual(row.updated_by, cg);
});

test('retrying a rejected change sends the current row, and never an outdated copy over a newer queued one', () => {
  const id = feed(60);
  const oldOp = { ...opsFor(id)[0], row: { ...opsFor(id)[0].row } };
  // pretend the first upload was refused, then the feed was edited again
  store.setState(s => { s.outbox = s.outbox.filter(o => o.row.feed_id !== id); s.syncFailed = [{ ...oldOp, error: 'x', failed_at: '' }]; });
  feed(120, id);
  store.retryFailedSync();
  assert.equal(opsFor(id).length, 1, 'only the newer queued change is kept');
  assert.equal(opsFor(id)[0].row.quantity_ml, 120);

  // no newer change queued: the retry carries the row as it is now on the device
  store.setState(s => { s.outbox = s.outbox.filter(o => o.row.feed_id !== id); s.syncFailed = [{ ...oldOp, error: 'x', failed_at: '' }]; s.feeds[id].quantity_ml = 150; });
  store.retryFailedSync();
  assert.equal(opsFor(id).length, 1);
  assert.equal(opsFor(id)[0].row.quantity_ml, 150);
});

test('deleting a baby drops its queued changes, so they are not refused and retried forever', () => {
  const b2 = store.createBaby({ name: 'Second', date_of_birth: '2026-10-01', sex: 'male', timezone: 'UTC', feeding_preference: 'formula', photograph_url: null });
  store.upsertEntry('feeds', { baby_id: b2, feeding_type: 'formula', start_datetime: '2026-11-20T10:00:00Z', quantity_ml: 50, observations: [] });
  store.startExtraTimer(b2, 'tracker-x');
  store.deleteBabyData(b2);
  const left = store.getState().outbox.filter(o => o.row.baby_id === b2);
  assert.equal(left.length, 1);
  assert.ok(left[0].table === 'babies' && left[0].row.deleted_at);
  assert.equal(Object.values(store.getState().timers).some(t => t.baby_id === b2), false);
});

test('a caregiver can leave; the owner cannot', async () => {
  await assert.rejects(store.leaveBaby(baby), /Only caregivers/);
  store.signOut(); await store.signIn('cg@x.fi', 'password1');
  await store.leaveBaby(baby);
  assert.equal(store.roleFor(baby), null);
  assert.equal(store.accessibleBabies().length, 0);
  assert.ok(store.getState().feeds[Object.keys(store.getState().feeds)[0]], 'records stay for the family');
});
