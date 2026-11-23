import React, { useState } from 'react';
import { useBaby } from '../ui/hooks';
import { useNav, Route } from '../ui/nav';
import { Page, Row, Field, Segmented, useToast, Chip, useConfirm } from '../ui/ui';
import { IChevron, IBottle, IUsers, IChart, IExport, ISliders, IShield, ITrash, IEdit, IBell, ICrown } from '../ui/icons';
import { BabyAvatar } from './Home';
import {
  useStore, updateBaby, inviteCaregiver, revokeAccess, setRole, updatePrefs, exportBaby, deleteBabyData, signOut, updateAccount,
  deleteAccount, currentUserId, accessibleBabies, selectBaby, unsyncedCount, leaveBaby,
} from '../lib/store';
import { formatDateKey, describeAge, daysBetween, todayKey, listTimezones } from '../lib/time';
import { syncMode, syncNow, syncStatus, syncDiagnostics } from '../lib/sync';
import { formatAgo } from '../lib/time';
import { config } from '../lib/config';
import type { FeedingPreference } from '../lib/types';
import { usePlus, PlusBadge, PlusLink, PlusNote, chooseFreeCaregiver } from '../ui/plus';
import { BabySwitcher } from '../ui/babies';
import { memberState, pausedWhenPlusEnds, freeSlotId, LIMITS } from '../lib/plans';
import { checkBirthDetails, csvSafe } from '../lib/validate';

const PREF_LABEL: Record<FeedingPreference, string> = { breast: 'Breastfed', formula: 'Formula fed', combination: 'Combination fed' };

