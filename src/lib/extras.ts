// Optional extra trackers (opt-in per baby) and wet nappies.
import type { TrackerDef, ExtraEntry, PooEntry, TrackerKind, TrackerIcon, Level } from './types';
import { upsertEntry, getState, live } from './store';
import { dateKey, formatTime, formatDuration, formatAgo, TimeFormat } from './time';

export const PRESETS: Record<'bath' | 'congestion', { name: string; icon: TrackerIcon; kind: TrackerKind; hint: string }> = {
  bath: { name: 'Bath', icon: 'bath', kind: 'event', hint: 'One tap · shows days since the last bath' },
  congestion: { name: 'Congestion', icon: 'wind', kind: 'level', hint: 'Mild / moderate / strong, with notes' },
};

export const KIND_INFO: Record<TrackerKind, { label: string; hint: string }> = {
  event: { label: 'Just the time', hint: 'One tap · e.g. drops, nail trim' },
  daily: { label: 'Once a day', hint: 'A check-off · e.g. vitamin D' },
  amount: { label: 'An amount', hint: 'Number + unit · e.g. pumped ml' },
  duration: { label: 'How long', hint: 'Minutes · e.g. tummy time' },
  level: { label: 'A level', hint: 'Mild / moderate / strong' },
};
export const LEVELS: Level[] = ['mild', 'moderate', 'strong'];
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- nappies ----
export const nappyType = (p: PooEntry) => p.nappy_type ?? 'poo';
export const hasPoo = (p: PooEntry) => nappyType(p) !== 'wet';
export const hasWet = (p: PooEntry) => nappyType(p) !== 'poo';

export function logWetNow(baby_id: string) {
  return upsertEntry('poos', { baby_id, datetime: new Date().toISOString(), nappy_type: 'wet', colour: null, size: null, texture: null, notes: null });
}

// ---- trackers ----
export function trackersOf(baby_id: string, includeDisabled = false): TrackerDef[] {
  return live(getState().trackers, baby_id).filter(t => includeDisabled || t.enabled).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}
export function setPreset(baby_id: string, preset: 'bath' | 'congestion', on: boolean) {
  const existing = live(getState().trackers, baby_id).find(t => t.preset === preset);
  if (existing) return upsertEntry('trackers', { ...existing, enabled: on });
  if (!on) return null;
  const p = PRESETS[preset];
  return upsertEntry('trackers', { baby_id, name: p.name, icon: p.icon, kind: p.kind, unit: null, preset, enabled: true, sort: preset === 'bath' ? 1 : 2 });
}
export function logExtraNow(t: TrackerDef) {
  return upsertEntry('extras', { baby_id: t.baby_id, tracker_id: t.tracker_id, datetime: new Date().toISOString(), duration_seconds: null, value_num: null, level: null, notes: null });
}
/** Trackers that can be logged with one tap (no value to enter). */
export const oneTap = (t: TrackerDef) => t.kind === 'event' || t.kind === 'daily';

export const entriesFor = (extras: ExtraEntry[], tracker_id: string) =>
  extras.filter(e => e.tracker_id === tracker_id).sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime));

/** Short status for a tile: when it was last done (or today's check-off). */
export function tileStatus(t: TrackerDef, extras: ExtraEntry[], tz: string, fmt: TimeFormat, now = Date.now()): { text: string; done: boolean } {
  const es = entriesFor(extras, t.tracker_id); const last = es[es.length - 1];
  const today = dateKey(new Date(now), tz);
  if (t.kind === 'daily') {
    const todays = es.filter(e => dateKey(e.datetime, tz) === today);
    return todays.length ? { text: `Given ${formatTime(todays[todays.length - 1].datetime, tz, fmt)}`, done: true } : { text: 'Not yet today', done: false };
  }
  if (!last) return { text: 'Not logged yet', done: false };
  const ago = formatAgo(last.datetime, now);
  if (t.kind === 'level' && last.level) return { text: `${cap(last.level)} · ${ago}`, done: false };
  if (t.kind === 'amount' && last.value_num != null) return { text: `${fmtNum(last.value_num)} ${t.unit ?? ''} · ${ago}`.trim(), done: false };
  if (t.kind === 'duration' && last.duration_seconds) return { text: `${formatDuration(last.duration_seconds)} · ${ago}`, done: false };
  return { text: ago, done: false };
}

/** One-line summary of a tracker for a single local day (calendar Extras card). */
export function daySummary(t: TrackerDef, extras: ExtraEntry[], tz: string, key: string, fmt: TimeFormat): string | null {
  const es = entriesFor(extras, t.tracker_id).filter(e => dateKey(e.datetime, tz) === key);
  if (!es.length) return null;
  const times = es.map(e => formatTime(e.datetime, tz, fmt));
  switch (t.kind) {
    case 'daily': return `Given ${times.join(', ')}`;
    case 'amount': { const sum = es.reduce((a, e) => a + (e.value_num || 0), 0); return `${fmtNum(sum)} ${t.unit ?? ''} · ${es.length}×`.trim(); }
    case 'duration': { const sum = es.reduce((a, e) => a + (e.duration_seconds || 0), 0); return `${formatDuration(sum)} · ${es.length}×`; }
    case 'level': { const order = { mild: 1, moderate: 2, strong: 3 } as const; const top = es.filter(e => e.level).sort((a, b) => order[b.level!] - order[a.level!])[0]; return `${top?.level ? cap(top.level) : 'Logged'} · ${es.length}×`; }
    default: return es.length > 1 ? `${es.length}× · last ${times[times.length - 1]}` : times[0];
  }
}

export function describeExtra(t: TrackerDef | undefined, e: ExtraEntry) {
  if (!t) return 'Extra';
  if (t.kind === 'daily') return `${t.name} given`;
  if (t.kind === 'level' && e.level) return `${t.name} · ${cap(e.level)}`;
  if (t.kind === 'amount' && e.value_num != null) return `${t.name} · ${fmtNum(e.value_num)} ${t.unit ?? ''}`.trim();
  if (t.kind === 'duration' && e.duration_seconds) return `${t.name} · ${formatDuration(e.duration_seconds)}`;
  return t.name;
}
const fmtNum = (n: number) => (Math.round(n * 10) / 10).toString();
