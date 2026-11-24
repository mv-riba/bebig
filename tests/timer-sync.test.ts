// Breastfeeding and extras timers shared between caregivers: taps are sent as actions and the server's answer is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const ls = mem();
// a breastfeeding timer saved on this device by the previous app version (before timers were shared)
const BABY = 'b0000000-0000-4000-8000-000000000001';
ls.setItem('bebig:v1', JSON.stringify({ version: 1, feedTimers: { [BABY]: { baby_id: BABY, started_at: new Date(Date.now() - 600000).toISOString(), side: 'left', left_seconds: 120, right_seconds: 0, unsided_seconds: 0, segment_started_at: null, created_by: null } } }));
Object.assign(globalThis as any, { localStorage: ls, sessionStorage: mem(), BroadcastChannel: undefined });
const store = await import('../src/lib/store.ts');

test('a timer saved by the previous app version becomes a shared timer, keeping its time and pause', () => {
  const t = store.feedTimerOf(BABY)!;
  assert.ok(t, 'still running');
  assert.equal(t.left_seconds, 120);
  assert.equal(t.segment_started_at, null);
  const q = store.getState().outbox.filter(o => o.table === 'timers');
  assert.deepEqual(q.map(o => o.action?.kind), ['start', 'pause']);
  assert.equal(q[0].action!.at, t.started_at);
  assert.equal((store.getState() as any).feedTimers, undefined);
});

await store.register('cg@x.fi', 'password1', 'Alex');
const cg = store.currentUserId()!;
store.signOut();
await store.register('owner@x.fi', 'password1', 'Marija');
const me = store.currentUserId()!;
const baby = store.createBaby({ name: 'Baby', date_of_birth: '2026-10-01', sex: 'female', timezone: 'UTC', feeding_preference: 'breast', photograph_url: null });
store.setState(s => { s.trackers['walk'] = { tracker_id: 'walk', baby_id: baby, name: 'Walk', icon: 'sun', kind: 'duration', unit: null, preset: null, enabled: true, sort: 0, created_by: me, updated_by: me, created_at: '', updated_at: '', deleted_at: null } as any; });

const notices: { text: string }[] = [];
store.onNotice(n => notices.push(n));
const ops = (id: string) => store.getState().outbox.filter(o => o.table === 'timers' && o.row.timer_id === id);
const clear = () => { notices.length = 0; store.setState(s => { s.outbox = []; s.syncFailed = []; s.timers = {}; s.feeds = {}; s.extras = {}; }); };
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();

test('each breastfeeding timer tap is queued as an action', () => {
  clear();
  const id = store.startFeedTimer(baby, 'left');
  store.switchFeedSide(baby, 'right');
  store.pauseFeedTimer(baby);
  store.resumeFeedTimer(baby);
  const feed = store.stopFeedTimer(baby, { baby_id: baby, feeding_type: 'breast', start_datetime: iso(5), observations: [] })!;
  assert.deepEqual(ops(id).map(o => o.action?.kind), ['start', 'side', 'pause', 'resume', 'stop']);
  assert.equal(ops(id)[1].action!.side, 'right');
  assert.equal(ops(id)[4].action!.entry_id, feed, 'the Stop names the feed it saves');
  const q = store.getState().outbox;
  assert.ok(q.findIndex(o => o.table === 'feeds' && o.row.feed_id === feed) > q.findIndex(o => o.action?.kind === 'stop'), 'the feed is sent after the Stop');
  assert.equal(store.feedTimerOf(baby), null);
});

test('starting when a timer is already running (perhaps another caregiver’s) shows that one', () => {
  clear();
  const a = store.startFeedTimer(baby, 'left');
  assert.equal(store.startFeedTimer(baby, 'right'), a);
  assert.equal(ops(a).length, 1);
});

test('a timer started by another caregiver is shown with their name, and taps on it are sent', () => {
  clear();
  store.setState(s => { s.timers['theirs'] = { timer_id: 'theirs', baby_id: baby, kind: 'extra', tracker_id: 'walk', started_at: iso(30), side: null, left_seconds: 0, right_seconds: 0, unsided_seconds: 600, segment_started_at: iso(10), ended_at: null, end_kind: null, entry_id: null, created_by: cg, updated_by: cg, created_at: iso(30), updated_at: iso(10), server_updated_at: iso(10) }; });
  const t = store.extraTimersOf()['walk'];
  assert.equal(store.timerStartedBy(t), 'Alex');
  assert.ok(Math.abs(store.extraTimerSeconds(t) - 1200) < 2);
  store.pauseExtraTimer('walk');
  assert.deepEqual(ops('theirs').map(o => o.action?.kind), ['pause']);
});

