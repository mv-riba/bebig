// Demo data for exploring the app. Clearly labelled as sample data in the UI.
import { createBaby, setState, uuid, currentUserId, nowIso } from './store';
import { todayKey, addDays, dayStart, guessTimezone } from './time';

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

export function createDemoBaby() {
  const tz = guessTimezone();
  const today = todayKey(tz);
  const dob = addDays(today, -21);
  const baby_id = createBaby({
    name: 'Emma (sample)', date_of_birth: dob, time_of_birth: '06:40', sex: 'female', timezone: tz,
    gestational_age_weeks: 39, gestational_age_days: 2, feeding_preference: 'combination',
    birth_weight_grams: 3250, birth_length_mm: 500, birth_head_circumference_mm: 340, photograph_url: null,
  });
  const uid = currentUserId()!; const r = rng(42); const t0 = nowIso();
  const now = Date.now();
  const audit = { baby_id, created_by: uid, updated_by: uid, created_at: t0, updated_at: t0, deleted_at: null };
  setState(s => {
    for (let back = 9; back >= 0; back--) {
      const key = addDays(today, -back);
      const ds = dayStart(key, tz).getTime();
      // feeds roughly every 2.5–3.2h starting around 01:00
      let tt = ds + (40 + r() * 40) * 60000;
      while (tt < ds + 86400000) {
        if (tt > now - 20 * 60000) break;
        const type = r() < 0.75 ? 'breast' : r() < 0.6 ? 'expressed' : 'formula';
        const dur = Math.round((14 + r() * 12) * 60);
        const id = uuid();
        const left = type === 'breast' && r() < 0.7 ? Math.round(dur * (0.4 + r() * 0.2)) : null;
        s.feeds[id] = {
          ...audit, feed_id: id, feeding_type: type as any, start_datetime: new Date(tt).toISOString(),
          end_datetime: type === 'breast' ? new Date(tt + dur * 1000).toISOString() : null,
          duration_seconds: type === 'breast' ? dur : null,
          left_duration_seconds: left, right_duration_seconds: left != null ? dur - left : null,
          quantity_ml: type === 'breast' ? null : Math.round((70 + r() * 30) / 5) * 5,
          observations: r() < 0.2 ? ['Fell asleep during feeding'] : r() < 0.15 ? ['Very hungry'] : [], notes: null,
        };
        // poo ~ 3.5–4.5h after some feeds
        if (r() < 0.45) {
          const pt = tt + (200 + r() * 70) * 60000;
          if (pt < now) {
            const pid = uuid();
            s.poos[pid] = { ...audit, poo_id: pid, datetime: new Date(pt).toISOString(), colour: r() < 0.8 ? 'yellow' : 'green', size: (['small', 'medium', 'large'] as const)[Math.floor(r() * 3)], texture: r() < 0.7 ? 'soft' : 'loose', notes: null };
          }
        }
        tt += (150 + r() * 40) * 60000;
      }
      // sleep: night blocks + day naps (one long nap around 12:30–15:00)
      const blocks: [number, number][] = [[0.5, 2.6], [3.4, 6.2], [8.4 + r() * 0.5, 9.6 + r() * 0.4], [12.1 + r() * 0.5, 14.4 + r() * 0.6], [16.3 + r() * 0.5, 17.2 + r() * 0.4], [19.5 + r() * 0.5, 23.2 + r() * 0.5]];
      for (const [a, b] of blocks) {
        const st = ds + a * 3600000, en = ds + b * 3600000;
        if (en > now) continue;
        const id = uuid();
        s.sleeps[id] = { ...audit, sleep_id: id, start_datetime: new Date(st).toISOString(), end_datetime: new Date(en).toISOString(), duration_seconds: Math.round((en - st) / 1000), status: 'completed', pauses: [], notes: null };
      }
    }
    for (const [days, w, l, h] of [[0, 3250, 500, 340], [5, 3150, null, null], [12, 3480, 515, 352], [19, 3790, 525, 361]] as const) {
      const id = uuid();
      s.growth[id] = { ...audit, measurement_id: id, measurement_date: addDays(dob, days), weight_grams: w, length_mm: l, head_circumference_mm: h, notes: days === 0 ? 'Birth' : null };
    }
  });
  return baby_id;
}
