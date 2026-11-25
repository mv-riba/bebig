import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBirthDetails, parseDecimal, csvSafe, babyNameError, BABY_NAME_MAX } from '../src/lib/validate.ts';
import { fromLocalInput } from '../src/lib/time.ts';

const empty = { ga_w: '', ga_d: '', bw: '', bl: '', bh: '' };

test('birth details: blank is fine, values convert to database units', () => {
  assert.deepEqual(checkBirthDetails(empty), { ok: true, value: { gestational_age_weeks: null, gestational_age_days: null, birth_weight_grams: null, birth_length_mm: null, birth_head_circumference_mm: null } });
  const r = checkBirthDetails({ ga_w: '39', ga_d: '2', bw: '3,45', bl: '50.5', bh: '34' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { gestational_age_weeks: 39, gestational_age_days: 2, birth_weight_grams: 3450, birth_length_mm: 505, birth_head_circumference_mm: 340 });
});

test('birth details: anything the database would refuse is caught before saving', () => {
  for (const bad of [
    { ga_d: '9', ga_w: '39' }, { ga_w: '38.5' }, { ga_w: '50' }, { ga_d: '2' }, // days without weeks
    { bl: '500' }, { bh: '3' }, { bw: '3400' }, { bw: 'abc' }, { bl: '50cm' },
  ]) assert.equal(checkBirthDetails({ ...empty, ...bad }).ok, false, JSON.stringify(bad));
});

test('parseDecimal: blank → null, junk → NaN', () => {
  assert.equal(parseDecimal('  '), null);
  assert.equal(parseDecimal('3,4'), 3.4);
  assert.ok(Number.isNaN(parseDecimal('x') as number));
});

test('CSV cells that look like formulas are exported as text', () => {
  assert.equal(csvSafe('=HYPERLINK("http://x")'), `'=HYPERLINK("http://x")`);
  assert.equal(csvSafe('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(csvSafe('very hungry'), 'very hungry');
});

test('a cleared date/time field gives a readable error', () => {
  assert.throws(() => fromLocalInput('', 'Europe/Helsinki'), /valid date and time/);
  assert.throws(() => fromLocalInput('2026-11-22T', 'Europe/Helsinki'), /valid date and time/);
  assert.equal(fromLocalInput('2026-11-22T10:30', 'Europe/Helsinki'), '2026-11-22T08:30:00.000Z');
});

test('baby name: up to 40 characters, with a message that states the limit', () => {
  assert.equal(BABY_NAME_MAX, 40);
  assert.equal(babyNameError('Emma'), null);
  assert.equal(babyNameError('a'.repeat(40)), null);
  assert.equal(babyNameError(`  ${'a'.repeat(40)}  `), null);
  assert.equal(babyNameError('a'.repeat(41)), 'Please keep the name to 40 characters or fewer.');
});
