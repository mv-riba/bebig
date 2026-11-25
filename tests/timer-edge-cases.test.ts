// Timer edge cases on the device: different timers at once for one baby, timers for several babies at once,
// server answers for one baby never touching another baby's timers, and timers left behind by other changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
Object.assign(globalThis as any, { localStorage: mem(), sessionStorage: mem(), BroadcastChannel: undefined });
const store = await import('../src/lib/store.ts');

await store.register('cg@x.fi', 'password1', 'Alex');
const cg = store.currentUserId()!;
store.signOut();
await store.register('owner@x.fi', 'password1', 'Marija');
const me = store.currentUserId()!;
const A = store.createBaby({ name: 'Twin A', date_of_birth: '2026-10-01', sex: 'female', timezone: 'Europe/Helsinki', feeding_preference: 'breast', photograph_url: null });
const B = store.createBaby({ name: 'Twin B', date_of_birth: '2026-10-01', sex: 'male', timezone: 'Europe/Helsinki', feeding_preference: 'combination', photograph_url: null });
const tracker = (id: string, baby: string, name: string) => store.setState(s => { s.trackers[id] = { tracker_id: id, baby_id: baby, name, icon: 'sun', kind: 'duration', unit: null, preset: null, enabled: true, sort: 0, created_by: me, updated_by: me, created_at: '', updated_at: '', deleted_at: null } as any; });
tracker('walkA', A, 'Walk'); tracker('tummyA', A, 'Tummy time'); tracker('walkB', B, 'Walk');

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();
const clear = () => store.setState(s => { s.outbox = []; s.syncFailed = []; s.timers = {}; s.feeds = {}; s.extras = {}; s.sleeps = {}; });
const timerOps = (id: string) => store.getState().outbox.filter(o => o.table === 'timers' && o.row.timer_id === id).map(o => o.action?.kind);
const sleepOps = (id: string) => store.getState().outbox.filter(o => o.table === 'sleeps' && o.row.sleep_id === id).map(o => o.action?.kind);
const breast = (baby: string) => ({ baby_id: baby, feeding_type: 'breast' as const, start_datetime: iso(5), observations: [] });
/** pretend a timer started `min` minutes ago */
const backdate = (id: string, min: number) => store.setState(s => { const t = s.timers[id]; t.started_at = iso(min); if (t.segment_started_at) t.segment_started_at = iso(min); });

// ---------- one baby, several timers at once ----------
test('sleep, walk, feed and tummy time can all run at once for one baby, each stopping on its own', () => {
  clear();
  const sleep = store.startSleep(A);
  const walk = store.startExtraTimer(A, 'walkA');
  const feed = store.startFeedTimer(A, 'left');
  const tummy = store.startExtraTimer(A, 'tummyA');
  assert.ok(store.activeSleep(A) && store.feedTimerOf(A));
  assert.deepEqual(Object.keys(store.extraTimersOf()).sort(), ['tummyA', 'walkA']);
  backdate(walk, 30);
  const saved = store.stopExtraTimer('walkA')!;
  assert.ok(Math.abs(saved.secs - 1800) < 3, 'walk timed ~30 min');
  assert.equal(store.getState().extras[saved.id].tracker_id, 'walkA');
  assert.ok(store.activeSleep(A), 'sleep still running after the walk is saved');
  assert.ok(store.feedTimerOf(A), 'feed still running after the walk is saved');
  store.stopSleep(store.activeSleep(A)!);
  assert.ok(store.feedTimerOf(A) && store.extraTimersOf()['tummyA'], 'feed and tummy time still running after the sleep is stopped');
  assert.ok(store.stopFeedTimer(A, breast(A)));
  store.discardExtraTimer('tummyA');
  assert.deepEqual(timerOps(walk), ['start', 'stop']);
  assert.deepEqual(timerOps(feed), ['start', 'stop']);
  assert.deepEqual(timerOps(tummy), ['start', 'discard']);
  assert.deepEqual(sleepOps(sleep), ['start', 'stop']);
});

test('pausing the walk doesn’t pause the sleep (and vice versa)', () => {
  clear();
  store.startSleep(A); store.startExtraTimer(A, 'walkA');
  store.pauseExtraTimer('walkA');
  assert.equal(store.activeSleep(A)!.status, 'active');
  store.pauseSleep(store.activeSleep(A)!);
  store.resumeExtraTimer('walkA');
  assert.equal(store.activeSleep(A)!.status, 'paused');
  assert.ok(store.extraTimersOf()['walkA'].segment_started_at);
});

test('rapid pause / resume taps keep the timed seconds within the time that passed', () => {
  clear();
  const id = store.startExtraTimer(A, 'walkA'); backdate(id, 10);
  for (let i = 0; i < 20; i++) { store.pauseExtraTimer('walkA'); store.resumeExtraTimer('walkA'); }
  const secs = store.extraTimerSeconds(store.extraTimersOf()['walkA']);
  assert.ok(secs <= 600 + 2 && secs >= 598, `timed ${secs}s`);
  assert.equal(timerOps(id).length, 41);
});

