import React, { useEffect, useState } from 'react';
import { syncNow } from '../lib/sync';
import { Page, Segmented, Field, NotesField, useToast, useNow, Wave, useConfirm } from '../ui/ui';
import { ITimer, ICalendar, IBed, IPause, IPlay, IStop, ITrash, IMoon } from '../ui/icons';
import { useBaby } from '../ui/hooks';
import { upsertEntry, deleteEntry, restoreEntry, startSleep, pauseSleep, resumeSleep, stopSleep, discardSleep, sleepElapsed, sleepTimerTooLong, getState, live } from '../lib/store';
import { toLocalInput, fromLocalInput, formatClock, formatTime, formatDuration, dateKey } from '../lib/time';
import type { SleepEntry } from '../lib/types';
import { defaultTime } from './LogFeed';
import { StillCheck } from '../ui/still';
import { useNav, TAB_LABEL } from '../ui/nav';

function Ring({ fraction, children }: { fraction: number; children: React.ReactNode }) {
  const r = 96, c = 2 * Math.PI * r;
  return (
    <div className="ring">
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <circle cx="110" cy="110" r={r} className="ring-bg" />
        <circle cx="110" cy="110" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} transform="rotate(-90 110 110)" />
      </svg>
      <div className="ring-inner">{children}</div>
    </div>
  );
}

