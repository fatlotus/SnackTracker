import { useCallback, useEffect, useRef, useState } from 'react';
import './index.css';
import type { Baby, DiaperEvent, TrackingEvent, User } from '@baby-tracker/shared';
import {
  Baby as BabyIcon,
  BarChart3,
  Clock,
  FileDown,
  Home,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { acceptInvite } from './lib/api.js';
import { getCurrentUser, logout } from './lib/auth.js';
import { useI18n, type TranslationKey } from './lib/i18n.js';
import {
  deleteEvent,
  getActiveTimersForBaby,
  listBabies,
  listEventsForBaby,
  subscribeStore,
  type ActiveTimersForBaby,
} from './lib/store.js';
import {
  getSyncStatus,
  startSyncLoop,
  stopSyncLoop,
  subscribeSyncStatus,
  syncOnce,
  type SyncStatus,
} from './lib/sync.js';
import { ActiveTimersBanner } from './components/ActiveTimersBanner.js';
import { AuthView } from './components/AuthView.js';
import { BabySwitcher } from './components/BabySwitcher.js';
import { DashboardView, type ModalRequest } from './components/DashboardView.js';
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import { OnboardingView } from './components/OnboardingView.js';
import { TimelineView } from './components/TimelineView.js';
import {
  BottleFeedModal,
  BreastFeedModal,
  DiaperModal,
  SleepModal,
  SpitUpModal,
} from './components/TrackingModals.js';
import { TrendsView } from './components/TrendsView.js';
import {
  ACTIVE_BABY_STORAGE_KEY,
  extractInviteCodeFromLocation,
  resolveThemeIsDark,
  THEME_STORAGE_KEY,
  VOLUME_UNIT_STORAGE_KEY,
  type ThemePreference,
  type VolumeUnit,
} from './components/uiUtils.js';
import { ExportPage } from './pages/ExportPage.js';
import { SettingsSharePage } from './pages/SettingsSharePage.js';

type NavTab = 'dashboard' | 'timeline' | 'trends' | 'export' | 'family';

const NAV_ITEMS: { id: NavTab; labelKey: TranslationKey; icon: typeof Home }[] = [
  { id: 'dashboard', labelKey: 'app.nav.dashboard', icon: Home },
  { id: 'timeline', labelKey: 'app.nav.timeline', icon: Clock },
  { id: 'trends', labelKey: 'app.nav.trends', icon: BarChart3 },
  { id: 'export', labelKey: 'app.nav.export', icon: FileDown },
  { id: 'family', labelKey: 'app.nav.family', icon: Users },
];

function readStoredTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

function readStoredVolumeUnit(): VolumeUnit {
  if (typeof window === 'undefined') return 'ml';
  const raw = window.localStorage.getItem(VOLUME_UNIT_STORAGE_KEY);
  return raw === 'oz' ? 'oz' : 'ml';
}

function readStoredBabyId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACTIVE_BABY_STORAGE_KEY);
}

function ThemeIcon({ theme }: { theme: ThemePreference }) {
  if (theme === 'dark') return <Moon className="h-4 w-4" />;
  if (theme === 'light') return <Sun className="h-4 w-4" />;
  return <Monitor className="h-4 w-4" />;
}

