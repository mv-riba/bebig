import React, { useMemo, useState, useEffect } from 'react';
import { useBaby } from '../ui/hooks';
import { useNav } from '../ui/nav';
import { useNow, Empty, Row } from '../ui/ui';
import { IBack, IChevron, ICalendar, IBottle, IPoo, IMoon, IChart, IPlus, IScale } from '../ui/icons';
import { Timeline, buildTimeline, TItem, openItem, extrasForDay } from '../ui/Timeline';
import { daySummary } from '../lib/extras';
import { TrackerIconSvg } from './Extras';
import { updatePrefs } from '../lib/store';
import { IDrop } from '../ui/icons';
import { dayStats } from '../lib/calc';
import { todayKey, parseKey, daysInMonth, weekdayIndex, monthName, formatDateKey, formatDuration, pad, dateKey } from '../lib/time';
import { toDisplay } from '../lib/growth';

export function Calendar() {
  const ctx = useBaby(); const nav = useNav(); const now = useNow(30000);
  const tz = ctx?.baby.timezone ?? 'UTC';
  const today = todayKey(tz);
  // selection lives in navigation state so it survives opening an entry and coming back
  const sel = nav.calendarKey ?? today;
  const setSel = nav.selectDay;
  const [view, setView] = useState(() => { const { y, m } = parseKey(sel); return { y, m }; });
  useEffect(() => { const { y, m } = parseKey(sel); setView(v => (v.y === y && v.m === m ? v : { y, m })); }, [sel]);

  const marks = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (!ctx) return m;
    const add = (k: string, t: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(t); };
    ctx.data.feeds.forEach(f => add(dateKey(f.start_datetime, tz), 'feed'));
    ctx.data.poos.forEach(p => add(dateKey(p.datetime, tz), 'poo'));
    ctx.data.sleeps.forEach(s => add(dateKey(s.start_datetime, tz), 'sleep'));
    ctx.growth.forEach(g => add(g.measurement_date, 'growth'));
    return m;
  }, [ctx, tz]);

  if (!ctx) return null;
  const { data, prefs, growth, baby } = ctx;
  const growthCount = growth.length; const fmt = prefs.time_format;
  const first = `${view.y}-${pad(view.m)}-01`;
  const lead = weekdayIndex(first); const n = daysInMonth(view.y, view.m);
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => `${view.y}-${pad(view.m)}-${pad(i + 1)}`)];
  while (cells.length % 7) cells.push(null);
  const move = (d: number) => setView(v => { let m = v.m + d, y = v.y; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } return { y, m }; });
  const st = dayStats(data, sel, now);
  const showExtras = prefs.show_extras !== false;
  const dayExtras = extrasForDay(ctx, tz, sel);
  const items = buildTimeline(st.feeds, st.poos, st.sleeps, 'asc', showExtras ? { wets: st.wets, extras: dayExtras, trackers: ctx.allTrackers } : undefined);
  const open = (i: TItem) => openItem(nav, i);
  const nappy = !!baby.wet_tracking;
  // Extras card: every enabled tracker (plus disabled ones that have entries this day) and wet nappies
  const extraRows = [
    ...(nappy || st.wetCount ? [{ id: 'wet', icon: <IDrop size={16} />, name: 'Wet nappies', value: String(st.wetCount), add: () => nav.push({ name: 'poo', onKey: sel }) }] : []),
    ...ctx.allTrackers.filter(t => t.enabled || dayExtras.some(e => e.tracker_id === t.tracker_id)).map(t => ({ id: t.tracker_id, icon: <TrackerIconSvg icon={t.icon} size={16} />, name: t.name,
      value: daySummary(t, ctx.extras, tz, sel, fmt) ?? '—', add: () => nav.push({ name: 'extra', trackerId: t.tracker_id, onKey: sel }) })),
  ];
  const hasMinor = st.wets.length > 0 || dayExtras.length > 0;
  const meas = growth.filter(g => g.measurement_date === sel);
  const future = sel > today; const beforeBirth = sel < baby.date_of_birth;

  return (
    <div className="screen calendar">
      <header className="screen-head"><span /><h1>Calendar</h1><button className="pill-btn" onClick={() => nav.push({ name: 'growth' })} aria-label={`Growth charts${growthCount ? `, ${growthCount} measurements` : ''}`}><IChart size={18} /> Growth</button></header>
      <div className="card cal">
        <div className="cal-nav">
          <button className="icon-btn" aria-label="Previous month" onClick={() => move(-1)}><IBack /></button>
          <strong aria-live="polite">{monthName(view.m)} {view.y}</strong>
          <button className="icon-btn" aria-label="Next month" onClick={() => move(1)}><IChevron /></button>
        </div>
        <div className="cal-grid" role="grid" aria-label={`${monthName(view.m)} ${view.y}`}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <span key={d} className="cal-wd" aria-hidden="true">{d}</span>)}
          {cells.map((k, i) => k ? (
            <button key={k} role="gridcell" aria-selected={k === sel} aria-label={`${formatDateKey(k)}${marks.has(k) ? ', has records' : ''}`}
              className={`cal-day ${k === sel ? 'sel' : ''} ${k === today ? 'today' : ''} ${k > today ? 'future' : ''} ${marks.get(k)?.has('growth') ? 'has-growth' : ''}`} onClick={() => setSel(k)}>
              <span className="cal-num">{Number(k.slice(8))}</span>
              <span className="cal-dots">{['feed', 'poo', 'sleep'].map(t => marks.get(k)?.has(t) ? <i key={t} className={`dot dot-${t}`} /> : null)}</span>
            </button>
          ) : <span key={'e' + i} />)}
        </div>
        <div className="cal-key" aria-hidden="true"><span><i className="dot dot-feed" />Feed</span><span><i className="dot dot-poo" />{nappy ? 'Nappy' : 'Poo'}</span><span><i className="dot dot-sleep" />Sleep</span><span><i className="ring-key" />Growth</span></div>
        {(view.y !== parseKey(today).y || view.m !== parseKey(today).m || sel !== today) && <button className="link small center-block" onClick={() => { setSel(today); const { y, m } = parseKey(today); setView({ y, m }); }}>Return to today</button>}
      </div>

      <div className="sec-head"><h2>{formatDateKey(sel)}</h2></div>
      {future ? <Empty title="This day hasn’t happened yet" /> : (
        <>
          <div className="day-summary">
            <div className="ds ds-feed"><IBottle size={20} /><strong>{st.feedCount}</strong><span>Feeds</span></div>
            <div className="ds ds-poo"><IPoo size={20} /><strong>{st.pooCount}</strong><span>Poos</span></div>
            <div className="ds ds-sleep"><IMoon size={20} /><strong>{st.sleepCount}</strong><span>Sleeps</span></div>
            <div className="ds ds-total"><span className="ds-big">{formatDuration(st.sleepSeconds, true)}</span><span>Total sleep</span></div>
          </div>
          {(st.formulaMl > 0 || st.expressedMl > 0 || st.breastSeconds > 0) && (
            <p className="muted small">{[st.breastCount && `Breastfeeding ${formatDuration(st.breastSeconds)} (${st.breastCount})`, st.formulaMl && `Formula ${st.formulaMl} ml`, st.expressedMl && `Expressed ${st.expressedMl} ml`].filter(Boolean).join(' · ')}{st.avgFeedIntervalMin ? ` · avg ${formatDuration(st.avgFeedIntervalMin * 60)} between feeds` : ''}</p>
          )}
          {meas.length > 0 && (
            <div className="card meas-card">
              {meas.map(m => (
                <Row key={m.measurement_id} icon={<IScale />} onClick={() => nav.push({ name: 'measure', id: m.measurement_id })}
                  title={m.measurement_id === 'birth' ? 'Birth measurements' : 'Growth measurement'} sub={[toDisplay('weight', m) != null && `${toDisplay('weight', m)!.toFixed(2)} kg`, toDisplay('length', m) != null && `${toDisplay('length', m)!.toFixed(1)} cm long`, toDisplay('head', m) != null && `head ${toDisplay('head', m)!.toFixed(1)} cm`].filter(Boolean).join(' · ')} right={<IChevron />} />
              ))}
            </div>
          )}
          {extraRows.length > 0 && (
            <details className="card extras-card" open>
              <summary><span>Extras</span><span className="muted small">{extraRows.filter(r => r.value !== '—' && r.value !== '0').length} recorded</span></summary>
              {extraRows.map(r => (
                <button key={r.id} className="xrow" onClick={r.add} aria-label={`Add ${r.name} for this day`}>
                  <span className="xrow-ic">{r.icon}</span><span className="xrow-n">{r.name}</span><span className="xrow-v">{r.value}</span><IPlus size={14} />
                </button>))}
            </details>
          )}
          {hasMinor && (
            <label className="extras-toggle"><span>Show extras in timeline</span><input type="checkbox" className="switch" checked={showExtras} onChange={e => updatePrefs({ show_extras: e.target.checked })} /></label>
          )}
          {items.length ? <Timeline items={items} tz={tz} fmt={fmt} onOpen={open} now={now} /> : <Empty title="No activity recorded" text={beforeBirth ? undefined : 'Missed something? You can add it now.'} />}
          {!beforeBirth && (
            <div className="add-row" aria-label="Add entry for this day">
              <button className="chip" onClick={() => nav.push({ name: 'feed', onKey: sel })}><IPlus size={14} /> Feed</button>
              <button className="chip" onClick={() => nav.push({ name: 'poo', onKey: sel })}><IPlus size={14} /> {nappy ? 'Nappy' : 'Poo'}</button>
              <button className="chip" onClick={() => nav.push({ name: 'sleep', onKey: sel })}><IPlus size={14} /> Sleep</button>
              <button className="chip" onClick={() => nav.push({ name: 'measure', onKey: sel })}><IPlus size={14} /> Growth</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
