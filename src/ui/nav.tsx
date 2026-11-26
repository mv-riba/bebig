import { createContext, useContext } from 'react';

export type Tab = 'home' | 'calendar' | 'insights' | 'assistant' | 'settings';
/** Tab names as the tab bar shows them, e.g. for a Back button that says where it goes. */
export const TAB_LABEL: Record<Tab, string> = { home: 'Home', calendar: 'Calendar', insights: 'Insights', assistant: 'Assistant', settings: 'Settings' };
export type Route =
  // draftId: an entry just undone from its "saved" toast; the form opens filled in with it so it can be corrected
  | { name: 'feed' | 'poo' | 'sleep'; entryId?: string; onKey?: string; draftId?: string }
  | { name: 'measure'; id?: string; onKey?: string }
  | { name: 'growth' }
  | { name: 'tracker'; id?: string }
  | { name: 'extra'; trackerId?: string; entryId?: string; onKey?: string; draftId?: string }
  | { name: 'extras-settings' }
  | { name: 'profile' | 'feeding-pref' | 'sharing' | 'prefs' | 'data' | 'privacy' | 'account' | 'plus' | 'add-baby' };

export interface Nav { tab: Tab; setTab: (t: Tab) => void; push: (r: Route) => void; pop: () => void; calendarKey: string | null; openDay: (k: string) => void; selectDay: (k: string) => void }
export const NavCtx = createContext<Nav>(null as any);
export const useNav = () => useContext(NavCtx);
