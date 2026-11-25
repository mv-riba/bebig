import React, { useState, useEffect } from 'react';
import { Page, Segmented, Chip, Field, Stepper, useToast, useNow, Wave, useConfirm } from '../ui/ui';
import { IBreast, IBottle, IFormula, IPlay, IPause, IStop, ITrash } from '../ui/icons';
import { useBaby } from '../ui/hooks';
import { upsertEntry, deleteEntry, restoreEntry, startFeedTimer, pauseFeedTimer, resumeFeedTimer, switchFeedSide, discardFeedTimer, stopFeedTimer, feedTimerTotals, timerStartedBy, getState, live, currentUserId, earliestTimerEnd } from '../lib/store';
import { StillCheck } from '../ui/still';
import { similarEntry, similarQuestion } from '../lib/duplicates';
import { toLocalInput, fromLocalInput, formatClock, formatTime, dayStart, zonedParts } from '../lib/time';
import type { FeedingEntry, FeedingType } from '../lib/types';
import { MAX_FEED_SECONDS } from '../lib/validate';

export const OBSERVATIONS = ['Very hungry', 'Hungry', 'Not very hungry', 'Fell asleep during feeding', 'Difficult feeding', 'Other'];

/** Default time for a new entry: now, or the same clock time on a past day chosen in the calendar. */
export function defaultTime(tz: string, onKey?: string) {
  if (!onKey) return new Date().toISOString();
  const p = zonedParts(new Date(), tz);
  return new Date(dayStart(onKey, tz).getTime() + (p.h * 60 + p.mi) * 60000).toISOString();
}

