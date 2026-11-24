import React, { useEffect, useState, useCallback } from 'react';
import { useStore, currentUserId, selectedBaby, isRemote, isInitialPullDone, onNotice } from './lib/store';
import { Logo } from './screens/Auth';
import { NavCtx, Tab, Route } from './ui/nav';
import { ToastProvider, ConfirmProvider, useToast } from './ui/ui';
import { IHome, ICalendar, IInsights, IChat, ISettings } from './ui/icons';
import { AuthScreen, Onboarding, InvitesBanner } from './screens/Auth';
import { Page } from './ui/ui';
import { Home } from './screens/Home';
import { Calendar } from './screens/Calendar';
import { Insights } from './screens/Insights';
import { Assistant } from './screens/Assistant';
import { Settings, ProfileEdit, FeedingPrefPage, SharingPage, PrefsPage, DataPage, PrivacyPage, AccountPage } from './screens/Settings';
import { LogFeed } from './screens/LogFeed';
import { LogPoo } from './screens/LogPoo';
import { LogSleep } from './screens/LogSleep';
import { MeasureForm, GrowthCharts } from './screens/Growth';
import { useReminders } from './lib/reminders';
import { ExtrasSettings, TrackerEditor, ExtraForm } from './screens/Extras';
import { PlusPage, PausedBanner } from './ui/plus';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'home', label: 'Home', icon: <IHome /> },
  { id: 'calendar', label: 'Calendar', icon: <ICalendar /> },
  { id: 'insights', label: 'Insights', icon: <IInsights /> },
  { id: 'assistant', label: 'Assistant', icon: <IChat /> },
  { id: 'settings', label: 'Settings', icon: <ISettings /> },
];

function Shell() {
  const [tab, setTabState] = useState<Tab>(() => { const h = location.hash.replace('#tab-', ''); return (['home', 'calendar', 'insights', 'assistant', 'settings'].includes(h) ? h : 'home') as Tab; });
  const [stack, setStack] = useState<Route[]>([]);
  const [calendarKey, setCalendarKey] = useState<string | null>(null);
  useReminders();

  // Integrate with browser/Android back button
  useEffect(() => {
    const onPop = () => setStack(s => s.slice(0, -1));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const push = useCallback((r: Route) => { history.pushState({ r: true }, ''); setStack(s => [...s, r]); window.scrollTo(0, 0); }, []);
  const pop = useCallback(() => { history.back(); }, []);
  const setTab = useCallback((t: Tab) => { setTabState(t); history.replaceState(history.state, '', '#tab-' + t); window.scrollTo(0, 0); }, []);
  const openDay = useCallback((k: string) => { setCalendarKey(k); setTab('calendar'); }, [setTab]);

  const top = stack[stack.length - 1];
  const overlay = top && (() => {
    switch (top.name) {
      case 'feed': return <LogFeed key={top.entryId ?? 'new'} entryId={top.entryId} onKey={top.onKey} onDone={pop} />;
      case 'poo': return <LogPoo key={top.entryId ?? 'new'} entryId={top.entryId} onKey={top.onKey} onDone={pop} />;
      case 'sleep': return <LogSleep key={top.entryId ?? 'new'} entryId={top.entryId} onKey={top.onKey} onDone={pop} />;
      case 'measure': if (top.id === 'birth') return <ProfileEdit onBack={pop} />; return <MeasureForm key={top.id ?? 'new'} id={top.id} onKey={top.onKey} onDone={pop} />;
      case 'growth': return <GrowthCharts onBack={pop} />;
      case 'extras-settings': return <ExtrasSettings onBack={pop} />;
      case 'tracker': return <TrackerEditor key={top.id ?? 'new'} id={top.id} onDone={pop} />;
      case 'extra': return <ExtraForm key={top.entryId ?? top.trackerId ?? 'new'} trackerId={top.trackerId} entryId={top.entryId} onKey={top.onKey} onDone={pop} />;
      case 'profile': return <ProfileEdit onBack={pop} />;
      case 'feeding-pref': return <FeedingPrefPage onBack={pop} />;
      case 'sharing': return <SharingPage onBack={pop} />;
      case 'prefs': return <PrefsPage onBack={pop} />;
      case 'data': return <DataPage onBack={pop} />;
      case 'privacy': return <PrivacyPage onBack={pop} />;
      case 'account': return <AccountPage onBack={pop} />;
      case 'plus': return <PlusPage onBack={pop} />;
      case 'add-baby': return <Page title="Add a baby" onBack={pop}><Onboarding onDone={pop} /></Page>;
    }
  })();

  return (
    <NavCtx.Provider value={{ tab, setTab, push, pop, calendarKey, openDay, selectDay: setCalendarKey }}>
      <div className="app">
        {overlay ? <main className="overlay">{overlay}</main> : (
          <main className="main" id="main">
            <InvitesBanner />
            <PausedBanner />
            {tab === 'home' && <Home />}
            {tab === 'calendar' && <Calendar />}
            {tab === 'insights' && <Insights />}
            {tab === 'assistant' && <Assistant />}
            {tab === 'settings' && <Settings />}
          </main>
        )}
        {!overlay && (
          <nav className="tabbar" aria-label="Main">
            {TABS.map(t => (
              <button key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
                {t.icon}<span>{t.label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </NavCtx.Provider>
  );
}

/** Messages from sync (e.g. another caregiver had already stopped the sleep) appear as toasts. */
function SyncNotices() {
  const toast = useToast();
  useEffect(() => onNotice(n => toast(n.text, n.action)), [toast]);
  return null;
}

export function App() {
  const uid = useStore(() => currentUserId());
  const hasBaby = useStore(s => !!selectedBaby(s));
  const loading = useStore(() => isRemote() && !isInitialPullDone());
  return (
    <ToastProvider><ConfirmProvider>
      <SyncNotices />
      {!uid ? <AuthScreen /> : !hasBaby && loading ? <div className="auth"><div className="auth-brand"><Logo size={64} /><h1>Bebig</h1><p className="muted">Loading your baby’s profile…</p></div></div> : !hasBaby ? <Onboarding /> : <Shell />}
    </ConfirmProvider></ToastProvider>
  );
}
