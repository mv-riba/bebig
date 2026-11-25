// Optional, user-enabled reminders (disabled by default — PRD 15). Simple elapsed-time nudges only;
// never feeding or medical advice. Fire while the app/PWA is running. Background push requires the native app.
import { useEffect } from 'react';
import { getState, accessibleBabies, myPrefs, live, activeSleep, feedTimerOf } from './store';
import { stillDue, confirmedAt } from './still';

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
      if (p.notifications.feeding) {
        const ft = feedTimerOf(b.baby_id, s);
        if (ft && stillDue('feed', ft.timer_id, ft.started_at)) notify(`still-feed:${ft.timer_id}:${confirmedAt(ft.timer_id)}`, 'Still feeding?', `${b.name}’s breastfeeding timer has been running for over 1½ hours. If it was left on, open Bebig to set when the feed finished.`);
      }
      if (p.notifications.sleep) {
        const a = activeSleep(b.baby_id, s);
        if (a && stillDue('sleep', a.sleep_id, a.start_datetime)) notify(`still-sleep:${a.sleep_id}:${confirmedAt(a.sleep_id)}`, 'Still sleeping?', `${b.name}’s sleep timer has been running for over 12 hours. If it was left on, open Bebig to set when ${b.name} woke up.`);
      }
      }
    };
    const id = setInterval(tick, 60000); tick();
    return () => clearInterval(id);
  }, []);
}
