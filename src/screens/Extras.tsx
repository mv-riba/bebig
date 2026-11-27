import React, { useState } from 'react';
import { Page, Field, Segmented, Sheet, Stepper, useToast, useConfirm, useNow, Row } from '../ui/ui';
import { IChevron, IPlus, ICheck, IDrop, IInfo, ITrash, ICrown } from '../ui/icons';
import { useBaby } from '../ui/hooks';
import { useNav, TAB_LABEL } from '../ui/nav';
import { upsertEntry, deleteEntry, restoreEntry, getState, updateBaby, useStore, startExtraTimer, pauseExtraTimer, resumeExtraTimer, stopExtraTimer, discardExtraTimer, extraTimerSeconds, extraTimersOf, timerStartedBy, live, currentUserId } from '../lib/store';
import { similarEntry, similarQuestion } from '../lib/duplicates';
import { IPlay, IPause, IStop } from '../ui/icons';
import { MAX_EXTRA_AMOUNT } from '../lib/validate';
import { overlappingExtras, mergeExtras, extraSpan } from '../lib/merge';
import { askMerge, applyMerge } from '../ui/overlap';
import { PRESETS, KIND_INFO, LEVELS, cap, setPreset, logExtraNow, logWetNow, oneTap, tileStatus, dailyEntryOn } from '../lib/extras';
import { toLocalInput, fromLocalInput, formatAgo, todayKey, dateKey, formatClock, formatTime, formatDuration } from '../lib/time';
import type { TrackerDef, TrackerIcon, TrackerKind, ExtraEntry, Level } from '../lib/types';
import { defaultTime } from './LogFeed';
import { usePlus, PlusLock, PlusBadge } from '../ui/plus';

// Extra trackers (bath, congestion, your own) are part of Bebig Plus. Wet nappies are core logging and stay free.
// Without Plus, existing extras stay visible and editable in history; only new trackers and new entries are locked.
const EXTRAS_LOCK_TEXT = 'Track baths, congestion or anything else you need, like vitamin D, drops, pumping or tummy time. Anything you’ve already logged stays in your history.';
function useCanExtras() { const plus = usePlus(); return plus ? plus.can('extras') : true; }

