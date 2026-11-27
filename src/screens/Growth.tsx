import React, { useState } from 'react';
import { Page, Field, NotesField, Segmented, useToast, Empty, Row } from '../ui/ui';
import { ITrash, IInfo, IChevron, IScale } from '../ui/icons';
import { useBaby } from '../ui/hooks';
import { useNav } from '../ui/nav';
import { upsertEntry, deleteEntry, restoreEntry, getState, useStore } from '../lib/store';
import { todayKey, formatDateKey, describeAge } from '../lib/time';
import { Indicator, LABEL, UNIT, assess, valueAtPercentile, CURVE_PCTS, growthAge, formatPercentile, toDisplay, LIMITS, MAX_DAYS, WHO_SOURCE } from '../lib/growth';
import type { GrowthMeasurement } from '../lib/types';

const LB = 453.59237, IN = 25.4;

function parseNum(v: string) { const n = Number(v.replace(',', '.')); return v.trim() === '' || !isFinite(n) ? null : n; }

export function MeasureForm({ id, onKey, onDone }: { id?: string; onKey?: string; onDone: () => void }) {
  const ctx = useBaby(); const toast = useToast();
  const ex: GrowthMeasurement | undefined = id ? getState().growth[id] : undefined;
  const imperial = ctx?.prefs.units === 'imperial';
  const fmtW = (g?: number | null) => g == null ? '' : imperial ? (g / LB).toFixed(2) : (g / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const fmtL = (mm?: number | null) => mm == null ? '' : imperial ? (mm / IN).toFixed(1) : (mm / 10).toFixed(1);
  const [date, setDate] = useState(ex?.measurement_date ?? onKey ?? (ctx ? todayKey(ctx.baby.timezone) : ''));
  const [w, setW] = useState(fmtW(ex?.weight_grams)); const [l, setL] = useState(fmtL(ex?.length_mm)); const [h, setH] = useState(fmtL(ex?.head_circumference_mm));
  const [notes, setNotes] = useState(ex?.notes ?? ''); const [err, setErr] = useState<string | null>(null);
  if (!ctx) return null;
  const { baby } = ctx;

  const save = () => {
    setErr(null);
    const wv = parseNum(w), lv = parseNum(l), hv = parseNum(h);
    if (wv == null && lv == null && hv == null) return setErr('Enter at least one measurement.');
    const weight_grams = wv == null ? null : Math.round(imperial ? wv * LB : wv * 1000);
    const length_mm = lv == null ? null : Math.round(imperial ? lv * IN : lv * 10);
    const head_circumference_mm = hv == null ? null : Math.round(imperial ? hv * IN : hv * 10);
    const bad = (v: number | null, [a, b]: readonly [number, number]) => v != null && (v < a || v > b);
    if (bad(weight_grams, LIMITS.weight_grams)) return setErr('Weight looks out of range — please check the value and unit.');
    if (bad(length_mm, LIMITS.length_mm)) return setErr('Length looks out of range — please check the value and unit.');
    if (bad(head_circumference_mm, LIMITS.head_circumference_mm)) return setErr('Head circumference looks out of range — please check.');
    if (date < baby.date_of_birth) return setErr('Date is before the date of birth.');
    if (date > todayKey(baby.timezone)) return setErr('Date can’t be in the future.');
    upsertEntry('growth', { ...(ex ? { measurement_id: ex.measurement_id } : {}), baby_id: baby.baby_id, measurement_date: date, weight_grams, length_mm, head_circumference_mm, notes: notes.trim() || null });
    toast(ex ? 'Measurement updated' : 'Measurement saved'); onDone();
  };
  const wu = imperial ? 'lb' : 'kg', lu = imperial ? 'in' : 'cm';
  return (
    <Page title={ex ? 'Edit Measurement' : 'Add Measurement'} onCancel={onDone} className="form-page"
      right={ex ? <button className="icon-btn danger" aria-label="Delete measurement" onClick={() => { deleteEntry('growth', ex.measurement_id); toast('Measurement deleted', { label: 'Undo', run: () => restoreEntry('growth', ex.measurement_id) }); onDone(); }}><ITrash /></button> : null}>
      <Field label="Measurement date"><input type="date" value={date} min={baby.date_of_birth} max={todayKey(baby.timezone)} onChange={e => setDate(e.target.value)} /></Field>
      <p className="muted small">Record any of the three — you don’t need all of them.</p>
      <Field label={`Weight (${wu})`} hint="(optional)"><input inputMode="decimal" placeholder={imperial ? 'e.g. 7.5' : 'e.g. 3.45'} value={w} onChange={e => setW(e.target.value)} /></Field>
      <Field label={`Length / height (${lu})`} hint="(optional)"><input inputMode="decimal" placeholder={imperial ? 'e.g. 20' : 'e.g. 51.5'} value={l} onChange={e => setL(e.target.value)} /></Field>
      <Field label={`Head circumference (${lu})`} hint="(optional)"><input inputMode="decimal" placeholder={imperial ? 'e.g. 13.8' : 'e.g. 35'} value={h} onChange={e => setH(e.target.value)} /></Field>
      <NotesField rows={2} value={notes} onChange={setNotes} placeholder="e.g. measured at a check-up" />
      {err && <div className="alert error" role="alert">{err}</div>}
      <button className="btn primary block" onClick={save}>{ex ? 'Save changes' : 'Save Measurement'}</button>
    </Page>
  );
}

function Chart({ ind, onPick, picked }: { ind: Indicator; onPick: (id: string) => void; picked: string | null }) {
  const ctx = useBaby()!; const { baby, growth } = ctx;
  const pts = growth.filter(g => toDisplay(ind, g) != null).sort((a, b) => a.measurement_date.localeCompare(b.measurement_date))
    .map(g => ({ g, v: toDisplay(ind, g)!, age: growthAge(baby, g.measurement_date) }));
  const valid = pts.filter(p => p.age.days >= 0 && p.age.days <= MAX_DAYS);
  const maxAge = Math.min(MAX_DAYS, Math.max(56, ...valid.map(p => p.age.days + 21)));
  const useMonths = maxAge > 120;
  const W = 340, H = 240, pl = 36, pr = 10, pt = 10, pb = 28;
  const curves = CURVE_PCTS.map(p => { const arr: [number, number][] = []; for (let a = 0; a <= maxAge; a += Math.max(1, Math.round(maxAge / 60))) { const v = valueAtPercentile(ind, baby.sex, a, p); if (v != null) arr.push([a, v]); } return { p, arr }; });
  const allV = [...curves.flatMap(c => c.arr.map(x => x[1])), ...valid.map(p => p.v)];
  const lo = Math.floor(Math.min(...allV)), hi = Math.ceil(Math.max(...allV));
  const x = (a: number) => pl + (a / maxAge) * (W - pl - pr);
  const y = (v: number) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const path = (arr: [number, number][]) => arr.map(([a, v], i) => `${i ? 'L' : 'M'}${x(a).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const band = (a: [number, number][], b: [number, number][]) => path(a) + b.slice().reverse().map(([aa, v]) => `L${x(aa).toFixed(1)},${y(v).toFixed(1)}`).join('') + 'Z';
  const ticksX = useMonths ? Array.from({ length: Math.floor(maxAge / 30.4375) + 1 }, (_, i) => i).filter(i => i % (maxAge > 400 ? 3 : 1) === 0).map(m => ({ a: m * 30.4375, l: `${m}m` })) : Array.from({ length: Math.floor(maxAge / 7) + 1 }, (_, i) => i).filter(i => i % (maxAge > 70 ? 2 : 1) === 0).map(w => ({ a: w * 7, l: `${w}w` }));
  const stepY = hi - lo > 20 ? 5 : hi - lo > 8 ? 2 : 1;
  const ticksY: number[] = []; for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) ticksY.push(v);
  const c = (p: number) => curves.find(q => q.p === p)!.arr;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${LABEL[ind]} chart with WHO percentile curves and ${valid.length} recorded measurements`}>
        {ticksY.map(v => <g key={v}><line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} className="grid" /><text x={pl - 6} y={y(v) + 4} textAnchor="end" className="axis">{v}</text></g>)}
        {ticksX.map(t => <text key={t.l} x={x(t.a)} y={H - 8} textAnchor="middle" className="axis">{t.l}</text>)}
        <path d={band(c(3), c(97))} className="band band-outer" />
        <path d={band(c(15), c(85))} className="band band-inner" />
        {curves.map(cv => <path key={cv.p} d={path(cv.arr)} className={`pct pct-${cv.p}`} />)}
        {valid.length > 1 && <path d={path(valid.map(p => [p.age.days, p.v]))} className="baby-line" />}
        {valid.map(p => (
          <g key={p.g.measurement_id} className="pt-hit" onClick={() => onPick(p.g.measurement_id)} role="button" tabIndex={0} aria-label={`${formatDateKey(p.g.measurement_date)}: ${p.v} ${UNIT[ind]}`} onKeyDown={e => e.key === 'Enter' && onPick(p.g.measurement_id)}>
            <circle cx={x(p.age.days)} cy={y(p.v)} r={14} fill="transparent" />
            <circle cx={x(p.age.days)} cy={y(p.v)} r={picked === p.g.measurement_id ? 6.5 : 4.5} className="baby-pt" />
          </g>
        ))}
        <text x={W - pr} y={y(c(97)[c(97).length - 1][1]) - 3} textAnchor="end" className="pct-label">97th</text>
        <text x={W - pr} y={y(c(50)[c(50).length - 1][1]) - 3} textAnchor="end" className="pct-label">50th</text>
        <text x={W - pr} y={y(c(3)[c(3).length - 1][1]) + 11} textAnchor="end" className="pct-label">3rd</text>
      </svg>
      <figcaption className="legend"><span><i className="lg-baby" /> {baby.name.split(' ')[0]}</span><span><i className="lg-50" /> 50th</span><span><i className="lg-band" /> 3rd–97th</span><span className="muted">Age: {pts.some(p => p.age.corrected) ? 'corrected' : 'chronological'}{useMonths ? ' (months)' : ' (weeks)'}</span></figcaption>
      {pts.length > valid.length && <p className="muted small">{pts.length - valid.length} measurement(s) aren’t plotted because they fall outside the 0–24 month WHO range for the age used.</p>}
    </figure>
  );
}

