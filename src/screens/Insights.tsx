import React, { useMemo, useState } from 'react';
import { useBaby } from '../ui/hooks';
import { useNav } from '../ui/nav';
import { useNow, Segmented, Empty } from '../ui/ui';
import { IMoon, IBottle, IPoo, ISparkle, IChart, IInfo } from '../ui/icons';
import { buildInsights, EVIDENCE_LABEL } from '../lib/insights';
import { formatDateKey, formatTime } from '../lib/time';
import type { AIInsight } from '../lib/types';

const CAT_ICON = { sleep: <IMoon />, feeding: <IBottle />, poo: <IPoo />, overview: <ISparkle /> };

function Histogram({ data }: { data: number[] }) {
  const max = Math.max(1, ...data.slice(6, 21));
  return (
    <div className="histo" aria-label="Average minutes asleep per hour, 06:00 to 21:00">
      <div className="histo-bars">{data.slice(6, 21).map((v, i) => <span key={i} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} title={`${String(i + 6).padStart(2, '0')}:00 · ${Math.round(v)} min`} />)}</div>
      <div className="histo-axis"><span>6am</span><span>12pm</span><span>6pm</span></div>
    </div>
  );
}

function InsightCard({ i, fmt, tz }: { i: AIInsight; fmt: '24h' | '12h'; tz: string }) {
  return (
    <article className={`card insight ins-${i.category}`}>
      <header><span className={`ins-ic ic-${i.category}`}>{CAT_ICON[i.category]}</span><h3>{i.title}</h3><span className={`badge ev-${i.evidence_level}`}>{EVIDENCE_LABEL[i.evidence_level]}</span></header>
      <p>{i.description}</p>
      {i.histogram && <Histogram data={i.histogram} />}
      {i.limited_data_note && <p className="muted small"><IInfo size={14} /> {i.limited_data_note}</p>}
      <footer className="muted tiny">
        {i.observation_count} observation{i.observation_count === 1 ? '' : 's'} · {i.days_covered} day{i.days_covered === 1 ? '' : 's'} · {formatDateKey(i.date_range_start, 'short')}–{formatDateKey(i.date_range_end, 'short')} · updated {formatTime(i.generated_at, tz, fmt)}
      </footer>
    </article>
  );
}

export function Insights() {
  const ctx = useBaby(); const nav = useNav(); const now = useNow(60000);
  const [tab, setTab] = useState<'overview' | 'patterns' | 'predictions' | 'trends'>('overview');
  const [cat, setCat] = useState<'all' | 'sleep' | 'feeding' | 'poo'>('all');
  const rep = useMemo(() => ctx ? buildInsights(ctx.data, ctx.prefs.time_format, now) : null, [ctx, now]);
  if (!ctx || !rep) return null;
  const tz = ctx.baby.timezone; const fmt = ctx.prefs.time_format;
  const obs = rep.observations.filter(o => cat === 'all' || o.category === cat);

  const notEnough = !rep.enoughData && (
    <Empty icon={<ISparkle size={30} />} title="Still learning your baby’s routine" text={rep.needs.join(' ')} />
  );

  return (
    <div className="screen insights">
      <header className="screen-head"><h1>Insights</h1><button className="icon-btn" aria-label="Growth charts" onClick={() => nav.push({ name: 'growth' })}><IChart /></button></header>
      <Segmented label="Insights section" value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'patterns', label: 'Patterns' }, { value: 'predictions', label: 'Next' }, { value: 'trends', label: 'Trends' }]} />

      {tab === 'overview' && (rep.enoughData ? (
        <>
          {rep.overview && <div className="card overview"><ISparkle className="spark" /><p>{rep.overview}</p></div>}
          <h2 className="sec-title">Key patterns</h2>
          {rep.observations.filter(o => ['sleep-nap-window', 'feed-interval', 'poo-frequency'].includes(o.insight_id)).map(i => <InsightCard key={i.insight_id} i={i} fmt={fmt} tz={tz} />)}
          {rep.predictions.length > 0 && <>
            <h2 className="sec-title">Next likely events</h2>
            <div className="card">{rep.predictions.map(p => (
              <div key={p.insight_id} className="pred-row"><span className={`ins-ic ic-${p.category}`}>{CAT_ICON[p.category]}</span>
                <div><strong>{p.title}</strong><span className="muted small">{p.predicted_at && p.insight_id !== 'predict-poo' ? `~ ${formatTime(p.predicted_at, tz, fmt)} (±${p.uncertainty_minutes} min)` : p.description}</span></div></div>
            ))}</div>
          </>}
          {rep.needs.length > 0 && <p className="muted small">{rep.needs.join(' ')}</p>}
        </>
      ) : notEnough)}

      {tab === 'patterns' && (rep.enoughData ? (
        <>
          <div className="chips"> {(['all', 'sleep', 'feeding', 'poo'] as const).map(c => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{c === 'all' ? 'All' : c === 'poo' ? 'Bowel movements' : c[0].toUpperCase() + c.slice(1)}</button>)}</div>
          {obs.length ? obs.map(i => <InsightCard key={i.insight_id} i={i} fmt={fmt} tz={tz} />) : <Empty title="No patterns here yet" text={rep.needs.find(n => n.toLowerCase().includes(cat === 'poo' ? 'bowel' : cat)) ?? 'Keep logging to see patterns.'} />}
        </>
      ) : notEnough)}

      {tab === 'predictions' && (
        <>
          <div className="alert notice soft"><IInfo size={20} /><span>Estimates come from your recorded data and can be wrong. They’re for planning only — always follow your baby’s hunger and tiredness cues.</span></div>
          {rep.predictions.length ? rep.predictions.map(i => <InsightCard key={i.insight_id} i={i} fmt={fmt} tz={tz} />) : notEnough || <Empty title="Not enough repeated events yet" text="Predictions need several recorded intervals between feeds, sleeps or bowel movements." />}
        </>
      )}

      {tab === 'trends' && (
        <>
          <p className="muted small">Average per logged day: the last 7 days vs. the 7 days before (today excluded).</p>
          <div className="card">
            {rep.trends.map(t => (
              <div key={t.label} className="trend-row">
                <span>{t.label}</span>
                <span className="trend-vals">
                  <span><em className="muted tiny">Prev</em> {t.lastWeek != null ? t.format(t.lastWeek) : '—'}</span>
                  <span><em className="muted tiny">Last 7d</em> <strong>{t.thisWeek != null ? t.format(t.thisWeek) : '—'}</strong></span>
                  {t.thisWeek != null && t.lastWeek != null && (Math.abs(t.thisWeek - t.lastWeek) < 0.05 ? <span className="delta">no change</span> : <span className="delta">{t.thisWeek > t.lastWeek ? '▲' : '▼'} {t.format(Math.abs(t.thisWeek - t.lastWeek))}</span>)}
                </span>
              </div>
            ))}
          </div>
          {rep.trends.every(t => t.lastWeek == null) && <p className="muted small">Comparisons appear once there are at least two logged days in each week.</p>}
          {rep.missingDays.length > 0 && <p className="muted small">{rep.missingDays.length} recent day{rep.missingDays.length > 1 ? 's have' : ' has'} no records, which affects these averages.</p>}
        </>
      )}
    </div>
  );
}
