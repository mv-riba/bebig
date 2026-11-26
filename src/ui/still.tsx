// "Still feeding?" / "Still sleeping?" on the timer screens: a breastfeeding timer over 1½ hours or a sleep timer
// over 12 hours was most likely left running. Yes → asked again later; Finished earlier → saved with the real end.
import React, { useState, useEffect } from 'react';
import { Field } from './ui';
import { stillDue, confirmStill, cameBackDue, markSeen } from '../lib/still';
import { toLocalInput, fromLocalInput, formatTime, formatDuration, type TimeFormat } from '../lib/time';

export function StillCheck({ kind, id, startedAt, earliestEnd, tz, fmt, now, onEnded }: {
  kind: 'feed' | 'sleep'; id: string; startedAt: string; earliestEnd: number; tz: string; fmt: TimeFormat; now: number;
  /** save with this end time; throw an Error with a message to show */
  onEnded: (endIso: string) => void;
}) {
  const [, bump] = useState(0); const [asking, setAsking] = useState(false); const [err, setErr] = useState<string | null>(null);
  const feed = kind === 'feed';
  // the suggested end is worked out when the question is answered, not when the screen opened: a screen left open on a
  // locked phone keeps its first `now`, which made the suggestion the start time and saving it failed
  const suggestEnd = () => toLocalInput(new Date(Math.min(Date.now(), Math.max(earliestEnd, Date.parse(startedAt) + (feed ? 30 : 180) * 60000))), tz);
  const [end, setEnd] = useState(suggestEnd);
  if (!asking && !stillDue(kind, id, startedAt, now)) return null;
  const save = () => {
    setErr(null);
    try {
      const iso = fromLocalInput(end, tz); const t = Date.parse(iso);
      if (t > Date.now() + 60000) throw new Error(feed ? 'The end can’t be in the future.' : 'Wake-up time can’t be in the future.');
      if (t < earliestEnd) throw new Error(`That’s before ${formatTime(new Date(earliestEnd), tz, fmt)}, when the timer was last ${t < Date.parse(startedAt) ? 'started' : 'paused or resumed'}.`);
      onEnded(iso);
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="card still-card" role="status">
      <h3>{feed ? 'Still feeding?' : 'Still sleeping?'}</h3>
      <p className="muted small">The timer started at {formatTime(startedAt, tz, fmt)}, {formatDuration((now - Date.parse(startedAt)) / 1000)} ago. If it was left on, enter when {feed ? 'the feed finished' : `baby woke up`}.</p>
      {!asking ? (
        <div className="btn-row">
          <button className="btn soft" onClick={() => { confirmStill(id); bump(x => x + 1); }}>{feed ? 'Yes, still feeding' : 'Yes, still asleep'}</button>
          <button className="btn primary" onClick={() => { setEnd(suggestEnd()); setAsking(true); }}>{feed ? 'Finished earlier' : 'Woke up earlier'}</button>
        </div>
      ) : (
        <>
          <Field label={feed ? 'Feed finished at' : 'Woke up at'}><input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></Field>
          {err && <div className="alert error" role="alert">{err}</div>}
          <div className="btn-row">
            <button className="btn soft" onClick={() => { setAsking(false); setErr(null); }}>Back</button>
            <button className="btn primary" onClick={save}>{feed ? 'Save feed' : 'Save sleep'}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Is this a new feed?" when coming back to a breastfeeding timer left alone for 45 minutes (see cameBackDue).
 *  Shows `children` (the "Still feeding?" check) when not asking. */
export function NewFeedCheck({ timer, startedBy, earliestEnd, tz, fmt, now, onNewFeed, children }: {
  timer: { timer_id: string; started_at: string; updated_at?: string | null }; startedBy: string | null;
  earliestEnd: number; tz: string; fmt: TimeFormat; now: number;
  /** save the earlier feed ending at endIso, then start a new timer on `side` (undefined: don't start one);
   *  throw an Error with a message to show */
  onNewFeed: (endIso: string, side: 'left' | 'right' | undefined) => void;
  children?: React.ReactNode;
}) {
  const id = timer.timer_id;
  const [asking, setAsking] = useState(() => cameBackDue(timer, now));
  const [ending, setEnding] = useState(false); const [err, setErr] = useState<string | null>(null);
  const suggestEnd = () => toLocalInput(new Date(Math.min(Date.now(), Math.max(earliestEnd, Date.parse(timer.started_at) + 30 * 60000))), tz);
  const [end, setEnd] = useState(suggestEnd);
  // while this screen is on view the timer is being watched; coming back after 45 minutes away asks again
  useEffect(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (asking) return;
    if (cameBackDue(timer, now)) setAsking(true); else markSeen(id, now);
  }, [now, asking, id]);
  if (!asking) return <>{children}</>;
  const done = () => { confirmStill(id); markSeen(id); setAsking(false); setEnding(false); setErr(null); };
  const save = (side: 'left' | 'right' | undefined) => {
    setErr(null);
    try {
      const iso = fromLocalInput(end, tz); const t = Date.parse(iso);
      if (t > Date.now() + 60000) throw new Error('The end can’t be in the future.');
      if (t < earliestEnd) throw new Error(`That’s before ${formatTime(new Date(earliestEnd), tz, fmt)}, when the timer was last ${t < Date.parse(timer.started_at) ? 'started' : 'paused or resumed'}.`);
      onNewFeed(iso, side);
    } catch (e: any) { setErr(e.message); }
  };
  const since = `${formatTime(timer.started_at, tz, fmt)}, ${formatDuration((now - Date.parse(timer.started_at)) / 1000)} ago`;
  return (
    <div className="card still-card" role="status">
      <h3>Is this a new feed?</h3>
      <p className="muted small">{startedBy ? `${startedBy} started this timer` : 'This timer started'} at {since}. If that feed already ended, save it and start a new one.</p>
      {!ending ? (
        <div className="btn-row">
          <button className="btn soft" onClick={done}>Same feed</button>
          <button className="btn primary" onClick={() => { setEnd(suggestEnd()); setEnding(true); }}>New feed</button>
        </div>
      ) : (
        <>
          <Field label="Last feed finished at"><input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></Field>
          {err && <div className="alert error" role="alert">{err}</div>}
          <p className="muted small">Save it, then start the new feed on:</p>
          <div className="btn-row">
            <button className="btn primary" onClick={() => save('left')}>Left</button>
            <button className="btn primary" onClick={() => save('right')}>Right</button>
          </div>
          <div className="btn-row">
            <button className="btn soft" onClick={() => { setEnding(false); setErr(null); }}>Back</button>
            <button className="btn soft" onClick={() => save(undefined)}>Just save it</button>
          </div>
        </>
      )}
    </div>
  );
}