export function Settings() {
  const ctx = useBaby(); const nav = useNav();
  const members = useStore(s => ctx ? Object.values(s.access).filter(a => a.baby_id === ctx.baby.baby_id && a.invitation_status === 'accepted').length : 0);
  const babies = useStore(s => accessibleBabies(s));
  const me = useStore(s => s.users[currentUserId() ?? '']);
  const plus = usePlus(); const [switching, setSwitching] = useState(false);
  if (!ctx || !plus) return null;
  const { baby, prefs } = ctx;
  const go = (r: Route) => () => nav.push(r);
  const age = daysBetween(baby.date_of_birth, todayKey(baby.timezone));
  const nExtras = ctx.trackers.length + (baby.wet_tracking ? 1 : 0);
  const extrasSub = nExtras ? `${nExtras} on` : 'Wet nappies, bath, your own…';
  const hasBirth = baby.birth_weight_grams != null || baby.birth_length_mm != null || baby.birth_head_circumference_mm != null;
  return (
    <div className="screen settings">
      <header className="screen-head"><span /><h1>Settings</h1><span /></header>
      <button className="card profile-card" onClick={go({ name: 'profile' })}>
        <BabyAvatar src={baby.photograph_url} name={baby.name} size={72} />
        <span className="row-main"><span className="row-title big">{baby.name}</span><span className="row-sub">Born {formatDateKey(baby.date_of_birth, 'long')}<br />({describeAge(age)})</span></span>
        <IChevron />
      </button>
      <button className="link" onClick={() => setSwitching(true)}>{babies.length > 1 ? `Switch baby (${babies.length} profiles) or add one` : 'Add another baby'}</button>
      <BabySwitcher open={switching} onClose={() => setSwitching(false)} />
      <div className="sec-head"><h2>Birth details</h2><button className="link" onClick={go({ name: 'profile' })}><IEdit size={16} /> {hasBirth ? 'Edit' : 'Add'}</button></div>
      <button className="card kv" onClick={go({ name: 'profile' })} aria-label="Edit birth details">
        <div><span>Birth weight</span><strong>{baby.birth_weight_grams ? (baby.birth_weight_grams / 1000).toFixed(2) + ' kg' : <em className="muted">Not added</em>}</strong></div>
        <div><span>Birth length</span><strong>{baby.birth_length_mm ? (baby.birth_length_mm / 10).toFixed(1) + ' cm' : <em className="muted">Not added</em>}</strong></div>
        <div><span>Head circumference</span><strong>{baby.birth_head_circumference_mm ? (baby.birth_head_circumference_mm / 10).toFixed(1) + ' cm' : <em className="muted">Not added</em>}</strong></div>
        <div><span>Gestational age</span><strong>{baby.gestational_age_weeks != null ? `${baby.gestational_age_weeks}+${baby.gestational_age_days || 0} weeks` : <em className="muted">Not added</em>}</strong></div>
        {!hasBirth && <p className="kv-hint">Add birth weight, length and head circumference to see them as the first point on the growth charts.</p>}
      </button>
      <div className="card list">
        <Row icon={<ICrown className="plus-ic" />} title="Bebig Plus" sub={plus.label} onClick={go({ name: 'plus' })} right={<IChevron />} />
      </div>
      <div className="card list">
        <Row icon={<IBottle />} title="Feeding preferences" sub={PREF_LABEL[baby.feeding_preference]} onClick={go({ name: 'feeding-pref' })} right={<IChevron />} />
        <Row icon={<IUsers />} title="Shared access" sub={`${members} member${members === 1 ? '' : 's'}`} onClick={go({ name: 'sharing' })} right={<IChevron />} />
        <Row icon={<ISliders />} title={<>Extra trackers <PlusBadge /></>} sub={extrasSub} onClick={go({ name: 'extras-settings' })} right={<IChevron />} />
        <Row icon={<IChart />} title="Growth charts" onClick={go({ name: 'growth' })} right={<IChevron />} />
        <Row icon={<IExport />} title="Data export & deletion" onClick={go({ name: 'data' })} right={<IChevron />} />
        <Row icon={<ISliders />} title="App preferences" sub={`${prefs.time_format} · ${prefs.units}`} onClick={go({ name: 'prefs' })} right={<IChevron />} />
        <Row icon={<IShield />} title="Privacy" onClick={go({ name: 'privacy' })} right={<IChevron />} />
        <Row icon={<IEdit />} title="Account" sub={me?.email} onClick={go({ name: 'account' })} right={<IChevron />} />
      </div>
      {syncMode() === 'remote' && <SyncRow />}
      <p className="muted tiny center">Bebig {config.version} · {syncMode() === 'local' ? 'Local mode: data is stored on this device only' : 'Cloud sync on'}</p>
      <p className="muted tiny center"><a className="link" href="https://bebig.mvriba.com/" target="_blank" rel="noopener">Discover more about Bebig</a></p>
    </div>
  );
}