export function LogFeed({ entryId, onKey, onDone }: { entryId?: string; onKey?: string; onDone: () => void }) {
  const ctx = useBaby(); const toast = useToast(); const now = useNow(1000); const confirm = useConfirm();
  const existing: FeedingEntry | undefined = entryId ? getState().feeds[entryId] : undefined;
  const pref = ctx?.baby.feeding_preference ?? 'combination';
  const allowed: FeedingType[] = pref === 'breast' ? ['breast'] : pref === 'formula' ? ['formula'] : ['breast', 'expressed', 'formula'];
  if (existing && !allowed.includes(existing.feeding_type)) allowed.push(existing.feeding_type); // preserve historical types
  // a breastfeeding timer still running (e.g. the preference was changed to formula meanwhile) must stay reachable
  const runningFeed = !existing && !!ctx?.feedTimer;
  if (runningFeed && !allowed.includes('breast')) allowed.unshift('breast');
  const tz = ctx?.baby.timezone ?? 'UTC';

  const [type, setType] = useState<FeedingType>(existing?.feeding_type ?? (runningFeed ? 'breast' : allowed[0]));
  const [start, setStart] = useState(toLocalInput(existing?.start_datetime ?? defaultTime(tz, onKey), tz));
  const [end, setEnd] = useState(existing?.end_datetime && existing.feeding_type !== 'breast' ? toLocalInput(existing.end_datetime, tz) : '');
  const [durMin, setDurMin] = useState<number | null>(existing?.duration_seconds != null ? Math.round(existing.duration_seconds / 60) : null);
  const [left, setLeft] = useState<number | null>(existing?.left_duration_seconds != null ? Math.round(existing.left_duration_seconds / 60) : null);
  const [right, setRight] = useState<number | null>(existing?.right_duration_seconds != null ? Math.round(existing.right_duration_seconds / 60) : null);
  const inferSide = (e?: FeedingEntry) => e?.breast_side ?? (e && e.left_duration_seconds && e.right_duration_seconds ? 'both' : e?.left_duration_seconds ? 'left' : e?.right_duration_seconds ? 'right' : null);
  const [side, setSide] = useState<'left' | 'right' | 'both' | null>(inferSide(existing));
  const [qty, setQty] = useState<number | null>(existing?.quantity_ml ?? null);
  const [obs, setObs] = useState<string[]>(existing?.observations ?? []);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);

  // keep total in sync with per-side durations when those are used
  useEffect(() => { if (side === 'both' && (left != null || right != null)) setDurMin((left || 0) + (right || 0)); }, [left, right, side]);

  if (!ctx) return null;
  const { baby, feedTimer } = ctx;
  const timer = !existing && type === 'breast' ? feedTimer : null;
  const totals = timer ? feedTimerTotals(timer, now) : null;

  /** endAt: when a timer feed really finished ("Finished earlier"); default now */
  const save = async (fromTimer = false, endAt?: string) => {
    setErr(null);
    try {
      let row: Partial<FeedingEntry> = { baby_id: baby.baby_id, feeding_type: type, observations: obs, notes: notes.trim() || null };
      if (existing) row.feed_id = existing.feed_id;
      if (fromTimer && timer) {
        const endMs = endAt ? Date.parse(endAt) : Date.now();
        const t = feedTimerTotals(timer, endMs);
        // the database keeps feeds up to 4 hours; a longer timer was almost certainly left running
        if (t.total > MAX_FEED_SECONDS) throw new Error('This timer has run for over 4 hours — it was probably left running. Discard it and enter the feed manually.');
        const sided = t.left + t.right > 0;
        row = { ...row, start_datetime: timer.started_at, end_datetime: new Date(endMs).toISOString(), duration_seconds: Math.round(t.total),
          breast_side: t.left > 0 && t.right > 0 ? 'both' : t.left > 0 ? 'left' : t.right > 0 ? 'right' : null,
          left_duration_seconds: sided ? Math.round(t.left) : null, right_duration_seconds: sided ? Math.round(t.right) : null, quantity_ml: null };
      } else {
        const s = fromLocalInput(start, tz);
        if (new Date(s).getTime() > Date.now() + 5 * 60000) throw new Error('Start time can’t be in the future.');
        row.start_datetime = s;
        if (type === 'breast') {
          const d = durMin != null ? durMin * 60 : null;
          if (d != null && (d < 0 || d > MAX_FEED_SECONDS)) throw new Error('Duration should be between 0 and 4 hours.');
          if (side === 'both' && ((left ?? 0) * 60 > MAX_FEED_SECONDS || (right ?? 0) * 60 > MAX_FEED_SECONDS)) throw new Error('Each side should be at most 4 hours.');
          row.duration_seconds = d; row.end_datetime = d != null ? new Date(new Date(s).getTime() + d * 1000).toISOString() : null;
          row.breast_side = side;
          row.left_duration_seconds = side === 'both' ? (left != null ? left * 60 : null) : side === 'left' ? d : null;
          row.right_duration_seconds = side === 'both' ? (right != null ? right * 60 : null) : side === 'right' ? d : null;
          row.quantity_ml = null;
        } else {
          if (qty == null || qty <= 0) throw new Error('Please enter the quantity in ml.');
          if (qty > 500) throw new Error('Quantity looks too large — please check (max 500 ml).');
          row.quantity_ml = qty; row.duration_seconds = null; row.breast_side = null; row.left_duration_seconds = null; row.right_duration_seconds = null;
          if (end) { const e = fromLocalInput(end, tz); if (new Date(e) <= new Date(s)) throw new Error('End time must be after the start time.'); row.end_datetime = e; } else row.end_datetime = null;
        }
      }
      // another caregiver (or you) may have logged this feed already, e.g. both phones at once or one offline
      if (!fromTimer && !existing) {
        const s = getState(); const like = similarEntry({ kind: 'feed', e: row as FeedingEntry }, live(s.feeds, baby.baby_id).map(e => ({ kind: 'feed' as const, e })), tz);
        if (like && !(await confirm(similarQuestion(like, `a ${row.feeding_type === 'breast' ? 'breastfeed' : row.feeding_type === 'formula' ? 'formula feed' : 'feed of expressed milk'}`, formatTime((like.e as FeedingEntry).start_datetime, tz, s.prefs[currentUserId() ?? '']?.time_format), s.users, currentUserId())))) return;
      }
      // from the timer: saved together with the Stop, so two caregivers stopping it can't save the feed twice
      const id = fromTimer ? stopFeedTimer(baby.baby_id, row, endAt) : upsertEntry('feeds', row);
      if (!id) throw new Error('This timer has already been stopped.');
      toast(existing ? 'Feed updated' : 'Feed saved', existing ? undefined : { label: 'Undo', run: () => deleteEntry('feeds', id) });
      onDone();
    } catch (e: any) { setErr(e.message); }
  };

  const typeOpts = [
    { value: 'breast' as const, label: 'Breastfed', icon: <IBreast size={26} /> },
    { value: 'expressed' as const, label: 'Expressed milk', icon: <IBottle size={26} /> },
    { value: 'formula' as const, label: 'Formula', icon: <IFormula size={26} /> },
  ].filter(o => allowed.includes(o.value));

  return (
    <Page title={existing ? 'Edit Feed' : 'Add Feed'} onCancel={onDone} className="form-page"
      right={existing ? <button className="icon-btn danger" aria-label="Delete feed" onClick={() => { deleteEntry('feeds', existing.feed_id); toast('Feed deleted', { label: 'Undo', run: () => restoreEntry('feeds', existing.feed_id) }); onDone(); }}><ITrash /></button> : null}>
      {typeOpts.length > 1 && <Segmented size="lg" label="Feeding type" value={type} onChange={v => { if (!timer) setType(v); }} options={typeOpts} />}

      {type === 'breast' && !existing && (
        <div className="card timer-card">
          {!timer ? (
            <>
              <p className="muted small">Start a timer on a side, or enter the feed manually below (you can still choose left, right or both).</p>
              <div className="btn-row">
                <button className="btn soft" onClick={() => startFeedTimer(baby.baby_id, 'left')}><IPlay size={16} /> Left</button>
                <button className="btn soft" onClick={() => startFeedTimer(baby.baby_id, 'right')}><IPlay size={16} /> Right</button>
                <button className="btn soft" onClick={() => startFeedTimer(baby.baby_id, null)}><IPlay size={16} /> Timer</button>
              </div>
            </>
          ) : (
            <>
              <StillCheck kind="feed" id={timer.timer_id} startedAt={timer.started_at} earliestEnd={earliestTimerEnd(timer)} tz={tz} fmt={ctx.prefs.time_format} now={now}
                onEnded={iso => {
                  // checked here so the message shows in the card, next to the time that needs changing
                  if (feedTimerTotals(timer, Date.parse(iso)).total > MAX_FEED_SECONDS) throw new Error('A feed can be at most 4 hours. Choose an earlier end, or discard the timer and enter the feed by hand.');
                  save(true, iso);
                }} />
              <div className="timer-big" aria-live="off">{formatClock(totals!.total)}</div>
              <div className="muted small">{timer.segment_started_at ? 'Running' : 'Paused'}{timer.side ? ` · ${timer.side} side` : ''}{totals!.left + totals!.right > 0 ? ` · L ${formatClock(totals!.left)} · R ${formatClock(totals!.right)}` : ''}</div>
              {timerStartedBy(timer) && <div className="muted small">Started by {timerStartedBy(timer)} · {formatTime(timer.started_at, tz, ctx.prefs.time_format)}</div>}
              <Segmented label="Breast side" value={timer.side} onChange={v => switchFeedSide(baby.baby_id, v)} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />
              <div className="btn-row">
                {timer.segment_started_at
                  ? <button className="btn soft" onClick={() => pauseFeedTimer(baby.baby_id)}><IPause size={16} /> Pause</button>
                  : <button className="btn soft" onClick={() => resumeFeedTimer(baby.baby_id)}><IPlay size={16} /> Resume</button>}
                <button className="btn primary" onClick={() => save(true)}><IStop size={16} /> Stop & save</button>
              </div>
              <button className="link small" onClick={async () => { if (await confirm({ title: 'Discard this timer?', text: 'Nothing will be saved.', ok: 'Discard', danger: true })) discardFeedTimer(baby.baby_id); }}>Discard timer</button>
            </>
          )}
        </div>
      )}

      {!timer && (
        <>
          <Field label="Start time"><input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></Field>
          {type === 'breast' ? (
            <>
              <Field label="Breast" hint="(optional)">
                <Segmented label="Breast side" value={side} onChange={v => setSide(v === side ? null : v)} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'both', label: 'Both' }]} />
              </Field>
              {side === 'both' && (
                <div className="two">
                  <Field label="Left" hint="(optional)"><Stepper label="left duration" value={left} onChange={setLeft} unit="min" max={180} /></Field>
                  <Field label="Right" hint="(optional)"><Stepper label="right duration" value={right} onChange={setRight} unit="min" max={180} /></Field>
                </div>
              )}
              <Field label={side === 'both' ? 'Total duration' : 'Duration'} hint="(optional)">
                <Stepper label="duration" value={durMin} onChange={v => { if (side === 'both') { setLeft(null); setRight(null); } setDurMin(v); }} step={5} max={240} unit="min" />
              </Field>
            </>
          ) : (
            <>
              <Field label="Quantity"><Stepper label="quantity" value={qty} onChange={setQty} step={10} max={500} unit="ml" /></Field>
              <Field label="End time" hint="(optional)"><input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></Field>
            </>
          )}
        </>
      )}

      <Field label="How was it?" hint="(optional)">
        <div className="chips">{OBSERVATIONS.map(o => <Chip key={o} on={obs.includes(o)} onClick={() => setObs(obs.includes(o) ? obs.filter(x => x !== o) : [...obs, o])}>{o}</Chip>)}</div>
      </Field>
      <Field label="Notes" hint="(optional)"><textarea rows={3} placeholder="e.g. very hungry, fell asleep…" value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      {err && <div className="alert error" role="alert">{err}</div>}
      {!timer && <button className="btn primary block" onClick={() => save(false)}>{existing ? 'Save changes' : 'Save Feed'}</button>}
      <Wave tone="peach" />
    </Page>
  );
}
