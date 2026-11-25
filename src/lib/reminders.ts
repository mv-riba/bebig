// Optional, user-enabled reminders (disabled by default — PRD 15). Simple elapsed-time nudges only;
// never feeding or medical advice. Fire while the app/PWA is running. Background push requires the native app.
import { useEffect } from 'react';
import { getState, accessibleBabies, myPrefs, live, activeSleep } from './store';

const fired = new Set<string>();
function notify(key: string, title: string, body: string) {
  if (fired.has(key) || !('Notification' in window) || Notification.permission !== 'granted') return;
  fired.add(key);
  try {
    navigator.serviceWorker?.ready.then(r => r.showNotification(title, { body, icon: '/icon-192.png', tag: key })).catch(() => new Notification(title, { body }));
  } catch { /* unsupported */ }
}

export function useReminders() {
  useEffect(() => {
    const tick = () => {
      const s = getState(); const p = myPrefs(s);
      // every baby, not just the one on screen: a twin's forgotten sleep timer matters as much
      for (const b of accessibleBabies(s)) {
      if (p.notifications.feeding) {
        const feeds = live(s.feeds, b.baby_id).sort((a, c) => +new Date(a.start_datetime) - +new Date(c.start_datetime));
        const last = feeds[feeds.length - 1];
        if (last && Date.now() - +new Date(last.start_datetime) >= p.notifications.feeding_interval_min * 60000)
          notify('feed:' + last.feed_id, 'Bebig', `It’s been ${p.notifications.feeding_interval_min / 60} h since ${b.name}’s last logged feed.`);
      }
      if (p.notifications.sleep) {
        const a = activeSleep(b.baby_id, s);
        if (a && Date.now() - +new Date(a.start_datetime) >= 4 * 3600000) notify('sleep:' + a.sleep_id, 'Bebig', `The sleep timer for ${b.name} has been running for over 4 hours. Did you forget to stop it?`);
      }
      }
    };
    const id = setInterval(tick, 60000); tick();
    return () => clearInterval(id);
  }, []);
}