export function GrowthCharts({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const nav = useNav();
  const [ind, setInd] = useState<Indicator>('weight');
  const [picked, setPicked] = useState<string | null>(null);
  const users = useStore(s => s.users);
  if (!ctx) return null;
  const { baby, growth } = ctx;
  const withV = growth.filter(g => toDisplay(ind, g) != null).sort((a, b) => a.measurement_date.localeCompare(b.measurement_date));
  const sel = withV.find(g => g.measurement_id === picked) ?? withV[withV.length - 1];
  const a = sel ? assess(baby, ind, sel.measurement_date, toDisplay(ind, sel)) : null;
  const ga = baby.gestational_age_weeks;

  return (
    <Page title="Growth Charts" onBack={onBack} right={<button className="link" onClick={() => nav.push({ name: 'measure' })}>Add</button>}>
      <Segmented label="Measurement" value={ind} onChange={v => { setInd(v); setPicked(null); }} options={[{ value: 'weight', label: 'Weight' }, { value: 'length', label: 'Length' }, { value: 'head', label: 'Head circ.' }]} />
      {sel && a ? (
        <div className="card stat-card">
          <div><span className="muted small">{LABEL[ind]}</span><strong className="stat-big">{ind === 'weight' ? a.value!.toFixed(2) : a.value!.toFixed(1)} {UNIT[ind]}</strong>
            <span className="muted small">{a.percentile != null ? `${formatPercentile(a.percentile)} percentile` : a.reason}</span></div>
          <div className="stat-side"><span className="muted small">Date</span><strong>{formatDateKey(sel.measurement_date, 'weekday')}</strong>
            <span className="muted small">Age {describeAge(a.ageDays).replace(' old', '')}{a.corrected ? ' (corrected)' : ''}</span>
            <span className="muted tiny">Entered by {(sel.created_by && users[sel.created_by]?.display_name) || 'Former caregiver'}</span></div>
        </div>
      ) : null}
      {withV.length ? <Chart ind={ind} onPick={setPicked} picked={sel?.measurement_id ?? null} /> : <Empty icon={<IScale size={30} />} title={`No ${LABEL[ind].toLowerCase()} measurements yet`} text="Add measurements from your healthcare visits, or add birth details in Settings, to see them on the chart." action={<div className="btn-row"><button className="btn primary" onClick={() => nav.push({ name: 'measure' })}>Add measurement</button><button className="btn soft" onClick={() => nav.push({ name: 'profile' })}>Birth details</button></div>} />}
      <div className="alert notice soft"><IInfo size={20} /><span>Growth charts are reference tools. A single measurement doesn’t show how a baby is growing — your healthcare professional is best placed to interpret them.</span></div>
      {ga != null && ga < 37 && <p className="muted small">Born at {ga}+{baby.gestational_age_days || 0} weeks: percentiles use corrected age (age minus weeks born early).</p>}
      {ga == null && <p className="muted small">Gestational age isn’t set, so chronological age is used. If your baby was born early, add it in Settings → Baby profile.</p>}
      {withV.length > 0 && (
        <div className="card">
          {[...withV].reverse().map(g => {
            const r = assess(baby, ind, g.measurement_date, toDisplay(ind, g));
            return <Row key={g.measurement_id} onClick={() => nav.push({ name: 'measure', id: g.measurement_id })} title={`${ind === 'weight' ? r.value!.toFixed(2) : r.value!.toFixed(1)} ${UNIT[ind]}`} sub={`${formatDateKey(g.measurement_date, 'weekday')} · ${r.percentile != null ? formatPercentile(r.percentile) + ' percentile' : r.reason}${g.notes ? ' · ' + g.notes : ''}`} right={<IChevron />} />;
          })}
        </div>
      )}
      <p className="muted tiny">Reference: {WHO_SOURCE}</p>
    </Page>
  );
}
