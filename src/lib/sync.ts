// Sync orchestration. In local mode there is no server: the outbox is acknowledged immediately
// (tabs on the same device share state via BroadcastChannel). In remote mode, the Supabase backend
// (supabase.ts) drains the outbox and pulls remote changes.
import { getState, setState, subscribe } from './store';
import { config } from './config';

export const syncMode = (): 'local' | 'remote' => (config.supabaseUrl && config.supabaseAnonKey ? 'remote' : 'local');

let started = false;
export function startSync() {
  if (started) return; started = true;
  if (syncMode() === 'local') {
    const ack = () => { const s = getState(); if (s.outbox.length && navigator.onLine) setState(x => { x.outbox = []; x.lastSyncedAt = new Date().toISOString(); }, false); };
    subscribe(() => { if (navigator.onLine) setTimeout(ack, 400); });
    window.addEventListener('online', ack);
    ack();
    return;
  }
  import('./supabase').then(m => m.startRemoteSync());
}

/** Force a sync now (remote mode) and report status for the Settings screen. */
export async function syncNow() { if (syncMode() === 'remote') { const m = await import('./supabase'); await m.syncNow(); } }
export async function syncStatus(): Promise<string | null> { if (syncMode() !== 'remote') return null; const m = await import('./supabase'); return m.lastSyncError(); }
export async function syncDiagnostics(): Promise<string> {
  if (syncMode() !== 'remote') return 'Local mode — no cloud sync configured in this build.';
  const m = await import('./supabase'); return m.diagnostics();
}
