// "Merge them into one?" when a feed, sleep or timed extra is saved over the time of one already logged.
import { formatTime } from '../lib/time';
import { saveMerged } from '../lib/store';

type Ask = (o: { title: string; text?: string; ok?: string; cancel?: string; alt?: string }) => Promise<boolean | 'alt'>;
export type MergeChoice = 'merge' | 'keep' | 'cancel';

/** what: "feed", "sleep", "walk"… · others: the overlapping entries' start and end. */
export async function askMerge(confirm: Ask, what: string, others: { start: string; end: string }[], tz: string, fmt?: '12h' | '24h' | string): Promise<MergeChoice> {
  const f = (iso: string) => formatTime(iso, tz, fmt as any);
  const times = others.map(o => `${f(o.start)}–${f(o.end)}`);
  const text = others.length === 1
    ? `This overlaps the ${what} at ${times[0]}. Merge them into one ${what}?`
    : `This overlaps ${others.length} other ${what}s (${times.join(', ')}). Merge them all into one ${what}?`;
  const a = await confirm({ title: `Overlaps another ${what}`, text, ok: 'Merge', alt: 'Keep both', cancel: 'Cancel' });
  return a === 'alt' ? 'keep' : a ? 'merge' : 'cancel';
}

/** Saves the merge into the earliest of `others`, removes the rest (and the entry being edited, if any).
 *  Returns the Undo for the toast. */
export function applyMerge(table: 'feeds' | 'sleeps' | 'extras', others: any[], editingId: string | undefined, merged: any) {
  const idf = table === 'feeds' ? 'feed_id' : table === 'sleeps' ? 'sleep_id' : 'extra_id';
  const drop = [...others.slice(1).map(o => o[idf]), ...(editingId ? [editingId] : [])];
  return saveMerged(table, others[0], merged, drop);
}
