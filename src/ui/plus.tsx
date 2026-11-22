// Bebig Plus UI: plan hook, badge, locked-feature card, trial nudge and the Plus page.
// Rules live in lib/plans.ts; the server enforces them when cloud sync is on.
import React, { useState } from 'react';
import { useBaby } from './hooks';
import { useNav } from './nav';
import { Page, useToast } from './ui';
import { ISparkle, ICheck, IX } from './icons';
import { useStore, getState, setPlusStatus } from '../lib/store';
import { resolveStatus, canUse, planLabel, localTrial, caregiverLimit, PLUS_FEATURES, ALWAYS_FREE, LIMITS, type Feature, type PlusStatus } from '../lib/plans';
import { config } from '../lib/config';
import { syncMode } from '../lib/sync';

export interface Plus { status: PlusStatus; can: (f: Feature) => boolean; label: string; caregivers: number }

export function usePlus(): Plus | null {
  const ctx = useBaby();
  const cached = useStore(s => (ctx ? s.plus?.[ctx.baby.baby_id] : undefined));
  if (!ctx) return null;
  const now = Date.now();
  const status = resolveStatus(ctx.data, cached, now, config.earlyAccessUntil);
  return { status, can: f => canUse(f, status), label: planLabel(status, now, ctx.baby.timezone), caregivers: caregiverLimit(status) };
}

/** Starts the family's one free trial (server-side with cloud sync, on this device in local mode). */
export async function startTrial(baby_id: string, data: Parameters<typeof localTrial>[0]) {
  if (syncMode() === 'remote') { const m = await import('../lib/supabase'); return m.startPlusTrial(baby_id); }
  const st = localTrial(data, Date.now(), getState().plus?.[baby_id]);
  setPlusStatus(baby_id, st); return st;
}

export function PlusBadge() { return <span className="badge plus-badge"><ISparkle size={11} /> Plus</span>; }

function TrialButton({ className = 'btn primary block' }: { className?: string }) {
  const ctx = useBaby(); const toast = useToast(); const [busy, setBusy] = useState(false);
  if (!ctx) return null;
  const go = async () => {
    setBusy(true);
    try { await startTrial(ctx.baby.baby_id, ctx.data); toast(`Your ${LIMITS.trial_days}-day Plus trial has started`); }
    catch (e: any) { toast(e.message); }
    finally { setBusy(false); }
  };
  return <button className={className} onClick={go} disabled={busy}>{busy ? 'Starting…' : `Try Plus free for ${LIMITS.trial_days} days`}</button>;
}

/** Shown in place of a Plus feature on the free plan. */
export function PlusLock({ title, text }: { title: string; text: string }) {
  const plus = usePlus(); const nav = useNav();
  if (!plus) return null;
  const left = Math.max(0, LIMITS.trial_min_logged_days - plus.status.logged_days);
  return (
    <div className="card plus-lock">
      <header><ISparkle className="spark" /><h3>{title}</h3><PlusBadge /></header>
      <p>{text}</p>
      {plus.status.trial_eligible ? <TrialButton />
        : !plus.status.trial_used && left > 0 ? <p className="muted small">Your free trial unlocks after {left} more day{left === 1 ? '' : 's'} of logging, when there’s enough data for predictions to be useful.</p>
          : null}
      <button className="link" onClick={() => nav.push({ name: 'plus' })}>What’s in Bebig Plus</button>
    </div>
  );
}

/** The "we've spotted a pattern" moment: offered once there are enough logged days. Dismissable per baby. */
export function TrialNudge() {
  const ctx = useBaby(); const plus = usePlus(); const nav = useNav();
  const key = ctx ? `bebig:trial-nudge:${ctx.baby.baby_id}` : '';
  const [hidden, setHidden] = useState(() => { try { return !!key && localStorage.getItem(key) === '1'; } catch { return false; } });
  if (!ctx || !plus || hidden || plus.status.plus || !plus.status.trial_eligible) return null;
  const close = () => { try { localStorage.setItem(key, '1'); } catch { /* */ } setHidden(true); };
  return (
    <div className="card plus-nudge" role="status">
      <button className="icon-btn nudge-x" aria-label="Not now" onClick={close}><IX size={18} /></button>
      <header><ISparkle className="spark" /><h3>We’re starting to see {ctx.baby.name.split(' ')[0]}’s rhythm</h3></header>
      <p>After {plus.status.logged_days} days of logging there’s enough data for predictions. Try Bebig Plus free for {LIMITS.trial_days} days — no payment details needed.</p>
      <TrialButton />
      <button className="link" onClick={() => nav.push({ name: 'plus' })}>What’s included</button>
    </div>
  );
}

export function PlusPage({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const plus = usePlus();
  if (!ctx || !plus) return null;
  const st = plus.status;
  return (
    <Page title="Bebig Plus" onBack={onBack} className="plus-page">
      <div className="card plus-hero">
        <ISparkle size={30} className="spark" />
        <h2>{plus.label}</h2>
        {st.early_access ? <p>Thank you for being an early Bebig family. Every Plus feature is free for you during early access.</p>
          : st.source === 'trial' ? <p>You’re trying every Plus feature. When the trial ends, everything you logged stays — only the Plus extras switch off.</p>
            : st.plus ? <p>Plus is on for {ctx.baby.name} and everyone who cares for {ctx.baby.name.split(' ')[0]}.</p>
              : <p>One plan covers the whole family — everyone with access to {ctx.baby.name} gets Plus.</p>}
        {!st.plus && st.trial_eligible && <TrialButton />}
        {!st.plus && !st.trial_eligible && !st.trial_used && <p className="muted small">The free trial unlocks after {LIMITS.trial_min_logged_days} days of logging ({st.logged_days} so far).</p>}
        {!st.plus && st.trial_used && <p className="muted small">Paid plans are coming with the Bebig app on Google Play.</p>}
      </div>
      <h2 className="sec-title">Plus</h2>
      <div className="card list">
        {PLUS_FEATURES.map(f => (
          <div key={f.id} className="row"><span className="row-ic"><ISparkle /></span>
            <span className="row-main"><span className="row-title">{f.title}{f.soon && <span className="badge">Coming soon</span>}</span><span className="row-sub">{f.text}</span></span></div>
        ))}
      </div>
      <h2 className="sec-title">Always free</h2>
      <div className="card list">
        {ALWAYS_FREE.map(t => <div key={t} className="row"><span className="row-ic"><ICheck /></span><span className="row-main"><span className="row-title">{t}</span></span></div>)}
      </div>
      <p className="muted tiny center">Health notices and anything you’ve logged are never behind a paywall.</p>
    </Page>
  );
}
