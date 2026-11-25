// Switching between babies: a sheet listing every profile you can see, plus "Add a baby".
// Each baby keeps its own records and insights; one Plus plan covers all of the owner's babies. The selected baby is remembered per user on this device.
import React from 'react';
import { Sheet, useToast, useNow } from './ui';
import { useNav } from './nav';
import { ICheck, IPlus } from './icons';
import { BabyAvatar } from '../screens/Home';
import { useStore, accessibleBabies, selectedBaby, selectBaby, roleFor, activeSleep, feedTimerOf, extraTimersOf, sleepElapsed, feedTimerTotals, extraTimerSeconds, live, type State } from '../lib/store';
import { formatClock } from '../lib/time';
import type { BabyProfile } from '../lib/types';
import { describeAge, daysBetween, todayKey } from '../lib/time';

export function BabySwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const babies = useStore(s => accessibleBabies(s));
  const current = useStore(s => selectedBaby(s));
  const paused = useStore(s => s.paused ?? []);
  const nav = useNav(); const toast = useToast(); const now = useNow(1000);
  const st = useStore(s => s);
  const running: Record<string, { label: string; secs: number }[]> = Object.fromEntries(babies.map(b => [b.baby_id, runningFor(st, b.baby_id, now)]));
  const pick = (id: string, name: string) => { if (id !== current?.baby_id) { selectBaby(id); nav.setTab('home'); toast(`Showing ${name}`); } onClose(); };
  const sorted = [...babies].sort((a, b) => b.date_of_birth.localeCompare(a.date_of_birth) || a.name.localeCompare(b.name));
  return (
    <Sheet open={open} onClose={onClose} title="Your babies">
      <div className="baby-list" role="list">
        {sorted.map(b => {
          const on = b.baby_id === current?.baby_id;
          return (
            <button key={b.baby_id} role="listitem" className={`baby-pick ${on ? 'on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => pick(b.baby_id, b.name)}>
              <BabyAvatar src={b.photograph_url} name={b.name} size={44} />
              <span className="row-main"><span className="row-title">{b.name}</span>
                <span className="row-sub">{describeAge(daysBetween(b.date_of_birth, todayKey(b.timezone)))} · {roleFor(b.baby_id) === 'owner' ? 'Your profile' : 'Shared with you'}</span>
                {running[b.baby_id]?.length ? <span className="row-sub running-now">● {describeRunning(running[b.baby_id])}</span> : null}</span>
              {on && <ICheck className="pick-check" />}
            </button>
          );
        })}
        {paused.map(p => (
          <div key={p.baby_id} role="listitem" className="baby-pick paused" aria-disabled="true">
            <BabyAvatar name={p.name} size={44} />
            <span className="row-main"><span className="row-title">{p.name}</span><span className="row-sub">Paused — {p.owner_name ?? 'the owner'}’s Bebig Plus has ended</span></span>
          </div>
        ))}
      </div>
      <button className="btn soft block" onClick={() => { onClose(); nav.push({ name: 'add-baby' }); }}><IPlus size={18} /> Add a baby</button>
      <p className="muted tiny center">Each baby has their own records, insights and sharing.</p>
    </Sheet>
  );
}

/** What's being timed for a baby right now (sleep, breastfeeding, extras), with how long so far. */
export function runningFor(s: State, baby_id: string, now = Date.now()): { label: string; secs: number }[] {
  const out: { label: string; secs: number }[] = [];
  const sl = activeSleep(baby_id, s); if (sl) out.push({ label: sl.status === 'paused' ? 'Sleep paused' : 'Sleeping', secs: sleepElapsed(sl, now) });
  const ft = feedTimerOf(baby_id, s); if (ft) out.push({ label: ft.segment_started_at ? 'Feeding' : 'Feed paused', secs: feedTimerTotals(ft, now).total });
  const names = new Map(live(s.trackers, baby_id).map(t => [t.tracker_id, t.name]));
  for (const t of Object.values(extraTimersOf(s))) if (t.baby_id === baby_id && names.has(t.tracker_id!)) out.push({ label: `${names.get(t.tracker_id!)}${t.segment_started_at ? '' : ' paused'}`, secs: extraTimerSeconds(t, now) });
  return out;
}
const describeRunning = (r: { label: string; secs: number }[]) => r.map(x => `${x.label} ${formatClock(x.secs)}`).join(' · ');

/** Home: timers running for the family's other babies, so a twin's sleep or feed isn't out of sight. Tap to switch. */
export function OtherBabiesTimers() {
  const now = useNow(1000); const toast = useToast();
  const babies = useStore(s => accessibleBabies(s)); const current = useStore(s => selectedBaby(s));
  const st = useStore(s => s);
  const others: { b: BabyProfile; r: { label: string; secs: number }[] }[] = babies.filter(b => b.baby_id !== current?.baby_id).map(b => ({ b, r: runningFor(st, b.baby_id, now) })).filter(x => x.r.length);
  if (!others.length) return null;
  return <>{others.map(({ b, r }) => (
    <button key={b.baby_id} className="timer-bar other-baby" onClick={() => { selectBaby(b.baby_id); toast(`Showing ${b.name}`); }} aria-label={`${b.name}: ${describeRunning(r)}. Switch to ${b.name}`}>
      <BabyAvatar src={b.photograph_url} name={b.name} size={32} />
      <span className="row-main"><span className="row-title">{b.name}</span><span className="row-sub">{r.map(x => x.label).join(' · ')}</span></span>
      <span className="timer-bar-clock">{formatClock(r[0].secs)}</span><span className="timer-bar-stop">Switch</span>
    </button>))}</>;
}
