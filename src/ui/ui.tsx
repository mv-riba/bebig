import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { IBack, IX } from './icons';

// ---------- Ticking clock for elapsed times ----------
export function useNow(intervalMs = 15000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    const vis = () => setNow(Date.now());
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); };
  }, [intervalMs]);
  return now;
}

// ---------- Toasts ----------
interface ToastMsg { id: number; text: string; action?: { label: string; run: () => void } }
const ToastCtx = createContext<(text: string, action?: ToastMsg['action']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const push = useCallback((text: string, action?: ToastMsg['action']) => {
    const id = Date.now() + Math.random();
    setItems(x => [...x.slice(-2), { id, text, action }]);
    setTimeout(() => setItems(x => x.filter(t => t.id !== id)), action ? 5000 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className="toast">
            <span>{t.text}</span>
            {t.action && <button className="toast-action" onClick={() => { t.action!.run(); setItems(x => x.filter(y => y.id !== t.id)); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Page shells ----------
/** `backLabel` names where Back goes (e.g. "Home" on a running timer), shown next to the same Back arrow as elsewhere. */
export function Page({ title, onBack, backLabel, onCancel, right, children, className = '' }: { title: string; onBack?: () => void; backLabel?: string; onCancel?: () => void; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`page ${className}`}>
      <header className="page-head">
        <div className="page-head-l">
          {onCancel && <button className="link" onClick={onCancel}>Cancel</button>}
          {onBack && (backLabel
            ? <button className="link back-link" onClick={onBack}><IBack size={20} />{backLabel}</button>
            : <button className="icon-btn" onClick={onBack} aria-label="Back"><IBack /></button>)}
        </div>
        <h1>{title}</h1>
        <div className="page-head-r">{right}</div>
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="sheet-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><IX /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: { value: T | null | undefined; options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[]; onChange: (v: T) => void; label: string; size?: 'md' | 'lg' }) {
  return (
    <div className={`seg seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={`seg-opt ${value === o.value ? 'on' : ''}`} onClick={() => onChange(o.value)} type="button">
          {o.icon}<span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={!!on} onClick={onClick}>{children}</button>;
}

export function Field({ label, hint, children, error }: { label: string; hint?: string; children: React.ReactNode; error?: string | null }) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <em> {hint}</em>}</span>
      {children}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

export function Stepper({ value, onChange, step = 1, min = 0, max = 999, unit, label }: { value: number | null; onChange: (v: number | null) => void; step?: number; min?: number; max?: number; unit: string; label: string }) {
  return (
    <div className="stepper">
      <input aria-label={label} inputMode="numeric" value={value ?? ''} placeholder="—" onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); onChange(v === '' ? null : Math.min(max, Number(v))); }} />
      <span className="stepper-unit">{unit}</span>
      <button type="button" className="round-btn" aria-label={`Decrease ${label}`} onClick={() => onChange(Math.max(min, (value ?? 0) - step))}>−</button>
      <button type="button" className="round-btn" aria-label={`Increase ${label}`} onClick={() => onChange(Math.min(max, (value ?? 0) + step))}>+</button>
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon?: React.ReactNode; title: string; text?: string; action?: React.ReactNode }) {
  return <div className="empty">{icon && <div className="empty-ic">{icon}</div>}<strong>{title}</strong>{text && <p>{text}</p>}{action}</div>;
}

export function Row({ icon, title, sub, onClick, right }: { icon?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; onClick?: () => void; right?: React.ReactNode }) {
  const C: any = onClick ? 'button' : 'div';
  return (
    <C className={`row ${onClick ? 'tap' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
      {icon && <span className="row-ic">{icon}</span>}
      <span className="row-main"><span className="row-title">{title}</span>{sub && <span className="row-sub">{sub}</span>}</span>
      {right}
    </C>
  );
}

export function Wave({ tone = 'sage' }: { tone?: 'sage' | 'peach' | 'lav' }) {
  return (
    <svg className={`wave wave-${tone}`} viewBox="0 0 400 90" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 60 C 80 20, 160 90, 240 55 S 360 30, 400 50 V90 H0z" />
      <path d="M0 75 C 100 50, 200 95, 300 70 S 380 60, 400 68 V90 H0z" opacity=".6" />
    </svg>
  );
}


// ---------- In-app confirmation dialog (replaces window.confirm/prompt; works in installed PWAs & embedded frames) ----------
interface ConfirmOpts { title: string; text?: string; ok?: string; cancel?: string; danger?: boolean; typeWord?: string }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [st, setSt] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>(resolve => { setTyped(''); setSt({ ...o, resolve }); }), []);
  const close = (v: boolean) => { st?.resolve(v); setSt(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Sheet open={!!st} onClose={() => close(false)} title={st?.title ?? ''}>
        {st?.text && <p className="muted">{st.text}</p>}
        {st?.typeWord && <Field label={`Type ${st.typeWord} to confirm`}><input autoFocus value={typed} onChange={e => setTyped(e.target.value)} /></Field>}
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn soft" onClick={() => close(false)}>{st?.cancel ?? 'Cancel'}</button>
          <button className={`btn ${st?.danger ? 'danger' : 'primary'}`} disabled={!!st?.typeWord && typed.trim() !== st.typeWord} onClick={() => close(true)}>{st?.ok ?? 'Confirm'}</button>
        </div>
      </Sheet>
    </ConfirmCtx.Provider>
  );
}
