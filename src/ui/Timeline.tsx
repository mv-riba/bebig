import React from 'react';
import type { FeedingEntry, PooEntry, SleepEntry } from '../lib/types';
import { formatTime, formatDuration, TimeFormat, dateKey, formatDateKey } from '../lib/time';
import { feedDurationSeconds, sleepDuration } from '../lib/calc';
import { colourLabel } from '../screens/LogPoo';
import { IBreast, IBottle, IFormula, IPoo, IMoon } from './icons';
import { useStore } from '../lib/store';

export type TItem = { kind: 'feed'; at: string; e: FeedingEntry } | { kind: 'poo'; at: string; e: PooEntry } | { kind: 'sleep'; at: string; e: SleepEntry };

export function buildTimeline(feeds: FeedingEntry[], poos: PooEntry[], sleeps: SleepEntry[], order: 'asc' | 'desc' = 'desc'): TItem[] {
  const items: TItem[] = [
    ...feeds.map(e => ({ kind: 'feed' as const, at: e.start_datetime, e })),
    ...poos.map(e => ({ kind: 'poo' as const, at: e.datetime, e })),
    ...sleeps.map(e => ({ kind: 'sleep' as const, at: e.start_datetime, e })),
  ];
  return items.sort((a, b) => (order === 'asc' ? 1 : -1) * (new Date(a.at).getTime() - new Date(b.at).getTime()));
}

const FEED_LABEL = { breast: 'Breastfeeding', expressed: 'Expressed milk', formula: 'Formula' };

export function describe(item: TItem, tz: string, fmt: TimeFormat, now = Date.now()) {
  if (item.kind === 'feed') {
    const f = item.e; const d = feedDurationSeconds(f);
    const parts = [FEED_LABEL[f.feeding_type]];
    if (f.feeding_type === 'breast') {
      if (d) parts.push(formatDuration(d));
      if (f.left_duration_seconds != null || f.right_duration_seconds != null) parts.push(`L ${formatDuration(f.left_duration_seconds || 0)} · R ${formatDuration(f.right_duration_seconds || 0)}`);
    } else if (f.quantity_ml) parts.push(`${f.quantity_ml} ml`);
    return { title: 'Feeding', sub: parts.join(' · '), time: formatTime(f.start_datetime, tz, fmt) };
  }
  if (item.kind === 'poo') {
    const p = item.e;
    const parts = [colourLabel(p.colour), p.texture && p.texture[0].toUpperCase() + p.texture.slice(1), p.size && p.size[0].toUpperCase() + p.size.slice(1)].filter(Boolean);
    return { title: 'Poo', sub: parts.join(' · ') || 'No details', time: formatTime(p.datetime, tz, fmt) };
  }
  const s = item.e;
  const running = s.status !== 'completed';
  const crosses = s.end_datetime && dateKey(s.start_datetime, tz) !== dateKey(s.end_datetime, tz);
  return {
    title: running ? 'Sleeping now' : 'Sleep',
    sub: running ? `${formatDuration(sleepDuration(s, now))} so far${s.status === 'paused' ? ' · paused' : ''}` : `${formatDuration(sleepDuration(s))}${crosses ? ` · until ${formatDateKey(dateKey(s.end_datetime!, tz), 'short')}` : ''}`,
    time: running ? formatTime(s.start_datetime, tz, fmt) : `${formatTime(s.start_datetime, tz, fmt)}–${formatTime(s.end_datetime!, tz, fmt)}`,
  };
}

export const KIND_ICON = (item: TItem, size = 18) =>
  item.kind === 'feed' ? (item.e.feeding_type === 'breast' ? <IBreast size={size} /> : item.e.feeding_type === 'formula' ? <IFormula size={size} /> : <IBottle size={size} />)
    : item.kind === 'poo' ? <IPoo size={size} /> : <IMoon size={size} />;

export function Timeline({ items, tz, fmt, onOpen, now }: { items: TItem[]; tz: string; fmt: TimeFormat; onOpen: (i: TItem) => void; now: number }) {
  const users = useStore(s => s.users);
  return (
    <ol className="timeline">
      {items.map(item => {
        const d = describe(item, tz, fmt, now);
        const notes = [...(item.kind === 'feed' ? item.e.observations : []), item.e.notes].filter(Boolean).join(' · ');
        const by = users[item.e.created_by]?.display_name;
        return (
          <li key={item.kind + (item.e as any)[item.kind === 'feed' ? 'feed_id' : item.kind === 'poo' ? 'poo_id' : 'sleep_id']}>
            <button className={`tl-item tl-${item.kind}`} onClick={() => onOpen(item)} aria-label={`${d.title} at ${d.time}, ${d.sub}. Tap to edit`}>
              <span className="tl-dot">{KIND_ICON(item, 16)}</span>
              <span className="tl-time">{d.time}</span>
              <span className="tl-main">
                <span className="tl-title">{d.title}</span>
                <span className="tl-sub">{d.sub}</span>
                {notes && <span className="tl-note">“{notes}”</span>}
              </span>
              {by && <span className="tl-by" title={`Logged by ${by}`}>{by[0].toUpperCase()}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
