import { PausedBanner } from '../ui/plus';
import React, { useState } from 'react';
import { Field, Segmented, Wave } from '../ui/ui';
import { register, signIn, resetPassword, createBaby, respondToInvite, useStore, pendingInvitesForMe, signOut } from '../lib/store';
import { createDemoBaby } from '../lib/seed';
import { guessTimezone, todayKey } from '../lib/time';
import { TzSelect, resizeImage } from './Settings';
import { syncMode } from '../lib/sync';
import type { FeedingPreference, Sex } from '../lib/types';
import { checkBirthDetails } from '../lib/validate';
import { Captcha, captchaEnabled } from '../ui/Captcha';

export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="22" fill="#ECE7F9" />
      <path d="M33 27.5A10.5 10.5 0 1 1 20.5 15a8.5 8.5 0 0 0 12.5 12.5z" fill="#9A8DD6" />
      <circle cx="31" cy="15" r="2" fill="#F2C9A9" />
    </svg>
  );
}

export function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'register' | 'reset'>('signin');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(() => { try { const m = sessionStorage.getItem('bebig:authmsg'); sessionStorage.removeItem('bebig:authmsg'); return m; } catch { return null; } });
  const [busy, setBusy] = useState(false);
  const remoteMode = syncMode() === 'remote';
  const needCaptcha = remoteMode && captchaEnabled();
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setMsg(null);
    if (needCaptcha && !captchaToken) return setErr('Please complete the security check below.');
    const token = captchaToken ?? undefined;
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, pw, token);
      else if (mode === 'register') await register(email, pw, name, token);
      else if (remoteMode) { await resetPassword(email, '', token); setMsg('If an account exists for that email, we’ve sent a link to reset your password.'); setMode('signin'); }
      else { await resetPassword(email, pw); setMsg('If an account exists for that email, its password has been updated. You can sign in now.'); setMode('signin'); setPw(''); }
    } catch (e: any) {
      const m: string = e.message || 'Something went wrong';
      if (m.startsWith('Check your email')) { setMsg(`We’ve sent a confirmation link to ${email.trim()}. Open it on this device, then you’re in (or come back and sign in).`); setMode('signin'); }
      else if (/email not confirmed/i.test(m)) setErr('Please confirm your email first — check your inbox (and spam) for the link from Bebig.');
      else if (/rate limit/i.test(m)) setErr('Too many emails were sent recently. Please wait a little and try again.');
      else if (/captcha/i.test(m)) setErr('The security check failed or expired. Please try again.');
      else setErr(m);
    } finally {
      setBusy(false);
      if (needCaptcha) setCaptchaReset(n => n + 1); // tokens are single-use
    }
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
        {mode === 'register' && <label className="consent"><input type="checkbox" required />
          <span>I’m 18 or over, I agree to the <a href="/terms/" target="_blank" rel="noopener">Terms</a>, and I consent to Bebig storing my baby’s care records, which can include health information, as described in the <a href="/privacy/" target="_blank" rel="noopener">Privacy policy</a>.</span></label>}
        {err && <div className="alert error" role="alert">{err}</div>}
        {msg && <div className="alert ok" role="status">{msg}</div>}
        {needCaptcha && <Captcha action={mode === 'register' ? 'signup' : mode} resetSignal={captchaReset} onToken={setCaptchaToken} />}
        <button className="btn primary block" disabled={busy || (needCaptcha && !captchaToken)}>{mode === 'signin' ? 'Sign in' : mode === 'register' ? 'Create account' : remoteMode ? 'Send reset link' : 'Update password'}</button>
        {mode === 'signin' && <button type="button" className="link small center-block" onClick={() => { setMode('reset'); setErr(null); }}>Forgot password?</button>}
        {mode === 'reset' && <button type="button" className="link small center-block" onClick={() => setMode('signin')}>Back to sign in</button>}
        {syncMode() === 'local' && <p className="muted tiny center">Local mode — accounts and records stay in this browser. {mode === 'reset' ? 'In the live app, a reset link is emailed instead.' : ''}</p>}
      </form>
      <p className="muted tiny center">Bebig is made by MVR Studios · <span className="nowrap">Business ID 3485332-7</span><br /><a className="link" href="/privacy/" target="_blank" rel="noopener">Privacy</a> · <a className="link" href="/terms/" target="_blank" rel="noopener">Terms</a> · <a className="link" href="mailto:support@bebig.app">support@bebig.app</a></p>
      <Wave tone="lav" />
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
          <p><strong>{(i.invited_by && users[i.invited_by]?.display_name) || 'Someone'}</strong> invited you to {babies[i.baby_id]?.name ?? 'a baby'}’s profile as a {i.role}.</p>
          <div className="btn-row"><button className="btn soft small" onClick={() => respondToInvite(i.access_id, false)}>Decline</button><button className="btn primary small" onClick={() => respondToInvite(i.access_id, true)}>Accept</button></div>
        </div>
      ))}
    </div>
  );
}

