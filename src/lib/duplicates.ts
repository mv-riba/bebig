// Possible duplicates: two caregivers logging the same feed, nappy or extra (e.g. both pressed "Log poo" for the same
// nappy, or both logged a feed while one phone was offline). Nothing is merged or deleted automatically, because
// two real events close together do happen: entries are flagged, and a new entry asks first.
import type { FeedingEntry, PooEntry, ExtraEntry, SleepEntry, TrackerDef } from './types';
import { dateKey } from './time';

export const DUPLICATE_WINDOW_MS = 10 * 60000;
type Entry = { kind: 'feed'; e: FeedingEntry } | { kind: 'poo'; e: PooEntry } | { kind: 'extra'; e: ExtraEntry; t?: TrackerDef } | { kind: 'sleep'; e: SleepEntry };

const at = (x: Entry) => new Date(x.kind === 'feed' || x.kind === 'sleep' ? x.e.start_datetime : x.e.datetime).getTime();
const idOf = (x: Entry) => (x.e as any)[x.kind === 'feed' ? 'feed_id' : x.kind === 'poo' ? 'poo_id' : x.kind === 'extra' ? 'extra_id' : 'sleep_id'] as string;
/** Same sort of thing: same feed type, same nappy type, same tracker. */
const sameSort = (a: Entry, b: Entry) => a.kind === b.kind && (
  a.kind === 'feed' ? a.e.feeding_type === (b.e as FeedingEntry).feeding_type
  : a.kind === 'poo' ? (a.e.nappy_type ?? 'poo') === ((b.e as PooEntry).nappy_type ?? 'poo')
  : a.kind === 'extra' ? a.e.tracker_id === (b.e as ExtraEntry).tracker_id
  : true);
/** Close enough to be the same event. Sleeps: overlapping. "Once a day" extras: the same day. */
function close(a: Entry, b: Entry, tz: string) {
  if (a.kind === 'sleep') {
    const sa = at(a), ea = a.e.end_datetime ? +new Date(a.e.end_datetime) : Date.now();
    const sb = at(b), eb = (b.e as SleepEntry).end_datetime ? +new Date((b.e as SleepEntry).end_datetime!) : Date.now();
    return sa < eb && sb < ea;
  }
  if (a.kind === 'extra' && a.t?.kind === 'daily') return dateKey(a.e.datetime, tz) === dateKey((b.e as ExtraEntry).datetime, tz);
  return Math.abs(at(a) - at(b)) <= DUPLICATE_WINDOW_MS;
}

/** IDs of entries that look like a second copy of one logged by another caregiver (the later-created one is flagged). */
export function possibleDuplicates(entries: Entry[], tz: string): Set<string> {
  const out = new Set<string>();
  const sorted = [...entries].sort((a, b) => at(a) - at(b));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i], b = sorted[j];
    if (a.kind !== 'sleep' && !(a.kind === 'extra' && a.t?.kind === 'daily') && at(b) - at(a) > DUPLICATE_WINDOW_MS) break;
    if (!sameSort(a, b) || !close(a, b, tz)) continue;
    if (!a.e.created_by || !b.e.created_by || a.e.created_by === b.e.created_by) continue; // one person logging twice is asked at save time instead
    const later = (a.e.created_at ?? '') > (b.e.created_at ?? '') ? a : b;
    out.add(idOf(later));
  }
  return out;
}

/** Before saving a new entry: an existing one that looks like the same event (anyone's), or null. */
export function similarEntry(candidate: Entry, existing: Entry[], tz: string): Entry | null {
  return existing.find(x => idOf(x) !== idOf(candidate) && !(x.e as any).deleted_at && sameSort(candidate, x) && close(candidate, x, tz)) ?? null;
}

/** Question asked before saving a new entry that looks like one already logged. */
export function similarQuestion(x: Entry, what: string, time: string, users: Record<string, { display_name?: string | null }>, me: string | null) {
  const by = x.e.created_by === me ? 'You' : (x.e.created_by && users[x.e.created_by]?.display_name?.split(' ')[0]) || 'Someone';
  return { title: 'Already logged?', text: `${by} already logged ${what} at ${time}. Is this a different one?`, ok: 'Yes, save it' };
}
