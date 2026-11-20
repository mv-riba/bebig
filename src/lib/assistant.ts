// Conversational assistant — retrieval + deterministic calculation layer.
// Intent detection maps a question to a query over stored records; every number in a reply is computed here.
// A server-side language model (see supabase/functions/assistant) may rephrase these verified answers,
// but is never the source of figures. Medical questions are always redirected to healthcare professionals.
import type { Data } from './calc';
import { sortedFeeds, sortedPoos, completedSleeps, dayStats, avgInterval, keyRange, feedDurationSeconds, sleepDuration, mean } from './calc';
import { buildInsights, EVIDENCE_LABEL } from './insights';
import { todayKey, addDays, formatTime, formatDuration, formatAgo, formatDateKey, dateKey, TimeFormat, weekdayIndex, monthName } from './time';
import { sleepElapsed } from './store';
import type { GrowthMeasurement, TrackerDef, ExtraEntry } from './types';
import { describeExtra, daySummary } from './extras';
import { assess, formatPercentile, toDisplay } from './growth';

export interface Reply { content: string; kind: 'fact' | 'estimate' | 'safety' | 'info' }

const MEDICAL = /\b(sick|ill|illness|fever|temperature|rash|vomit|vomiting|throw(ing)? up|spit(ting)? up a lot|blood|bloody|diagnos|disease|infection|medicine|medication|dose|dosage|paracetamol|ibuprofen|calpol|colic|reflux|jaundice|yellow skin|constipat|diarrh|dehydrat|breathing|cough|cold|allerg|normal|should i (be )?worr|worried|concern|healthy|underweight|overweight|too (much|little)|not enough|doctor|pediatric|paediatric|emergency|lethargic|seizure)\b/i;
const PRESCRIBE = /\b(how much|how many ml|how often|how long) should (i|we|she|he|my baby|the baby)\b|\bshould (i|we) (feed|wake|let|give|stop|delay|wait|skip)|\b(withhold|delay|skip) (a )?feed/i;
const SLEEP_TRAINING = /\b(sleep train|cry it out|ferber|self[- ]sooth|controlled crying)/i;

interface Range { keys: string[]; label: string }

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseRange(q: string, tz: string, fallback: 'today' | 'week' = 'today'): Range {
  const today = todayKey(tz);
  const s = q.toLowerCase();
  let m: RegExpMatchArray | null;
  if (/\byesterday\b/.test(s)) { const k = addDays(today, -1); return { keys: [k], label: 'yesterday' }; }
  if (/\btoday\b|\bso far\b/.test(s)) return { keys: [today], label: 'today' };
  if ((m = s.match(/\b(?:last|past|previous)\s+(\d+|two|three|four|five|six|seven|ten|fourteen)\s+days?\b/))) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };
    const n = Math.min(31, Number(m[1]) || words[m[1]] || 3);
    return { keys: keyRange(addDays(today, -(n - 1)), today), label: `the last ${n} days` };
  }
  if (/\blast week\b|\bprevious week\b/.test(s)) {
    const wd = weekdayIndex(today); const thisMon = addDays(today, -wd);
    return { keys: keyRange(addDays(thisMon, -7), addDays(thisMon, -1)), label: 'last week' };
  }
  if (/\bthis week\b|\bweek\b/.test(s)) { const wd = weekdayIndex(today); return { keys: keyRange(addDays(today, -wd), today), label: 'this week' }; }
  for (let i = 0; i < 7; i++) if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(s)) {
    let back = (weekdayIndex(today) - i + 7) % 7; if (back === 0 && !/today/.test(s)) back = 7;
    const k = addDays(today, -back); return { keys: [k], label: `on ${formatDateKey(k, 'weekday')}` };
  }
  if ((m = s.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/))) {
    const mo = MONTHS.indexOf(m[2]) + 1; const [y] = today.split('-').map(Number);
    let k = `${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`; if (k > today) k = `${y - 1}${k.slice(4)}`;
    return { keys: [k], label: `on ${formatDateKey(k, 'weekday')}` };
  }
  if (fallback === 'week') return { keys: keyRange(addDays(today, -6), today), label: 'the last 7 days' };
  return { keys: [today], label: 'today' };
}

