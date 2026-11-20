// Level 1 (observational) and Level 2 (predictive) insights.
// Every insight is computed deterministically from stored records and carries its evidence:
// number of observations, days covered, consistency, and missing days. Nothing is shown without enough data.
import type { AIInsight } from './types';
import type { Data } from './calc';
import { sortedFeeds, sortedPoos, completedSleeps, intervals, wakeWindows, median, quantile, mean, dayStats, keyRange, sleepSecondsIn } from './calc';
import { dateKey, addDays, todayKey, dayStart, formatMinutesOfDay, minutesOfDay, TimeFormat, formatTime } from './time';

export const MIN_DAYS = 3;
export const WINDOW_DAYS = 7;

export type Evidence = AIInsight['evidence_level'];
export const EVIDENCE_LABEL: Record<Evidence, string> = { preliminary: 'Preliminary observation', emerging: 'Emerging pattern', recurring: 'Recurring pattern' };

/** Evidence classification from days covered, observation count and consistency (0..1). */
export function classify(days: number, obs: number, consistency: number): Evidence {
  if (days >= 7 && obs >= 14 && consistency >= 0.7) return 'recurring';
  if (days >= 5 && obs >= 8 && consistency >= 0.5) return 'emerging';
  return 'preliminary';
}

const hrs = (min: number) => {
  const h = min / 60;
  const r = Math.round(h * 2) / 2; // nearest half hour
  return r % 1 === 0 ? `${r}` : `${r}`;
};
const roundTo = (x: number, step: number) => Math.round(x / step) * step;

export interface InsightReport {
  enoughData: boolean;
  daysWithData: number;
  missingDays: string[];
  windowStart: string; windowEnd: string;
  observations: AIInsight[];
  predictions: AIInsight[];
  overview: string | null;
  trends: Trend[];
  needs: string[];
  sleepHistogram: number[]; // 24 buckets, avg minutes asleep per hour
}
export interface Trend { label: string; thisWeek: number | null; lastWeek: number | null; unit: string; format: (n: number) => string }