// ---------- twins: timers for several babies at once ----------
test('both twins can have a sleep, a breastfeeding timer and a walk running at once', () => {
  clear();
  const sa = store.startSleep(A), sb = store.startSleep(B);
  const fa = store.startFeedTimer(A, 'left'), fb = store.startFeedTimer(B, 'right');
  const wa = store.startExtraTimer(A, 'walkA'), wb = store.startExtraTimer(B, 'walkB');
  assert.notEqual(sa, sb); assert.notEqual(fa, fb); assert.notEqual(wa, wb);
  assert.equal(store.activeSleep(A)!.sleep_id, sa); assert.equal(store.activeSleep(B)!.sleep_id, sb);
  assert.equal(store.feedTimerOf(A)!.side, 'left'); assert.equal(store.feedTimerOf(B)!.side, 'right');
  // stopping twin A's never touches twin B's
  store.stopFeedTimer(A, breast(A)); store.stopSleep(store.activeSleep(A)!); store.stopExtraTimer('walkA');
  assert.equal(store.feedTimerOf(B)!.timer_id, fb);
  assert.equal(store.activeSleep(B)!.sleep_id, sb);
  assert.equal(store.extraTimersOf()['walkB'].timer_id, wb);
  // and twin B's feed is saved against twin B
  const f = store.stopFeedTimer(B, breast(B))!;
  assert.equal(store.getState().feeds[f].baby_id, B);
});

test('switching side on one twin’s feed doesn’t change the other twin’s', () => {
  clear();
  store.startFeedTimer(A, 'left'); store.startFeedTimer(B, 'left');
  store.switchFeedSide(A, 'right');
  assert.equal(store.feedTimerOf(A)!.side, 'right');
  assert.equal(store.feedTimerOf(B)!.side, 'left');
});

test('another caregiver stopping twin A’s feed first drops only twin A’s queued taps', () => {
  clear();
  const fa = store.startFeedTimer(A, 'left'), fb = store.startFeedTimer(B, 'left');
  store.pauseFeedTimer(A); store.pauseFeedTimer(B);
  const startA = store.getState().outbox.find(o => o.row.timer_id === fa && o.action?.kind === 'start')!;
  const theirs = { ...store.getState().timers[fa], ended_at: iso(1), end_kind: 'saved', entry_id: 'their-feed', updated_by: cg };
  store.applyTimerResult(startA, { outcome: 'not_running', row: theirs });
  assert.deepEqual(timerOps(fa), [], 'twin A’s later taps are dropped');
  assert.deepEqual(timerOps(fb), ['start', 'pause'], 'twin B’s taps still go out');
  assert.equal(store.feedTimerOf(A), null);
  assert.ok(store.feedTimerOf(B));
});

test('joining another caregiver’s timer for twin A doesn’t re-point twin B’s taps', () => {
  clear();
  const fa = store.startFeedTimer(A, 'left'), fb = store.startFeedTimer(B, 'left');
  store.pauseFeedTimer(A); store.pauseFeedTimer(B);
  const startA = store.getState().outbox.find(o => o.row.timer_id === fa && o.action?.kind === 'start')!;
  const theirs = { ...store.getState().timers[fa], timer_id: 'their-timer', created_by: cg, updated_by: cg };
  store.applyTimerResult(startA, { outcome: 'joined', row: theirs });
  assert.deepEqual(timerOps('their-timer'), ['pause']);
  assert.deepEqual(timerOps(fb), ['start', 'pause']);
  assert.equal(store.feedTimerOf(A)!.timer_id, 'their-timer');
  assert.equal(store.feedTimerOf(B)!.timer_id, fb);
});

test('another caregiver stopping twin A’s sleep first leaves twin B’s sleep taps alone', () => {
  clear();
  const sa = store.startSleep(A), sb = store.startSleep(B);
  store.stopSleep(store.activeSleep(A)!); store.pauseSleep(store.activeSleep(B)!);
  const stopA = store.getState().outbox.find(o => o.row.sleep_id === sa && o.action?.kind === 'stop')!;
  const theirs = { ...store.getState().sleeps[sa], end_datetime: iso(1), status: 'completed', updated_by: cg };
  store.applySleepResult(stopA, { outcome: 'already_stopped', row: theirs });
  assert.deepEqual(sleepOps(sb), ['start', 'pause']);
  assert.equal(store.activeSleep(B)!.status, 'paused');
});

