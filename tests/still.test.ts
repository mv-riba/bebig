// "Still feeding?" after 1½ h, "Still sleeping?" after 12 h; "Yes" quiets it for a while; "Finished earlier" saves the real end.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
Object.assign(globalThis as any, { localStorage: mem(), sessionStorage: mem(), BroadcastChannel: undefined });
const store = await import('../src/lib/store.ts');
const { stillDue, confirmStill } = await import('../src/lib/still.ts');

await store.register('still@x.fi', 'password1', 'Marija');
const A = store.createBaby({ name: 'Ella', date_of_birth: '2026-10-01', sex: 'female', timezone: 'Europe/Helsinki', feeding_preference: 'breast', photograph_url: null });
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const clear = () => store.setState(s => { s.outbox = []; s.timers = {}; s.feeds = {}; s.sleeps = {}; });

test('feed: asked after 1½ hours, not before; "Yes" quiets it for 30 minutes', () => {
  const now = Date.now();
  assert.equal(stillDue('feed', 't1', ago(89), now), false);
  assert.equal(stillDue('feed', 't1', ago(91), now), true);
  confirmStill('t1', now);
  assert.equal(stillDue('feed', 't1', ago(91), now + 29 * 60000), false);
  assert.equal(stillDue('feed', 't1', ago(91), now + 31 * 60000), true);
});

test('sleep: asked after 12 hours (a 5-hour night stretch is not questioned); "Yes" quiets it for 2 hours', () => {
  const now = Date.now();
  assert.equal(stillDue('sleep', 's1', ago(5 * 60), now), false);
  assert.equal(stillDue('sleep', 's1', ago(12 * 60 + 1), now), true);
  confirmStill('s1', now);
  assert.equal(stillDue('sleep', 's1', ago(12 * 60 + 1), now + 60 * 60000), false);
  assert.equal(stillDue('sleep', 's1', ago(12 * 60 + 1), now + 121 * 60000), true);
});

test('a feed timer left on for 2 hours, finished after 25 minutes: saved as 25 minutes, and the server is told the real end', () => {
  clear();
  const id = store.startFeedTimer(A, 'left');
  store.setState(s => { s.timers[id].started_at = ago(120); s.timers[id].segment_started_at = ago(120); });
  const end = new Date(Date.parse(store.getState().timers[id].started_at) + 25 * 60000).toISOString();
  const t = store.feedTimerTotals(store.feedTimerOf(A)!, Date.parse(end));
  assert.equal(Math.round(t.left), 25 * 60);
  const fid = store.stopFeedTimer(A, { baby_id: A, feeding_type: 'breast', start_datetime: ago(120), end_datetime: end, duration_seconds: Math.round(t.total) }, end)!;
  assert.equal(store.getState().feeds[fid].duration_seconds, 1500);
  const stop = store.getState().outbox.find(o => o.table === 'timers' && o.action?.kind === 'stop')!;
  assert.equal(stop.action!.at, end);
  assert.equal(store.getState().timers[id].left_seconds, 1500);
  assert.equal(store.feedTimerOf(A), null);
});

test('the earliest a feed timer can have ended: when it was last resumed, or after the time already counted when paused', () => {
  clear();
  const id = store.startFeedTimer(A, null);
  store.setState(s => { s.timers[id].started_at = ago(100); s.timers[id].segment_started_at = ago(40); s.timers[id].unsided_seconds = 600; });
  assert.ok(Math.abs(store.earliestTimerEnd(store.getState().timers[id]) - Date.parse(ago(40))) < 1000);
  store.pauseFeedTimer(A);
  store.setState(s => { s.timers[id].unsided_seconds = 600; });
  assert.ok(Math.abs(store.earliestTimerEnd(store.getState().timers[id]) - (Date.parse(ago(100)) + 600000)) < 1000);
  store.discardFeedTimer(A);
});

test('a sleep timer left on for 14 hours, woke after 6: saved as 6 hours, server told the real end', () => {
  clear();
  const sid = store.startSleep(A);
  store.setState(s => { s.sleeps[sid].start_datetime = ago(14 * 60); });
  const end = new Date(Date.parse(store.getState().sleeps[sid].start_datetime) + 6 * 3600000).toISOString();
  const done = store.stopSleep(store.activeSleep(A)!, end);
  assert.equal(done.duration_seconds, 6 * 3600);
  assert.equal(store.getState().outbox.find(o => o.table === 'sleeps' && o.action?.kind === 'stop')!.action!.at, end);
});

test('a sleep pause after the real wake-up time is dropped from the saved sleep', () => {
  clear();
  const sid = store.startSleep(A);
  store.setState(s => { s.sleeps[sid].start_datetime = ago(13 * 60); s.sleeps[sid].pauses = [{ start: ago(60), end: ago(50) }] as any; });
  const done = store.stopSleep(store.activeSleep(A)!, ago(10 * 60));
  assert.equal(done.pauses.length, 0);
  assert.equal(done.duration_seconds, 3 * 3600);
});

test('a wake-up time before the sleep started, or in the future, is refused', () => {
  clear();
  const sid = store.startSleep(A);
  store.setState(s => { s.sleeps[sid].start_datetime = ago(13 * 60); });
  assert.throws(() => store.stopSleep(store.activeSleep(A)!, ago(14 * 60)), /after the sleep started/);
  assert.throws(() => store.stopSleep(store.activeSleep(A)!, new Date(Date.now() + 3600000).toISOString()), /future/);
  assert.equal(store.activeSleep(A)!.status, 'active');
});
