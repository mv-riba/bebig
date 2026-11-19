import React, { useState } from 'react';
import { Field, Segmented, Wave } from '../ui/ui';
import { register, signIn, resetPassword, createBaby, respondToInvite, useStore, pendingInvitesForMe, signOut } from '../lib/store';
import { createDemoBaby } from '../lib/seed';
import { guessTimezone, todayKey } from '../lib/time';
import { TzSelect, resizeImage } from './Settings';
import { syncMode } from '../lib/sync';
import type { FeedingPreference, Sex } from '../lib/types';

export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="22" fill="#E4ECDD" />
      <path d="M33 27.5A10.5 10.5 0 1 1 20.5 15a8.5 8.5 0 0 0 12.5 12.5z" fill="#C9C2E6" />
      <circle cx="31" cy="15" r="2" fill="#F2C9A9" />
    </svg>
  );
}

export function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'register' | 'reset'>('signin');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const remoteMode = syncMode() === 'remote';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setMsg(null); setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, pw);
      else if (mode === 'register') await register(email, pw, name);
      else if (remoteMode) { await resetPassword(email, ''); setMsg('If an account exists for that email, we’ve sent a link to reset your password.'); setMode('signin'); }
      else { await resetPassword(email, pw); setMsg('If an account exists for that email, its password has been updated. You can sign in now.'); setMode('signin'); setPw(''); }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <div className="blob blob-peach" aria-hidden="true" /><div className="blob blob-lav" aria-hidden="true" />
      <div className="auth-brand"><Logo size={64} /><h1>Bebig</h1><p className="muted">Record effortlessly. Understand patterns. Plan with confidence.</p></div>
      <form className="card auth-card" onSubmit={submit}>
        {mode !== 'reset' && <Segmented label="Account" value={mode} onChange={m => { setMode(m); setErr(null); }} options={[{ value: 'signin', label: 'Sign in' }, { value: 'register', label: 'Create account' }]} />}
        {mode === 'reset' && <h2>Reset password</h2>}
        {mode === 'register' && <Field label="Your name"><input autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sanne" /></Field>}
        <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        {!(mode === 'reset' && remoteMode) && <Field label={mode === 'reset' ? 'New password' : 'Password'} hint={mode !== 'signin' ? '(at least 8 characters)' : undefined}>
          <input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required minLength={mode === 'signin' ? 1 : 8} value={pw} onChange={e => setPw(e.target.value)} />
        </Field>}
        {err && <div className="alert error" role="alert">{err}</div>}
        {msg && <div className="alert ok" role="status">{msg}</div>}
        <button className="btn primary block" disabled={busy}>{mode === 'signin' ? 'Sign in' : mode === 'register' ? 'Create account' : remoteMode ? 'Send reset link' : 'Update password'}</button>
        {mode === 'signin' && <button type="button" className="link small center-block" onClick={() => { setMode('reset'); setErr(null); }}>Forgot password?</button>}
        {mode === 'reset' && <button type="button" className="link small center-block" onClick={() => setMode('signin')}>Back to sign in</button>}
        {syncMode() === 'local' && <p className="muted tiny center">Local mode — accounts and records stay in this browser. {mode === 'reset' ? 'In the live app, a reset link is emailed instead.' : ''}</p>}
      </form>
      <Wave tone="sage" />
    </div>
  );
}

export function InvitesBanner() {
  const invites = useStore(s => pendingInvitesForMe(s));
  const babies = useStore(s => s.babies); const users = useStore(s => s.users);
  if (!invites.length) return null;
  return (
    <div className="invites">
      {invites.map(i => (
        <div key={i.access_id} className="card invite">
          <p><strong>{users[i.invited_by]?.display_name ?? 'Someone'}</strong> invited you to {babies[i.baby_id]?.name ?? 'a baby'}’s profile as a {i.role}.</p>
          <div className="btn-row"><button className="btn soft small" onClick={() => respondToInvite(i.access_id, false)}>Decline</button><button className="btn primary small" onClick={() => respondToInvite(i.access_id, true)}>Accept</button></div>
        </div>
      ))}
    </div>
  );
}