export function LogSleep({ entryId, draftId, onKey, onDone }: { entryId?: string; draftId?: string; onKey?: string; onDone: () => void }) {
  const ctx = useBaby(); const nav = useNav(); const toast = useToast(); const now = useNow(1000); const confirm = useConfirm();
  const existing: SleepEntry | undefined = entryId ? getState().sleeps[entryId] : undefined;
  // a sleep just undone from its "saved" toast: opened again as a new manual entry, filled in, to correct
  const draft: SleepEntry | undefined = !existing && draftId ? getState().sleeps[draftId] : undefined;
  const seed = existing ?? draft;
  const tz = ctx?.baby.timezone ?? 'UTC';
  const [mode, setMode] = useState<'timer' | 'manual'>(seed || onKey ? 'manual' : 'timer');
  const defStart = seed?.start_datetime ?? new Date(new Date(defaultTime(tz, onKey)).getTime() - 3600000).toISOString();
  const [start, setStart] = useState(toLocalInput(defStart, tz));
  const [end, setEnd] = useState(toLocalInput(seed?.end_datetime ?? defaultTime(tz, onKey), tz));
  const [notes, setNotes] = useState(seed?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);
  // a sleep timer left running over 24 hours: entered by hand instead, and the timer is discarded once that's saved
  const [replacing, setReplacing] = useState<SleepEntry | null>(null);
  // fetch the latest before anyone taps Start: another caregiver may have started a timer a moment ago
  useEffect(() => { syncNow().catch(() => { /* offline: the timer still works and syncs later */ }); }, []);
  if (!ctx) return null;
  const { baby, active, prefs } = ctx;
  const editingActive = existing && existing.status !== 'completed';

  const saveManual = async () => {
    setErr(null);
    let s: string, e: string;
    try { s = fromLocalInput(start, tz); e = fromLocalInput(end, tz); } catch (x: any) { return setErr(x.message); }
    if (new Date(e) <= new Date(s)) return setErr('End time must be after the start time.');
    if (new Date(e).getTime() > Date.now() + 5 * 60000) return setErr('End time can’t be in the future. Use the timer for an ongoing sleep.');
    if (new Date(e).getTime() - new Date(s).getTime() > 16 * 3600000) return setErr('That’s longer than 16 hours — please check the times.');
    const overlap = live(getState().sleeps, baby.baby_id).find(x => x.sleep_id !== existing?.sleep_id && x.sleep_id !== replacing?.sleep_id && x.end_datetime && new Date(x.start_datetime) < new Date(e) && new Date(x.end_datetime) > new Date(s));
    if (overlap && !(await confirm({ title: 'Overlapping sleep', text: `This overlaps another sleep (${formatTime(overlap.start_datetime, tz, prefs.time_format)}–${formatTime(overlap.end_datetime!, tz, prefs.time_format)}). Save anyway?`, ok: 'Save anyway' }))) return;
    const pauses = existing?.status === 'completed' ? (existing.pauses || []).filter(p => p.end && new Date(p.start) >= new Date(s) && new Date(p.end) <= new Date(e)) : [];
    const row: Partial<SleepEntry> = { ...(existing && !replacing ? { sleep_id: existing.sleep_id } : {}), baby_id: baby.baby_id, start_datetime: s, end_datetime: e, status: 'completed', pauses, notes: notes.trim() || null };
    row.duration_seconds = Math.round(sleepElapsed(row as SleepEntry));
    const id = upsertEntry('sleeps', row);
    if (replacing) discardSleep(replacing);
    toast(existing && !replacing ? 'Sleep updated' : 'Sleep saved', existing || replacing ? undefined : { label: 'Undo', run: () => { deleteEntry('sleeps', id); nav.push({ name: 'sleep', draftId: id }); } });
    onDone();
  };

  const timerView = () => {
    const a = active;
    if (!a) return (
      <div className="sleep-start">
        <Ring fraction={0}><IBed size={34} /><div className="timer-big">0:00</div><div className="muted small">Ready when baby falls asleep</div></Ring>
        <button className="btn primary block" onClick={() => { startSleep(baby.baby_id); toast('Sleep timer started'); }}><IPlay size={16} /> Start sleep</button>
      </div>
    );
    const el = sleepElapsed(a, now);
    if (sleepTimerTooLong(a, now)) return (
      <div className="sleep-start">
        <Ring fraction={1}><IBed size={34} /><div className="timer-big">24 h+</div><div className="muted small">Since {formatTime(a.start_datetime, tz, prefs.time_format)}</div></Ring>
        <p className="center">This sleep timer has been running for more than 24 hours, so it was probably left on. Enter when the sleep really ended, or discard it.</p>
        <button className="btn primary block" onClick={() => { setReplacing(a); setStart(toLocalInput(a.start_datetime, tz)); setEnd(toLocalInput(new Date(Math.min(Date.now(), new Date(a.start_datetime).getTime() + 3 * 3600000)).toISOString(), tz)); setMode('manual'); }}><ICalendar size={16} /> Enter the real times</button>
        <button className="link small" onClick={async () => { if (await confirm({ title: 'Discard this sleep timer?', text: 'Nothing will be saved.', ok: 'Discard', danger: true })) { discardSleep(a); onDone(); } }}>Discard timer</button>
      </div>
    );
    const lastPause = (a.pauses || []).reduce((m, p) => Math.max(m, Date.parse(p.start)), Date.parse(a.start_datetime) + 1000);
    return (
      <div className="sleep-start">
        <StillCheck kind="sleep" id={a.sleep_id} startedAt={a.start_datetime} earliestEnd={a.status === 'paused' ? lastPause : Date.parse(a.start_datetime) + 60000} tz={tz} fmt={prefs.time_format} now={now}
          onEnded={iso => { const d = stopSleep(a, iso); toast(`Sleep saved · ${formatDuration(d.duration_seconds || 0)}`); onDone(); }} />
        <Ring fraction={(el % 3600) / 3600 || 0.002}>
          <IBed size={34} />
          <div className="timer-big">{formatClock(el)}</div>
          <div className="muted small">{a.status === 'paused' ? 'Paused · started' : 'Since sleep started ·'} {formatTime(a.start_datetime, tz, prefs.time_format)}</div>
        </Ring>
        <div className="btn-row">
          {a.status === 'paused'
            ? <button className="btn soft" onClick={() => resumeSleep(a)}><IPlay size={16} /> Resume</button>
            : <button className="btn soft" onClick={() => pauseSleep(a)}><IPause size={16} /> Pause</button>}
          <button className="btn soft" onClick={() => { const d = stopSleep(a); toast(`Sleep saved · ${formatDuration(d.duration_seconds || 0)}`); onDone(); }}><IStop size={16} /> Stop</button>
        </div>
        <p className="muted small center">Paused time doesn’t count as sleep. If baby woke properly, stop and start a new session — interruptions are kept as separate sleeps.</p>
        <button className="link small" onClick={async () => { if (await confirm({ title: 'Discard this sleep timer?', text: 'Nothing will be saved.', ok: 'Discard', danger: true })) { discardSleep(a); onDone(); } }}>Discard timer</button>
      </div>
    );
  };

  // A running timer isn't cancelled by leaving it, so it gets "‹ Home" (where Back goes) instead of Cancel
  const running = !!active && !replacing && ((mode === 'timer' && !existing) || !!editingActive);
  return (
    <Page title={running ? 'Sleep' : existing ? 'Edit Sleep' : 'Add Sleep'} onCancel={running ? undefined : onDone} onBack={running ? onDone : undefined} backLabel={TAB_LABEL[nav.tab]} className="form-page"
      right={existing && !editingActive ? <button className="icon-btn danger" aria-label="Delete sleep" onClick={() => { deleteEntry('sleeps', existing.sleep_id); toast('Sleep deleted', { label: 'Undo', run: () => restoreEntry('sleeps', existing.sleep_id) }); onDone(); }}><ITrash /></button> : null}>
      {!existing && <Segmented size="lg" label="Logging method" value={mode} onChange={setMode} options={[{ value: 'timer', label: 'Timer', icon: <ITimer size={26} /> }, { value: 'manual', label: 'Manual', icon: <ICalendar size={26} /> }]} />}
      {((mode === 'timer' && !existing) || editingActive) && !replacing ? timerView() : (
        <>
          <Field label="Fell asleep"><input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></Field>
          <Field label="Woke up"><input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></Field>
          {(() => { try { const s = new Date(fromLocalInput(start, tz)), e = new Date(fromLocalInput(end, tz)); return e > s ? <p className="muted">Duration: <strong>{formatDuration((e.getTime() - s.getTime()) / 1000)}</strong>{dateKey(s, tz) !== dateKey(e, tz) ? ' · crosses midnight' : ''}</p> : null; } catch { return null; } })()}
          <NotesField rows={2} value={notes} onChange={setNotes} />
          {err && <div className="alert error" role="alert">{err}</div>}
          <button className="btn primary block" onClick={saveManual}>{existing && !replacing ? 'Save changes' : 'Save Sleep'}</button>
          {replacing && <button className="link small" onClick={() => setReplacing(null)}>Back to the timer</button>}
        </>
      )}
      <div className="moon-deco" aria-hidden="true"><IMoon size={56} /></div>
      <Wave tone="lav" />
    </Page>
  );
}
