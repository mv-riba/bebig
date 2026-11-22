// Switching between babies: a sheet listing every profile you can see, plus "Add a baby".
// Each baby keeps its own records, insights and Plus plan; the selected one is remembered per user on this device.
import React from 'react';
import { Sheet, useToast } from './ui';
import { useNav } from './nav';
import { ICheck, IPlus } from './icons';
import { BabyAvatar } from '../screens/Home';
import { useStore, accessibleBabies, selectedBaby, selectBaby, roleFor } from '../lib/store';
import { describeAge, daysBetween, todayKey } from '../lib/time';

export function BabySwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const babies = useStore(s => accessibleBabies(s));
  const current = useStore(s => selectedBaby(s));
  const paused = useStore(s => s.paused ?? []);
  const nav = useNav(); const toast = useToast();
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
                <span className="row-sub">{describeAge(daysBetween(b.date_of_birth, todayKey(b.timezone)))} · {roleFor(b.baby_id) === 'owner' ? 'Your profile' : 'Shared with you'}</span></span>
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