export function ProfileEdit({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const toast = useToast(); const confirm = useConfirm();
  const b = ctx!.baby;
  const [f, setF] = useState({ name: b.name, date_of_birth: b.date_of_birth, time_of_birth: b.time_of_birth ?? '', sex: b.sex, timezone: b.timezone,
    ga_w: b.gestational_age_weeks?.toString() ?? '', ga_d: b.gestational_age_days?.toString() ?? '',
    bw: b.birth_weight_grams ? (b.birth_weight_grams / 1000).toString() : '', bl: b.birth_length_mm ? (b.birth_length_mm / 10).toString() : '', bh: b.birth_head_circumference_mm ? (b.birth_head_circumference_mm / 10).toString() : '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const onPhoto = (file?: File) => { if (!file) return; resizeImage(file).then(url => { updateBaby(b.baby_id, { photograph_url: url }); toast('Photo updated'); }); };
  const save = async () => {
    setErr(null);
    if (!f.name.trim()) return setErr('Please enter a name.');
    if (!f.date_of_birth || f.date_of_birth > todayKey(f.timezone)) return setErr('Please enter a valid date of birth.');
    if (f.name.trim().length > 80) return setErr('Please keep the name under 80 characters.');
    const birth = checkBirthDetails(f);
    if (!birth.ok) return setErr(birth.error);
    if (f.timezone !== b.timezone && !(await confirm({ title: 'Change time zone?', text: 'All times and daily totals will be shown in the new zone. Recorded moments stay the same.', ok: 'Change' }))) return;
    updateBaby(b.baby_id, { name: f.name.trim(), date_of_birth: f.date_of_birth, time_of_birth: f.time_of_birth || null, sex: f.sex, timezone: f.timezone, ...birth.value });
    toast('Profile saved'); onBack();
  };
  return (
    <Page title="Baby profile" onBack={onBack}>
      <div className="photo-edit">
        <BabyAvatar src={b.photograph_url} name={b.name} size={96} />
        <label className="btn soft small">Change photo<input type="file" accept="image/*" hidden onChange={e => onPhoto(e.target.files?.[0])} /></label>
        {b.photograph_url && <button className="link small" onClick={() => updateBaby(b.baby_id, { photograph_url: null })}>Remove</button>}
      </div>
      <Field label="Name"><input value={f.name} onChange={set('name')} /></Field>
      <div className="two"><Field label="Date of birth"><input type="date" value={f.date_of_birth} onChange={set('date_of_birth')} /></Field><Field label="Time of birth" hint="(optional)"><input type="time" value={f.time_of_birth} onChange={set('time_of_birth')} /></Field></div>
      <Field label="Sex" hint="(used for WHO growth references)"><Segmented label="Sex" value={f.sex} onChange={v => setF({ ...f, sex: v })} options={[{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }]} /></Field>
      <Field label="Time zone"><TzSelect value={f.timezone} onChange={v => setF({ ...f, timezone: v })} /></Field>
      <div className="card form-section">
        <h2>Birth details</h2>
        <p className="muted small">All optional. Birth measurements appear as the first point on the growth charts; gestational age lets percentiles use corrected age if your baby was born early.</p>
        <div className="three">
          <Field label="Weight (kg)"><input inputMode="decimal" placeholder="e.g. 3.4" value={f.bw} onChange={set('bw')} /></Field>
          <Field label="Length (cm)"><input inputMode="decimal" placeholder="e.g. 50" value={f.bl} onChange={set('bl')} /></Field>
          <Field label="Head (cm)"><input inputMode="decimal" placeholder="e.g. 34" value={f.bh} onChange={set('bh')} /></Field>
        </div>
        <Field label="Gestational age at birth"><div className="two"><input inputMode="numeric" placeholder="weeks, e.g. 39" value={f.ga_w} onChange={set('ga_w')} aria-label="weeks" /><input inputMode="numeric" placeholder="days, e.g. 2" value={f.ga_d} onChange={set('ga_d')} aria-label="days" /></div></Field>
      </div>
      {err && <div className="alert error" role="alert">{err}</div>}
      <button className="btn primary block" onClick={save}>Save</button>
    </Page>
  );
}

export function TzSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const zones = listTimezones();
  return <select value={value} onChange={e => onChange(e.target.value)}>{(zones.includes(value) ? zones : [value, ...zones]).map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</select>;
}

export function resizeImage(file: File, max = 512): Promise<string> {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.82)); // re-encoding strips EXIF metadata (location etc.)
    };
    img.onerror = rej; img.src = url;
  });
}

