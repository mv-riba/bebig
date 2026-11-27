// Overlapping entries: a timer was stopped, a new one started, and its start was then moved back to before the
// first one ended (or a manual entry was typed over an existing one). Those are really one feed / sleep / walk, so
// the app asks "Merge them into one?" before saving. Only overlaps count: back-to-back or close entries stay apart.
// Nothing is merged without asking (same rule as possible duplicates).
import type { FeedingEntry, SleepEntry, ExtraEntry, Pause } from './types';
import { MAX_FEED_SECONDS, MAX_EXTRA_SECONDS } from './validate';

type Span = [number, number];
const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
const overlaps = (a: Span | null, b: Span | null) => !!a && !!b && a[0] < b[1] && b[0] < a[1];
const notDeleted = (x: { deleted_at?: string | null }) => !x.deleted_at;

// ---------- feeds ----------
/** When a feed ran, or null if it has no end (a bottle with no end time, a breastfeed with no duration). */
export function feedSpan(f: Partial<FeedingEntry>): Span | null {
  if (!f.start_datetime) return null;
  const s = ms(f.start_datetime);
  const e = f.end_datetime ? ms(f.end_datetime) : f.duration_seconds != null ? s + f.duration_seconds * 1000 : NaN;
  return isFinite(e) && e > s ? [s, e] : null;
}
/** Saved feeds of the same type that overlap `f` (not `f` itself), earliest first. */
export function overlappingFeeds(f: Partial<FeedingEntry>, all: FeedingEntry[]): FeedingEntry[] {
  const sp = feedSpan(f);
  return all.filter(x => notDeleted(x) && x.feed_id !== f.feed_id && x.feeding_type === f.feeding_type && overlaps(sp, feedSpan(x)))
    .sort((a, b) => ms(a.start_datetime) - ms(b.start_datetime));
}
const joinNotes = (xs: (string | null | undefined)[]) => [...new Set(xs.map(n => n?.trim()).filter(Boolean))].join('\n') || null;
/** One feed covering all of them: earliest start to latest end. Breastfeeds add up the time on each side, but
 *  never count more than the merged feed lasted (the overlap would otherwise be counted twice). Bottles add up the ml. */
export function mergeFeeds(feeds: Partial<FeedingEntry>[]): Partial<FeedingEntry> {
  const spans = feeds.map(feedSpan) as Span[];
  const start = Math.min(...spans.map(s => s[0])), end = Math.max(...spans.map(s => s[1]));
  const span = (end - start) / 1000;
  const type = feeds[0].feeding_type!;
  const out: Partial<FeedingEntry> = { feeding_type: type, start_datetime: iso(start), end_datetime: iso(end),
    observations: [...new Set(feeds.flatMap(f => f.observations ?? []))], notes: joinNotes(feeds.map(f => f.notes)) };
  if (type === 'breast') {
    let l = 0, r = 0, total = 0;
    for (const f of feeds) { l += f.left_duration_seconds ?? 0; r += f.right_duration_seconds ?? 0; total += f.duration_seconds ?? (feedSpan(f)![1] - feedSpan(f)![0]) / 1000; }
    if (total > span) { const k = span / total; l *= k; r *= k; total = span; }
    if (total > MAX_FEED_SECONDS) throw new Error('Together these would be longer than 4 hours, so they can’t be one feed. Check the times.');
    const sides = new Set(feeds.map(f => f.breast_side).filter(Boolean));
    out.duration_seconds = Math.round(total);
    out.left_duration_seconds = l + r > 0 ? Math.round(l) : null;
    out.right_duration_seconds = l + r > 0 ? Math.round(r) : null;
    out.breast_side = l > 0 && r > 0 ? 'both' : l > 0 ? 'left' : r > 0 ? 'right' : sides.size > 1 || sides.has('both') ? 'both' : ([...sides][0] ?? null) as any;
    out.quantity_ml = null;
  } else {
    const q = feeds.reduce((n, f) => n + (f.quantity_ml ?? 0), 0);
    if (q > 500) throw new Error('Together these would be more than 500 ml, so they can’t be one feed. Check the amounts.');
    out.quantity_ml = q; out.duration_seconds = null; out.breast_side = null; out.left_duration_seconds = null; out.right_duration_seconds = null;
  }
  return out;
}

