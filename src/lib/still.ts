// "Still feeding?" / "Still sleeping?": a breastfeeding timer over 1½ hours or a sleep timer over 12 hours was most
// likely left running (Maria, 25 Nov 2026). The app asks; "Yes" quiets the question for a while on this phone,
// "Finished earlier" saves the feed or sleep with the real end time.
export const STILL_FEEDING_AFTER_MS = 90 * 60000;
export const STILL_SLEEPING_AFTER_MS = 12 * 3600000;
/** After "Yes, still …", ask again this much later. */
const ASK_AGAIN_MS = { feed: 30 * 60000, sleep: 2 * 3600000 };

const key = (id: string) => `bebig:still:${id}`;
/** When "Yes, still …" was last tapped for this timer on this phone (0 = never). Also tells notifications apart:
 *  after a "Yes", the next question is a new notification. */
export function confirmedAt(id: string): number { try { return Number(localStorage.getItem(key(id))) || 0; } catch { return 0; } }
export function confirmStill(id: string, now = Date.now()) {
  try {
    localStorage.setItem(key(id), String(now));
    // forget answers about timers that finished long ago (a timer runs at most a day)
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('bebig:still:') && k !== key(id) && now - (Number(localStorage.getItem(k)) || 0) > 2 * 86400000) localStorage.removeItem(k);
    }
  } catch { /* private mode: asked again */ }
}

/** Should we ask "Still feeding?" / "Still sleeping?" about this running timer now? */
export function stillDue(kind: 'feed' | 'sleep', id: string, startedIso: string, now = Date.now()): boolean {
  const ran = now - Date.parse(startedIso);
  if (ran < (kind === 'feed' ? STILL_FEEDING_AFTER_MS : STILL_SLEEPING_AFTER_MS)) return false;
  return now - confirmedAt(id) >= ASK_AGAIN_MS[kind];
}

// "Is this a new feed?": coming back to a breastfeeding timer that nobody has touched or watched on this phone for
// 45 minutes. Most often the last feed was never stopped and a new one is starting (Maria, 26 Nov 2026: a 03:59
// timer was still running at 06:00 and the 06:00 feed went into it). Asked once per return, not while watching.
export const CAME_BACK_AFTER_MS = 45 * 60000;
const seenKey = (id: string) => `bebig:seen:${id}`;
/** When the timer screen last showed this timer on this phone (0 = never). */
export function lastSeen(id: string): number { try { return Number(localStorage.getItem(seenKey(id))) || 0; } catch { return 0; } }
export function markSeen(id: string, now = Date.now()) {
  try {
    localStorage.setItem(seenKey(id), String(now));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('bebig:seen:') && k !== seenKey(id) && now - (Number(localStorage.getItem(k)) || 0) > 2 * 86400000) localStorage.removeItem(k);
    }
  } catch { /* private mode */ }
}
/** Should "Is this a new feed?" be asked as the screen comes back? Only when the timer has run 45 minutes and
 *  nobody has tapped it (any caregiver), answered "still feeding", or had it on screen here for 45 minutes. */
export function cameBackDue(t: { timer_id: string; started_at: string; updated_at?: string | null }, now = Date.now()): boolean {
  const touched = Math.max(Date.parse(t.started_at), t.updated_at ? Date.parse(t.updated_at) || 0 : 0, lastSeen(t.timer_id), confirmedAt(t.timer_id));
  return now - Date.parse(t.started_at) >= CAME_BACK_AFTER_MS && now - touched >= CAME_BACK_AFTER_MS;
}
