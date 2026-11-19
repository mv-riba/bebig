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
