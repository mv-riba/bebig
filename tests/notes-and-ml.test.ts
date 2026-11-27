import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Data } from '../src/lib/calc';

(globalThis as any).BroadcastChannel = undefined; // store.ts: no cross-tab channel in tests
const { roundMl, dayStats } = await import('../src/lib/calc.ts');
const { NOTES_MAX } = await import('../src/lib/validate.ts');

test('notes limit is well under the database limit (2000)', () => {
  assert.equal(NOTES_MAX, 500);
});

test('roundMl keeps one decimal without float noise', () => {
  assert.equal(roundMl(0.1 + 0.2), 0.3);
  assert.equal(roundMl(12.5 + 0.1), 12.6);
  assert.equal(roundMl(120), 120);
});

test('day totals add decimal bottle amounts cleanly', () => {
  const base = { baby_id: 'b', created_by: 'u', updated_by: 'u', created_at: '', updated_at: '', deleted_at: null, observations: [], notes: null, end_datetime: null, duration_seconds: null, breast_side: null, left_duration_seconds: null, right_duration_seconds: null } as any;
  const d = { baby: { baby_id: 'b', timezone: 'Europe/Helsinki', date_of_birth: '2026-11-01' }, feeds: [
    { ...base, feed_id: '1', feeding_type: 'formula', start_datetime: '2026-11-26T08:00:00Z', quantity_ml: 0.1 },
    { ...base, feed_id: '2', feeding_type: 'formula', start_datetime: '2026-11-26T10:00:00Z', quantity_ml: 0.2 },
    { ...base, feed_id: '3', feeding_type: 'expressed', start_datetime: '2026-11-26T12:00:00Z', quantity_ml: 12.5 },
  ], poos: [], sleeps: [], growth: [] } as unknown as Data;
  const st = dayStats(d, '2026-11-26', new Date('2026-11-26T20:00:00Z'));
  assert.equal(st.formulaMl, 0.3);
  assert.equal(st.expressedMl, 12.5);
});
