import React, { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { syncMode } from '../lib/sync';
import { ICloudOff, ICheck } from './icons';

export function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener('online', a); window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

/** Shows offline state and number of changes waiting to sync (PRD 17.2). */
export function SyncBadge() {
  const online = useOnline();
  const pending = useStore(s => s.outbox.length);
  const mode = syncMode();
  if (!online) return <span className="sync-badge off" role="status"><ICloudOff size={14} /> Offline{pending ? ` · ${pending} to sync` : ''}</span>;
  if (mode === 'remote' && pending) return <span className="sync-badge" role="status">Syncing {pending}…</span>;
  if (mode === 'remote') return <span className="sync-badge ok" role="status" title="All changes synced"><ICheck size={14} /></span>;
  return null;
}
