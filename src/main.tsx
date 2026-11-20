import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startSync } from './lib/sync';
import './styles.css';

startSync();
createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker?.register('./sw.js', { updateViaCache: 'none' }).then(r => {
      r.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') r.update().catch(() => {}); });
    }).catch(() => {});
  });
  // a new version took over: reload once so the screen shows it (never while the user is mid-form: only if hidden or on next open)
  let reloaded = false; const hadController = !!navigator.serviceWorker?.controller; // first install: no reload
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return; reloaded = true;
    if (document.visibilityState === 'hidden') location.reload(); else document.addEventListener('visibilitychange', () => location.reload(), { once: true });
  });
}