test('second Stop: the other caregiver’s feed is kept and this device’s copy is dropped, not saved twice', () => {
  clear();
  const id = store.startFeedTimer(baby, 'left');
  store.setState(s => { s.outbox = []; });
  const feed = store.stopFeedTimer(baby, { baby_id: baby, feeding_type: 'breast', start_datetime: iso(5), observations: [] })!;
  const stop = ops(id)[0];
  const theirs = { ...store.getState().timers[id], ended_at: iso(2), end_kind: 'saved', entry_id: 'their-feed', updated_by: cg };
  store.applyTimerResult(stop, { outcome: 'already_stopped', row: theirs });
  assert.equal(store.getState().feeds[feed], undefined);
  assert.equal(store.getState().outbox.some(o => o.table === 'feeds'), false);
  assert.equal(store.getState().timers[id].entry_id, 'their-feed');
  assert.match(notices[0].text, /^Alex already saved this feed at \d\d:\d\d, so it wasn’t saved twice\.$/);
});

test('a stale Pause refused by the server drops later taps for that timer', () => {
  clear();
  store.startExtraTimer(baby, 'walk');
  const id = store.extraTimersOf()['walk'].timer_id;
  store.setState(s => { s.outbox = []; });
  store.pauseExtraTimer('walk'); store.resumeExtraTimer('walk');
  const [pause] = ops(id);
  store.applyTimerResult(pause, { outcome: 'not_running', row: { ...store.getState().timers[id], ended_at: iso(0), end_kind: 'discarded', updated_by: cg } });
  assert.equal(ops(id).length, 0);
  assert.equal(store.extraTimersOf()['walk'], undefined);
  assert.equal(notices[0].text, 'Alex discarded the Walk timer.');
});

test('two caregivers start at once: this device joins the running timer and its later taps follow', () => {
  clear();
  const mine = store.startFeedTimer(baby, 'left');
  store.pauseFeedTimer(baby);
  const [start] = ops(mine);
  const theirs = { timer_id: 'their-timer', baby_id: baby, kind: 'feed', tracker_id: null, started_at: iso(4), side: 'right', left_seconds: 0, right_seconds: 0, unsided_seconds: 0, segment_started_at: iso(4), ended_at: null, end_kind: null, entry_id: null, created_by: cg, updated_by: cg };
  store.applyTimerResult(start, { outcome: 'joined', row: theirs });
  assert.equal(store.getState().timers[mine], undefined);
  assert.equal(store.feedTimerOf(baby)!.timer_id, 'their-timer');
  assert.deepEqual(ops('their-timer').map(o => o.action?.kind), ['pause']);
  assert.match(notices[0].text, /^Alex already started the breastfeeding timer at .*both timing the same one\.$/);
});

test('our own retried Stop is not announced and keeps the feed', () => {
  clear();
  const id = store.startFeedTimer(baby, null);
  store.setState(s => { s.outbox = []; });
  const feed = store.stopFeedTimer(baby, { baby_id: baby, feeding_type: 'breast', start_datetime: iso(5), observations: [] })!;
  store.applyTimerResult(ops(id)[0], { outcome: 'stopped', row: { ...store.getState().timers[id], updated_by: me } });
  assert.equal(notices.length, 0);
  assert.ok(store.getState().feeds[feed]);
});

test('discard after someone saved keeps their entry and says so', () => {
  clear();
  const id = store.startFeedTimer(baby, null);
  store.setState(s => { s.outbox = []; });
  store.discardFeedTimer(baby);
  store.applyTimerResult(ops(id)[0], { outcome: 'not_running', row: { ...store.getState().timers[id], ended_at: iso(1), end_kind: 'saved', entry_id: 'their-feed', updated_by: cg } });
  assert.match(notices[0].text, /^Alex already saved this feed at .*so it was kept\.$/);
});

test('finished timers are dropped from the device after two days', () => {
  clear();
  store.setState(s => {
    s.timers['old'] = { ...(s.timers['old'] as any), timer_id: 'old', baby_id: baby, kind: 'feed', ended_at: iso(3 * 1440), end_kind: 'saved' };
    s.timers['new'] = { ...(s.timers['new'] as any), timer_id: 'new', baby_id: baby, kind: 'feed', ended_at: iso(60), end_kind: 'saved' };
    store.pruneFinishedTimers(s);
  });
  assert.deepEqual(Object.keys(store.getState().timers), ['new']);
});