export function buildInsights(d: Data, fmt: TimeFormat = '24h', now = Date.now()): InsightReport {
  const tz = d.baby.timezone;
  const today = todayKey(tz);
  const windowEnd = today;
  const windowStart = addDays(today, -(WINDOW_DAYS - 1));
  const winA = dayStart(windowStart, tz).getTime();
  const inWin = (iso: string) => new Date(iso).getTime() >= winA;
  const generated_at = new Date(now).toISOString();
  const base = { baby_id: d.baby.baby_id, generated_at, date_range_start: windowStart, date_range_end: windowEnd };

  const feeds = sortedFeeds(d).filter(f => inWin(f.start_datetime));
  const poos = sortedPoos(d).filter(p => inWin(p.datetime));
  const sleeps = completedSleeps(d).filter(s => inWin(s.start_datetime));

  const keys = keyRange(windowStart, windowEnd);
  const dayHas = (k: string) => feeds.some(f => dateKey(f.start_datetime, tz) === k) || poos.some(p => dateKey(p.datetime, tz) === k) || sleeps.some(s => dateKey(s.start_datetime, tz) === k);
  const dataDays = keys.filter(dayHas);
  // today is still in progress — not counted as "missing"
  const missingDays = keys.filter(k => k !== today && !dayHas(k) && k >= (dataDays[0] ?? today));
  const observations: AIInsight[] = []; const predictions: AIInsight[] = []; const needs: string[] = [];

  const feedDays = new Set(feeds.map(f => dateKey(f.start_datetime, tz)));
  const sleepDays = new Set(sleeps.map(s => dateKey(s.start_datetime, tz)));
  const pooDays = new Set(poos.map(p => dateKey(p.datetime, tz)));
  const enoughData = dataDays.length >= MIN_DAYS;

  // -------- Sleep histogram (avg minutes asleep per local hour across days with sleep logged) --------
  const sleepHistogram = new Array(24).fill(0);
  const fullSleepDays = [...sleepDays];
  if (fullSleepDays.length) {
    for (const k of fullSleepDays) {
      const ds = dayStart(k, tz).getTime();
      for (let h = 0; h < 24; h++) {
        const a = ds + h * 3600000, b = a + 3600000;
        for (const s of d.sleeps) if (s.status === 'completed') sleepHistogram[h] += sleepSecondsIn(s, a, b, now) / 60;
      }
    }
    for (let h = 0; h < 24; h++) sleepHistogram[h] /= fullSleepDays.length;
  }

  // ================= SLEEP =================
  if (sleepDays.size >= MIN_DAYS && sleeps.length >= 4) {
    // most common daytime nap period: best 3-hour window between 07:00 and 20:00, scored by share of days with sleep there
    let best = { start: 0, days: 0, minutes: 0 };
    for (let st = 7 * 60; st <= 17 * 60; st += 30) {
      let daysHit = 0, total = 0;
      for (const k of sleepDays) {
        const a = dayStart(k, tz).getTime() + st * 60000, b = a + 180 * 60000;
        const m = sleeps.reduce((acc, s) => acc + sleepSecondsIn(s, a, b, now) / 60, 0);
        if (m >= 30) daysHit++;
        total += m;
      }
      if (daysHit > best.days || (daysHit === best.days && total > best.minutes)) best = { start: st, days: daysHit, minutes: total };
    }
    const cons = best.days / sleepDays.size;
    if (best.days >= MIN_DAYS && cons >= 0.6) {
      // extend to 4h if the following hour also often contains sleep
      let len = 180;
      let hit4 = 0;
      for (const k of sleepDays) { const a = dayStart(k, tz).getTime() + (best.start + 180) * 60000; const m = sleeps.reduce((acc, s) => acc + sleepSecondsIn(s, a, a + 3600000, now) / 60, 0); if (m >= 20) hit4++; }
      if (hit4 / sleepDays.size >= 0.6) len = 240;
      const ev = classify(sleepDays.size, sleeps.length, cons);
      observations.push({
        ...base, insight_id: 'sleep-nap-window', insight_type: 'observation', category: 'sleep', title: 'Sleep pattern',
        description: `Your baby has tended to sleep most frequently between ${formatMinutesOfDay(best.start, fmt)} and ${formatMinutesOfDay(best.start + len, fmt)} — on ${best.days} of the last ${sleepDays.size} days with sleep logged.`,
        evidence_level: ev, observation_count: best.days, days_covered: sleepDays.size, histogram: sleepHistogram,
      });
    }
    const durs = sleeps.map(s => (s.duration_seconds || 0) / 60);
    const naps = durs.filter(x => x <= 180);
    const perDay = sleeps.length / sleepDays.size;
    const fullDays = [...sleepDays].filter(k => k !== today);
    const totals = fullDays.map(k => dayStats(d, k, now).sleepSeconds / 3600);
    const avgTotal = mean(totals);
    observations.push({
      ...base, insight_id: 'sleep-duration', insight_type: 'observation', category: 'sleep', title: 'Sleep sessions',
      description: `About ${perDay.toFixed(1)} sleep sessions per day${naps.length ? `, with naps averaging ${Math.round(mean(naps)!)} min` : ''}${avgTotal != null && fullDays.length >= 2 ? `. Total recorded sleep averaged ${avgTotal.toFixed(1)} h per full day logged` : ''}.`,
      evidence_level: classify(sleepDays.size, sleeps.length, 0.6), observation_count: sleeps.length, days_covered: sleepDays.size,
    });
    const ww = wakeWindows(d.sleeps.filter(s => s.status === 'completed' && inWin(s.start_datetime))).map(w => w.minutes).filter(m => m >= 10);
    if (ww.length >= 5) {
      const q1 = quantile(ww, 0.25)!, q3 = quantile(ww, 0.75)!, med = median(ww)!;
      const cv = (q3 - q1) / Math.max(1, med);
      observations.push({
        ...base, insight_id: 'sleep-wake-windows', insight_type: 'observation', category: 'sleep', title: 'Wake windows',
        description: `Time awake between recorded sleeps has typically been ${Math.round(roundTo(q1, 5))}–${Math.round(roundTo(q3, 5))} minutes (median ${Math.round(med)} min).`,
        evidence_level: classify(sleepDays.size, ww.length, cv < 0.5 ? 0.75 : 0.5), observation_count: ww.length, days_covered: sleepDays.size,
      });
    }
  } else needs.push(`Log sleep on at least ${MIN_DAYS} days (${sleepDays.size} so far) to see sleep patterns.`);

  // ================= FEEDING =================
  const fInts = intervals(feeds.map(f => f.start_datetime));
  if (feedDays.size >= MIN_DAYS && fInts.length >= 6) {
    const q1 = quantile(fInts, 0.25)!, q3 = quantile(fInts, 0.75)!, med = median(fInts)!;
    const spread = (q3 - q1) / med;
    const lo = hrs(q1), hi = hrs(q3);
    observations.push({
      ...base, insight_id: 'feed-interval', insight_type: 'observation', category: 'feeding', title: 'Feeding pattern',
      description: lo === hi ? `Your baby has generally been feeding about every ${lo} hours.` : `Your baby has generally been feeding every ${lo}–${hi} hours.`,
      evidence_level: classify(feedDays.size, fInts.length, spread < 0.35 ? 0.8 : spread < 0.6 ? 0.6 : 0.4), observation_count: fInts.length, days_covered: feedDays.size,
    });
    const full = [...feedDays].filter(k => k !== today);
    if (full.length >= 2) {
      const counts = full.map(k => dayStats(d, k, now).feedCount);
      observations.push({
        ...base, insight_id: 'feed-count', insight_type: 'observation', category: 'feeding', title: 'Feeds per day',
        description: `Between ${Math.min(...counts)} and ${Math.max(...counts)} feeds were logged per full day (average ${mean(counts)!.toFixed(1)}).`,
        evidence_level: classify(full.length, feeds.length, 0.6), observation_count: feeds.length, days_covered: full.length,
      });
    }
    const types = { breast: 0, expressed: 0, formula: 0 } as Record<string, number>;
    feeds.forEach(f => types[f.feeding_type]++);
    const used = Object.entries(types).filter(([, n]) => n > 0);
    if (used.length > 1) {
      const name: Record<string, string> = { breast: 'breastfeeds', expressed: 'expressed milk', formula: 'formula' };
      observations.push({
        ...base, insight_id: 'feed-types', insight_type: 'observation', category: 'feeding', title: 'Feeding types',
        description: 'Of ' + feeds.length + ' recorded feeds: ' + used.map(([k, n]) => `${Math.round((n / feeds.length) * 100)}% ${name[k]}`).join(', ') + '.',
        evidence_level: classify(feedDays.size, feeds.length, 0.7), observation_count: feeds.length, days_covered: feedDays.size,
      });
    }
    // change in frequency: last 3 full days vs earlier full days
    const fullSorted = full.sort();
    if (fullSorted.length >= 5) {
      const recent = fullSorted.slice(-3), earlier = fullSorted.slice(0, -3);
      const r = mean(recent.map(k => dayStats(d, k, now).feedCount))!, e = mean(earlier.map(k => dayStats(d, k, now).feedCount))!;
      if (Math.abs(r - e) >= 1.5) observations.push({
        ...base, insight_id: 'feed-change', insight_type: 'observation', category: 'feeding', title: 'Recent change',
        description: `Over the last 3 days, ${r > e ? 'more' : 'fewer'} feeds were logged per day (${r.toFixed(1)}) than in the days before (${e.toFixed(1)}).`,
        evidence_level: 'preliminary', observation_count: feeds.length, days_covered: fullSorted.length,
      });
    }
  } else needs.push(`Log feeds on at least ${MIN_DAYS} days (${feedDays.size} so far) to see feeding patterns.`);

  // ================= POO =================
  if (pooDays.size >= MIN_DAYS && poos.length >= 4) {
    const full = [...pooDays].filter(k => k !== today);
    const per = full.length ? mean(full.map(k => dayStats(d, k, now).pooCount)) : null;
    if (per != null) observations.push({
      ...base, insight_id: 'poo-frequency', insight_type: 'observation', category: 'poo', title: 'Bowel movements',
      description: `About ${per.toFixed(1)} bowel movements were logged per full day.`,
      evidence_level: classify(pooDays.size, poos.length, 0.6), observation_count: poos.length, days_covered: pooDays.size,
    });
    // timing association with the preceding feed
    const allFeeds = sortedFeeds(d);
    const lags: number[] = [];
    for (const p of poos) {
      const pt = new Date(p.datetime).getTime();
      const prev = [...allFeeds].reverse().find(f => new Date(f.start_datetime).getTime() <= pt);
      if (prev) { const lag = (pt - new Date(prev.start_datetime).getTime()) / 60000; if (lag <= 6 * 60) lags.push(lag); }
    }
    if (lags.length >= 4) {
      const med = median(lags)!; const q1 = quantile(lags, 0.25)!, q3 = quantile(lags, 0.75)!;
      const within = lags.filter(l => Math.abs(l - med) <= 45).length;
      if (within >= 3) observations.push({
        ...base, insight_id: 'poo-feed-timing', insight_type: 'observation', category: 'poo', title: 'Timing after feeds',
        description: `${within} of ${lags.length} recorded bowel movements happened about ${med < 60 ? Math.round(roundTo(med, 5)) + ' minutes' : hrs(med) + ' hours'} after the start of a feed (typical range ${Math.round(q1)}–${Math.round(q3)} min). This is a timing association, not evidence that one causes the other.`,
        evidence_level: classify(pooDays.size, within, within / lags.length), observation_count: within, days_covered: pooDays.size,
      });
    }
    // intake between bowel movements: how many feeds (and, for bottle-only stretches, how much milk) came between one poo and the next
    const fs = sortedFeeds(d); const ps = poos;
    const gaps: { feeds: number; ml: number; breast: boolean }[] = [];
    for (let i = 1; i < ps.length; i++) {
      const a = new Date(ps[i - 1].datetime).getTime(), b = new Date(ps[i].datetime).getTime();
      if (b - a > 36 * 3600e3) continue; // likely missing logs
      const between = fs.filter(f => { const x = new Date(f.start_datetime).getTime(); return x > a && x <= b; });
      gaps.push({ feeds: between.length, ml: between.reduce((s, f) => s + (f.feeding_type === 'breast' ? 0 : f.quantity_ml || 0), 0), breast: between.some(f => f.feeding_type === 'breast') });
    }
    const counted = gaps.filter(g => g.feeds > 0);
    if (counted.length >= 5) {
      const c = counted.map(g => g.feeds); const med = median(c)!; const lo = Math.round(quantile(c, 0.25)!), hi = Math.round(quantile(c, 0.75)!);
      const within = c.filter(x => x >= lo && x <= hi).length;
      if (within / c.length >= 0.6) observations.push({
        ...base, insight_id: 'poo-after-feeds', insight_type: 'observation', category: 'poo', title: 'Feeds between bowel movements',
        description: `Bowel movements have usually come after ${lo === hi ? `${lo}` : `${lo}–${hi}`} feed${hi === 1 ? '' : 's'} since the previous one (${within} of ${c.length} times, median ${med}). This shows a timing pattern, not that feeding causes it.`,
        evidence_level: classify(pooDays.size, c.length, within / c.length), observation_count: c.length, days_covered: pooDays.size,
      });
    }
    const bottle = gaps.filter(g => !g.breast && g.ml > 0).map(g => g.ml);
    if (bottle.length >= 5) {
      const med = median(bottle)!; const lo = roundTo(quantile(bottle, 0.25)!, 10), hi = roundTo(quantile(bottle, 0.75)!, 10);
      const within = bottle.filter(x => x >= lo - 5 && x <= hi + 5).length;
      if ((hi - lo) / Math.max(1, med) <= 0.5) observations.push({
        ...base, insight_id: 'poo-after-volume', insight_type: 'observation', category: 'poo', title: 'Bottle volume between bowel movements',
        description: `When only bottles were given in between, a bowel movement usually followed after about ${lo === hi ? `${lo}` : `${lo}–${hi}`} ml since the previous one (${within} of ${bottle.length} times). An association in your records, not a rule.`,
        evidence_level: classify(pooDays.size, bottle.length, within / bottle.length), observation_count: bottle.length, days_covered: pooDays.size,
      });
    } else if (gaps.some(g => !g.breast && g.ml > 0)) needs.push('Volume patterns appear after 5+ stretches between bowel movements with only bottle feeds logged (with ml).');
  } else needs.push(`Log bowel movements on at least ${MIN_DAYS} days (${pooDays.size} so far) to see patterns.`);

  // ================= PREDICTIONS =================
  if (enoughData) {
    const all = sortedFeeds(d);
    const recentInts = intervals(all.filter(f => new Date(f.start_datetime).getTime() >= now - 3 * 86400000).map(f => f.start_datetime));
    const useInts = recentInts.length >= 6 ? recentInts : fInts;
    const last = all[all.length - 1];
    if (last && useInts.length >= 6) {
      const med = median(useInts)!; const q1 = quantile(useInts, 0.25)!, q3 = quantile(useInts, 0.75)!;
      const unc = Math.max(15, roundTo((q3 - q1) / 2, 15));
      const at = new Date(new Date(last.start_datetime).getTime() + med * 60000);
      const passed = now > at.getTime() + unc * 60000;
      predictions.push({
        ...base, insight_id: 'predict-feed', insight_type: 'prediction', category: 'feeding', title: 'Next feed',
        description: passed
          ? `The typical interval since the last feed (${formatTime(last.start_datetime, tz, fmt)}) has passed. Estimates can’t account for today’s needs — follow your baby’s cues.`
          : `Based on recent patterns, the next feed may occur around ${formatTime(at, tz, fmt)} (±${unc} min).`,
        predicted_at: passed ? undefined : at.toISOString(), uncertainty_minutes: unc,
        evidence_level: classify(feedDays.size, useInts.length, 0.6), observation_count: useInts.length, days_covered: feedDays.size,
        limited_data_note: useInts.length < 12 ? `Based on only ${useInts.length} feed intervals.` : undefined,
      });
    }
    const allSleeps = completedSleeps(d);
    const ww = wakeWindows(allSleeps.filter(s => inWin(s.start_datetime))).map(w => w.minutes).filter(m => m >= 10);
    const active = d.sleeps.find(s => s.status !== 'completed');
    const lastSleep = [...allSleeps].sort((a, b) => +new Date(a.end_datetime!) - +new Date(b.end_datetime!)).pop();
    if (!active && lastSleep && ww.length >= 5) {
      const med = median(ww)!; const q1 = quantile(ww, 0.25)!, q3 = quantile(ww, 0.75)!;
      const unc = Math.max(15, roundTo((q3 - q1) / 2, 15));
      const at = new Date(new Date(lastSleep.end_datetime!).getTime() + med * 60000);
      const passed = now > at.getTime() + unc * 60000;
      predictions.push({
        ...base, insight_id: 'predict-sleep', insight_type: 'prediction', category: 'sleep', title: 'Next sleep',
        description: passed
          ? `Your baby has been awake longer than the usual recorded wake window (${Math.round(q1)}–${Math.round(q3)} min).`
          : `Based on recent wake windows, the next sleep may start around ${formatTime(at, tz, fmt)} (±${unc} min).`,
        predicted_at: passed ? undefined : at.toISOString(), uncertainty_minutes: unc,
        evidence_level: classify(sleepDays.size, ww.length, 0.6), observation_count: ww.length, days_covered: sleepDays.size,
        limited_data_note: ww.length < 12 ? `Based on only ${ww.length} wake windows.` : undefined,
      });
    }
    const pInts = intervals(sortedPoos(d).filter(p => inWin(p.datetime)).map(p => p.datetime), 36 * 60);
    const lastP = sortedPoos(d).pop();
    if (lastP && pInts.length >= 4) {
      const q1 = quantile(pInts, 0.25)!, q3 = quantile(pInts, 0.75)!;
      const a = new Date(new Date(lastP.datetime).getTime() + q1 * 60000), b = new Date(new Date(lastP.datetime).getTime() + q3 * 60000);
      predictions.push({
        ...base, insight_id: 'predict-poo', insight_type: 'prediction', category: 'poo', title: 'Next bowel movement',
        description: now > b.getTime()
          ? `It has been longer than the usual recorded interval between bowel movements (${hrs(q1)}–${hrs(q3)} h). Intervals naturally vary.`
          : `The next bowel movement may occur within the usual observed interval, roughly ${formatTime(a, tz, fmt)}–${formatTime(b, tz, fmt)}.`,
        predicted_at: a.toISOString(), uncertainty_minutes: Math.round((q3 - q1) / 2),
        evidence_level: classify(pooDays.size, pInts.length, 0.5), observation_count: pInts.length, days_covered: pooDays.size,
        limited_data_note: pInts.length < 10 ? `Based on only ${pInts.length} intervals; bowel patterns vary a lot.` : undefined,
      });
    }
  }

  // ================= TRENDS (this week vs last week) =================
  const wk = (from: number, to: number) => keyRange(addDays(today, -to), addDays(today, -from));
  const avgOver = (ks: string[], f: (s: ReturnType<typeof dayStats>) => number, has: Set<string>) => {
    const vals = ks.filter(k => has.has(k)).map(k => f(dayStats(d, k, now)));
    return vals.length >= 2 ? mean(vals) : null;
  };
  const allFeedDays = new Set(d.feeds.map(f => dateKey(f.start_datetime, tz)));
  const allSleepDays = new Set(d.sleeps.map(s => dateKey(s.start_datetime, tz)));
  const allPooDays = new Set(d.poos.map(p => dateKey(p.datetime, tz)));
  const thisW = wk(1, 7), lastW = wk(8, 14);
  const trends: Trend[] = [
    { label: 'Feeds per day', unit: '', thisWeek: avgOver(thisW, s => s.feedCount, allFeedDays), lastWeek: avgOver(lastW, s => s.feedCount, allFeedDays), format: n => n.toFixed(1) },
    { label: 'Sleep per day', unit: 'h', thisWeek: avgOver(thisW, s => s.sleepSeconds / 3600, allSleepDays), lastWeek: avgOver(lastW, s => s.sleepSeconds / 3600, allSleepDays), format: n => n.toFixed(1) + ' h' },
    { label: 'Bowel movements per day', unit: '', thisWeek: avgOver(thisW, s => s.pooCount, allPooDays), lastWeek: avgOver(lastW, s => s.pooCount, allPooDays), format: n => n.toFixed(1) },
  ];

  let overview: string | null = null;
  if (enoughData && observations.length) {
    const parts: string[] = [];
    const fi = observations.find(o => o.insight_id === 'feed-interval'); if (fi) parts.push(fi.description.replace('Your baby has generally been ', '').replace(/\.$/, ''));
    const sw = observations.find(o => o.insight_id === 'sleep-nap-window'); if (sw) parts.push('most daytime sleep ' + sw.description.split('between ')[1]?.split(' —')[0].replace(/^/, 'between '));
    overview = parts.length ? `Over the last ${dataDays.length} days with records: ${parts.join('; ')}.` : `Patterns are starting to form across ${dataDays.length} days of records.`;
    if (missingDays.length) overview += ` ${missingDays.length} day${missingDays.length > 1 ? 's' : ''} in this period had no records, which reduces confidence.`;
  }
  if (!enoughData) needs.unshift(`Insights begin after ${MIN_DAYS} days of logging — ${dataDays.length} day${dataDays.length === 1 ? '' : 's'} recorded in the last week.`);

  return { enoughData, daysWithData: dataDays.length, missingDays, windowStart, windowEnd, observations, predictions, overview, trends, needs, sleepHistogram };
}

export { minutesOfDay };
