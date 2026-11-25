// "Still feeding?" / "Still sleeping?" on the timer screens: a breastfeeding timer over 1½ hours or a sleep timer
// over 12 hours was most likely left running. Yes → asked again later; Finished earlier → saved with the real end.
import React, { useState } from 'react';
import { Field } from './ui';
import { stillDue, confirmStill } from '../lib/still';
import { toLocalInput, fromLocalInput, formatTime, formatDuration, type TimeFormat } from '../lib/time';

export function StillCheck({ kind, id, startedAt, earliestEnd, tz, fmt, now, onEnded }: {
  kind: 'feed' | 'sleep'; id: string; startedAt: string; earliestEnd: number; tz: string; fmt: TimeFormat; now: number;
  /** save with this end time; throw an Error with a message to show */
  onEnded: (endIso: string) => void;
}) {
  const [, bump] = useState(0); const [asking, setAsking] = useState(false); const [err, setErr] = useState<string | null>(null);
  const feed = kind === 'feed';
  const [end, setEnd] = useState(() => toLocalInput(new Date(Math.min(now, Math.max(earliestEnd, Date.parse(startedAt) + (feed ? 30 : 180) * 60000))), tz));
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
          <button className="btn primary" onClick={() => setAsking(true)}>{feed ? 'Finished earlier' : 'Woke up earlier'}</button>
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
