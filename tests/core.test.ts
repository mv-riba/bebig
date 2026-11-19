// Unit tests for deterministic calculations: time zones/DST, daily totals, WHO percentiles, insights, assistant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

(globalThis as any).BroadcastChannel = undefined; // store.ts: no cross-tab channel in tests
const time = await import('../src/lib/time.ts');
const calc = await import('../src/lib/calc.ts');
const growth = await import('../src/lib/growth.ts');
const { buildInsights } = await import('../src/lib/insights.ts');
const { answer } = await import('../src/lib/assistant.ts');

const TZ = 'Europe/Amsterdam';
const baby: any = { baby_id: 'b', name: 'Emma', date_of_birth: '2026-03-01', sex: 'female', timezone: TZ, feeding_preference: 'combination' };
const audit = { baby_id: 'b', created_by: 'u', updated_by: 'u', created_at: '', updated_at: '' };

test('DST: spring-forward day is 23 hours, autumn day is 25 hours', () => {
  const a = time.dayStart('2026-03-29', TZ).getTime(), b = time.dayEnd('2026-03-29', TZ).getTime();
  assert.equal((b - a) / 3600000, 23);
  const c = time.dayStart('2026-10-25', TZ).getTime(), d = time.dayEnd('2026-10-25', TZ).getTime();
  assert.equal((d - c) / 3600000, 25);
});

test('wall-clock conversion round-trips in the baby time zone', () => {
  const iso = time.fromLocalInput('2026-07-01T14:15', TZ);
  assert.equal(iso, '2026-07-01T12:15:00.000Z');
  assert.equal(time.toLocalInput(iso, TZ), '2026-07-01T14:15');
  assert.equal(time.formatTime(iso, TZ, '12h'), '2:15 pm');
  assert.equal(time.dateKey('2026-07-01T22:30:00Z', TZ), '2026-07-02'); // past local midnight
});

test('sleep crossing midnight is split between local days', () => {
  const s = { ...audit, sleep_id: 's1', start_datetime: time.fromLocalInput('2026-07-01T23:00', TZ), end_datetime: time.fromLocalInput('2026-07-02T01:30', TZ), duration_seconds: 9000, status: 'completed', pauses: [] };
  const d: any = { baby, feeds: [], poos: [], sleeps: [s] };
  assert.equal(calc.dayStats(d, '2026-07-01').sleepSeconds, 3600);
  assert.equal(calc.dayStats(d, '2026-07-02').sleepSeconds, 5400);
});

test('paused time is excluded from sleep duration', () => {
  const st = Date.parse('2026-07-01T10:00:00Z');
  const s: any = { start_datetime: new Date(st).toISOString(), end_datetime: new Date(st + 3600e3).toISOString(), pauses: [{ start: new Date(st + 600e3).toISOString(), end: new Date(st + 1200e3).toISOString() }], status: 'completed' };
  const { sleepElapsed } = calc as any;
  assert.equal((calc as any).sleepSecondsIn(s, st, st + 7200e3), 3000);
});

test('feeding totals keep breastfeeding time and bottle volume separate', () => {
  const k = '2026-07-01';
  const f = (h: number, type: string, extra: any) => ({ ...audit, feed_id: 'f' + h, feeding_type: type, start_datetime: time.fromLocalInput(`${k}T${String(h).padStart(2, '0')}:00`, TZ), observations: [], ...extra });
  const d: any = { baby, poos: [], sleeps: [], feeds: [f(6, 'breast', { duration_seconds: 1200 }), f(9, 'formula', { quantity_ml: 90 }), f(12, 'expressed', { quantity_ml: 60 }), f(15, 'breast', { left_duration_seconds: 300, right_duration_seconds: 420 })] };
  const st = calc.dayStats(d, k);
  assert.equal(st.feedCount, 4); assert.equal(st.formulaMl, 90); assert.equal(st.expressedMl, 60); assert.equal(st.breastSeconds, 1920);
  assert.equal(st.avgFeedIntervalMin, 180);
});

test('wake windows run from end of one sleep to start of the next', () => {
  const mk = (a: string, b: string) => ({ start_datetime: a, end_datetime: b, status: 'completed' }) as any;
  const w = calc.wakeWindows([mk('2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z'), mk('2026-07-01T12:30:00Z', '2026-07-01T13:00:00Z')]);
  assert.deepEqual(w.map(x => x.minutes), [90]);
});

