import React, { useState } from 'react';
import { Page, Segmented, Field, useToast, Wave } from '../ui/ui';
import { IInfo, ITrash, IDrop, IPoo } from '../ui/icons';
import { useBaby } from '../ui/hooks';
import { upsertEntry, deleteEntry, restoreEntry, getState } from '../lib/store';
import { toLocalInput, fromLocalInput, daysBetween, dateKey } from '../lib/time';
import type { PooColour, PooEntry, PooSize, PooTexture, NappyType } from '../lib/types';
import { defaultTime } from './LogFeed';

export const COLOURS: { value: PooColour; label: string; hex: string }[] = [
  { value: 'yellow', label: 'Yellow', hex: '#F2CF6B' },
  { value: 'green', label: 'Green', hex: '#8FAE6E' },
  { value: 'brown', label: 'Brown', hex: '#8A5A33' },
  { value: 'pale', label: 'White / pale / grey', hex: '#ECE9E3' },
  { value: 'black', label: 'Black', hex: '#2B2724' },
  { value: 'red', label: 'Red', hex: '#B9473F' },
  { value: 'other', label: 'Other / unknown', hex: 'conic-gradient(#e8d7f0,#f6dcc8,#d6e4cf,#e8d7f0)' },
];
export const colourLabel = (c?: string | null) => COLOURS.find(x => x.value === c)?.label ?? '';

// NOTE: Notice copy is a draft and MUST be clinically reviewed before release (PRD 8.3).
export function healthNotice(colour: PooColour | null | undefined, ageDays: number): string | null {
  if (colour === 'pale') return 'White, pale or grey stools can sometimes be a sign of a problem that needs prompt checking. Please contact your GP, midwife or consultatiebureau promptly — even if your baby seems well.';
  if (colour === 'red') return 'Red or visibly bloody stools should be checked. Please contact your GP or healthcare provider promptly.';
  if (colour === 'black') return ageDays <= 4
    ? 'Dark, sticky stools (meconium) are common in the first few days after birth. If black stools continue or you’re unsure, contact your midwife or GP.'
    : 'Black, tarry stools after the first few days should be checked. Please contact your GP or healthcare provider promptly.';
  return null;
}

export function LogPoo({ entryId, onKey, onDone }: { entryId?: string; onKey?: string; onDone: () => void }) {
  const ctx = useBaby(); const toast = useToast();
  const existing: PooEntry | undefined = entryId ? getState().poos[entryId] : undefined;
  const tz = ctx?.baby.timezone ?? 'UTC';
  const [time, setTime] = useState(toLocalInput(existing?.datetime ?? defaultTime(tz, onKey), tz));
  const [colour, setColour] = useState<PooColour | null>(existing?.colour ?? null);
  const [size, setSize] = useState<PooSize | null>(existing?.size ?? null);
  const [texture, setTexture] = useState<PooTexture | null>(existing?.texture ?? null);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [ntype, setNtype] = useState<NappyType>(existing?.nappy_type ?? 'poo');
  const [err, setErr] = useState<string | null>(null);
  if (!ctx) return null;
  const { baby } = ctx;
  const iso = (() => { try { return fromLocalInput(time, tz); } catch { return new Date().toISOString(); } })();
  const ageDays = daysBetween(baby.date_of_birth, dateKey(iso, tz));
  const nappy = !!baby.wet_tracking || (existing?.nappy_type != null && existing.nappy_type !== 'poo');
  const wetOnly = nappy && ntype === 'wet';
  const notice = wetOnly ? null : healthNotice(colour, ageDays);
  const noun = !nappy ? 'Poo' : 'Nappy';

  const save = () => {
    setErr(null);
    if (new Date(iso).getTime() > Date.now() + 5 * 60000) return setErr('Time can’t be in the future.');
    const id = upsertEntry('poos', { ...(existing ? { poo_id: existing.poo_id } : {}), baby_id: baby.baby_id, datetime: iso, nappy_type: nappy ? ntype : 'poo',
      colour: wetOnly ? null : colour, size: wetOnly ? null : size, texture: wetOnly ? null : texture, notes: notes.trim() || null });
    toast(existing ? `${noun} updated` : wetOnly ? 'Wet nappy saved' : `${noun} saved`, existing ? undefined : { label: 'Undo', run: () => deleteEntry('poos', id) });
    onDone();
  };

  return (
    <Page title={existing ? `Edit ${noun}` : `Add ${noun}`} onCancel={onDone} className="form-page"
      right={existing ? <button className="icon-btn danger" aria-label="Delete entry" onClick={() => { deleteEntry('poos', existing.poo_id); toast('Entry deleted', { label: 'Undo', run: () => restoreEntry('poos', existing.poo_id) }); onDone(); }}><ITrash /></button> : null}>
      {nappy && <Segmented size="lg" label="Nappy type" value={ntype} onChange={setNtype} options={[{ value: 'wet', label: 'Wet', icon: <IDrop size={26} /> }, { value: 'poo', label: 'Poo', icon: <IPoo size={26} /> }, { value: 'both', label: 'Both', icon: <span className="both-ic"><IDrop size={20} /><IPoo size={20} /></span> }]} />}
      <Field label="Time"><input type="datetime-local" value={time} onChange={e => setTime(e.target.value)} /></Field>
      {!wetOnly && <>
      <Field label="Colour" hint={colour ? `· ${colourLabel(colour)}` : '(optional)'}>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {COLOURS.map(c => (
            <button key={c.value} type="button" role="radio" aria-checked={colour === c.value} className={`swatch ${colour === c.value ? 'on' : ''}`} onClick={() => setColour(colour === c.value ? null : c.value)}>
              <span className="swatch-dot" style={{ background: c.hex }} />
              <span className="swatch-label">{c.label.replace(' / pale / grey', '/pale').replace(' / unknown', '')}</span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Size" hint="(optional)"><Segmented label="Size" value={size} onChange={v => setSize(v === size ? null : v)} options={[{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }]} /></Field>
      <Field label="Texture" hint="(optional)"><Segmented label="Texture" value={texture} onChange={v => setTexture(v === texture ? null : v)} options={[{ value: 'soft', label: 'Soft' }, { value: 'loose', label: 'Loose/runny' }, { value: 'firm', label: 'Firm' }, { value: 'other', label: 'Other' }]} /></Field>
      </>}
      <Field label="Notes" hint="(optional)"><textarea rows={3} placeholder={wetOnly ? 'optional' : 'e.g. unusual colour…'} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      {notice && <div className="alert notice" role="note"><IInfo size={20} /><span>{notice}</span></div>}
      {!notice && !wetOnly && <p className="muted small">Colour alone can’t tell whether something is normal. If anything about your baby worries you, contact your healthcare provider.</p>}
      {err && <div className="alert error" role="alert">{err}</div>}
      <button className="btn primary block" onClick={save}>{existing ? 'Save changes' : `Save ${wetOnly ? 'Wet nappy' : noun}`}</button>
      <Wave tone="sage" />
    </Page>
  );
}
