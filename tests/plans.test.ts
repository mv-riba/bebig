// Bebig Plus rules (lib/plans.ts): early access, trials, expiry, caregiver limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).BroadcastChannel = undefined;
const plans = await import('../src/lib/plans.ts');
const { resolveStatus, canUse, localTrial, loggedDays, caregiverLimit, planLabel, LIMITS } = plans;

const TZ = 'Europe/Helsinki';
const baby: any = { baby_id: 'b', name: 'Emma', date_of_birth: '2026-10-01', sex: 'female', timezone: TZ };
const NOW = Date.parse('2027-05-01T09:00:00Z');
const day = 86400000;
const feedsOnDays = (n: number) => Array.from({ length: n }, (_, i) => ({ feed_id: `f${i}`, baby_id: 'b', start_datetime: new Date(NOW - i * day).toISOString() }));
const data = (n: number): any => ({ baby, feeds: feedsOnDays(n), poos: [], sleeps: [] });

test('logged days count distinct local days across feeds, sleeps and nappies', () => {
  const d: any = { baby, feeds: [{ start_datetime: '2027-05-01T08:00:00Z' }, { start_datetime: '2027-05-01T10:00:00Z' }], sleeps: [{ start_datetime: '2027-04-30T22:30:00Z' }], poos: [], wet: [{ datetime: '2027-04-29T12:00:00Z' }] };
  // 22:30 UTC on 30 April is 01:30 on 1 May in Helsinki → same day as the feeds
  assert.equal(loggedDays(d), 2);
});

test('early access gives everyone Plus; it ends on its date', () => {
  const during = resolveStatus(data(1), undefined, NOW, '2027-05-31T21:00:00Z'); // 1 June 00:00 in Helsinki
  assert.equal(during.plus, true); assert.equal(during.early_access, true); assert.ok(canUse('predictions', during));
  const after = resolveStatus(data(1), undefined, NOW, '2027-04-01T00:00:00Z');
  assert.equal(after.plus, false); assert.equal(canUse('ai_phrasing', after), false);
  assert.match(planLabel(during, NOW, TZ), /early access · until Monday, 31 May/);
});

test('server status wins over the built-in early-access date', () => {
  const server: any = { plus: false, early_access: false, early_access_until: '2027-04-01T00:00:00Z', source: null, expires_at: null, trial_used: false, logged_days: 0, trial_eligible: false, checked_at: '' };
  assert.equal(resolveStatus(data(1), server, NOW, '2099-01-01T00:00:00Z').plus, false);
});

test('trial: needs enough logged days, runs 14 days, only once, ends offline', () => {
  assert.equal(resolveStatus(data(LIMITS.trial_min_logged_days - 1), undefined, NOW).trial_eligible, false);
  assert.throws(() => localTrial(data(3), NOW), /after 10 days/);
  const d = data(LIMITS.trial_min_logged_days);
  assert.equal(resolveStatus(d, undefined, NOW).trial_eligible, true);
  const trial = localTrial(d, NOW);
  assert.equal(trial.plus, true);
  assert.equal(Date.parse(trial.expires_at!) - NOW, LIMITS.trial_days * day);
  assert.match(planLabel(resolveStatus(d, trial, NOW + 3 * day), NOW + 3 * day, TZ), /11 days left/);
  assert.throws(() => localTrial(d, NOW + day, trial), /already been used/);
  const ended = resolveStatus(d, trial, NOW + 15 * day);
  assert.equal(ended.plus, false); assert.equal(ended.trial_used, true); assert.equal(ended.trial_eligible, false);
});

test('a paid plan stays on until it expires; refunds switch it off', () => {
  const paid: any = { plus: true, early_access: false, early_access_until: null, source: 'play', status: 'cancelled', expires_at: new Date(NOW + 5 * day).toISOString(), trial_used: true, logged_days: 30, trial_eligible: false, checked_at: '' };
  assert.equal(resolveStatus(data(1), paid, NOW).plus, true);
  assert.match(planLabel(resolveStatus(data(1), paid, NOW), NOW, TZ), /until/);
  assert.equal(resolveStatus(data(1), { ...paid, status: 'refunded' }, NOW).plus, false);
});

test('free families get one caregiver, Plus families more', () => {
  const free = resolveStatus(data(1), undefined, NOW, null);
  const plus = resolveStatus(data(1), undefined, NOW, '2099-01-01T00:00:00Z');
  assert.equal(caregiverLimit(free), 1);
  assert.ok(caregiverLimit(plus) > 1);
});
