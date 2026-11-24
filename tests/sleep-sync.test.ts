// Sleep timer shared between caregivers: taps are sent as actions and the server's answer is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
Object.assign(globalThis as any, { localStorage: mem(), sessionStorage: mem(), BroadcastChannel: undefined });
const store = await import('../src/lib/store.ts');

await store.register('cg@x.fi', 'password1', 'Alex');
const cg = store.currentUserId()!;
store.signOut();
await store.register('owner@x.fi', 'password1', 'Maria');
const me = store.currentUserId()!;
const baby = store.createBaby({ name: 'Baby', date_of_birth: '2026-10-01', sex: 'female', timezone: 'UTC', feeding_preference: 'formula', photograph_url: null });

const notices: { text: string; action?: { label: string; run: () => void } }[] = [];
store.onNotice(n => notices.push(n));
const ops = (id: string) => store.getState().outbox.filter(o => o.table === 'sleeps' && o.row.sleep_id === id);
const clear = () => store.setState(s => { s.outbox = []; s.syncFailed = []; for (const k of Object.keys(s.sleeps)) delete s.sleeps[k]; });
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();

test('each timer tap is queued as an action with the time it was tapped', () => {
  clear();
  const id = store.startSleep(baby);
  store.pauseSleep(store.getState().sleeps[id]);
  store.resumeSleep(store.getState().sleeps[id]);
  store.stopSleep(store.getState().sleeps[id]);
  assert.deepEqual(ops(id).map(o => o.action?.kind), ['start', 'pause', 'resume', 'stop']);
  assert.ok(ops(id).every(o => o.action && !isNaN(Date.parse(o.action.at))));
  assert.equal(store.getState().sleeps[id].status, 'completed');
});

test('a tap on a sleep that is already finished on this device does nothing', () => {
  clear();
  const id = store.startSleep(baby);
  const stale = store.getState().sleeps[id]; // the screen still shows it running
  store.stopSleep(stale);
  store.pauseSleep(stale); store.resumeSleep(stale); store.stopSleep(stale); store.discardSleep(stale);
  assert.deepEqual(ops(id).map(o => o.action?.kind), ['start', 'stop']);
  assert.equal(store.getState().sleeps[id].deleted_at ?? null, null, 'discard never deletes a saved sleep');
});

test('second Stop: the server copy wins and the person is told who stopped it, with the option to use their time', () => {
  clear(); notices.length = 0;
  const id = store.startSleep(baby);
  store.setState(s => { s.sleeps[id].start_datetime = iso(60); s.outbox = []; });
  store.stopSleep(store.getState().sleeps[id]);
  const op = ops(id)[0];
  const theirs = { ...store.getState().sleeps[id], start_datetime: iso(60), end_datetime: iso(10), status: 'completed', pauses: [], duration_seconds: 3000, updated_by: cg, server_updated_at: iso(0) };
  store.applySleepResult(op, { outcome: 'already_stopped', row: theirs });
  const row = store.getState().sleeps[id];
  assert.equal(row.end_datetime, theirs.end_datetime);
  assert.equal(ops(id).length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /^Alex already stopped this sleep at \d\d:\d\d\.$/);
  assert.ok(notices[0].action, 'offers "Use <my time>"');
  notices[0].action!.run();
  const edited = store.getState().sleeps[id];
  assert.equal(edited.end_datetime, op.action!.at);
  assert.equal(edited.duration_seconds, Math.round((Date.parse(op.action!.at) - Date.parse(theirs.start_datetime)) / 1000));
  assert.equal(edited.updated_by, me);
});

test('a stale Pause refused by the server keeps the finished sleep and drops later taps for it', () => {
  clear(); notices.length = 0;
  const id = store.startSleep(baby);
  store.setState(s => { s.outbox = []; });
  store.pauseSleep(store.getState().sleeps[id]);
  store.resumeSleep(store.getState().sleeps[id]);
  const [pause] = ops(id);
  const theirs = { ...store.getState().sleeps[id], end_datetime: iso(0), status: 'completed', pauses: [], duration_seconds: 60, updated_by: cg };
  store.applySleepResult(pause, { outcome: 'not_running', row: theirs });
  assert.equal(store.getState().sleeps[id].status, 'completed');
  assert.equal(ops(id).length, 0, 'the queued Resume is dropped, not refused again');
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /^Alex already stopped this sleep at /);
});

test('two caregivers start at once: this device joins the running sleep and its later taps follow', () => {
  clear(); notices.length = 0;
  const mine = store.startSleep(baby);
  store.stopSleep(store.getState().sleeps[mine]);
  const [start] = ops(mine);
  const theirs = { sleep_id: 'their-sleep', baby_id: baby, start_datetime: iso(20), end_datetime: null, status: 'active', pauses: [], created_by: cg, updated_by: cg };
  store.applySleepResult(start, { outcome: 'joined', row: theirs });
  assert.equal(store.getState().sleeps[mine], undefined);
  assert.equal(store.getState().sleeps['their-sleep'].created_by, cg);
  assert.deepEqual(ops('their-sleep').map(o => o.action?.kind), ['stop'], 'the Stop now goes to the joined sleep');
  assert.match(notices[0].text, /^Alex already started this sleep at .*both timing the same one\.$/);
});

test('joining a timer that started later keeps this device\'s earlier start, and says so', () => {
  clear(); notices.length = 0;
  const mine = store.startSleep(baby);
  const [start] = ops(mine);
  const theirs = { sleep_id: 'their-later', baby_id: baby, start_datetime: start.action!.at, end_datetime: null, status: 'active', pauses: [], created_by: cg, updated_by: me };
  store.applySleepResult(start, { outcome: 'joined', row: theirs });
  assert.match(notices[0].text, /^Alex had also started a sleep timer, so they’re now one sleep, from your start at /);
});

test('our own retried Stop is not announced', () => {
  clear(); notices.length = 0;
  const id = store.startSleep(baby);
  store.setState(s => { s.outbox = []; });
  store.stopSleep(store.getState().sleeps[id]);
  store.applySleepResult(ops(id)[0], { outcome: 'already_stopped', row: { ...store.getState().sleeps[id], updated_by: me } });
  assert.equal(notices.length, 0);
});

test('rejected timer taps are retried as they were, in order (not collapsed into one row upload)', () => {
  clear();
  const id = store.startSleep(baby);
  store.pauseSleep(store.getState().sleeps[id]);
  store.setState(s => { s.syncFailed = s.outbox.map(o => ({ ...o, error: 'x', failed_at: '' })); s.outbox = []; });
  store.retryFailedSync();
  assert.deepEqual(ops(id).map(o => o.action?.kind), ['start', 'pause']);
});
