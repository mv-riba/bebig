import React, { useMemo, useState } from 'react';
import { MoreSheet, RunningExtraTimers } from './Extras';
import { useBaby } from '../ui/hooks';
import { useNav } from '../ui/nav';
import { useNow, Empty, useConfirm, useToast } from '../ui/ui';
import { IBottle, IPoo, IMoon, ISparkle, IChevron, IPlus, ICalendar, IBreast } from '../ui/icons';
import { Timeline, buildTimeline, TItem, openItem, extrasForDay } from '../ui/Timeline';
import { TrialNudge } from '../ui/plus';
import { BabySwitcher, OtherBabiesTimers } from '../ui/babies';
import { lastFeed, lastPoo, lastCompletedSleep, dayStats } from '../lib/calc';
import { buildInsights, EVIDENCE_LABEL } from '../lib/insights';
import { formatTime, formatAgo, todayKey, formatDateKey, formatDuration, zonedParts, describeAge, daysBetween, tzGapNote, tzName, guessTimezone } from '../lib/time';
import { sleepElapsed, sleepTimerTooLong, feedTimerTotals, useStore, currentUserId, roleFor, updateBaby, useSyncPhase, isStale, unsyncedEntries, otherCaregiverNames } from '../lib/store';
import { SyncBadge, useOnline } from '../ui/SyncBadge';
import { syncMode, syncNow } from '../lib/sync';
import type { BabyProfile } from '../lib/types';
import { stillDue } from '../lib/still';

export function BabyAvatar({ src, name, size = 64 }: { src?: string | null; name: string; size?: number }) {
  return src ? <img className="avatar" src={src} alt={`${name}`} width={size} height={size} style={{ width: size, height: size }} />
    : <span className="avatar avatar-ph" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">{name.trim()[0]?.toUpperCase() ?? '?'}</span>;
}