const FEED_NAME = { breast: 'breastfeed', expressed: 'expressed-milk bottle', formula: 'formula bottle' } as const;
function describeFeed(f: ReturnType<typeof sortedFeeds>[number]) {
  const d = feedDurationSeconds(f);
  if (f.feeding_type === 'breast') return `a ${FEED_NAME.breast}${d ? ` for ${formatDuration(d)}` : ''}`;
  return `${f.quantity_ml ? f.quantity_ml + ' ml ' : 'a '}${f.feeding_type === 'formula' ? 'formula' : 'expressed milk'}`;
}

export function answer(question: string, d: Data, growth: GrowthMeasurement[], fmt: TimeFormat = '24h', now = Date.now(), x?: { trackers: TrackerDef[]; extras: ExtraEntry[] }): Reply[] {
  const q = question.trim();
  const s = q.toLowerCase();
  const tz = d.baby.timezone; const name = d.baby.name;
  const T = (iso: string | Date) => formatTime(iso, tz, fmt);
  if (!q) return [{ kind: 'info', content: 'Ask me about feeds, sleep, bowel movements or growth that have been recorded.' }];

  // ---- Safety first ----
  if (SLEEP_TRAINING.test(s)) return [{ kind: 'safety', content: `I can’t recommend sleep training or any treatment. I can show you what ${name}’s recorded sleep looks like — try “Does ${name} have a consistent nap pattern?”. For guidance on sleep approaches, please speak with your health visitor, consultatiebureau or GP.` }];
  if (PRESCRIBE.test(s)) return [{ kind: 'safety', content: `I can’t tell you how much or how often to feed, or advise delaying feeds. Always respond to ${name}’s hunger and tiredness cues. A midwife, health visitor, consultatiebureau or GP can advise on feeding. I can show what has been recorded — for example “How much formula today?”.` }];
  if (MEDICAL.test(s)) return [{ kind: 'safety', content: `I’m a routine-tracking assistant, so I can’t assess ${name}’s health or say whether something is normal. If you’re concerned, please contact your GP, midwife, consultatiebureau or health visitor — or call emergency services (112 in the EU) if it feels urgent. I can share what has been recorded if that helps you talk to them.` }];

  const feeds = sortedFeeds(d), poos = sortedPoos(d), sleeps = completedSleeps(d);
  const active = d.sleeps.find(x => x.status !== 'completed');

  // ---- Predictions ----
  if (/\b(next|likely|when will|expect|predict|upcoming)\b/.test(s)) {
    const rep = buildInsights(d, fmt, now);
    const cat = /sleep|nap/.test(s) ? 'sleep' : /poo|bowel|nappy|diaper|stool/.test(s) ? 'poo' : 'feeding';
    const p = rep.predictions.find(x => x.category === cat);
    if (!p) {
      if (cat === 'sleep' && active) return [{ kind: 'fact', content: `${name} is asleep now — this sleep started at ${T(active.start_datetime)} (${formatDuration(sleepElapsed(active, now))} so far).` }];
      return [{ kind: 'info', content: `There isn’t enough recorded data yet to estimate the next ${cat === 'feeding' ? 'feed' : cat === 'poo' ? 'bowel movement' : 'sleep'}. Estimates start after ${3} days of logging with enough repeated events. ${rep.needs[0] ?? ''}` }];
    }
    return [{ kind: 'estimate', content: `Estimate (not a schedule): ${p.description} ${p.limited_data_note ?? ''} Evidence: ${EVIDENCE_LABEL[p.evidence_level].toLowerCase()}, ${p.observation_count} observations over ${p.days_covered} days. Always follow ${name}’s cues.`.replace(/\s+/g, ' ') }];
  }

  // ---- Summaries ----
  if (/summar|overview|recap|how (was|were|has)/.test(s) && !/sleep\b.*change/.test(s)) {
    const r = parseRange(s, tz, 'week');
    const rows = r.keys.map(k => dayStats(d, k, now)).filter(x => x.feedCount || x.pooCount || x.sleepCount);
    if (!rows.length) return [{ kind: 'info', content: `Nothing has been recorded for ${r.label}.` }];
    const lines = rows.map(x => `• ${formatDateKey(x.key, 'weekday')}: ${x.feedCount} feed${x.feedCount === 1 ? '' : 's'}${x.formulaMl + x.expressedMl ? ` (${x.formulaMl + x.expressedMl} ml bottle)` : ''}, ${x.pooCount} poo${x.pooCount === 1 ? '' : 's'}, ${x.sleepCount} sleep${x.sleepCount === 1 ? '' : 's'} totalling ${formatDuration(x.sleepSeconds)}${x.key === todayKey(tz) ? ' (so far)' : ''}`);
    const missing = r.keys.length - rows.length;
    return [{ kind: 'fact', content: `Recorded for ${r.label}:\n${lines.join('\n')}${missing ? `\n${missing} day${missing > 1 ? 's' : ''} had no records.` : ''}` }];
  }

  // ---- Change over time ----
  if (/chang|differ|compar|trend/.test(s)) {
    const rep = buildInsights(d, fmt, now);
    const cat = /feed|eat/.test(s) ? 'Feeds per day' : /poo|bowel/.test(s) ? 'Bowel movements per day' : 'Sleep per day';
    const today = todayKey(tz);
    const recent = keyRange(addDays(today, -3), addDays(today, -1)), earlier = keyRange(addDays(today, -7), addDays(today, -4));
    const metric = (k: string) => { const x = dayStats(d, k, now); return cat === 'Feeds per day' ? x.feedCount : cat === 'Sleep per day' ? x.sleepSeconds / 3600 : x.pooCount; };
    const has = (k: string) => { const x = dayStats(d, k, now); return cat === 'Feeds per day' ? x.feedCount > 0 : cat === 'Sleep per day' ? x.sleepCount > 0 : x.pooCount > 0; };
    const r = recent.filter(has), e = earlier.filter(has);
    if (r.length < 2 || e.length < 2) return [{ kind: 'info', content: `I need at least two logged days in both the last 3 days and the 4 days before to compare. ${rep.needs[0] ?? ''}` }];
    const rm = mean(r.map(metric))!, em = mean(e.map(metric))!;
    const f = (n: number) => cat === 'Sleep per day' ? `${n.toFixed(1)} h` : n.toFixed(1);
    let extra = '';
    if (cat === 'Sleep per day') {
      const nap = rep.observations.find(o => o.insight_id === 'sleep-nap-window'); if (nap) extra = ` ${nap.description}`;
    }
    return [{ kind: 'fact', content: `${cat.replace(' per day', '')} per day averaged ${f(rm)} over the last 3 full days, compared with ${f(em)} in the 4 days before (${rm === em ? 'no change' : `${rm > em ? 'up' : 'down'} ${f(Math.abs(rm - em))}`}).${extra} This compares recorded data only; missed logs affect it.` }];
  }

  // ---- Pattern questions ----
  if (/pattern|routine|consistent|regular|usually|tend/.test(s)) {
    const rep = buildInsights(d, fmt, now);
    const cat = /feed|eat/.test(s) ? 'feeding' : /poo|bowel/.test(s) ? 'poo' : /sleep|nap/.test(s) ? 'sleep' : null;
    const obs = rep.observations.filter(o => !cat || o.category === cat);
    if (!rep.enoughData || !obs.length) return [{ kind: 'info', content: `Not enough data for a reliable pattern yet. ${rep.needs.join(' ')}` }];
    return [{ kind: 'fact', content: obs.slice(0, 3).map(o => `• ${o.description} (${EVIDENCE_LABEL[o.evidence_level]}, ${o.observation_count} observations over ${o.days_covered} days)`).join('\n') + (cat === 'sleep' && obs[0].evidence_level === 'preliminary' ? '\nThis is still preliminary — a few more days of logging will make it clearer.' : '') }];
  }

  // ---- Feed interval ----
  if (/(average|mean|typical).*(between|interval|gap)|time between feeds|how often.*(feed|eat)/.test(s)) {
    const r = parseRange(s, tz, 'week');
    const inR = feeds.filter(f => r.keys.includes(dateKey(f.start_datetime, tz)));
    const avg = avgInterval(inR.map(f => f.start_datetime));
    if (avg == null) return [{ kind: 'info', content: `There aren’t enough feeds recorded for ${r.label} to calculate an interval.` }];
    return [{ kind: 'fact', content: `Over ${r.label}, the average time between the start of consecutive feeds was ${formatDuration(avg * 60)}, across ${inR.length} recorded feeds. Gaps over 8 hours are treated as missing logs.` }];
  }

  // ---- Growth ----
  if (/weigh|weight|length|height|tall|head|growth|grow/.test(s)) {
    const g = [...growth].sort((a, b) => a.measurement_date.localeCompare(b.measurement_date));
    const ind = /length|height|tall/.test(s) ? 'length' : /head/.test(s) ? 'head' : 'weight';
    const withV = g.filter(m => toDisplay(ind, m) != null);
    const last = withV[withV.length - 1];
    if (!last) return [{ kind: 'info', content: `No ${ind === 'head' ? 'head circumference' : ind} measurements have been recorded yet. You can add one from the Calendar.` }];
    const v = toDisplay(ind, last)!; const a = assess(d.baby, ind, last.measurement_date, v);
    const unit = ind === 'weight' ? 'kg' : 'cm';
    return [{ kind: 'fact', content: `The latest recorded ${ind === 'head' ? 'head circumference' : ind} was ${ind === 'weight' ? v.toFixed(2) : v.toFixed(1)} ${unit} on ${formatDateKey(last.measurement_date, 'weekday')}${a.percentile != null ? `, around the ${formatPercentile(a.percentile)} percentile on the WHO standard${a.corrected ? ' (using corrected age)' : ''}` : ''}. Growth charts are reference tools — your healthcare professional is best placed to interpret them.` }];
  }

  // ---- Wet nappies ----
  if (/\bwet\b|\bpee\b|\bwee\b|\burin/.test(s)) {
    const wets = [...(d.wet ?? []), ...d.poos.filter(p => p.nappy_type === 'both')].sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime));
    if (!wets.length) return [{ kind: 'info', content: d.baby.wet_tracking ? 'No wet nappies have been recorded yet.' : 'Wet nappies aren’t being tracked. You can turn this on in Settings → Extra trackers.' }];
    if (isLastQ(s)) { const w = wets[wets.length - 1]; return [{ kind: 'fact', content: `The last recorded wet nappy was at ${T(w.datetime)}${dateKey(w.datetime, tz) !== todayKey(tz) ? ` on ${formatDateKey(dateKey(w.datetime, tz), 'weekday')}` : ''} (${formatAgo(w.datetime, now)}).` }]; }
    const r = parseRange(s, tz);
    const n = wets.filter(w => r.keys.includes(dateKey(w.datetime, tz))).length;
    return [{ kind: 'fact', content: `${n} wet nappie${n === 1 ? ' was' : 's were'} recorded ${r.label}.` }];
  }
  // ---- Extra trackers (by name) ----
  const tr = (x?.trackers ?? []).find(t => s.includes(t.name.toLowerCase()) || t.name.toLowerCase().split(/\s+/).some(w => w.length > 3 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '')}`).test(s)));
  if (tr) {
    const es = (x?.extras ?? []).filter(e => e.tracker_id === tr.tracker_id).sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime));
    if (!es.length) return [{ kind: 'info', content: `Nothing has been recorded for ${tr.name} yet.` }];
    const last = es[es.length - 1];
    if (tr.kind === 'daily' && !isLastQ(s)) {
      const r = parseRange(s, tz);
      const lines = r.keys.map(k => `• ${formatDateKey(k, 'weekday')}: ${daySummary(tr, es, tz, k, fmt) ?? 'not recorded'}`);
      return [{ kind: 'fact', content: r.keys.length === 1 ? `${tr.name} ${r.label}: ${daySummary(tr, es, tz, r.keys[0], fmt) ?? 'not recorded'}.` : `${tr.name}, ${r.label}:\n${lines.join('\n')}` }];
    }
    const r = parseRange(s, tz);
    const inR = es.filter(e => r.keys.includes(dateKey(e.datetime, tz)));
    const lastLine = `Last: ${describeExtra(tr, last)} at ${T(last.datetime)}${dateKey(last.datetime, tz) !== todayKey(tz) ? ` on ${formatDateKey(dateKey(last.datetime, tz), 'weekday')}` : ''} (${formatAgo(last.datetime, now)}).`;
    return [{ kind: 'fact', content: isLastQ(s) || !inR.length ? lastLine : `${tr.name} ${r.label}: ${daySummary(tr, inR, tz, r.keys[r.keys.length - 1], fmt) ?? inR.length + '×'}. ${lastLine}` }];
  }

  const isFeed = /\b(eat|ate|feed|fed|feeding|milk|bottle|breast|formula|nurs)/.test(s);
  const isPoo = /\b(poo|poop|bowel|nappy|diaper|stool|dirty)/.test(s);
  const isSleep = /\b(sleep|slept|nap|asleep|awake|wake|woke|bed)/.test(s);
  const isLast = /\b(last|latest|recent|when did|when was|most recent|since)\b/.test(s) && !/\blast (week|\d+|two|three|four|five|six|seven) /.test(s + ' ');

  // ---- Volume ----
  if (isFeed && /\b(ml|millilit|how much|volume|amount)\b/.test(s)) {
    const r = parseRange(s, tz);
    const st = r.keys.map(k => dayStats(d, k, now));
    const formula = st.reduce((a, x) => a + x.formulaMl, 0), expressed = st.reduce((a, x) => a + x.expressedMl, 0), breastS = st.reduce((a, x) => a + x.breastSeconds, 0), breastN = st.reduce((a, x) => a + x.breastCount, 0);
    if (!formula && !expressed && !breastN) return [{ kind: 'info', content: `No feeds have been recorded for ${r.label}.` }];
    const parts = [] as string[];
    if (formula) parts.push(`${formula} ml formula`); if (expressed) parts.push(`${expressed} ml expressed milk`);
    if (breastN) parts.push(`${breastN} breastfeed${breastN > 1 ? 's' : ''}${breastS ? ` totalling ${formatDuration(breastS)}` : ''}`);
    return [{ kind: 'fact', content: `Recorded ${r.label}: ${parts.join(', ')}. Breastfeeding is tracked by time, so it isn’t converted into a volume.` }];
  }

  // ---- Last events ----
  if (isLast && isFeed) {
    const f = feeds[feeds.length - 1]; if (!f) return [{ kind: 'info', content: 'No feeds have been recorded yet.' }];
    return [{ kind: 'fact', content: `${name} last ate at ${T(f.start_datetime)}${dateKey(f.start_datetime, tz) !== todayKey(tz) ? ` on ${formatDateKey(dateKey(f.start_datetime, tz), 'weekday')}` : ''} (${formatAgo(f.start_datetime, now)}) — ${describeFeed(f)}.` }];
  }
  if (isLast && isPoo) {
    const p = poos[poos.length - 1]; if (!p) return [{ kind: 'info', content: 'No bowel movements have been recorded yet.' }];
    const det = [p.colour, p.texture, p.size].filter(Boolean).join(', ');
    return [{ kind: 'fact', content: `The last recorded bowel movement was at ${T(p.datetime)}${dateKey(p.datetime, tz) !== todayKey(tz) ? ` on ${formatDateKey(dateKey(p.datetime, tz), 'weekday')}` : ''} (${formatAgo(p.datetime, now)})${det ? ` — ${det}` : ''}.` }];
  }
  if (isSleep && (isLast || /\b(is|currently|now|right now|how long has)\b/.test(s)) && !/how (much|many)/.test(s)) {
    if (active) return [{ kind: 'fact', content: `${name} is asleep now — since ${T(active.start_datetime)} (${formatDuration(sleepElapsed(active, now))}${active.status === 'paused' ? ', timer paused' : ''}).` }];
    const l = [...sleeps].sort((a, b) => +new Date(a.end_datetime!) - +new Date(b.end_datetime!)).pop();
    if (!l) return [{ kind: 'info', content: 'No completed sleeps have been recorded yet.' }];
    return [{ kind: 'fact', content: `The last recorded sleep was ${T(l.start_datetime)}–${T(l.end_datetime!)} (${formatDuration(sleepDuration(l))}). ${name} has been awake for ${formatDuration((now - new Date(l.end_datetime!).getTime()) / 1000)} since, based on the records.` }];
  }

  // ---- Totals / counts ----
  if (isSleep) {
    const r = parseRange(s, tz);
    const st = r.keys.map(k => dayStats(d, k, now));
    const total = st.reduce((a, x) => a + x.sleepSeconds, 0), n = st.reduce((a, x) => a + x.sleepCount, 0);
    if (!n) return [{ kind: 'info', content: `No sleep has been recorded for ${r.label}.` }];
    const perDay = r.keys.length > 1 ? ` That’s an average of ${formatDuration(total / st.filter(x => x.sleepCount).length)} per logged day.` : '';
    return [{ kind: 'fact', content: `${name} slept ${formatDuration(total)} across ${n} recorded session${n === 1 ? '' : 's'} ${r.label}${st.some(x => x.activeSleep) ? ' (including the current sleep)' : ''}.${perDay} Sessions crossing midnight are split between days.` }];
  }
  if (isPoo) {
    const r = parseRange(s, tz);
    const n = r.keys.reduce((a, k) => a + dayStats(d, k, now).pooCount, 0);
    return [{ kind: 'fact', content: n ? `${n} bowel movement${n === 1 ? ' was' : 's were'} recorded ${r.label}.` : `No bowel movements were recorded ${r.label}.` }];
  }
  if (isFeed) {
    const r = parseRange(s, tz);
    const st = r.keys.map(k => dayStats(d, k, now));
    const n = st.reduce((a, x) => a + x.feedCount, 0);
    if (!n) return [{ kind: 'info', content: `No feeds were recorded ${r.label}.` }];
    const times = r.keys.length === 1 ? ` at ${st[0].feeds.map(f => T(f.start_datetime)).join(', ')}` : '';
    return [{ kind: 'fact', content: `${n} feed${n === 1 ? ' was' : 's were'} recorded ${r.label}${times}.` }];
  }

  return [{ kind: 'info', content: `I can answer questions about ${name}’s recorded feeds, sleep, bowel movements and growth. Try: “When did ${name} last eat?”, “How much did ${name} sleep yesterday?” or “Summarise the last three days”.` }];
}

const isLastQ = (s: string) => /\b(last|latest|recent|when did|when was|most recent|since)\b/.test(s) && !/\blast (week|\d+|two|three|four|five|six|seven) /.test(s + ' ');

export const SUGGESTIONS = ['When did my baby last eat?', 'How much did my baby sleep yesterday?', 'How many poos today?', 'Next feed?', 'Does my baby have a consistent nap pattern?', 'Summarise the last three days', 'What has changed in sleep over the last 7 days?', 'Average time between feeds this week'];
export { monthName };
