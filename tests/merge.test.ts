// Overlapping feeds, sleeps and timed extras: found, and merged into one without counting the overlap twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlappingFeeds, mergeFeeds, overlappingSleeps, mergeSleeps, overlappingExtras, mergeExtras } from '../src/lib/merge.ts';

const at = (hm: string) => `2026-11-26T${hm}:00.000Z`;
const min = (m: number) => m * 60;
const breast = (id: string, from: string, mins: number, side: 'left' | 'right', extra: any = {}) => ({ feed_id: id, baby_id: 'b', feeding_type: 'breast', start_datetime: at(from),
  end_datetime: new Date(Date.parse(at(from)) + mins * 60000).toISOString(), duration_seconds: min(mins), breast_side: side,
  left_duration_seconds: side === 'left' ? min(mins) : null, right_duration_seconds: side === 'right' ? min(mins) : null, observations: [], ...extra }) as any;

test('feed timer stopped, new one started, its start moved back before the first ended: found and merged', () => {
  const a = breast('a', '14:00', 15, 'left');          // 14:00–14:15 left
  const b = breast('b', '14:10', 20, 'right');         // moved back to 14:10, 20 min right → 14:10–14:30
  assert.deepEqual(overlappingFeeds(b, [a, b]).map(f => f.feed_id), ['a']);
  const m = mergeFeeds([a, b]);
  assert.equal(m.start_datetime, at('14:00')); assert.equal(m.end_datetime, at('14:30'));
  assert.equal(m.duration_seconds, min(30));            // 35 min of timer time can't fit in 30 min: overlap not counted twice
  assert.equal(m.breast_side, 'both');
  assert.equal(m.left_duration_seconds! + m.right_duration_seconds!, min(30));
  assert.ok(Math.abs(m.left_duration_seconds! - min(30) * 15 / 35) <= 1);
});
test('a gap inside the merged feed (paused timers) keeps the real feeding time', () => {
  const a = breast('a', '14:00', 10, 'left', { end_datetime: at('14:20') }); // 10 min timed, paused, ended 14:20
  const b = breast('b', '14:15', 10, 'left');                               // 14:15–14:25
  const m = mergeFeeds([a, b]);
  assert.equal(m.duration_seconds, min(20)); assert.equal(m.breast_side, 'left'); assert.equal(m.right_duration_seconds, 0);
});
test('not overlapping: back to back, different feed types, a deleted feed, a bottle with no end time', () => {
  const a = breast('a', '14:00', 15, 'left');
  assert.equal(overlappingFeeds(breast('b', '14:15', 10, 'left'), [a]).length, 0);
  assert.equal(overlappingFeeds({ ...breast('b', '14:10', 10, 'left'), feeding_type: 'formula', quantity_ml: 60 }, [a]).length, 0);
  assert.equal(overlappingFeeds(breast('b', '14:10', 10, 'left'), [{ ...a, deleted_at: at('15:00') }]).length, 0);
  const bottle = { feed_id: 'c', feeding_type: 'formula', start_datetime: at('14:05'), end_datetime: null, quantity_ml: 60 } as any;
  assert.equal(overlappingFeeds(bottle, [{ ...a, feeding_type: 'formula', quantity_ml: 30 }]).length, 0);
});
test('editing a feed never finds itself', () => {
  const a = breast('a', '14:00', 15, 'left');
  assert.equal(overlappingFeeds({ ...a, start_datetime: at('13:55') }, [a]).length, 0);
});
test('bottles add up the ml; over 500 ml or 4 hours is refused', () => {
  const f = (id: string, from: string, to: string, ml: number) => ({ feed_id: id, feeding_type: 'formula', start_datetime: at(from), end_datetime: at(to), quantity_ml: ml, observations: ['Hungry'], notes: 'n' + id }) as any;
  const m = mergeFeeds([f('a', '10:00', '10:20', 90), f('b', '10:10', '10:30', 60)]);
  assert.equal(m.quantity_ml, 150); assert.equal(m.end_datetime, at('10:30')); assert.deepEqual(m.observations, ['Hungry']); assert.equal(m.notes, 'na\nnb');
  assert.throws(() => mergeFeeds([f('a', '10:00', '10:20', 300), f('b', '10:10', '10:30', 300)]), /500 ml/);
  assert.throws(() => mergeFeeds([breast('a', '10:00', 150, 'left'), breast('b', '12:00', 150, 'left')]), /4 hours/);
});
test('three overlapping feeds merge into one', () => {
  const a = breast('a', '14:00', 10, 'left'), b = breast('b', '14:05', 10, 'right'), c = breast('c', '14:12', 10, 'left');
  assert.deepEqual(overlappingFeeds(c, [a, b]).map(x => x.feed_id), ['b']);
  assert.deepEqual(overlappingFeeds({ ...c, start_datetime: at('14:02') }, [a, b]).map(x => x.feed_id), ['a', 'b']);
  const m = mergeFeeds([a, b, c]);
  assert.equal(m.start_datetime, at('14:00')); assert.equal(m.end_datetime, at('14:22')); assert.equal(m.duration_seconds, min(22));
});