export function Home() {
  const ctx = useBaby(); const nav = useNav(); const now = useNow(10000);
  const [more, setMore] = useState(false); const [switching, setSwitching] = useState(false);
  const me = useStore(s => s.users[currentUserId() ?? '']);
  const phase = useSyncPhase(); const online = useOnline();
  const lastSynced = useStore(s => s.lastSyncedAt);
  const outboxCount = useStore(s => s.outbox.length);
  const waitingCount = useStore(s => unsyncedEntries(s).waiting.size);
  const accessKey = useStore(s => s.access); const usersKey = useStore(s => s.users);
  const insight = useMemo(() => ctx ? buildInsights(ctx.data, ctx.prefs.time_format, now) : null, [ctx, Math.floor(now / 60000)]);
  if (!ctx) return null;
  const { baby, data, prefs, active, feedTimer } = ctx; const tz = baby.timezone; const fmt = prefs.time_format;
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
  const tzNote = tzGapNote(tz, new Date(now));
  // Sync state: while catching up (or after a failed catch-up) the cards are this phone's old copy, so they're faded
  // and a running timer isn't shown as live. Offline with an old copy: running timers say "as of" the last sync.
  const remote = syncMode() === 'remote';
  const updating = remote && online && phase === 'updating';
  const couldNot = remote && online && phase === 'failed';
  const offlineOld = remote && !online && isStale(undefined, now);
  const unsure = updating || couldNot || offlineOld;
  const asOf = lastSynced ? `as of ${formatTime(lastSynced, tz, fmt)}` : 'not synced yet';
  const unsureSub = updating ? 'checking…' : asOf;
  const others = useMemo(() => otherCaregiverNames(baby.baby_id), [baby.baby_id, accessKey, usersKey]);
  const pendingN = waitingCount || outboxCount; const pendingNoun = waitingCount ? (pendingN === 1 ? 'entry is' : 'entries are') : (pendingN === 1 ? 'change is' : 'changes are');

  return (
    <div className="screen home">
      <div className="blob blob-peach" aria-hidden="true" />
      <header className="home-head">
        <button className="avatar-btn" onClick={() => setSwitching(true)} aria-label={`${baby.name} — switch or add a baby`}><BabyAvatar src={baby.photograph_url} name={baby.name} size={64} /></button>
        <div className="home-greet">
          <h1>{greet}{me?.display_name ? `, ${me.display_name.split(' ')[0]}` : ''}!</h1>
          <p className="muted">{formatDateKey(today)} · <button className="baby-switch" onClick={() => setSwitching(true)} aria-haspopup="dialog"><span className="name-clamp">{baby.name}</span><IChevron size={14} className="chev-down" /></button> is {describeAge(daysBetween(baby.date_of_birth, today))}</p>
          {tzNote && <TravelPrompt baby={baby} note={tzNote} />}
        </div>
        <BabySwitcher open={switching} onClose={() => setSwitching(false)} />
        <SyncBadge />
      </header>
      {updating && lastSynced && <p className="sync-note" role="status">Getting the latest{others ? ` from ${others}’s phone` : ''}… Last updated {formatAgo(lastSynced, now)}.</p>}
      {couldNot && <p className="sync-note" role="status">Couldn’t get the latest. Showing what this phone had {lastSynced ? `at ${formatTime(lastSynced, tz, fmt)}` : 'before'}. <button className="link small" onClick={() => { syncNow(); }}>Try again</button></p>}
      {remote && !online && pendingN > 0 && <p className="sync-note offline" role="status">You’re offline. {pendingN} {pendingNoun} saved on this phone and will sync when you’re back online.{others ? ` ${others} won’t see ${pendingN === 1 ? 'it' : 'them'} until then.` : ''}</p>}

      <section className={`summary ${updating || couldNot ? 'is-stale' : ''}`} aria-label="Last activity" aria-busy={updating}>
        <button className={`sum-card sum-feed ${feedTimer ? 'is-active' : ''}`} onClick={() => nav.push({ name: 'feed' })} aria-label={feedTimer ? `Breastfeeding timer ${feedTimer.segment_started_at ? 'running' : 'paused'} since ${formatTime(feedTimer.started_at, tz, fmt)}. Open timer` : lf ? `Last feed ${formatTime(lf.start_datetime, tz, fmt)}, ${formatAgo(lf.start_datetime, now)}. Log feed` : 'No feeds yet. Log feed'}>
          <span className="sum-ic">{feedTimer || lf?.feeding_type === 'breast' ? <IBreast size={30} /> : <IBottle size={30} />}</span>
          <span className="sum-label">{feedTimer ? (unsure ? 'Feeding?' : <>{feedTimer.segment_started_at && <span className="pulse" aria-hidden="true" />} {feedTimer.segment_started_at ? 'Feeding' : 'Feed paused'}</>) : 'Feed'}</span>
          {feedTimer ? <><span className="sum-time">{formatDuration(feedTimerTotals(feedTimer, now).total, true)}</span><span className="sum-ago">{unsure ? unsureSub : stillDue('feed', feedTimer.timer_id, feedTimer.started_at, now) ? 'Still feeding?' : `since ${formatTime(feedTimer.started_at, tz, fmt)}`}</span></>
            : lf ? <><span className="sum-time">{formatTime(lf.start_datetime, tz, fmt)}</span><span className="sum-ago">({formatAgo(lf.start_datetime, now)})</span></> : <span className="sum-ago">No feeds yet</span>}
        </button>
        <button className="sum-card sum-poo" onClick={() => nav.push({ name: 'poo' })} aria-label={lp ? `Last ${nappy ? 'nappy' : 'poo'} ${formatTime(lp.datetime, tz, fmt)}, ${formatAgo(lp.datetime, now)}. Log ${nappy ? 'nappy' : 'poo'}` : `No ${nappy ? 'nappies' : 'poos'} yet. Log ${nappy ? 'nappy' : 'poo'}`}>
          <span className="sum-ic"><IPoo size={30} /></span>
          <span className="sum-label">{nappy ? 'Nappy' : 'Poo'}</span>
          {lp ? <><span className="sum-time">{formatTime(lp.datetime, tz, fmt)}</span><span className="sum-ago">({formatAgo(lp.datetime, now)})</span></> : <span className="sum-ago">{nappy ? 'No poo yet' : 'None yet'}</span>}
          {nappy && <span className="sum-ago sum-wet">{stats.wetCount} wet today</span>}
        </button>
        <button className={`sum-card sum-sleep ${active ? 'is-active' : ''}`} disabled={updating} onClick={() => nav.push({ name: 'sleep', entryId: active?.sleep_id })} aria-label={updating ? 'Sleep: checking for updates from other phones' : active ? `Sleeping since ${formatTime(active.start_datetime, tz, fmt)}` : ls ? `Last sleep ended at ${formatTime(ls.end_datetime!, tz, fmt)}, awake ${formatAgo(ls.end_datetime!, now).replace(' ago', '')}. Log sleep` : 'No sleep yet. Log sleep'}>
          <span className="sum-ic"><IMoon size={30} /></span>
          <span className="sum-label">{active ? (unsure ? 'Sleeping?' : <><span className="pulse" aria-hidden="true" /> Sleeping</>) : 'Sleep'}</span>
          {active ? <><span className="sum-time">{formatDuration(sleepElapsed(active, now), true)}</span><span className="sum-ago">{unsure ? unsureSub : sleepTimerTooLong(active, now) ? 'Over 24 h · tap to fix' : stillDue('sleep', active.sleep_id, active.start_datetime, now) ? 'Still sleeping?' : `since ${formatTime(active.start_datetime, tz, fmt)}`}</span></>
            : ls ? <><span className="sum-time">{formatTime(ls.end_datetime!, tz, fmt)}</span><span className="sum-ago">awake {formatAgo(ls.end_datetime!, now).replace(' ago', '')}</span></> : <span className="sum-ago">None yet</span>}
        </button>
      </section>

      <section className="quick" aria-label="Quick actions">
        <button className="btn primary" onClick={() => nav.push({ name: 'feed' })}><IPlus size={18} /> Log Feed</button>
        <button className="btn primary" onClick={() => nav.push({ name: 'poo' })}><IPlus size={18} /> {nappy ? 'Log Nappy' : 'Log Poo'}</button>
        <button className="btn primary" disabled={updating} onClick={() => nav.push({ name: 'sleep', entryId: active?.sleep_id })}>{active ? 'Sleep timer' : <><IPlus size={18} /> Log Sleep</>}</button>
      </section>
      {hasExtras && <button className="more-pill" onClick={() => setMore(true)}><IPlus size={16} /> Log something else</button>}
      <RunningExtraTimers />
      <OtherBabiesTimers />
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
          : <Empty title="Nothing logged yet today" text={`Use the buttons above to log a feed, ${nappy ? 'nappy' : 'poo'} or sleep. It only takes a couple of taps.`} />}
        {items.length > 0 && <p className="day-totals muted small">{stats.feedCount} feed{stats.feedCount === 1 ? '' : 's'} · {stats.pooCount} poo{stats.pooCount === 1 ? '' : 's'}{nappy ? ` · ${stats.wetCount} wet` : ''} · {formatDuration(stats.sleepSeconds)} sleep so far</p>}
      </section>
      <TrialNudge />
    </div>
  );
}