const S = ({ size = 22, children }: { size?: number; children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export function TrackerIconSvg({ icon, size = 22 }: { icon: TrackerIcon; size?: number }) {
  switch (icon) {
    case 'drop': return <S size={size}><path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5z" /></S>;
    case 'wind': return <S size={size}><path d="M3 8h11a3 3 0 1 0-3-3" /><path d="M3 12h15a3 3 0 1 1-3 3" /><path d="M3 16h7" /></S>;
    case 'pill': return <S size={size}><path d="M10.5 3.5a5 5 0 0 1 7 7l-7 7a5 5 0 0 1-7-7z" /><path d="M7 10l7 7" /></S>;
    case 'sun': return <S size={size}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></S>;
    case 'heart': return <S size={size}><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" /></S>;
    case 'bath': return <S size={size}><path d="M4 12h16v2a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" /><path d="M6 12V6a2 2 0 0 1 4 0" /><path d="M7 19l-1 2M17 19l1 2" /></S>;
    default: return <S size={size}><path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" /></S>;
  }
}
const ICONS: TrackerIcon[] = ['pill', 'drop', 'wind', 'bath', 'sun', 'heart', 'star'];

// ---------------- Settings → Extra trackers ----------------
export function ExtrasSettings({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const nav = useNav(); const toast = useToast(); const canX = useCanExtras();
  if (!ctx) return null;
  const { baby, allTrackers } = ctx;
  const preset = (p: 'bath' | 'congestion') => allTrackers.find(t => t.preset === p);
  const custom = allTrackers.filter(t => !t.preset);
  return (
    <Page title="Extra trackers" onBack={onBack}>
      <p className="muted small">Turn on only what you need. Feed, {baby.wet_tracking ? 'Nappy' : 'Poo'} and Sleep always stay front and centre — extras appear under <strong>Log something else</strong> on Home.</p>
      <div className="card list">
        <label className="row"><span className="row-ic xt-ic xt-wet"><IDrop size={20} /></span>
          <span className="row-main"><span className="row-title">Wet nappies</span><span className="row-sub">{baby.wet_tracking ? 'Nappies are logged as Wet / Poo / Both' : 'Turns “Poo” into “Nappy” with Wet / Poo / Both'}</span></span>
          <input type="checkbox" className="switch" checked={!!baby.wet_tracking} onChange={e => { updateBaby(baby.baby_id, { wet_tracking: e.target.checked }); toast(e.target.checked ? 'Wet nappy tracking on' : 'Wet nappy tracking off'); }} /></label>
        {canX && (['bath', 'congestion'] as const).map(p => (
          <label className="row" key={p}><span className="row-ic xt-ic"><TrackerIconSvg icon={PRESETS[p].icon} size={20} /></span>
            <span className="row-main"><span className="row-title">{PRESETS[p].name} <PlusBadge /></span><span className="row-sub">{PRESETS[p].hint}</span></span>
            <input type="checkbox" className="switch" checked={!!preset(p)?.enabled} onChange={e => setPreset(baby.baby_id, p, e.target.checked)} /></label>
        ))}
      </div>
      {!canX ? <PlusLock title="Extra trackers are part of Bebig Plus" text={EXTRAS_LOCK_TEXT} /> : <>
      <h2 className="sec-title">Your trackers <PlusBadge /></h2>
      {custom.length > 0 && (
        <div className="card list">{custom.map(t => (
          <div className="row" key={t.tracker_id}>
            <span className="row-ic xt-ic"><TrackerIconSvg icon={t.icon} size={20} /></span>
            <button className="row-main tap" style={{ textAlign: 'left' }} onClick={() => nav.push({ name: 'tracker', id: t.tracker_id })}>
              <span className="row-title">{t.name}</span><span className="row-sub">{KIND_INFO[t.kind].label}{t.unit ? ` · ${t.unit}` : ''} · tap to edit</span></button>
            <input type="checkbox" className="switch" aria-label={`${t.name} on`} checked={t.enabled} onChange={e => upsertEntry('trackers', { ...t, enabled: e.target.checked })} />
          </div>))}
        </div>
      )}
      <button className="btn dashed block" onClick={() => nav.push({ name: 'tracker' })}><IPlus size={18} /> Create your own tracker</button>
      <p className="muted small">For example Vitamin D (once a day), saline drops (just the time) or pumping (an amount in ml). Trackers are shared with everyone who has access to {baby.name}.</p>
      </>}
    </Page>
  );
}

// ---------------- Create / edit a tracker ----------------
export function TrackerEditor({ id, onDone }: { id?: string; onDone: () => void }) {
  const ctx = useBaby(); const toast = useToast(); const confirm = useConfirm(); const canX = useCanExtras();
  const ex: TrackerDef | undefined = id ? getState().trackers[id] : undefined;
  const [name, setName] = useState(ex?.name ?? '');
  const [icon, setIcon] = useState<TrackerIcon>(ex?.icon ?? 'pill');
  const [kind, setKind] = useState<TrackerKind>(ex?.kind ?? 'daily');
  const [unit, setUnit] = useState(ex?.unit ?? 'ml');
  const [err, setErr] = useState<string | null>(null);
  if (!ctx) return null;
  if (!ex && !canX) return <Page title="New tracker" onCancel={onDone}><PlusLock title="Extra trackers are part of Bebig Plus" text={EXTRAS_LOCK_TEXT} /></Page>;
  const save = () => {
    setErr(null);
    const n = name.trim();
    if (!n) return setErr('Give the tracker a name.');
    if (n.length > 40) return setErr('Keep the name under 40 characters.');
    if (kind === 'amount' && !unit.trim()) return setErr('Add a unit, e.g. ml or drops.');
    if (ctx.allTrackers.some(t => t.tracker_id !== ex?.tracker_id && t.name.toLowerCase() === n.toLowerCase())) return setErr('You already have a tracker with this name.');
    upsertEntry('trackers', { ...(ex ?? {}), baby_id: ctx.baby.baby_id, name: n, icon, kind: ex ? ex.kind : kind, unit: kind === 'amount' ? unit.trim().slice(0, 12) : null, preset: ex?.preset ?? null, enabled: ex?.enabled ?? true, sort: ex?.sort ?? 10 + ctx.allTrackers.length });
    toast(ex ? 'Tracker updated' : `${n} added — find it under Log something else`); onDone();
  };
  return (
    <Page title={ex ? 'Edit tracker' : 'New tracker'} onCancel={onDone} className="form-page"
      right={ex && !ex.preset ? <button className="icon-btn danger" aria-label="Delete tracker" onClick={async () => { if (await confirm({ title: `Delete “${ex.name}”?`, text: extraTimersOf()[ex.tracker_id] ? 'Its past entries will be hidden too, and its running timer will be discarded.' : 'Its past entries will be hidden too.', ok: 'Delete', danger: true })) { deleteEntry('trackers', ex.tracker_id); toast('Tracker deleted', { label: 'Undo', run: () => restoreEntry('trackers', ex.tracker_id) }); onDone(); } }}><ITrash /></button> : null}>
      <Field label="Name"><input value={name} maxLength={40} placeholder="e.g. Vitamin D" onChange={e => setName(e.target.value)} disabled={!!ex?.preset} /></Field>
      <Field label="Icon">
        <div className="icon-pick" role="radiogroup" aria-label="Icon">{ICONS.map(i => (
          <button key={i} type="button" role="radio" aria-checked={icon === i} aria-label={i} className={`icb ${icon === i ? 'on' : ''}`} onClick={() => setIcon(i)}><TrackerIconSvg icon={i} size={20} /></button>))}</div>
      </Field>
      <Field label="What do you want to record?" hint={ex ? '(can’t change after creating)' : undefined}>
        <div className="kinds" role="radiogroup" aria-label="Tracker type">
          {(Object.keys(KIND_INFO) as TrackerKind[]).map(k => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} disabled={!!ex && ex.kind !== k} className={`kind ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              <span className="radio" aria-hidden="true" /><span className="row-main"><span className="row-title">{KIND_INFO[k].label}</span><span className="row-sub">{KIND_INFO[k].hint}</span></span></button>))}
        </div>
      </Field>
      {kind === 'amount' && <Field label="Unit"><input value={unit} maxLength={12} placeholder="ml, drops, °C…" onChange={e => setUnit(e.target.value)} /></Field>}
      {err && <div className="alert error" role="alert">{err}</div>}
      <button className="btn primary block" onClick={save}>{ex ? 'Save changes' : 'Add tracker'}</button>
    </Page>
  );
}

// ---------------- Log / edit an extra entry ----------------
export function ExtraForm({ trackerId, entryId, draftId, onKey, onDone }: { trackerId?: string; entryId?: string; draftId?: string; onKey?: string; onDone: () => void }) {
  const ctx = useBaby(); const nav = useNav(); const toast = useToast(); const confirm = useConfirm(); const now = useNow(1000); const canX = useCanExtras();
  const timer = useStore(s => extraTimersOf(s)[trackerId ?? ''] ?? null);
  const ex: ExtraEntry | undefined = entryId ? getState().extras[entryId] : undefined;
  // the starting values: the entry being edited, or one just undone (opened again as a new entry to correct)
  const seed: ExtraEntry | undefined = ex ?? (draftId ? getState().extras[draftId] : undefined);
  const t: TrackerDef | undefined = getState().trackers[ex?.tracker_id ?? trackerId ?? ''];
  const tz = ctx?.baby.timezone ?? 'UTC';
  const [time, setTime] = useState(toLocalInput(seed?.datetime ?? defaultTime(tz, onKey), tz));
  const [value, setValue] = useState<string>(seed?.value_num != null ? String(seed.value_num) : '');
  const [mins, setMins] = useState<number | null>(seed?.duration_seconds != null ? Math.round(seed.duration_seconds / 60) : null);
  const [level, setLevel] = useState<Level | null>(seed?.level ?? null);
  const [notes, setNotes] = useState(seed?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);
  if (!ctx || !t) return null;
  // a running timer can always be stopped and saved, even if Plus ended while it ran
  if (!ex && !timer && !canX) return <Page title={t.name} onCancel={onDone}><PlusLock title="Extra trackers are part of Bebig Plus" text={EXTRAS_LOCK_TEXT} /></Page>;
  const save = async () => {
    setErr(null);
    let iso: string;
    try { iso = fromLocalInput(time, tz); } catch (x: any) { return setErr(x.message); }
    if (new Date(iso).getTime() > Date.now() + 5 * 60000) return setErr('Time can’t be in the future.');
    const num = value.trim() === '' ? null : Number(value.replace(',', '.'));
    if (t.kind === 'amount' && (num == null || !isFinite(num) || num < 0)) return setErr(`Enter the amount in ${t.unit}.`);
    if (t.kind === 'amount' && num! > MAX_EXTRA_AMOUNT) return setErr('That amount is too large — please check it.');
    if (t.kind === 'duration' && (mins == null || mins <= 0)) return setErr('Enter how many minutes.');
    if (t.kind === 'level' && !level) return setErr('Choose a level.');
    // "Once a day" trackers: only one entry per day, so every caregiver sees the same check-off
    const given = dailyEntryOn(t, ctx.extras.filter(e => e.extra_id !== ex?.extra_id), tz, dateKey(iso, tz));
    if (given) return setErr(`${t.name} was already given that day at ${formatTime(given.datetime, tz, ctx.prefs.time_format)}. Edit that entry instead.`);
    // a timed extra (e.g. a walk) saved over the time of one already logged: really one, so offer to merge them
    let askedOverlap = false;
    if (t.kind === 'duration') {
      const cand = { extra_id: ex?.extra_id ?? '', tracker_id: t.tracker_id, datetime: iso, duration_seconds: (mins ?? 0) * 60, notes: notes.trim() || null };
      const others = overlappingExtras(cand, ctx.extras);
      if (others.length) {
        const choice = await askMerge(confirm, t.name.toLowerCase(), others.map(o => { const [a, b] = extraSpan(o)!; return { start: new Date(a).toISOString(), end: new Date(b).toISOString() }; }), tz, ctx.prefs.time_format);
        if (choice === 'cancel') return;
        if (choice === 'merge') {
          let merged;
          try { merged = mergeExtras([...others, cand]); } catch (x: any) { return setErr(x.message); }
          const undo = applyMerge('extras', others, ex?.extra_id, { ...merged, baby_id: ctx.baby.baby_id, tracker_id: t.tracker_id, value_num: null, level: null });
          toast(`Merged into one ${t.name.toLowerCase()}`, { label: 'Undo', run: undo });
          onDone(); return;
        }
        askedOverlap = true;
      }
    }
    if (!ex && !askedOverlap) {
      const s = getState();
      const like = similarEntry({ kind: 'extra', e: { extra_id: '', tracker_id: t.tracker_id, datetime: iso } as ExtraEntry, t }, ctx.extras.filter(e => e.tracker_id === t.tracker_id).map(e => ({ kind: 'extra' as const, e, t })), tz);
      if (like && !(await confirm(similarQuestion(like, t.name.toLowerCase(), formatTime((like.e as ExtraEntry).datetime, tz, ctx.prefs.time_format), s.users, currentUserId())))) return;
    }
    const id = upsertEntry('extras', { ...(ex ?? {}), baby_id: ctx.baby.baby_id, tracker_id: t.tracker_id, datetime: iso,
      value_num: t.kind === 'amount' ? num : null, duration_seconds: t.kind === 'duration' ? (mins ?? 0) * 60 : null, level: t.kind === 'level' ? level : null, notes: notes.trim() || null });
    toast(ex ? `${t.name} updated` : `${t.name} logged`, ex ? undefined : { label: 'Undo', run: () => { deleteEntry('extras', id); nav.push({ name: 'extra', trackerId: t.tracker_id, draftId: id }); } });
    onDone();
  };
  const timerAllowed = t.kind === 'duration' && !ex && !onKey;
  const timerView = timerAllowed && (
    <div className="card timer-card">
      {!timer ? (
        <>
          <p className="muted small">Start a timer, or enter the minutes below.</p>
          <button className="btn soft" onClick={() => { startExtraTimer(ctx.baby.baby_id, t.tracker_id); toast(`${t.name} timer started — it keeps running if you close the app`); }}><IPlay size={16} /> Start timer</button>
        </>
      ) : (
        <>
          <div className="timer-big" aria-live="off">{formatClock(extraTimerSeconds(timer, now))}</div>
          <div className="muted small">{timer.segment_started_at ? 'Running' : 'Paused'} · started {formatTime(timer.started_at, tz, ctx.prefs.time_format)}{timerStartedBy(timer) ? ` by ${timerStartedBy(timer)}` : ''}</div>
          <div className="btn-row">
            {timer.segment_started_at
              ? <button className="btn soft" onClick={() => pauseExtraTimer(t.tracker_id)}><IPause size={16} /> Pause</button>
              : <button className="btn soft" onClick={() => resumeExtraTimer(t.tracker_id)}><IPlay size={16} /> Resume</button>}
            <button className="btn primary" onClick={() => { try { const r = stopExtraTimer(t.tracker_id, notes.trim() || null); if (!r) throw new Error('This timer has already been stopped.'); toast(`${t.name} saved · ${formatDuration(r.secs)}`, { label: 'Undo', run: () => { deleteEntry('extras', r.id); nav.push({ name: 'extra', trackerId: t.tracker_id, draftId: r.id }); } }); onDone(); } catch (x: any) { setErr(x.message); } }}><IStop size={16} /> Stop & save</button>
          </div>
          <button className="link small" onClick={async () => { if (await confirm({ title: `Discard the ${t.name} timer?`, text: 'Nothing will be saved.', ok: 'Discard', danger: true })) discardExtraTimer(t.tracker_id); }}>Discard timer</button>
        </>
      )}
    </div>
  );
  return (
    <Page title={ex ? `Edit ${t.name}` : t.name} onCancel={timer && !ex ? undefined : onDone} onBack={timer && !ex ? onDone : undefined} backLabel={TAB_LABEL[nav.tab]} className="form-page"
      right={ex ? <button className="icon-btn danger" aria-label="Delete entry" onClick={() => { deleteEntry('extras', ex.extra_id); toast('Entry deleted', { label: 'Undo', run: () => restoreEntry('extras', ex.extra_id) }); onDone(); }}><ITrash /></button> : null}>
      {timerView}
      {!timer && <>
      <Field label={t.kind === 'duration' ? 'Started' : 'Time'}><input type="datetime-local" value={time} onChange={e => setTime(e.target.value)} /></Field>
      {t.kind === 'amount' && <Field label={`Amount (${t.unit})`}><input inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} /></Field>}
      {t.kind === 'duration' && <Field label="Duration"><Stepper label="duration" value={mins} onChange={setMins} step={5} max={600} unit="min" /></Field>}
      {t.kind === 'level' && <Field label="Level"><Segmented label="Level" value={level} onChange={setLevel} options={LEVELS.map(l => ({ value: l, label: cap(l) }))} /></Field>}
      <Field label="Notes" hint="(optional)"><textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      {t.preset === 'congestion' && <div className="alert notice soft"><IInfo size={18} /><span>This is a record only. If you’re worried about your baby’s breathing or health, contact your doctor or another healthcare professional, or call your local emergency number if it feels urgent.</span></div>}
      {err && <div className="alert error" role="alert">{err}</div>}
      <button className="btn primary block" onClick={save}>{ex ? 'Save changes' : `Save ${t.name}`}</button>
      </>}
      {timer && <Field label="Notes" hint="(optional, saved with the timer)"><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></Field>}
      {timer && err && <div className="alert error" role="alert">{err}</div>}
    </Page>
  );
}

// ---------------- Home: "Log something else" sheet ----------------
export function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = useBaby(); const nav = useNav(); const toast = useToast(); const now = useNow(1000);
  const timers = useStore(s => extraTimersOf(s)); const canX = useCanExtras();
  if (!ctx) return null;
  const { baby, trackers, extras, data, prefs } = ctx; const tz = baby.timezone;
  const today = todayKey(tz);
  const wets = [...(data.wet ?? []), ...data.poos.filter(p => p.nappy_type === 'both')].sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime));
  const wetToday = wets.filter(p => dateKey(p.datetime, tz) === today).length;
  const lastWet = wets[wets.length - 1];
  const tap = (t: TrackerDef) => {
    // "Once a day" and already given today: don't log it twice, offer to edit today's entry instead
    const given = dailyEntryOn(t, extras, tz, today);
    if (given) {
      toast(`${t.name} already given today at ${formatTime(given.datetime, tz, prefs.time_format)}`, { label: 'Edit', run: () => nav.push({ name: 'extra', entryId: given.extra_id }) });
      onClose(); return;
    }
    if (!oneTap(t)) { onClose(); nav.push({ name: 'extra', trackerId: t.tracker_id }); return; }
    const id = logExtraNow(t);
    toast(t.kind === 'daily' ? `${t.name} ✓ logged` : `${t.name} logged`, { label: 'Undo', run: () => deleteEntry('extras', id) });
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Log something else">
      <div className="tiles">
        {baby.wet_tracking && (
          <button className="tile" onClick={() => { const id = logWetNow(baby.baby_id); toast('Wet nappy logged', { label: 'Undo', run: () => deleteEntry('poos', id) }); onClose(); }}>
            <span className="tile-ic xt-wet"><IDrop size={22} /></span><span className="tile-n">Wet nappy</span>
            <span className="tile-s">{wetToday} today{lastWet ? ` · ${formatAgo(lastWet.datetime, now)}` : ''}</span></button>
        )}
        {!canX && (
          <button className="tile tile-plus" onClick={() => { onClose(); nav.push({ name: 'plus' }); }} aria-label="Extra trackers are part of Bebig Plus. See what’s included">
            <ICrown size={14} className="tile-crown" /><span className="tile-ic"><TrackerIconSvg icon="bath" size={22} /></span><span className="tile-n">Extra trackers</span><span className="tile-s"><PlusBadge /></span></button>
        )}
        {canX && trackers.map(t => { const tm = timers[t.tracker_id]; const st = tm ? { text: `● ${formatClock(extraTimerSeconds(tm, now))}${tm.segment_started_at ? '' : ' paused'}`, done: false } : tileStatus(t, extras, tz, prefs.time_format, now); return (
          <button key={t.tracker_id} className={`tile ${st.done ? 'done' : ''}`} onClick={() => tap(t)} aria-label={`${t.name}: ${st.text}. ${t.kind === 'daily' && st.done ? 'Done for today' : oneTap(t) ? 'Tap to log now' : 'Tap to add'}`}>
            <ICrown size={14} className="tile-crown" /><span className="tile-ic">{st.done ? <ICheck size={22} /> : <TrackerIconSvg icon={t.icon} />}</span><span className="tile-n">{t.name}</span><span className="tile-s">{st.text}</span></button>); })}
        <button className="tile tile-manage" onClick={() => { onClose(); nav.push({ name: 'extras-settings' }); }}>
          <span className="tile-ic"><IPlus size={22} /></span><span className="tile-n">Manage</span><span className="tile-s">Add or hide</span></button>
      </div>
      <p className="muted small center">One tap logs it now. Tap the entry in today’s activity to change the time or add a note.</p>
    </Sheet>
  );
}

export { Row, IChevron };

/** Home: a slim bar for each running "How long" timer, so it isn't hidden in the sheet. */
export function RunningExtraTimers() {
  const ctx = useBaby(); const nav = useNav(); const now = useNow(1000);
  const timers = useStore(s => Object.values(extraTimersOf(s)));
  if (!ctx) return null;
  const mine = timers.filter(t => t.baby_id === ctx.baby.baby_id).map(t => ({ t, def: ctx.allTrackers.find(d => d.tracker_id === t.tracker_id) })).filter(x => x.def);
  if (!mine.length) return null;
  return <>{mine.map(({ t, def }) => (
    <button key={t.tracker_id} className="timer-bar" onClick={() => nav.push({ name: 'extra', trackerId: t.tracker_id })} aria-label={`${def!.name} timer ${t.segment_started_at ? 'running' : 'paused'}. Open to stop`}>
      <span className="tile-ic sm"><TrackerIconSvg icon={def!.icon} size={18} /></span>
      <span className="row-main"><span className="row-title">{def!.name}</span><span className="row-sub">{t.segment_started_at ? 'Running' : 'Paused'}</span></span>
      <span className="timer-bar-clock">{formatClock(extraTimerSeconds(t, now))}</span><span className="timer-bar-stop">Stop</span>
    </button>))}</>;
}
