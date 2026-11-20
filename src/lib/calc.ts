// Deterministic calculations. The AI assistant and insights only ever explain numbers produced here.
import type { FeedingEntry, PooEntry, SleepEntry, BabyProfile } from './types';
import { dateKey, dayStart, dayEnd, overlapSeconds, addDays } from './time';
import { sleepElapsed } from './store';

export interface Data { baby: BabyProfile; feeds: FeedingEntry[]; poos: PooEntry[]; sleeps: SleepEntry[]; wet?: PooEntry[] }

const t = (iso: string) => new Date(iso).getTime();
export const byStart = <T>(get: (x: T) => string) => (a: T, b: T) => t(get(a)) - t(get(b));

export function sortedFeeds(d: Data) { return [...d.feeds].sort(byStart(f => f.start_datetime)); }
export function sortedPoos(d: Data) { return [...d.poos].sort(byStart(p => p.datetime)); }
export function completedSleeps(d: Data) { return d.sleeps.filter(s => s.status === 'completed' && s.end_datetime).sort(byStart(s => s.start_datetime)); }

export function feedDurationSeconds(f: FeedingEntry): number | null {
  if (f.duration_seconds != null) return f.duration_seconds;
  const lr = (f.left_duration_seconds || 0) + (f.right_duration_seconds || 0);
  if (lr) return lr;
  if (f.end_datetime) return Math.max(0, (t(f.end_datetime) - t(f.start_datetime)) / 1000);
  return null;
}

export function lastFeed(d: Data) { const s = sortedFeeds(d); return s[s.length - 1] ?? null; }
export function lastPoo(d: Data) { const s = sortedPoos(d); return s[s.length - 1] ?? null; }
export function lastCompletedSleep(d: Data) { const s = completedSleeps(d); return s.sort(byStart(x => x.end_datetime!))[s.length - 1] ?? null; }

/** Sleep seconds of a session that fall within [a,b), excluding paused time proportionally. */
export function sleepSecondsIn(s: SleepEntry, a: number, b: number, now = Date.now()) {
  const start = t(s.start_datetime);
  const end = s.end_datetime ? t(s.end_datetime) : now;
  let secs = overlapSeconds(start, end, a, b);
  for (const p of s.pauses || []) {
    const pe = p.end ? t(p.end) : Math.min(now, end);
    secs -= overlapSeconds(t(p.start), pe, a, b);
  }
  return Math.max(0, secs);
}

export interface DayStats {
  key: string;
  feeds: FeedingEntry[]; poos: PooEntry[]; sleeps: SleepEntry[];
  feedCount: number; formulaMl: number; expressedMl: number; breastSeconds: number; breastCount: number; bottleCount: number;
  pooCount: number; wetCount: number; wets: PooEntry[];
  sleepCount: number; sleepSeconds: number; activeSleep: boolean;
  avgFeedIntervalMin: number | null;
}

export function dayStats(d: Data, key: string, now = Date.now()): DayStats {
  const tz = d.baby.timezone;
  const a = dayStart(key, tz).getTime(), b = dayEnd(key, tz).getTime();
  const feeds = sortedFeeds(d).filter(f => dateKey(f.start_datetime, tz) === key);
  const poos = sortedPoos(d).filter(p => dateKey(p.datetime, tz) === key);
  const wets = (d.wet ?? []).filter(p => dateKey(p.datetime, tz) === key);
  const wetCount = wets.length + poos.filter(p => p.nappy_type === 'both').length;
  // a sleep belongs to every local day it overlaps (sessions crossing midnight are split for totals)
  const sleeps = [...d.sleeps].sort(byStart(s => s.start_datetime)).filter(s => {
    const st = t(s.start_datetime), en = s.end_datetime ? t(s.end_datetime) : now;
    return st < b && en > a;
  });
  let formulaMl = 0, expressedMl = 0, breastSeconds = 0, breastCount = 0, bottleCount = 0;
  for (const f of feeds) {
    if (f.feeding_type === 'formula') { formulaMl += f.quantity_ml || 0; bottleCount++; }
    else if (f.feeding_type === 'expressed') { expressedMl += f.quantity_ml || 0; bottleCount++; }
    else { breastCount++; breastSeconds += feedDurationSeconds(f) || 0; }
  }
  const sleepSeconds = sleeps.reduce((acc, s) => acc + sleepSecondsIn(s, a, b, now), 0);
  return {
    key, feeds, poos, sleeps, feedCount: feeds.length, formulaMl, expressedMl, breastSeconds, breastCount, bottleCount,
    pooCount: poos.length, wetCount, wets, sleepCount: sleeps.length, sleepSeconds, activeSleep: sleeps.some(s => s.status !== 'completed'),
    avgFeedIntervalMin: avgInterval(feeds.map(f => f.start_datetime)),
  };
}

/** Mean gap (minutes) between consecutive timestamps; gaps over maxGapMin are treated as missing data. */
export function avgInterval(isos: string[], maxGapMin = 8 * 60): number | null {
  const gaps = intervals(isos, maxGapMin);
  return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
}
export function intervals(isos: string[], maxGapMin = 8 * 60): number[] {
  const ts = isos.map(t).sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < ts.length; i++) { const g = (ts[i] - ts[i - 1]) / 60000; if (g > 0 && g <= maxGapMin) out.push(g); }
  return out;
}

/** Wake windows: end of one completed sleep to the start of the next (minutes). */
export function wakeWindows(sleeps: SleepEntry[], maxGapMin = 8 * 60): { from: string; to: string; minutes: number }[] {
  const done = sleeps.filter(s => s.end_datetime).sort(byStart(s => s.start_datetime));
  const out: { from: string; to: string; minutes: number }[] = [];
  for (let i = 1; i < done.length; i++) {
    const m = (t(done[i].start_datetime) - t(done[i - 1].end_datetime!)) / 60000;
    if (m >= 0 && m <= maxGapMin) out.push({ from: done[i - 1].end_datetime!, to: done[i].start_datetime, minutes: m });
  }
  return out;
}

export function sleepDuration(s: SleepEntry, now = Date.now()) {
  return s.status === 'completed' && s.duration_seconds != null ? s.duration_seconds : sleepElapsed(s, now);
}

/** Keys of local days in the range [from, to] inclusive. */
export function keyRange(from: string, to: string) { const out: string[] = []; for (let k = from; k <= to; k = addDays(k, 1)) out.push(k); return out; }

/** Set of local day keys with at least one record of any kind. */
export function daysWithData(d: Data): Set<string> {
  const tz = d.baby.timezone; const s = new Set<string>();
  d.feeds.forEach(f => s.add(dateKey(f.start_datetime, tz)));
  d.poos.forEach(p => s.add(dateKey(p.datetime, tz)));
  d.sleeps.forEach(x => s.add(dateKey(x.start_datetime, tz)));
  return s;
}

export function median(xs: number[]) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
export function quantile(xs: number[], q: number) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const p = (s.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); }
export function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
