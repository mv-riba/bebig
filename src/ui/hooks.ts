import { useStore, selectedBaby, live, myPrefs, roleFor, activeSleep, currentUserId } from '../lib/store';
import type { Data } from '../lib/calc';
import type { GrowthMeasurement, UserPrefs, BabyProfile, Role, SleepEntry, FeedTimer } from '../lib/types';

export interface BabyCtx { baby: BabyProfile; data: Data; growth: GrowthMeasurement[]; prefs: UserPrefs; role: Role; active: SleepEntry | null; feedTimer: FeedTimer | null; uid: string }

export function useBaby(): BabyCtx | null {
  return useStore(s => {
    const baby = selectedBaby(s); if (!baby) return null;
    const id = baby.baby_id;
    return {
      baby, uid: currentUserId()!,
      data: { baby, feeds: live(s.feeds, id), poos: live(s.poos, id), sleeps: live(s.sleeps, id) },
      growth: live(s.growth, id), prefs: myPrefs(s), role: roleFor(id) ?? 'caregiver',
      active: activeSleep(id, s), feedTimer: s.feedTimers[id] ?? null,
    };
  });
}

export function userName(s: { users: Record<string, { display_name: string }> }, id?: string | null) {
  return (id && s.users[id]?.display_name) || 'Someone';
}