test('WHO LMS: median gives 50th percentile; published ±2 SD values give ~2.3rd/97.7th', () => {
  const rows = JSON.parse(fs.readFileSync(new URL('./who-sd-check.json', import.meta.url), 'utf8')) as [string, 'male' | 'female', number, number, number, number][];
  for (const [ind, sex, m, sdm2, sd0, sd2] of rows) {
    const days = m * 30.4375;
    // WHO publishes SD curves rounded to 0.1: our LMS-derived values must round to the same numbers
    const { L, M, S } = growth.lms(ind as any, sex, days)!;
    const at = (z: number) => M * Math.pow(1 + L * S * z, 1 / L);
    for (const [z, ref] of [[0, sd0], [2, sd2], [-2, sdm2]] as const) assert.ok(Math.abs(at(z) - ref) <= 0.051, `${ind} ${sex} ${m}m z=${z}: ${at(z).toFixed(3)} vs ${ref}`);
    assert.ok(Math.abs(growth.zScore(ind as any, sex, days, at(2))! - 2) < 1e-6);
  }
  assert.ok(Math.abs(growth.percentile('weight', 'male', 0, 3.3464)! - 50) < 0.01);
});

test('growth: corrected age for prematurity and no invented percentiles', () => {
  const pre: any = { ...baby, gestational_age_weeks: 32, gestational_age_days: 0, date_of_birth: '2026-01-01' };
  const a = growth.growthAge(pre, '2026-02-01');
  assert.equal(a.corrected, true); assert.equal(a.chronological, 31); assert.equal(a.days, 31 - 56);
  const r = growth.assess(pre, 'weight', '2026-02-01', 2.1);
  assert.equal(r.percentile, null); assert.match(r.reason!, /term/);
  assert.equal(growth.assess(baby, 'weight', '2029-01-01', 12).percentile, null);
});

function synthetic(days: number, now: number) {
  const feeds: any[] = [], sleeps: any[] = [], poos: any[] = [];
  const today = time.todayKey(TZ);
  for (let i = days - 1; i >= 0; i--) {
    const ds = time.dayStart(time.addDays(today, -i), TZ).getTime();
    for (let h = 1; h < 24; h += 3) { const t = ds + h * 3600e3; if (t < now) feeds.push({ ...audit, feed_id: `f${i}-${h}`, feeding_type: 'breast', start_datetime: new Date(t).toISOString(), duration_seconds: 1200, observations: [] }); }
    for (const [a, b] of [[12.5, 14.5], [9, 10], [16, 17]]) { const st = ds + a * 3600e3, en = ds + b * 3600e3; if (en < now) sleeps.push({ ...audit, sleep_id: `s${i}-${a}`, start_datetime: new Date(st).toISOString(), end_datetime: new Date(en).toISOString(), duration_seconds: (en - st) / 1000, status: 'completed', pauses: [] }); }
    const pt = ds + 11 * 3600e3; if (pt < now) poos.push({ ...audit, poo_id: `p${i}`, datetime: new Date(pt).toISOString(), colour: 'yellow' });
  }
  return { baby, feeds, sleeps, poos } as any;
}

test('insights: nothing shown below 3 days; patterns and predictions after', () => {
  const now = Date.now();
  const few = buildInsights(synthetic(2, now), '24h', now);
  assert.equal(few.enoughData, false); assert.equal(few.predictions.length, 0); assert.equal(few.overview, null);
  const rep = buildInsights(synthetic(8, now), '24h', now);
  assert.equal(rep.enoughData, true);
  const fi = rep.observations.find(o => o.insight_id === 'feed-interval')!;
  assert.match(fi.description, /every 3 hours/);
  assert.equal(fi.evidence_level, 'recurring');
  const nap = rep.observations.find(o => o.insight_id === 'sleep-nap-window')!;
  assert.ok(nap, 'nap window found');
  const p = rep.predictions.find(x => x.insight_id === 'predict-feed')!;
  assert.ok(p.uncertainty_minutes! >= 15);
});

test('assistant: facts from records, estimates labelled, medical questions redirected', () => {
  const now = Date.now(); const d = synthetic(5, now);
  const last = answer('When did my baby last eat?', d, [], '24h', now)[0];
  assert.equal(last.kind, 'fact'); assert.match(last.content, /last ate at \d\d:00/);
  assert.equal(answer('Is green poo normal?', d, [], '24h', now)[0].kind, 'safety');
  assert.equal(answer('How much formula should I give?', d, [], '24h', now)[0].kind, 'safety');
  assert.equal(answer('Should I try sleep training?', d, [], '24h', now)[0].kind, 'safety');
  const y = answer('How much did my baby sleep yesterday?', d, [], '24h', now)[0];
  assert.equal(y.kind, 'fact'); assert.match(y.content, /4 h/);
  const empty = answer('When did my baby last eat?', { baby, feeds: [], poos: [], sleeps: [] } as any, [], '24h', now)[0];
  assert.equal(empty.kind, 'info'); assert.match(empty.content, /No feeds/);
});
