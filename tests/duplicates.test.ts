// Two (or more) caregivers logging the same thing: flagged in the timeline, and asked about before saving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { possibleDuplicates, similarEntry, similarQuestion } from '../src/lib/duplicates.ts';

const H = 'Europe/Helsinki';
const at = (hm: string) => `2026-11-25T${hm}:00.000Z`;
let n = 0;
const feed = (hm: string, by: string, type = 'formula', made = hm) => ({ kind: 'feed' as const, e: { feed_id: 'f' + ++n, baby_id: 'b', feeding_type: type, start_datetime: at(hm), created_by: by, created_at: at(made) } as any });
const poo = (hm: string, by: string, nt = 'poo', made = hm) => ({ kind: 'poo' as const, e: { poo_id: 'p' + ++n, baby_id: 'b', datetime: at(hm), nappy_type: nt, created_by: by, created_at: at(made) } as any });
const daily = { tracker_id: 'vitd', kind: 'daily', name: 'Vitamin D' } as any;
const drops = { tracker_id: 'eye', kind: 'event', name: 'Eye drops' } as any;
const extra = (hm: string, by: string, t: any, made = hm) => ({ kind: 'extra' as const, t, e: { extra_id: 'x' + ++n, baby_id: 'b', tracker_id: t.tracker_id, datetime: at(hm), created_by: by, created_at: at(made) } as any });
const sleep = (from: string, to: string | null, by: string, made = from) => ({ kind: 'sleep' as const, e: { sleep_id: 's' + ++n, baby_id: 'b', start_datetime: at(from), end_datetime: to && at(to), status: to ? 'completed' : 'active', created_by: by, created_at: at(made) } as any });
const ids = (s: Set<string>) => [...s].sort();

test('two caregivers log the same nappy a few minutes apart: the later one is flagged', () => {
  const a = poo('10:00', 'mum', 'poo', '10:01'), b = poo('10:03', 'dad', 'poo', '10:05');
  assert.deepEqual(ids(possibleDuplicates([a, b], H)), [b.e.poo_id]);
});
test('the copy synced later from an offline phone is the one flagged, even if its time is earlier', () => {
  const a = feed('10:05', 'mum', 'formula', '10:06'), b = feed('10:00', 'dad', 'formula', '11:30');
  assert.deepEqual(ids(possibleDuplicates([a, b], H)), [b.e.feed_id]);
});
test('three caregivers, same feed: two flagged, the first kept', () => {
  const a = feed('10:00', 'mum'), b = feed('10:02', 'dad', 'formula', '10:03'), c = feed('10:04', 'gran', 'formula', '10:05');
  assert.deepEqual(ids(possibleDuplicates([a, b, c], H)), [b.e.feed_id, c.e.feed_id].sort());
});
test('not flagged: different feed types (breastfeed then formula top-up), different nappy types, more than 10 minutes apart', () => {
  assert.equal(possibleDuplicates([feed('10:00', 'mum', 'breast'), feed('10:05', 'dad', 'formula')], H).size, 0);
  assert.equal(possibleDuplicates([poo('10:00', 'mum', 'wet'), poo('10:02', 'dad', 'poo')], H).size, 0);
  assert.equal(possibleDuplicates([poo('10:00', 'mum'), poo('10:11', 'dad')], H).size, 0);
});
test('not flagged: one person logging twice (they were asked at save time)', () => {
  assert.equal(possibleDuplicates([poo('10:00', 'mum'), poo('10:01', 'mum')], H).size, 0);
});
test('"Once a day" given twice by two offline phones on the same day is flagged, hours apart', () => {
  const a = extra('08:00', 'mum', daily), b = extra('17:00', 'dad', daily, '18:00');
  assert.deepEqual(ids(possibleDuplicates([a, b], H)), [b.e.extra_id]);
});
test('"Just the time" trackers (eye drops) only within 10 minutes', () => {
  assert.equal(possibleDuplicates([extra('08:00', 'mum', drops), extra('12:00', 'dad', drops)], H).size, 0);
  assert.equal(possibleDuplicates([extra('08:00', 'mum', drops), extra('08:04', 'dad', drops)], H).size, 1);
});
test('overlapping sleeps typed in by two caregivers are flagged; back-to-back ones are not', () => {
  assert.equal(possibleDuplicates([sleep('10:00', '11:00', 'mum'), sleep('10:15', '11:05', 'dad')], H).size, 1);
  assert.equal(possibleDuplicates([sleep('10:00', '11:00', 'mum'), sleep('11:00', '12:00', 'dad')], H).size, 0);
});
test('before saving: a similar entry by anyone is found, and the question names who logged it', () => {
  const existing = [poo('10:00', 'dad')];
  const like = similarEntry(poo('10:06', 'mum'), existing, H)!;
  assert.equal(like, existing[0]);
  assert.equal(similarQuestion(like, 'a poo', '12:00', { dad: { display_name: 'Alex Riba' } }, 'mum').text, 'Alex already logged a poo at 12:00. Is this a different one?');
  assert.equal(similarQuestion(like, 'a poo', '12:00', {}, 'dad').text.startsWith('You already logged'), true);
  assert.equal(similarEntry(poo('10:20', 'mum'), existing, H), null);
  assert.equal(similarEntry(poo('10:05', 'mum', 'wet'), existing, H), null);
});
test('a deleted entry doesn’t count', () => {
  const gone = poo('10:00', 'dad'); gone.e.deleted_at = at('10:30');
  assert.equal(similarEntry(poo('10:02', 'mum'), [gone], H), null);
});
