/** Notes on an entry are kept short: they're quick reminders, not a diary (the database allows 2000). */
export const NOTES_MAX = 500;

// Input checks that mirror the database constraints (supabase/migrations). A value the server would reject
// must be caught here: otherwise the change is saved on the device, then refused on every sync attempt.
// Pure and framework-free (unit-tested in tests/validate.test.ts).

/** '' → null; '3,4' → 3.4; anything that isn't a finite number → NaN (so range checks fail). */
export function parseDecimal(v: string): number | null {
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** Longest baby name the app accepts. The database allows 80 (0001_init); 40 keeps names readable on every card. */
export const BABY_NAME_MAX = 40;

/** Error message for a baby name that's too long, or null if it's fine. Assumes the name isn't empty. */
export function babyNameError(name: string): string | null {
  return name.trim().length > BABY_NAME_MAX ? `Please keep the name to ${BABY_NAME_MAX} characters or fewer.` : null;
}

export interface BirthInput { ga_w: string; ga_d: string; bw: string; bl: string; bh: string }
export interface BirthDetails {
  gestational_age_weeks: number | null; gestational_age_days: number | null;
  birth_weight_grams: number | null; birth_length_mm: number | null; birth_head_circumference_mm: number | null;
}

const outside = (v: number | null, lo: number, hi: number) => v != null && (!Number.isFinite(v) || v < lo || v > hi);
const notWhole = (v: number | null) => v != null && !Number.isInteger(v);

/** Birth details as entered in the forms (kg, cm, weeks + days) → database values, or an error message. */
export function checkBirthDetails(f: BirthInput): { ok: true; value: BirthDetails } | { ok: false; error: string } {
  const gw = parseDecimal(f.ga_w), gd = parseDecimal(f.ga_d);
  const bw = parseDecimal(f.bw), bl = parseDecimal(f.bl), bh = parseDecimal(f.bh);
  if (outside(gw, 22, 44) || notWhole(gw)) return { ok: false, error: 'Gestational age weeks should be a whole number between 22 and 44.' };
  if (outside(gd, 0, 6) || notWhole(gd)) return { ok: false, error: 'Gestational age days should be a whole number from 0 to 6.' };
  if (gd != null && gw == null) return { ok: false, error: 'Add the weeks as well as the days of gestational age.' };
  // database: 300–7000 g, 250–650 mm, 200–450 mm
  if (outside(bw, 0.3, 7)) return { ok: false, error: 'Birth weight should be in kg (e.g. 3.4).' };
  if (outside(bl, 25, 65)) return { ok: false, error: 'Birth length should be in cm (e.g. 50).' };
  if (outside(bh, 20, 45)) return { ok: false, error: 'Head circumference should be in cm (e.g. 34).' };
  return { ok: true, value: {
    gestational_age_weeks: gw, gestational_age_days: gw != null ? gd ?? 0 : null,
    birth_weight_grams: bw != null ? Math.round(bw * 1000) : null,
    birth_length_mm: bl != null ? Math.round(bl * 10) : null,
    birth_head_circumference_mm: bh != null ? Math.round(bh * 10) : null,
  } };
}

/** Database limits for timers and amounts (feeding_entries ≤ 4 h per feed and side; extra_entries ≤ 24 h, numeric(10,2)). */
export const MAX_FEED_SECONDS = 4 * 3600;
export const MAX_EXTRA_SECONDS = 24 * 3600;
export const MAX_EXTRA_AMOUNT = 99_999_999;

/** A spreadsheet treats a cell starting with = + - @ (or a tab/CR) as a formula; prefix it so it shows as text. */
export function csvSafe(s: string): string { return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; }
