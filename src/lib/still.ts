// "Still feeding?" / "Still sleeping?": a breastfeeding timer over 1½ hours or a sleep timer over 12 hours was most
// likely left running (Maria, 25 Nov 2026). The app asks; "Yes" quiets the question for a while on this phone,
// "Finished earlier" saves the feed or sleep with the real end time.
export const STILL_FEEDING_AFTER_MS = 90 * 60000;
export const STILL_SLEEPING_AFTER_MS = 12 * 3600000;
/** After "Yes, still …", ask again this much later. */
const ASK_AGAIN_MS = { feed: 30 * 60000, sleep: 2 * 3600000 };

const key = (id: string) => `bebig:still:${id}`;
function confirmedAt(id: string): number { try { return Number(localStorage.getItem(key(id))) || 0; } catch { return 0; } }
export function confirmStill(id: string, now = Date.now()) { try { localStorage.setItem(key(id), String(now)); } catch { /* private mode: asked again */ } }

/** Should we ask "Still feeding?" / "Still sleeping?" about this running timer now? */
export function stillDue(kind: 'feed' | 'sleep', id: string, startedIso: string, now = Date.now()): boolean {
  const ran = now - Date.parse(startedIso);
  if (ran < (kind === 'feed' ? STILL_FEEDING_AFTER_MS : STILL_SLEEPING_AFTER_MS)) return false;
  return now - confirmedAt(id) >= ASK_AGAIN_MS[kind];
}