test('losing access to twin A removes only twin A’s timers', () => {
  clear();
  store.startSleep(A); store.startSleep(B); store.startFeedTimer(A, null); store.startFeedTimer(B, null);
  store.startExtraTimer(A, 'walkA'); store.startExtraTimer(B, 'walkB');
  const snapshot = structuredClone(store.getState());
  store.setState(s => store.forgetBabyLocally(s, A, me));
  assert.equal(store.feedTimerOf(A), null); assert.equal(store.activeSleep(A), null);
  assert.ok(store.feedTimerOf(B)); assert.ok(store.activeSleep(B)); assert.ok(store.extraTimersOf()['walkB']);
  assert.equal(store.extraTimersOf()['walkA'], undefined);
  store.setState(s => { Object.assign(s, structuredClone(snapshot)); });
});

// ---------- limits and leftovers ----------
test('a walk left running over 24 hours can’t be saved (discard and enter it by hand)', () => {
  clear();
  const id = store.startExtraTimer(A, 'walkA'); backdate(id, 25 * 60);
  assert.throws(() => store.stopExtraTimer('walkA'), /more than 24 hours/);
  assert.ok(store.extraTimersOf()['walkA'], 'still running so it can be discarded');
});

test('a running timer is never pruned, however old (a forgotten timer stays visible)', () => {
  clear();
  const id = store.startExtraTimer(A, 'walkA'); backdate(id, 4 * 24 * 60);
  store.setState(s => store.pruneFinishedTimers(s));
  assert.ok(store.getState().timers[id]);
});

test('a phone clock that jumps backwards never makes a timer negative', () => {
  clear();
  const id = store.startExtraTimer(A, 'walkA');
  store.setState(s => { s.timers[id].segment_started_at = new Date(Date.now() + 3600000).toISOString(); });
  assert.equal(store.extraTimerSeconds(store.getState().timers[id]), 0);
  store.pauseExtraTimer('walkA');
  assert.equal(store.getState().timers[id].unsided_seconds, 0);
});

test('deleting a tracker while its timer runs discards the timer instead of leaving it running out of sight', () => {
  clear();
  const id = store.startExtraTimer(A, 'tummyA');
  store.deleteEntry('trackers', 'tummyA');
  assert.equal(store.extraTimersOf()['tummyA'], undefined, 'no hidden running timer left');
  assert.deepEqual(timerOps(id), ['start', 'discard']);
  store.restoreEntry('trackers', 'tummyA');
});

test('a sleep timer left running over 24 hours can’t be stopped as is, only discarded (then entered by hand)', () => {
  clear();
  const id = store.startSleep(A);
  store.setState(s => { s.sleeps[id].start_datetime = iso(25 * 60); });
  assert.ok(store.sleepTimerTooLong(store.activeSleep(A)!));
  assert.throws(() => store.stopSleep(store.activeSleep(A)!), /more than 24 hours/);
  assert.equal(store.activeSleep(A)!.status, 'active', 'still running so it can be discarded');
  store.discardSleep(store.activeSleep(A)!);
  assert.equal(store.activeSleep(A), null);
  assert.deepEqual(sleepOps(id), ['start', 'discard']);
});

test('a sleep timer at 23 hours still stops normally', () => {
  clear();
  const id = store.startSleep(A);
  store.setState(s => { s.sleeps[id].start_datetime = iso(23 * 60); });
  assert.equal(store.sleepTimerTooLong(store.activeSleep(A)!), false);
  assert.ok(Math.abs(store.stopSleep(store.activeSleep(A)!).duration_seconds! - 23 * 3600) < 5);
});

test('time zone note: shown only when the phone’s clock differs from the baby’s', async () => {
  const { tzGapNote } = await import('../src/lib/time.ts');
  const winter = new Date('2026-11-25T10:00:00Z');
  assert.equal(tzGapNote('Europe/Helsinki', winter, 'Europe/Helsinki'), null);
  assert.equal(tzGapNote('Europe/Helsinki', winter, 'Europe/Riga'), null, 'same clock time, different name');
  assert.equal(tzGapNote('Europe/Helsinki', winter, 'Europe/London'), 'Times are in Eastern European Standard Time, 2 h ahead of this phone.');
  assert.equal(tzGapNote('Europe/Helsinki', winter, 'Asia/Kolkata'), 'Times are in Eastern European Standard Time, 3 h 30 min behind this phone.');
  assert.equal(tzGapNote('America/New_York', winter, 'Europe/Helsinki'), 'Times are in Eastern Standard Time, 7 h behind this phone.');
});

test('time zone names follow summer time', async () => {
  const { tzName } = await import('../src/lib/time.ts');
  assert.equal(tzName('Europe/London', new Date('2026-11-25T10:00:00Z')), 'Greenwich Mean Time');
  assert.equal(tzName('Europe/London', new Date('2026-07-01T10:00:00Z')), 'British Summer Time');
  assert.equal(tzName('Europe/Helsinki', new Date('2026-07-01T10:00:00Z')), 'Eastern European Summer Time');
  assert.equal(tzName('Not/A_Zone'), 'A Zone time');
});
