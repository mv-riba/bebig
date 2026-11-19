import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startSync } from './lib/sync';
import './styles.css';

startSync();
createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker?.register('./sw.js').catch(() => {}));
}
