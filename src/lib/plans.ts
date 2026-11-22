// Bebig Plus — what's free, what's Plus, and the current plan of a baby profile (the family).
// Pure and framework-free (unit-tested). The server is the source of truth when cloud sync is on
// (supabase/migrations/0006_entitlements.sql → plus_status()); this file mirrors its rules for local mode,
// offline use and instant UI.
//
// Principle: logging, sync with one partner, safety information, basic summaries, export and full history
// are always free. Plus is about what Bebig does with the data.
import type { Data } from './calc';
import { dateKey, formatDateKey } from './time';

export type Feature =
  | 'predictions'      // "Next" tab, next likely events, estimate answers in the assistant
  | 'ai_phrasing'      // LLM-phrased assistant answers (server-enforced, the only real running cost)
  | 'long_trends'      // 4+ week trends and week-to-week comparisons (coming)
  | 'doctor_report'    // PDF report for doctor / neuvola visits (coming)
  | 'extra_caregivers'; // more than one caregiver besides the owner

export const PLUS_FEATURES: { id: Feature; title: string; text: string; soon?: boolean }[] = [
  { id: 'predictions', title: 'Predictions', text: 'Next feed, nap and poo, estimated from your baby’s own rhythm.' },
  { id: 'ai_phrasing', title: 'AI assistant', text: 'Friendly, plain-language answers to questions about your records.' },
  { id: 'long_trends', title: 'Long-range trends', text: 'How feeding and sleep change over weeks, not just days.', soon: true },
  { id: 'doctor_report', title: 'Doctor & neuvola report', text: 'A tidy PDF summary to take to check-ups.', soon: true },
  { id: 'extra_caregivers', title: 'Whole family', text: 'Add grandparents or a nanny — one plan covers everyone.' },
];

export const ALWAYS_FREE = [
  'All logging: feeds, sleep, poo, growth and timers',
  'Sync with a partner',
  'Health notices and WHO growth charts',
  'Daily summaries, patterns and 7-day trends',
  'Your full history and data export',
];

export const LIMITS = { free_caregivers: 1, plus_caregivers: 6, trial_days: 14, trial_min_logged_days: 10 };

export interface PlusStatus {
  plus: boolean;
  early_access: boolean;
  early_access_until: string | null;
  source: 'trial' | 'promo' | 'play' | 'stripe' | 'manual' | null;
  product_id?: string | null;
  status?: string | null;
  expires_at: string | null;
  trial_used: boolean;
  logged_days: number;
  trial_eligible: boolean;
  checked_at: string;
}

/** Distinct days (in the baby's time zone) with at least one feed, sleep or nappy logged. */
export function loggedDays(d: Data): number {
  const tz = d.baby.timezone; const days = new Set<string>();
  for (const f of d.feeds) days.add(dateKey(f.start_datetime, tz));
  for (const s of d.sleeps) days.add(dateKey(s.start_datetime, tz));
  for (const p of [...d.poos, ...(d.wet ?? [])]) days.add(dateKey(p.datetime, tz));
  return days.size;
}

const after = (iso: string | null | undefined, now: number) => !!iso && new Date(iso).getTime() > now;

/**
 * The plan to show right now. `cached` is the last status from the server (or the local-mode trial);
 * expiry is re-checked against the clock so an ended trial switches off offline too.
 */
export function resolveStatus(d: Data, cached: PlusStatus | undefined, now: number, earlyAccessFallback?: string | null): PlusStatus {
  const ea = cached?.early_access_until ?? earlyAccessFallback ?? null;
  const early_access = after(ea, now);
  const paidActive = !!cached?.source && (cached.expires_at == null || after(cached.expires_at, now)) && cached.status !== 'expired' && cached.status !== 'refunded';
  const days = Math.max(cached?.logged_days ?? 0, loggedDays(d));
  const trial_used = !!cached?.trial_used || cached?.source === 'trial';
  return {
    plus: early_access || paidActive,
    early_access, early_access_until: ea,
    source: paidActive ? cached!.source : null,
    product_id: paidActive ? cached?.product_id ?? null : null,
    status: paidActive ? cached?.status ?? 'active' : null,
    expires_at: paidActive ? cached!.expires_at : null,
    trial_used,
    logged_days: days,
    trial_eligible: !trial_used && !paidActive && days >= LIMITS.trial_min_logged_days,
    checked_at: cached?.checked_at ?? new Date(now).toISOString(),
  };
}

export function canUse(f: Feature, st: PlusStatus): boolean {
  void f; // every gated feature is part of Plus today; kept per-feature so tiers can differ later
  return st.plus;
}

export const caregiverLimit = (st: PlusStatus) => (st.plus ? LIMITS.plus_caregivers : LIMITS.free_caregivers);

/** A local-mode trial (no server). With cloud sync the server creates it (start_plus_trial). */
export function localTrial(d: Data, now: number, prev?: PlusStatus): PlusStatus {
  const base = resolveStatus(d, prev, now);
  if (base.trial_used) throw new Error('The free trial has already been used.');
  if (base.logged_days < LIMITS.trial_min_logged_days) throw new Error(`The free trial starts after ${LIMITS.trial_min_logged_days} days of logging.`);
  const expires_at = new Date(now + LIMITS.trial_days * 86400000).toISOString();
  return { ...base, plus: true, source: 'trial', status: 'active', expires_at, trial_used: true, trial_eligible: false, checked_at: new Date(now).toISOString() };
}

const daysLeft = (iso: string, now: number) => Math.max(1, Math.ceil((new Date(iso).getTime() - now) / 86400000));
// last day that is still included (an end of 1 Apr 00:00 reads "until 31 March")
const lastDay = (iso: string, tz: string) => formatDateKey(dateKey(new Date(new Date(iso).getTime() - 1), tz), 'long');

/** One line describing the plan, for Settings and the Plus page. */
export function planLabel(st: PlusStatus, now: number, tz: string): string {
  if (st.source === 'trial' && st.expires_at) { const n = daysLeft(st.expires_at, now); return `Free trial · ${n} day${n === 1 ? '' : 's'} left`; }
  if (st.source && st.source !== 'trial') return st.status === 'cancelled' && st.expires_at ? `Bebig Plus · until ${lastDay(st.expires_at, tz)}` : 'Bebig Plus';
  if (st.early_access && st.early_access_until) return `Plus free during early access · until ${lastDay(st.early_access_until, tz)}`;
  return 'Free plan';
}