/** The phone's clock is in another time zone than the baby's. The owner is asked whether to switch the baby's
 *  time zone (e.g. the family is travelling); "Not now" is remembered on this phone until the phone's zone changes
 *  again. Caregivers only see the note: switching changes the times for everyone. */
function TravelPrompt({ baby, note }: { baby: BabyProfile; note: string }) {
  const confirm = useConfirm(); const toast = useToast();
  const here = guessTimezone(); const key = `bebig:tz-dismissed:${baby.baby_id}`;
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(key) === here; } catch { return false; } });
  if (roleFor(baby.baby_id) !== 'owner' || dismissed) return <p className="muted small tz-note">{note}</p>;
  const notNow = () => { try { localStorage.setItem(key, here); } catch { /* private mode: ask again next time */ } setDismissed(true); };
  const name = tzName(here);
  const sw = async () => {
    if (!(await confirm({ title: `Switch to ${name}?`, text: `${baby.name}’s times will be shown in ${name} for everyone who follows ${baby.name}. Past days are regrouped by the new midnight, so some daily totals change. Recorded moments stay the same, and you can switch back any time.`, ok: 'Switch' }))) return;
    updateBaby(baby.baby_id, { timezone: here }); toast(`Now showing ${name}`);
  };
  return (
    <div className="tz-ask">
      <p className="muted small">This phone is on {name}. {note}</p>
      <div className="btn-row"><button className="btn small soft" onClick={sw}>Switch to {name}</button><button className="link small" onClick={notNow}>Not now</button></div>
    </div>
  );
}