const sleep = (id: string, from: string, to: string, pauses: [string, string][] = []) => ({ sleep_id: id, baby_id: 'b', start_datetime: at(from), end_datetime: at(to), status: 'completed',
  pauses: pauses.map(([s, e]) => ({ start: at(s), end: at(e) })) }) as any;
test('sleeps: overlap found (finished ones only), merged without double-counting, pauses kept', () => {
  const a = sleep('a', '13:00', '14:00', [['13:20', '13:30']]); // 50 min asleep
  const b = sleep('b', '13:45', '14:30');                         // moved back to 13:45
  const running = { ...sleep('r', '13:50', '14:00'), status: 'active', end_datetime: null };
  assert.deepEqual(overlappingSleeps(b, [a, b, running]).map(x => x.sleep_id), ['a']);
  const m = mergeSleeps([a, b]);
  assert.equal(m.start_datetime, at('13:00')); assert.equal(m.end_datetime, at('14:30'));
  assert.deepEqual(m.pauses, [{ start: at('13:20'), end: at('13:30') }]);
  assert.equal(m.duration_seconds, min(80));
});
test('sleeps: a pause in one is covered by the other being asleep', () => {
  const a = sleep('a', '13:00', '14:00', [['13:40', '13:50']]), b = sleep('b', '13:35', '14:10');
  const m = mergeSleeps([a, b]);
  assert.deepEqual(m.pauses, []); assert.equal(m.duration_seconds, min(70));
});
test('sleeps: back to back is not an overlap; skip id is ignored; over 16 h refused', () => {
  assert.equal(overlappingSleeps(sleep('b', '14:00', '15:00'), [sleep('a', '13:00', '14:00')]).length, 0);
  assert.equal(overlappingSleeps(sleep('b', '13:30', '15:00'), [sleep('a', '13:00', '14:00')], 'a').length, 0);
  assert.throws(() => mergeSleeps([{ ...sleep('a', '00:00', '09:00') }, { ...sleep('b', '08:00', '17:30') }]), /16 hours/);
});

test('timed extras (a walk): overlap found per tracker, merged from first start to last end', () => {
  const w = (id: string, from: string, mins: number, tr = 'walk') => ({ extra_id: id, tracker_id: tr, datetime: at(from), duration_seconds: min(mins) }) as any;
  const a = w('a', '10:00', 30), b = w('b', '10:20', 25);
  assert.deepEqual(overlappingExtras(b, [a]).map(x => x.extra_id), ['a']);
  assert.equal(overlappingExtras(b, [w('a', '10:00', 30, 'bath')]).length, 0);
  assert.equal(overlappingExtras(w('b', '10:30', 10), [a]).length, 0);
  const m = mergeExtras([a, b]);
  assert.equal(m.datetime, at('10:00')); assert.equal(m.duration_seconds, min(45));
});