export function FeedingPrefPage({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const toast = useToast();
  const b = ctx!.baby;
  const opts: { v: FeedingPreference; t: string; d: string }[] = [
    { v: 'breast', t: 'Breastfed', d: 'Direct breastfeeding, optional duration and left/right tracking.' },
    { v: 'formula', t: 'Formula fed', d: 'Bottle feeds with quantity in ml.' },
    { v: 'combination', t: 'Combination fed', d: 'Choose breastfeeding, expressed milk or formula for each feed.' },
  ];
  return (
    <Page title="Feeding preferences" onBack={onBack}>
      <div className="card list">{opts.map(o => (
        <button key={o.v} className={`row tap ${b.feeding_preference === o.v ? 'row-on' : ''}`} role="radio" aria-checked={b.feeding_preference === o.v} onClick={() => { updateBaby(b.baby_id, { feeding_preference: o.v }); toast('Feeding preference updated'); }}>
          <span className="radio" aria-hidden="true" /><span className="row-main"><span className="row-title">{o.t}</span><span className="row-sub">{o.d}</span></span>
        </button>))}</div>
      <p className="muted small">Changing this only affects new entries. Past feeds keep their original type.</p>
    </Page>
  );
}

export function SharingPage({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const toast = useToast(); const confirm = useConfirm(); const plus = usePlus();
  const b = ctx!.baby; const isOwner = ctx!.role === 'owner';
  const rows = useStore(s => Object.values(s.access).filter(a => a.baby_id === b.baby_id && a.invitation_status !== 'declined'));
  const users = useStore(s => s.users);
  const [email, setEmail] = useState(''); const [err, setErr] = useState<string | null>(null); const [limitHit, setLimitHit] = useState(false);
  const invite = () => { setErr(null); setLimitHit(false); try { inviteCaregiver(b.baby_id, email, 'caregiver', plus?.caregivers); setEmail(''); toast('Invitation created'); } catch (e: any) { setErr(e.message); setLimitHit(!!e.planLimit); } };
  const active = rows.filter(r => r.invitation_status === 'accepted'), pending = rows.filter(r => r.invitation_status === 'pending'), revoked = rows.filter(r => r.invitation_status === 'revoked');
  if (!plus) return null;
  const nameOf = (a: typeof rows[number]) => (a.user_id && users[a.user_id]?.display_name) || a.invited_email || '?'; // an empty name must not crash the page
  const STATE_LABEL = { owner: 'Owner', free: 'Caregiver', plus: 'Caregiver · with Plus', paused: 'Paused — needs Bebig Plus', pending: 'Invited' };
  const st = plus.status;
  const temporary = st.plus && (st.early_access || st.source === 'trial' || st.status === 'cancelled');
  const willPause = temporary ? pausedWhenPlusEnds(active) : [];
  const slot = active.find(a => a.access_id === freeSlotId(active));
  const keep = async (access_id: string) => { try { await chooseFreeCaregiver(access_id); toast('Updated who keeps access on the free plan'); } catch (e: any) { toast(e.message); } };
  return (
    <Page title="Shared access" onBack={onBack}>
      <h2 className="sec-title">Members</h2>
      <div className="card list">{active.map(a => {
        const ms = memberState(a, active, st);
        return (
          <Row key={a.access_id} icon={<span className={`avatar avatar-ph sm ${ms === 'paused' ? 'paused' : ''}`}>{nameOf(a)[0].toUpperCase()}</span>}
            title={nameOf(a)} sub={<>{a.invited_email} · {STATE_LABEL[ms]}{ms === 'free' && active.length > 2 && !st.plus ? ' · on the free plan' : ''}</>}
            right={isOwner && a.role !== 'owner' ? <span className="btn-row">
              {ms !== 'free' && active.length > 2 && (ms === 'paused' || temporary) && <button className="btn soft small" onClick={() => keep(a.access_id)}>{ms === 'paused' ? 'Unpause' : 'Keep on free'}</button>}
              <button className="btn soft small danger" onClick={async () => { if (await confirm({ title: 'Revoke access?', text: `${a.invited_email} will no longer see ${b.name}’s records.`, ok: 'Revoke', danger: true })) { revokeAccess(a.access_id); toast('Access revoked'); } }}>Revoke</button>
            </span> : null} />
        );
      })}</div>
      {isOwner && willPause.length > 0 && slot && (
        <div className="alert notice"><PlusBadge /><span>
          {st.early_access ? 'When early access ends' : st.source === 'trial' ? 'When the trial ends' : 'When Plus ends'}, the free plan includes you and one caregiver ({nameOf(slot)}). {willPause.map(nameOf).join(', ')} will be paused — not removed — until you get Plus. Use “Keep on free” to choose someone else.
        </span></div>
      )}
      {isOwner && !st.plus && active.some(a => memberState(a, active, st) === 'paused') && (
        <div className="alert notice"><PlusBadge /><span>Paused caregivers can’t see {b.name}’s records until you get Bebig Plus. Nothing they logged has been deleted. <PlusLink /></span></div>
      )}
      {pending.length > 0 && <><h2 className="sec-title">Pending invitations</h2><div className="card list">{pending.map(a => (
        <Row key={a.access_id} title={a.invited_email} sub="Waiting for them to sign in and accept" right={isOwner ? <button className="btn soft small" onClick={() => revokeAccess(a.access_id)}>Cancel</button> : null} />
      ))}</div></>}
      {isOwner ? (
        <>
          <h2 className="sec-title">Invite a parent or caregiver</h2>
          <PlusNote>The free plan includes you and one caregiver. More caregivers (up to {LIMITS.plus_caregivers}) are part of Bebig Plus.</PlusNote>
          <Field label="Email address"><input type="email" autoComplete="email" placeholder="partner@example.com" value={email} onChange={e => setEmail(e.target.value)} /></Field>
          {err && <div className="alert error">{err}</div>}
          {limitHit && <PlusLink />}
          <button className="btn primary block" onClick={invite} disabled={!email}>Send invitation</button>
          <p className="muted small">Caregivers can view, add and edit activity and measurements. Only you (the owner) can manage access or delete the profile. They’ll see the invitation after signing in with this email{syncMode() === 'local' ? ' — in local mode, on this device (try a second browser tab)' : ''}.</p>
        </>
      ) : <>
        <p className="muted small">Only the profile owner can invite or remove people.</p>
        <button className="btn soft block danger" onClick={async () => {
          if (!(await confirm({ title: `Leave ${b.name}’s profile?`, text: 'You’ll no longer see or add records. Everything you logged stays with the profile. To come back, the owner needs to invite you again.', ok: 'Leave', danger: true }))) return;
          try { await leaveBaby(b.baby_id); toast(`You’ve left ${b.name}’s profile`); onBack(); } catch (e: any) { toast(e.message); }
        }}>Leave this profile</button>
      </>}
      {revoked.length > 0 && <p className="muted tiny">Previously removed: {revoked.map(r => r.invited_email).join(', ')}</p>}
    </Page>
  );
}

export function PrefsPage({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const p = ctx!.prefs; const b = ctx!.baby; const toast = useToast(); const confirm = useConfirm();
  const setN = async (k: 'feeding' | 'sleep' | 'custom', v: boolean) => {
    if (v && 'Notification' in window && Notification.permission !== 'granted') {
      const r = await Notification.requestPermission();
      if (r !== 'granted') { toast('Notifications are blocked in your browser settings'); return; }
    }
    updatePrefs({ notifications: { ...p.notifications, [k]: v } });
  };
  return (
    <Page title="App preferences" onBack={onBack}>
      <Field label="Time format"><Segmented label="Time format" value={p.time_format} onChange={v => updatePrefs({ time_format: v })} options={[{ value: '24h', label: '24-hour' }, { value: '12h', label: '12-hour' }]} /></Field>
      <Field label="Units for measurements"><Segmented label="Units" value={p.units} onChange={v => updatePrefs({ units: v })} options={[{ value: 'metric', label: 'Metric (kg, cm)' }, { value: 'imperial', label: 'Imperial (lb, in)' }]} /></Field>
      <Field label="Baby’s time zone" hint="(all times use this)"><TzSelect value={b.timezone} onChange={async v => { if (await confirm({ title: 'Change time zone?', text: 'All times and daily totals will be shown in the new zone. Recorded moments are not changed.', ok: 'Change' })) updateBaby(b.baby_id, { timezone: v }); }} /></Field>
      <Field label="Language"><select value="en" disabled><option value="en">English</option></select></Field>
      <h2 className="sec-title"><IBell size={18} /> Reminders</h2>
      <p className="muted small">Off by default. Reminders appear while Bebig is open or installed on your home screen. They’re simple timers — never feeding or medical advice.</p>
      <div className="card list">
        <div className="row-stack">
          <label className="row"><span className="row-main"><span className="row-title">Feeding reminder</span><span className="row-sub">Reminds you when it’s been a while since the last logged feed</span></span>
            <input type="checkbox" className="switch" checked={p.notifications.feeding} onChange={e => setN('feeding', e.target.checked)} /></label>
          <label className="row-inline"><span>Remind me after</span>
            <select aria-label="Feeding reminder interval" value={p.notifications.feeding_interval_min} disabled={!p.notifications.feeding} onChange={e => updatePrefs({ notifications: { ...p.notifications, feeding_interval_min: Number(e.target.value) } })}>{[120, 150, 180, 210, 240].map(m => <option key={m} value={m}>{m / 60} h</option>)}</select></label>
        </div>
        <label className="row"><span className="row-main"><span className="row-title">Sleep timer reminder</span><span className="row-sub">If a sleep timer has run for 4+ hours</span></span><input type="checkbox" className="switch" checked={p.notifications.sleep} onChange={e => setN('sleep', e.target.checked)} /></label>
      </div>
    </Page>
  );
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Notes are free text written by any caregiver: cells that look like spreadsheet formulas are exported as text.
const csv = (rows: any[]) => {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const esc = (v: any) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : typeof v === 'string' ? csvSafe(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
};

export function DataPage({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const toast = useToast(); const confirm = useConfirm(); const b = ctx!.baby;
  const slug = b.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return (
    <Page title="Data" onBack={onBack}>
      <h2 className="sec-title">Export</h2>
      <p className="muted small">Download all of {b.name}’s records. Times are stored in UTC with the profile’s time zone included.</p>
      <div className="btn-row">
        <button className="btn soft" onClick={() => { download(`bebig-${slug}.json`, JSON.stringify(exportBaby(b.baby_id), null, 2), 'application/json'); toast('Export downloaded'); }}>Export JSON</button>
        <button className="btn soft" onClick={() => { const e = exportBaby(b.baby_id); for (const [k, rows] of Object.entries({ feeds: e.feeding_entries, poos: e.poo_entries, sleeps: e.sleep_entries, growth: e.growth_measurements })) if ((rows as any[]).length) download(`bebig-${slug}-${k}.csv`, csv(rows as any[]), 'text/csv'); toast('CSV files downloaded'); }}>Export CSV</button>
      </div>
      <h2 className="sec-title">Delete</h2>
      {ctx!.role === 'owner' ? (
        <>
          <p className="muted small">Permanently deletes {b.name}’s profile and all records for every member. This can’t be undone — export first if you want a copy.</p>
          <button className="btn danger block" onClick={async () => { if (await confirm({ title: `Delete all of ${b.name}’s data?`, text: 'This permanently removes the profile and every record for all members.', ok: 'Delete everything', danger: true, typeWord: 'DELETE' })) { deleteBabyData(b.baby_id); toast('All data deleted'); } }}><ITrash size={16} /> Delete all baby data</button>
        </>
      ) : <p className="muted small">Only the profile owner can delete the baby’s data. You can ask them, or leave the profile from Settings → Shared access.</p>}
    </Page>
  );
}

export function PrivacyPage({ onBack }: { onBack: () => void }) {
  const ctx = useBaby(); const p = ctx!.prefs; const toast = useToast();
  // consent is also recorded on the server, which checks it before any text is sent to the AI model
  const onAiConsent = async (on: boolean) => {
    updatePrefs({ ai_consent: on });
    if (syncMode() !== 'remote') return;
    try { const { setAiConsent } = await import('../lib/supabase'); await setAiConsent(on); }
    catch { updatePrefs({ ai_consent: !on }); toast('Couldn’t save that setting — check your connection and try again'); }
  };
  return (
    <Page title="Privacy" onBack={onBack}>
      <div className="prose">
        <p><strong>Your baby’s records are sensitive.</strong> Bebig treats them as health-related personal data.</p>
        <ul>
          <li>Only people you invite and who accept can see a baby profile. Access is enforced by the database, not just the app.</li>
          <li>Data is encrypted in transit (HTTPS) and at rest, and stored in the EU.</li>
          <li>Records are never shared with advertising networks and never sold.</li>
          <li>The AI assistant only reads records for the selected baby, and only for people with access.</li>
          <li>Records are not used to train third-party AI models.</li>
          <li>You can export or delete your data at any time (Settings → Data export &amp; deletion, and Settings → Account).</li>
        </ul>
        <p className="muted small">{syncMode() === 'local' ? 'You’re in local mode: everything stays in this browser on this device. Clearing browser data removes it.' : 'Cloud sync is on.'}</p>
        <p className="small"><a className="link" href="/privacy/" target="_blank" rel="noopener">Privacy policy</a> · <a className="link" href="/terms/" target="_blank" rel="noopener">Terms of use</a></p>
      </div>
      <label className="row card"><span className="row-main"><span className="row-title">Allow AI phrasing by our server-side model</span><span className="row-sub">Numbers are always calculated from your records. Off by default.</span></span><input type="checkbox" className="switch" checked={p.ai_consent} onChange={e => onAiConsent(e.target.checked)} /></label>
    </Page>
  );
}

export function AccountPage({ onBack }: { onBack: () => void }) {
  const me = useStore(s => s.users[currentUserId() ?? '']); const toast = useToast(); const confirm = useConfirm();
  const [name, setName] = useState(me?.display_name ?? '');
  if (!me) return null;
  return (
    <Page title="Account" onBack={onBack}>
      <Field label="Your name"><input value={name} maxLength={80} onChange={e => setName(e.target.value)} onBlur={() => { if (name.trim() && name !== me.display_name) { updateAccount({ display_name: name.trim() }); toast('Name updated'); } }} /></Field>
      <Field label="Email"><input value={me.email} disabled /></Field>
      <button className="btn soft block" onClick={async () => { const n = unsyncedCount(); if (!n || await confirm({ title: 'Sign out?', text: `${n} change${n > 1 ? 's haven’t' : ' hasn’t'} synced yet and would be lost. Try Settings → Sync now first.`, ok: 'Sign out anyway', danger: true })) signOut(); }}>Sign out</button>
      <button className="btn danger block" onClick={async () => { if (await confirm({ title: 'Delete your account?', text: 'Baby profiles you own will also be deleted for everyone.', ok: 'Delete account', danger: true, typeWord: 'DELETE' })) { try { await deleteAccount(); } catch (e: any) { toast(e.message || 'Couldn’t delete the account. Check your connection and try again.'); } } }}>Delete account</button>
    </Page>
  );
}

function SyncRow() {
  const last = useStore(s => s.lastSyncedAt);
  const pending = useStore(s => s.outbox.length + (s.syncFailed?.length ?? 0));
  const me = useStore(s => s.users[currentUserId() ?? '']);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = async () => { setBusy(true); await syncNow(); const e = await syncStatus(); setErr(e); setBusy(false); toast(e ? 'Sync problem: ' + e : 'Synced'); };
  const [diag, setDiag] = useState<string | null>(null);
  const showDiag = async () => { setBusy(true); try { await syncNow(); } catch { /* */ } setDiag(await syncDiagnostics()); setBusy(false); };
  const copy = async () => { try { await navigator.clipboard.writeText(diag || ''); toast('Copied — paste it to Claude'); } catch { toast('Couldn’t copy — take a screenshot instead'); } };
  return (
    <div className="card list">
      <Row title="Sync" sub={<>{last ? `Last synced ${formatAgo(last)}` : 'Not synced yet'}{pending ? ` · ${pending} change${pending > 1 ? 's' : ''} waiting` : ''}<br />Signed in as {me?.email}{err ? <><br /><span className="field-error">{err}</span></> : null}</>}
        right={<button className="btn soft small" disabled={busy} onClick={run}>{busy ? 'Syncing…' : 'Sync now'}</button>} />
      <button className="row tap" onClick={showDiag} disabled={busy}><span className="row-main"><span className="row-title">Sync diagnostics</span><span className="row-sub">Compare this device with the server</span></span></button>
      {diag && <div className="diag"><pre>{diag}</pre><button className="btn soft small" onClick={copy}>Copy</button></div>}
    </div>
  );
}
