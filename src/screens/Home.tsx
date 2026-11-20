import React, { useMemo, useState } from 'react';
import { MoreSheet } from './Extras';
import { useBaby } from '../ui/hooks';
import { useNav } from '../ui/nav';
import { useNow, Empty } from '../ui/ui';
import { IBottle, IPoo, IMoon, ISparkle, IChevron, IPlus, ICalendar, IBreast } from '../ui/icons';
import { Timeline, buildTimeline, TItem, openItem, extrasForDay } from '../ui/Timeline';
import { lastFeed, lastPoo, lastCompletedSleep, dayStats } from '../lib/calc';
import { buildInsights, EVIDENCE_LABEL } from '../lib/insights';
import { formatTime, formatAgo, todayKey, formatDateKey, formatDuration, zonedParts, describeAge, daysBetween } from '../lib/time';
import { sleepElapsed, useStore, currentUserId } from '../lib/store';
import { SyncBadge } from '../ui/SyncBadge';

export function BabyAvatar({ src, name, size = 64 }: { src?: string | null; name: string; size?: number }) {
  return src ? <img className="avatar" src={src} alt={`${name}`} width={size} height={size} style={{ width: size, height: size }} />
    : <span className="avatar avatar-ph" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">{name.trim()[0]?.toUpperCase() ?? '?'}</span>;
}

export function Home() {
  const ctx = useBaby(); const nav = useNav(); const now = useNow(10000);
  const [more, setMore] = useState(false);
  const me = useStore(s => s.users[currentUserId() ?? '']);
  const insight = useMemo(() => ctx ? buildInsights(ctx.data, ctx.prefs.time_format, now) : null, [ctx, Math.floor(now / 60000)]);
  if (!ctx) return null;
  const { baby, data, prefs, active } = ctx; const tz = baby.timezone; const fmt = prefs.time_format;
  const today = todayKey(tz);
  const stats = dayStats(data, today, now);
  const lf = lastFeed(data), lp = lastPoo(data), ls = lastCompletedSleep(data);
  const h = zonedParts(new Date(now), tz).h;
  const greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const showExtras = prefs.show_extras !== false;
  const items = buildTimeline(stats.feeds, stats.poos, stats.sleeps, 'desc', showExtras ? { wets: stats.wets, extras: extrasForDay(ctx, tz, today), trackers: ctx.allTrackers } : undefined);
  const open = (i: TItem) => openItem(nav, i);
  const nappy = !!baby.wet_tracking;
  const hasExtras = nappy || ctx.trackers.length > 0;
  const topInsight = insight?.observations[0];

  return (
    <div className="screen home">
      <div className="blob blob-peach" aria-hidden="true" />
      <header className="home-head">
        <BabyAvatar src={baby.photograph_url} name={baby.name} size={64} />
        <div className="home-greet">
          <h1>{greet}{me?.display_name ? `, ${me.display_name.split(' ')[0]}` : ''}!</h1>
          <p className="muted">{formatDateKey(today)} · {baby.name} is {describeAge(daysBetween(baby.date_of_birth, today))}</p>
        </div>
        <SyncBadge />
      </header>

      <section className="summary" aria-label="Last activity">
        <button className="sum-card sum-feed" onClick={() => nav.push({ name: 'feed' })} aria-label={lf ? `Last feed ${formatTime(lf.start_datetime, tz, fmt)}, ${formatAgo(lf.start_datetime, now)}. Log feed` : 'No feeds yet. Log feed'}>
          <span className="sum-ic">{lf?.feeding_type === 'breast' ? <IBreast size={30} /> : <IBottle size={30} />}</span>
          <span className="sum-label">Feed</span>
          {lf ? <><span className="sum-time">{formatTime(lf.start_datetime, tz, fmt)}</span><span className="sum-ago">({formatAgo(lf.start_datetime, now)})</span></> : <span className="sum-ago">No feeds yet</span>}
        </button>
        <button className="sum-card sum-poo" onClick={() => nav.push({ name: 'poo' })} aria-label={lp ? `Last poo ${formatTime(lp.datetime, tz, fmt)}, ${formatAgo(lp.datetime, now)}. Log poo` : 'No poos yet. Log poo'}>
          <span className="sum-ic"><IPoo size={30} /></span>
          <span className="sum-label">{nappy ? 'Nappy' : 'Poo'}</span>
          {lp ? <><span className="sum-time">{formatTime(lp.datetime, tz, fmt)}</span><span className="sum-ago">({formatAgo(lp.datetime, now)})</span></> : <span className="sum-ago">{nappy ? 'No poo yet' : 'None yet'}</span>}
          {nappy && <span className="sum-ago sum-wet">{stats.wetCount} wet today</span>}
        </button>
        <button className={`sum-card sum-sleep ${active ? 'is-active' : ''}`} onClick={() => nav.push({ name: 'sleep', entryId: active?.sleep_id })} aria-label={active ? `Sleeping since ${formatTime(active.start_datetime, tz, fmt)}` : ls ? `Last sleep ended ${formatAgo(ls.end_datetime!, now)}. Log sleep` : 'No sleep yet. Log sleep'}>
          <span className="sum-ic"><IMoon size={30} /></span>
          <span className="sum-label">{active ? <><span className="pulse" aria-hidden="true" /> Sleeping</> : 'Sleep'}</span>
          {active ? <><span className="sum-time">{formatDuration(sleepElapsed(active, now), true)}</span><span className="sum-ago">since {formatTime(active.start_datetime, tz, fmt)}</span></>
            : ls ? <><span className="sum-time">{formatTime(ls.start_datetime, tz, fmt)}</span><span className="sum-ago">awake {formatAgo(ls.end_datetime!, now).replace(' ago', '')}</span></> : <span className="sum-ago">None yet</span>}
        </button>
      </section>

      <section className="quick" aria-label="Quick actions">
        <button className="btn primary" onClick={() => nav.push({ name: 'feed' })}><IPlus size={18} /> Log Feed</button>
        <button className="btn primary" onClick={() => nav.push({ name: 'poo' })}><IPlus size={18} /> {nappy ? 'Log Nappy' : 'Log Poo'}</button>
        <button className="btn primary" onClick={() => nav.push({ name: 'sleep', entryId: active?.sleep_id })}>{active ? 'Sleep timer' : <><IPlus size={18} /> Log Sleep</>}</button>
      </section>
      {hasExtras && <button className="more-pill" onClick={() => setMore(true)}><IPlus size={16} /> Log something else</button>}
      <MoreSheet open={more} onClose={() => setMore(false)} />

      {topInsight && (
        <button className="card insight-card" onClick={() => nav.setTab('insights')}>
          <ISparkle size={26} className="spark" />
          <span className="row-main">
            <span className="row-title">AI insight <span className="badge">{EVIDENCE_LABEL[topInsight.evidence_level]}</span></span>
            <span className="row-sub">{topInsight.description}</span>
          </span>
          <IChevron />
        </button>
      )}

      <section>
        <div className="sec-head"><h2>Today’s activity</h2><button className="link" onClick={() => nav.openDay(today)}><ICalendar size={16} /> Full day</button></div>
        {items.length ? <Timeline items={items} tz={tz} fmt={fmt} onOpen={open} now={now} />
          : <Empty title="Nothing logged yet today" text="Use the buttons above to log a feed, poo or sleep. It only takes a couple of taps." />}
        {items.length > 0 && <p className="day-totals muted small">{stats.feedCount} feeds · {stats.pooCount} poos{nappy ? ` · ${stats.wetCount} wet` : ''} · {formatDuration(stats.sleepSeconds)} sleep so far</p>}
      </section>
    </div>
  );
}
