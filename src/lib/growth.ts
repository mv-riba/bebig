// WHO Child Growth Standards (0–24 months) using the LMS method.
// Weekly tables are used up to 13 weeks, monthly tables after, with linear interpolation of L, M and S.
// Percentiles are never invented: outside the supported range or with missing data, functions return null + a reason.
import who from '../data/who-lms.json';
import type { BabyProfile, Sex } from './types';
import { daysBetween } from './time';

export type Indicator = 'weight' | 'length' | 'head';
type Row = [number, number, number, number];
const TABLES = (who as any).indicators as Record<Indicator, Record<Sex, { weekly: Row[]; monthly: Row[] }>>;
export const WHO_SOURCE: string = (who as any).source;
export const MAX_DAYS = 730.5; // 24 months (24 × 30.4375 days), WHO table end used here

export const UNIT: Record<Indicator, string> = { weight: 'kg', length: 'cm', head: 'cm' };
export const LABEL: Record<Indicator, string> = { weight: 'Weight', length: 'Length', head: 'Head circ.' };

function interp(rows: Row[], x: number): { L: number; M: number; S: number } | null {
  if (x < rows[0][0] || x > rows[rows.length - 1][0]) return null;
  for (let i = 0; i < rows.length - 1; i++) {
    const [x0, L0, M0, S0] = rows[i], [x1, L1, M1, S1] = rows[i + 1];
    if (x >= x0 && x <= x1) {
      const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return { L: L0 + (L1 - L0) * f, M: M0 + (M1 - M0) * f, S: S0 + (S1 - S0) * f };
    }
  }
  const r = rows[rows.length - 1]; return { L: r[1], M: r[2], S: r[3] };
}

export function lms(ind: Indicator, sex: Sex, ageDays: number) {
  if (ageDays < 0 || ageDays > MAX_DAYS) return null;
  const t = TABLES[ind][sex];
  if (ageDays <= 91) return interp(t.weekly, ageDays / 7);
  return interp(t.monthly, ageDays / 30.4375);
}

const valueAtZ = (L: number, M: number, S: number, z: number) => (L === 0 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L));

export function zScore(ind: Indicator, sex: Sex, ageDays: number, x: number): number | null {
  const p = lms(ind, sex, ageDays); if (!p || !(x > 0)) return null;
  const { L, M, S } = p;
  let z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  // WHO restricted application of the LMS method beyond ±3 SD (for skewed indicators)
  if (ind === 'weight' && Math.abs(z) > 3) {
    const sd3 = valueAtZ(L, M, S, 3 * Math.sign(z)), sd2 = valueAtZ(L, M, S, 2 * Math.sign(z));
    z = Math.sign(z) * 3 + (x - sd3) / Math.abs(sd3 - sd2);
  }
  return z;
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, max error ~1.5e-7)
export function normCdf(z: number) {
  const s = Math.sign(z), x = Math.abs(z) / Math.SQRT2;
  const tt = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * tt - 1.453152027) * tt) + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}
export function percentile(ind: Indicator, sex: Sex, ageDays: number, x: number): number | null {
  const z = zScore(ind, sex, ageDays, x); return z == null ? null : normCdf(z) * 100;
}
const Z_FOR: Record<number, number> = { 3: -1.880794, 15: -1.036433, 50: 0, 85: 1.036433, 97: 1.880794 };
export const CURVE_PCTS = [3, 15, 50, 85, 97];
export function valueAtPercentile(ind: Indicator, sex: Sex, ageDays: number, pct: number) {
  const p = lms(ind, sex, ageDays); if (!p) return null; return valueAtZ(p.L, p.M, p.S, Z_FOR[pct]);
}

export function formatPercentile(p: number) {
  if (p < 0.1) return '<0.1st';
  if (p > 99.9) return '>99.9th';
  const r = p < 1 || p > 99 ? Math.round(p * 10) / 10 : Math.round(p);
  const n = Math.floor(r) % 100;
  const suf = n >= 11 && n <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as any)[Math.floor(r) % 10] || 'th';
  return `${r}${suf}`;
}

/** Age used for growth reference: corrected for prematurity (<37 weeks) where gestational age is known. */
export function growthAge(baby: BabyProfile, onKey: string) {
  const chrono = daysBetween(baby.date_of_birth, onKey);
  const gaW = baby.gestational_age_weeks;
  if (gaW != null && gaW < 37) {
    const gaDays = gaW * 7 + (baby.gestational_age_days || 0);
    const corrected = chrono - (280 - gaDays);
    return { days: corrected, chronological: chrono, corrected: true as const };
  }
  return { days: chrono, chronological: chrono, corrected: false as const };
}

export function toDisplay(ind: Indicator, raw: { weight_grams?: number | null; length_mm?: number | null; head_circumference_mm?: number | null }) {
  if (ind === 'weight') return raw.weight_grams != null ? raw.weight_grams / 1000 : null;
  if (ind === 'length') return raw.length_mm != null ? raw.length_mm / 10 : null;
  return raw.head_circumference_mm != null ? raw.head_circumference_mm / 10 : null;
}

export interface PercentileResult { value: number | null; percentile: number | null; ageDays: number; corrected: boolean; reason?: string }
export function assess(baby: BabyProfile, ind: Indicator, onKey: string, value: number | null): PercentileResult {
  const age = growthAge(baby, onKey);
  if (value == null) return { value, percentile: null, ageDays: age.days, corrected: age.corrected, reason: 'Not measured' };
  if (age.days < 0) return { value, percentile: null, ageDays: age.days, corrected: age.corrected, reason: 'Before term-equivalent age — WHO standards start at term' };
  if (age.days > MAX_DAYS) return { value, percentile: null, ageDays: age.days, corrected: age.corrected, reason: 'Beyond the 0–24 month range supported' };
  const p = percentile(ind, baby.sex, age.days, value);
  return { value, percentile: p, ageDays: age.days, corrected: age.corrected, reason: p == null ? 'Invalid value' : undefined };
}

/** Plausibility limits for input validation (not clinical thresholds). */
export const LIMITS = { weight_grams: [300, 25000], length_mm: [250, 1100], head_circumference_mm: [200, 550] } as const;