export function Onboarding({ onDone }: { onDone?: () => void } = {}) {
  const tz0 = guessTimezone();
  const [f, setF] = useState({ name: '', dob: '', tob: '', sex: '' as Sex | '', tz: tz0, pref: 'breast' as FeedingPreference, gaw: '', gad: '', bw: '', bl: '', bh: '' });
  const [photo, setPhoto] = useState<string | null>(null); const [more, setMore] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    setErr(null);
    if (!f.name.trim()) return setErr('Please enter your baby’s name.');
    if (!f.dob || f.dob > todayKey(f.tz)) return setErr('Please enter a valid date of birth.');
    if (!f.sex) return setErr('Please choose the sex used for growth references.');
    if (f.name.trim().length > 80) return setErr('Please keep the name under 80 characters.');
    // same limits as the database, so the profile can't get stuck unsynced
    const birth = checkBirthDetails({ ga_w: f.gaw, ga_d: f.gad, bw: f.bw, bl: f.bl, bh: f.bh });
    if (!birth.ok) return setErr(birth.error);
    try {
      createBaby({ name: f.name.trim(), date_of_birth: f.dob, time_of_birth: f.tob || null, sex: f.sex, timezone: f.tz, feeding_preference: f.pref, photograph_url: photo, ...birth.value });
    } catch (e: any) { return setErr(e.message); }
    onDone?.();
  };
  return (
    <div className={`onboarding page ${onDone ? 'embedded' : ''}`}>
      {!onDone && <div className="blob blob-peach" aria-hidden="true" />}
      {!onDone && <div className="auth-brand"><Logo /><h1>Welcome to Bebig</h1><p className="muted">Let’s set up your baby’s profile.</p></div>}
      {!onDone && <><InvitesBanner /><PausedBanner /></>}
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
        <button type="button" className="link small" onClick={() => setMore(!more)}>{more ? 'Hide birth details' : '+ Add birth details (weight, length, head, gestational age)'}</button>
        {!more && <p className="muted tiny">Optional — you can also add or change these any time in Settings → Birth details.</p>}
        {more && (
          <>
            <Field label="Gestational age at birth"><div className="two"><input inputMode="numeric" placeholder="weeks" aria-label="weeks" value={f.gaw} onChange={set('gaw')} /><input inputMode="numeric" placeholder="days" aria-label="days" value={f.gad} onChange={set('gad')} /></div></Field>
            <div className="three"><Field label="Weight (kg)"><input inputMode="decimal" value={f.bw} onChange={set('bw')} /></Field><Field label="Length (cm)"><input inputMode="decimal" value={f.bl} onChange={set('bl')} /></Field><Field label="Head (cm)"><input inputMode="decimal" value={f.bh} onChange={set('bh')} /></Field></div>
          </>
        )}
        {err && <div className="alert error" role="alert">{err}</div>}
        <button className="btn primary block" onClick={save}>Create profile</button>
      </div>
      {onDone ? <p className="muted small center">The new baby gets their own records, insights and sharing. Switch between babies by tapping the name on Home.</p> : <div className="center onboard-alt">
        <button className="link" onClick={() => createDemoBaby()}>Explore with sample data instead</button>
        <button className="link small muted" onClick={() => signOut()}>Sign out</button>
      </div>}
    </div>
  );
}
