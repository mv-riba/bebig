import React, { useEffect, useState } from 'react';
import { useStore, retryFailedSync, getState, useSyncPhase } from '../lib/store';
import { useConfirm } from './ui';
import { syncMode, syncNow } from '../lib/sync';
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

/** Shows offline state, "Updating…" while catching up after the app was away, and changes waiting to sync (PRD 17.2). */
export function SyncBadge() {
  const online = useOnline();
  const pending = useStore(s => s.outbox.length);
  const failed = useStore(s => s.syncFailed?.length ?? 0);
  const confirm = useConfirm();
  const showFailed = async () => {
    const list = getState().syncFailed || [];
    const kinds = Array.from(new Set(list.map(f => `${f.table}: ${f.error}`))).slice(0, 4).join('\n');
    if (await confirm({ title: `${list.length} change${list.length === 1 ? '' : 's'} not synced`, text: `The server said:\n${kinds}\n\nYour data is safe on this device. Retry now?`, ok: 'Retry' })) retryFailedSync();
  };
  const phase = useSyncPhase();
  const mode = syncMode();
  if (online && mode === 'remote' && phase === 'updating') return <span className="sync-badge busy" role="status"><span className="spinner" aria-hidden="true" /> Updating…</span>;
  if (online && mode === 'remote' && phase === 'failed') return <button className="sync-badge off" onClick={() => { syncNow(); }} aria-label="Couldn’t update. Tap to try again">Couldn’t update</button>;
  if (failed && online) return <button className="sync-badge off" onClick={showFailed} title="Some changes were rejected by the server. Tap for details.">⚠ {failed} not synced · details</button>;
  if (!online) return <span className="sync-badge off" role="status"><ICloudOff size={14} /> Offline{pending ? ` · ${pending} waiting` : ''}</span>;
  if (mode === 'remote' && pending) return <span className="sync-badge" role="status">Syncing {pending}…</span>;
  if (mode === 'remote') return <span className="sync-badge ok" role="status" title="All changes synced"><ICheck size={14} /></span>;
  return null;
}