// ---------- sleeps ----------
export function sleepSpan(e: Partial<SleepEntry>): Span | null {
  if (!e.start_datetime || !e.end_datetime) return null;
  const s = ms(e.start_datetime), x = ms(e.end_datetime);
  return x > s ? [s, x] : null;
}
/** Finished sleeps that overlap `e` (not `e` itself, nor `skip`), earliest first. */
export function overlappingSleeps(e: Partial<SleepEntry>, all: SleepEntry[], skip?: string): SleepEntry[] {
  const sp = sleepSpan(e);
  return all.filter(x => notDeleted(x) && x.sleep_id !== e.sleep_id && x.sleep_id !== skip && x.status === 'completed' && overlaps(sp, sleepSpan(x)))
    .sort((a, b) => ms(a.start_datetime) - ms(b.start_datetime));
}
/** The stretches a sleep was actually asleep (its span minus its pauses). */
function asleep(e: Partial<SleepEntry>): Span[] {
  const [s, x] = sleepSpan(e)!;
  const out: Span[] = []; let at = s;
  const pauses = (e.pauses ?? []).map(p => [Math.max(s, ms(p.start)), Math.min(x, p.end ? ms(p.end) : x)] as Span).filter(p => p[1] > p[0]).sort((a, b) => a[0] - b[0]);
  for (const [ps, pe] of pauses) { if (ps > at) out.push([at, ps]); at = Math.max(at, pe); }
  if (x > at) out.push([at, x]);
  return out;
}
/** One sleep covering all of them. Baby counts as asleep whenever any of them says so; the times when none of them
 *  does become pauses, so the total never counts the overlap twice. */
export function mergeSleeps(sleeps: Partial<SleepEntry>[]): Partial<SleepEntry> {
  const parts = sleeps.flatMap(asleep).sort((a, b) => a[0] - b[0]);
  const union: Span[] = [];
  for (const p of parts) { const last = union[union.length - 1]; if (last && p[0] <= last[1]) last[1] = Math.max(last[1], p[1]); else union.push([...p] as Span); }
  const spans = sleeps.map(sleepSpan) as Span[];
  const start = Math.min(...spans.map(s => s[0])), end = Math.max(...spans.map(s => s[1]));
  if (end - start > 16 * 3600000) throw new Error('Together these would be longer than 16 hours, so they can’t be one sleep. Check the times.');
  const pauses: Pause[] = [];
  let at = start;
  for (const [s, x] of union) { if (s > at) pauses.push({ start: iso(at), end: iso(s) }); at = x; }
  if (end > at) pauses.push({ start: iso(at), end: iso(end) });
  return { start_datetime: iso(start), end_datetime: iso(end), status: 'completed', pauses,
    duration_seconds: Math.round(union.reduce((n, [s, x]) => n + (x - s), 0) / 1000), notes: joinNotes(sleeps.map(s => s.notes)) };
}

// ---------- timed extras ("How long" trackers, e.g. walks) ----------
export function extraSpan(e: Partial<ExtraEntry>): Span | null {
  if (!e.datetime || !e.duration_seconds) return null;
  const s = ms(e.datetime);
  return [s, s + e.duration_seconds * 1000];
}
export function overlappingExtras(e: Partial<ExtraEntry>, all: ExtraEntry[]): ExtraEntry[] {
  const sp = extraSpan(e);
  return all.filter(x => notDeleted(x) && x.extra_id !== e.extra_id && x.tracker_id === e.tracker_id && overlaps(sp, extraSpan(x)))
    .sort((a, b) => ms(a.datetime) - ms(b.datetime));
}
export function mergeExtras(extras: Partial<ExtraEntry>[]): Partial<ExtraEntry> {
  const spans = extras.map(extraSpan) as Span[];
  const start = Math.min(...spans.map(s => s[0])), end = Math.max(...spans.map(s => s[1]));
  const secs = Math.round((end - start) / 1000);
  if (secs > MAX_EXTRA_SECONDS) throw new Error('Together these would be longer than 24 hours, so they can’t be one entry. Check the times.');
  return { datetime: iso(start), duration_seconds: secs, notes: joinNotes(extras.map(x => x.notes)) };
}