export function App() {
  const { t } = useI18n();
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true,
  );
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(
    () =>
      typeof window !== 'undefined'
        ? extractInviteCodeFromLocation(
            window.location.pathname,
            window.location.search,
          )
        : null,
  );
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [babies, setBabies] = useState<Baby[]>([]);
  const [activeBabyId, setActiveBabyId] = useState<string | null>(readStoredBabyId);
  const [events, setEvents] = useState<TrackingEvent[]>([]);
  const [timers, setTimers] = useState<ActiveTimersForBaby>({
    breastFeed: null,
    bottleFeed: null,
    sleep: null,
  });

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [timelineInitialDateKey, setTimelineInitialDateKey] = useState<
    string | null
  >(null);
  const [timelineResetNonce, setTimelineResetNonce] = useState(0);
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => getSyncStatus());

  const [theme, setTheme] = useState<ThemePreference>(readStoredTheme);
  const [volumeUnit, setVolumeUnit] = useState<VolumeUnit>(readStoredVolumeUnit);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 5-second Undo toast for 1-tap diaper logs
  const [undoDiaper, setUndoDiaper] = useState<DiaperEvent | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const activeBabyIdRef = useRef<string | null>(activeBabyId);
  activeBabyIdRef.current = activeBabyId;
  const refreshSeqRef = useRef(0);

  // Responsive desktop breakpoint listener for single active LanguageSwitcher testid
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Theme application
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const isDark = resolveThemeIsDark(theme, media.matches);
      document.documentElement.classList.toggle('dark', isDark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(VOLUME_UNIT_STORAGE_KEY, volumeUnit);
  }, [volumeUnit]);

  const handleSelectBaby = useCallback((babyId: string) => {
    setActiveBabyId(babyId);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACTIVE_BABY_STORAGE_KEY, babyId);
    }
  }, []);

  // Load babies & active baby's events from IDB
  const refreshFromStore = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const allBabies = await listBabies();
    if (seq !== refreshSeqRef.current) return;
    setBabies(allBabies);

    const currentActiveId = activeBabyIdRef.current;
    const targetId =
      allBabies.find((b) => b.id === currentActiveId)?.id ??
      allBabies[0]?.id ??
      null;

    if (targetId !== currentActiveId && targetId !== null) {
      handleSelectBaby(targetId);
    }

    if (targetId) {
      const [evList, activeTimers] = await Promise.all([
        listEventsForBaby(targetId),
        getActiveTimersForBaby(targetId),
      ]);
      if (seq !== refreshSeqRef.current) return;
      setEvents(evList);
      setTimers(activeTimers);
    } else {
      setEvents([]);
      setTimers({ breastFeed: null, bottleFeed: null, sleep: null });
    }
  }, [handleSelectBaby]);

  // Initial auth resolution
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getCurrentUser();
      if (cancelled) return;
      if (res.unauthorized) {
        stopSyncLoop();
        setUser(null);
      } else {
        setUser(res.user);
      }
      setAuthReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync loop + Store subscriptions when authenticated (decoupled from activeBabyId)
  useEffect(() => {
    if (!user) {
      stopSyncLoop();
      return;
    }

    const unsubSync = subscribeSyncStatus((status) => {
      setSyncStatus(status);
      if (
        status.state === 'error' &&
        status.lastError &&
        /401|unauthori[sz]ed|authentication required/i.test(status.lastError)
      ) {
        stopSyncLoop();
      }
    });
    const stopLoop = startSyncLoop();

    return () => {
      unsubSync();
      stopLoop();
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void refreshFromStore();
    const unsubStore = subscribeStore(() => {
      void refreshFromStore();
    });
    return () => {
      unsubStore();
    };
  }, [user, refreshFromStore]);

  // Refresh events when switching babies
  useEffect(() => {
    if (!user || !activeBabyId) return;
    void refreshFromStore();
  }, [user, activeBabyId, refreshFromStore]);

  // Handle pending invite code once authenticated
  useEffect(() => {
    if (!user || !pendingInviteCode) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await acceptInvite({ code: pendingInviteCode });
        if (cancelled) return;
        await syncOnce();
        handleSelectBaby(res.baby.id);
        setPendingInviteCode(null);
        setInviteError(null);
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', '/');
        }
      } catch (err) {
        if (cancelled) return;
        setInviteError(
          err instanceof Error ? err.message : t('app.inviteAcceptFailed'),
        );
        setPendingInviteCode(null);
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', '/');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, pendingInviteCode, handleSelectBaby, t]);

  // Live 1s timer tick when any timer is active; 15s otherwise
  const hasActiveTimer = Boolean(
    timers.breastFeed || timers.bottleFeed || timers.sleep,
  );
  useEffect(() => {
    const intervalMs = hasActiveTimer ? 1000 : 15_000;
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [hasActiveTimer]);

  const handleLogout = useCallback(async () => {
    setActionError(null);
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoDiaper(null);
    setModal(null);
    setInviteError(null);
    try {
      stopSyncLoop();
      await logout();
      setUser(null);
      setBabies([]);
      setEvents([]);
      setTimers({ breastFeed: null, bottleFeed: null, sleep: null });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('app.signOutFailed'),
      );
    }
  }, [t]);

  const handleDiaperQuickLogged = useCallback((event: DiaperEvent) => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
    }
    setUndoDiaper(event);
    undoTimerRef.current = setTimeout(() => {
      setUndoDiaper(null);
      undoTimerRef.current = null;
    }, 5000);
  }, []);

  const handleUndoDiaper = useCallback(async () => {
    if (!undoDiaper || !user) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    const targetId = undoDiaper.id;
    setUndoDiaper(null);
    setActionError(null);
    try {
      await deleteEvent(targetId, user.id);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('app.undoDiaperFailed'),
      );
    }
  }, [undoDiaper, user, t]);

  function cycleTheme() {
    setTheme((prev) => {
      if (prev === 'light') return 'dark';
      if (prev === 'dark') return 'system';
      const prefersDark =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const resolvedDark = resolveThemeIsDark(prev, prefersDark);
      return resolvedDark ? 'light' : 'dark';
    });
  }

  if (!authReady) {
    return (
      <div className="bt-surface min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <RefreshCw className="h-4 w-4 animate-spin text-teal-600" />
          <span>{t('app.loading')}</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthView
        pendingInviteCode={pendingInviteCode}
        onAuthenticated={(authedUser) => setUser(authedUser)}
        onClearInvite={() => {
          setPendingInviteCode(null);
          if (typeof window !== 'undefined') {
            window.history.replaceState({}, '', '/');
          }
        }}
      />
    );
  }

  const activeBaby = babies.find((b) => b.id === activeBabyId) ?? babies[0] ?? null;

  const errorBanners = (
    <>
      {inviteError && (
        <div className="no-print mx-auto mt-3 flex w-full max-w-6xl items-center justify-between gap-2 px-4">
          <div
            role="alert"
            className="flex w-full items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
          >
            <span>{inviteError}</span>
            <button
              type="button"
              onClick={() => setInviteError(null)}
              aria-label={t('app.dismissInviteError')}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg hover:bg-rose-100 dark:hover:bg-rose-900/50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      {actionError && (
        <div className="no-print mx-auto mt-3 flex w-full max-w-6xl items-center justify-between gap-2 px-4">
          <div
            role="alert"
            className="flex w-full items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
          >
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              aria-label={t('common.dismissError')}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg hover:bg-rose-100 dark:hover:bg-rose-900/50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );

  if (!activeBaby) {
    return (
      <div className="bt-surface min-h-screen">
        {errorBanners}
        <OnboardingView
          user={user}
          onBabyReady={(baby) => {
            handleSelectBaby(baby.id);
            void refreshFromStore();
          }}
          onLogout={() => void handleLogout()}
        />
      </div>
    );
  }

  const syncLabel =
    syncStatus.state === 'offline'
      ? t('app.sync.offline')
      : syncStatus.state === 'syncing'
        ? t('app.sync.syncing')
        : syncStatus.state === 'error'
          ? t('app.sync.error')
          : syncStatus.pendingCount > 0
            ? t('app.sync.pending', { count: syncStatus.pendingCount })
            : t('app.sync.synced');

  const themeLabel = t(`app.theme.${theme}` as TranslationKey);

  return (
    <div className="bt-surface min-h-screen text-slate-900 dark:text-slate-100 lg:flex">
      {/* Desktop Left Sidebar (>= 1024px) */}
      <aside className="no-print hidden lg:flex lg:w-72 lg:shrink-0 lg:flex-col lg:border-r lg:border-stone-200 lg:bg-white lg:dark:border-slate-800 lg:dark:bg-slate-900">
        <div className="flex h-16 items-center justify-between gap-2 border-b border-stone-200 px-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-xs shadow-teal-600/20">
              <BabyIcon className="h-5 w-5" />
            </div>
            <span className="truncate text-lg font-bold tracking-tight">
              {t('app.brand')}
            </span>
          </div>
        </div>

        <div className="p-4 border-b border-stone-200 dark:border-slate-800">
          <BabySwitcher
            babies={babies}
            activeBaby={activeBaby}
            onSelectBaby={handleSelectBaby}
            onManageBabies={() => setActiveTab('family')}
          />
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  setTimelineInitialDateKey(null);
                  if (item.id === 'timeline') {
                    setTimelineResetNonce((n) => n + 1);
                  }
                  setActiveTab(item.id);
                }}
                className={`bt-focus-ring flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3.5 text-sm font-medium transition ${
                  active
                    ? 'bg-teal-50 text-teal-700 ring-1 ring-teal-200/70 dark:bg-teal-950/70 dark:text-teal-300 dark:ring-teal-800/60'
                    : 'text-slate-600 hover:bg-stone-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-3 border-t border-stone-200 p-4 text-xs dark:border-slate-800">
          {/* Language Switcher */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-slate-500 dark:text-slate-400">
              {t('lang.ariaLabel')}
            </span>
            <LanguageSwitcher
              testId={isDesktop ? 'language-switcher' : ''}
              variant="full"
            />
          </div>

          {/* Sync status + Sync now */}
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-300">
              {syncStatus.state === 'offline' ? (
                <WifiOff className="h-3.5 w-3.5 text-amber-500" />
              ) : (
                <span
                  className={`h-2 w-2 rounded-full ${
                    syncStatus.state === 'error'
                      ? 'bg-rose-500'
                      : syncStatus.state === 'syncing'
                        ? 'bg-sky-500 animate-pulse'
                        : 'bg-emerald-500'
                  }`}
                />
              )}
              <span>{syncLabel}</span>
            </span>
            <button
              type="button"
              onClick={() => void syncOnce()}
              className="bt-focus-ring rounded-lg border border-stone-200 px-2.5 py-1.5 font-medium hover:bg-stone-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {t('app.sync.syncNow')}
            </button>
          </div>

          {/* Theme + Unit toggles */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={cycleTheme}
              aria-label={t('app.theme.aria', { theme: themeLabel })}
              className="bt-focus-ring inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-stone-200 px-2.5 font-medium hover:bg-stone-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <ThemeIcon theme={theme} />
              <span className="capitalize">{themeLabel}</span>
            </button>
            <button
              type="button"
              onClick={() =>
                setVolumeUnit((u) => (u === 'ml' ? 'oz' : 'ml'))
              }
              className="bt-focus-ring inline-flex min-h-[40px] items-center justify-center rounded-xl border border-stone-200 px-3 font-semibold uppercase hover:bg-stone-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {volumeUnit}
            </button>
          </div>

          {/* User + Sign Out */}
          <div className="flex items-center justify-between pt-1">
            <span className="truncate font-medium text-slate-700 dark:text-slate-300">
              {user.displayName}
            </span>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="inline-flex items-center gap-1 text-rose-600 hover:underline dark:text-rose-400"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>{t('app.signOut')}</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile Sticky Top Header (< 1024px) */}
        <header className="no-print sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-stone-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 lg:hidden">
          <div className="min-w-0 flex-1">
            <BabySwitcher
              babies={babies}
              activeBaby={activeBaby}
              onSelectBaby={handleSelectBaby}
              onManageBabies={() => setActiveTab('family')}
              compact
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <LanguageSwitcher
              testId={!isDesktop ? 'language-switcher' : ''}
              variant="compact"
            />
            <button
              type="button"
              onClick={() => void syncOnce()}
              aria-label={t('app.sync.statusAria', { status: syncLabel })}
              title={syncLabel}
              className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-stone-200 bg-white text-xs font-medium dark:border-slate-700 dark:bg-slate-900"
            >
              {syncStatus.state === 'offline' ? (
                <WifiOff className="h-4 w-4 text-amber-500" />
              ) : (
                <RefreshCw
                  className={`h-4 w-4 ${syncStatus.state === 'syncing' ? 'animate-spin text-sky-500' : 'text-teal-600'}`}
                />
              )}
            </button>
            <button
              type="button"
              onClick={cycleTheme}
              aria-label={t('app.theme.aria', { theme: themeLabel })}
              title={t('app.theme.aria', { theme: themeLabel })}
              className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-stone-200 bg-white dark:border-slate-700 dark:bg-slate-900"
            >
              <ThemeIcon theme={theme} />
            </button>
          </div>
        </header>

        {/* Sticky Active-Timer Banner */}
        <ActiveTimersBanner
          babyId={activeBaby.id}
          userId={user.id}
          timers={timers}
          nowMs={nowMs}
          onFinishBottle={(ev) =>
            setModal({ kind: 'bottle_finish', event: ev })
          }
        />

        {errorBanners}

        <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-4 pb-24 sm:px-6 lg:py-6 lg:pb-8">
          {activeTab === 'dashboard' && (
            <DashboardView
              babyId={activeBaby.id}
              userId={user.id}
              userName={user.displayName}
              events={events}
              timers={timers}
              nowMs={nowMs}
              volumeUnit={volumeUnit}
              onOpenModal={setModal}
              onDiaperQuickLogged={handleDiaperQuickLogged}
              onViewTimeline={(dateKey) => {
                setTimelineInitialDateKey(dateKey ?? null);
                setActiveTab('timeline');
              }}
            />
          )}

          {activeTab === 'timeline' && (
            <TimelineView
              key={timelineResetNonce}
              events={events}
              userId={user.id}
              volumeUnit={volumeUnit}
              nowMs={nowMs}
              initialDateKey={timelineInitialDateKey}
              onEditEvent={(ev) => setModal({ kind: 'edit', event: ev })}
            />
          )}

          {activeTab === 'trends' && (
            <TrendsView
              events={events}
              volumeUnit={volumeUnit}
              nowMs={nowMs}
            />
          )}

          {activeTab === 'export' && (
            <ExportPage
              baby={activeBaby}
              events={events}
              volumeUnit={volumeUnit}
              nowMs={nowMs}
            />
          )}

          {activeTab === 'family' && (
            <SettingsSharePage
              user={user}
              baby={activeBaby}
              syncStatus={syncStatus}
              theme={theme}
              volumeUnit={volumeUnit}
              onChangeTheme={setTheme}
              onChangeVolumeUnit={setVolumeUnit}
              onSelectBaby={handleSelectBaby}
              onLogout={() => void handleLogout()}
            />
          )}
        </main>
      </div>

      {/* Mobile Thumb-Zone Bottom Navigation (< 1024px) */}
      <nav
        aria-label={t('app.nav.primaryAria')}
        className="no-print pb-safe fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-stone-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 lg:hidden"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                setTimelineInitialDateKey(null);
                if (item.id === 'timeline') {
                  setTimelineResetNonce((n) => n + 1);
                }
                setActiveTab(item.id);
              }}
              className={`flex min-h-[52px] min-w-[44px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] font-medium ${
                active
                  ? 'text-teal-600 dark:text-teal-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {/* 5-Second Undo Toast for 1-Tap Diaper Log */}
      {undoDiaper && (
        <div className="no-print fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg dark:bg-slate-800 lg:bottom-6">
          <span className="capitalize">
            {t('app.loggedDiaper', {
              kind: t(`modals.diaper.kind.${undoDiaper.payload.kind}` as TranslationKey),
            })}
          </span>
          <button
            type="button"
            onClick={() => void handleUndoDiaper()}
            className="min-h-[44px] rounded-lg bg-amber-500 px-3 text-xs font-bold text-slate-950 hover:bg-amber-400"
          >
            {t('app.undo')}
          </button>
        </div>
      )}

      {/* Tracking Modals */}
      {modal?.kind === 'breast_manual' && (
        <BreastFeedModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'bottle_manual' && (
        <BottleFeedModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          volumeUnit={volumeUnit}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'bottle_finish' && (
        <BottleFeedModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          volumeUnit={volumeUnit}
          finishingActive={modal.event}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'sleep_manual' && (
        <SleepModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'diaper_details' && (
        <DiaperModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'spit_up' && (
        <SpitUpModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          recentEvents={events}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'edit' && modal.event.type === 'breast_feed' && (
        <BreastFeedModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          existing={modal.event}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'edit' && modal.event.type === 'bottle_feed' && (
        <BottleFeedModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          volumeUnit={volumeUnit}
          existing={modal.event}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'edit' && modal.event.type === 'sleep' && (
        <SleepModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          existing={modal.event}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'edit' && modal.event.type === 'diaper' && (
        <DiaperModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          existing={modal.event}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'edit' && modal.event.type === 'spit_up' && (
        <SpitUpModal
          babyId={activeBaby.id}
          userId={user.id}
          userName={user.displayName}
          recentEvents={events}
          existing={modal.event}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default App;