export function Onboarding() {
  const tz0 = guessTimezone();
  const [f, setF] = useState({ name: '', dob: '', tob: '', sex: '' as Sex | '', tz: tz0, pref: 'breast' as FeedingPreference, gaw: '', gad: '', bw: '', bl: '', bh: '' });
  const [photo, setPhoto] = useState<string | null>(null); const [more, setMore] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const num = (v: string) => v.trim() === '' ? null : Number(v.replace(',', '.'));
  const save = () => {
    setErr(null);
    if (!f.name.trim()) return setErr('Please enter your baby’s name.');
    if (!f.dob || f.dob > todayKey(f.tz)) return setErr('Please enter a valid date of birth.');
    if (!f.sex) return setErr('Please choose the sex used for growth references.');
    const gw = num(f.gaw); if (gw != null && (gw < 22 || gw > 44)) return setErr('Gestational age weeks should be between 22 and 44.');
    const bw = num(f.bw), bl = num(f.bl), bh = num(f.bh);
    if (bw != null && (bw < 0.3 || bw > 7)) return setErr('Birth weight should be in kg, e.g. 3.4');
    createBaby({ name: f.name.trim(), date_of_birth: f.dob, time_of_birth: f.tob || null, sex: f.sex, timezone: f.tz, feeding_preference: f.pref, photograph_url: photo,
      gestational_age_weeks: gw, gestational_age_days: gw != null ? num(f.gad) ?? 0 : null,
      birth_weight_grams: bw != null ? Math.round(bw * 1000) : null, birth_length_mm: bl != null ? Math.round(bl * 10) : null, birth_head_circumference_mm: bh != null ? Math.round(bh * 10) : null });
  };
  return (
    <div className="onboarding page">
      <div className="blob blob-peach" aria-hidden="true" />
      <div className="auth-brand"><Logo /><h1>Welcome to Bebig</h1><p className="muted">Let’s set up your baby’s profile.</p></div>
      <InvitesBanner />
      <div className="card form-card">
        <label className="photo-pick">
          {photo ? <img src={photo} alt="Baby" className="avatar" width={84} height={84} /> : <span className="avatar avatar-ph" style={{ width: 84, height: 84 }}>＋</span>}
          <span className="link small">Add photo (optional)</span>
          <input type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && resizeImage(e.target.files[0]).then(setPhoto)} />
        </label>
        <Field label="Baby’s name"><input value={f.name} onChange={set('name')} placeholder="First or preferred name" /></Field>
        <div className="two"><Field label="Date of birth"><input type="date" max={todayKey(f.tz)} value={f.dob} onChange={set('dob')} /></Field><Field label="Time of birth" hint="(optional)"><input type="time" value={f.tob} onChange={set('tob')} /></Field></div>
        <Field label="Sex" hint="(for WHO growth references)"><Segmented label="Sex" value={f.sex || null} onChange={v => setF({ ...f, sex: v })} options={[{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }]} /></Field>
        <Field label="Time zone"><TzSelect value={f.tz} onChange={v => setF({ ...f, tz: v })} /></Field>
        <Field label="Feeding"><Segmented label="Feeding preference" value={f.pref} onChange={v => setF({ ...f, pref: v })} options={[{ value: 'breast', label: 'Breastfed' }, { value: 'formula', label: 'Formula' }, { value: 'combination', label: 'Combination' }]} /></Field>
        <button type="button" className="link small" onClick={() => setMore(!more)}>{more ? 'Hide' : 'Add'} birth details (optional)</button>
        {more && (
          <>
            <Field label="Gestational age at birth"><div className="two"><input inputMode="numeric" placeholder="weeks" aria-label="weeks" value={f.gaw} onChange={set('gaw')} /><input inputMode="numeric" placeholder="days" aria-label="days" value={f.gad} onChange={set('gad')} /></div></Field>
            <div className="three"><Field label="Weight (kg)"><input inputMode="decimal" value={f.bw} onChange={set('bw')} /></Field><Field label="Length (cm)"><input inputMode="decimal" value={f.bl} onChange={set('bl')} /></Field><Field label="Head (cm)"><input inputMode="decimal" value={f.bh} onChange={set('bh')} /></Field></div>
          </>
        )}
        {err && <div className="alert error" role="alert">{err}</div>}
        <button className="btn primary block" onClick={save}>Create profile</button>
      </div>
      <div className="center onboard-alt">
        <button className="link" onClick={() => createDemoBaby()}>Explore with sample data instead</button>
        <button className="link small muted" onClick={() => signOut()}>Sign out</button>
      </div>
    </div>
  );
}
