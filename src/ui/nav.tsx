import { createContext, useContext } from 'react';

export type Tab = 'home' | 'calendar' | 'insights' | 'assistant' | 'settings';
export type Route =
  | { name: 'feed' | 'poo' | 'sleep'; entryId?: string; onKey?: string }
  | { name: 'measure'; id?: string; onKey?: string }
  | { name: 'growth' }
  | { name: 'tracker'; id?: string }
  | { name: 'extra'; trackerId?: string; entryId?: string; onKey?: string }
  | { name: 'extras-settings' }
  | { name: 'profile' | 'feeding-pref' | 'sharing' | 'prefs' | 'data' | 'privacy' | 'account' | 'plus' | 'add-baby' };

export interface Nav { tab: Tab; setTab: (t: Tab) => void; push: (r: Route) => void; pop: () => void; calendarKey: string | null; openDay: (k: string) => void; selectDay: (k: string) => void }
export const NavCtx = createContext<Nav>(null as any);
export const useNav = () => useContext(NavCtx);
