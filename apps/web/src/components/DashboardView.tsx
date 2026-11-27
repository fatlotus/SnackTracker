import { useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Baby as BabyIcon,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Droplets,
  GlassWater,
  Milk,
  Moon,
  Pause,
  Pill,
  Play,
  Plus,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import {
  addDays,
  computeDailyStats,
  computeLastActivitySummary,
  toLocalDateKey,
  type DiaperKind,
  type PumpingEvent,
  type TrackingEvent,
} from '@baby-tracker/shared';
import {
  computeBreastFeedElapsed,
  deleteEvent,
  finishBreastFeed,
  finishSleep,
  finishTummyTime,
  logDiaper,
  pauseBreastFeed,
  resumeBreastFeed,
  startBottleFeed,
  startBreastFeed,
  startPumping,
  startSleep,
  startTummyTime,
  switchBreastSide,
  toggleVitaminForLocalDay,
  type ActiveTimersForBaby,
} from '../lib/store.js';
import type { BottleFeedEvent, DiaperEvent } from '@baby-tracker/shared';
import { useI18n } from '../lib/i18n.js';
import {
  ALL_SUMMARY_CATEGORIES,
  DailySummaryCards,
  NON_PARENT_SUMMARY_CATEGORIES,
} from './DailySummaryCards.js';
import {
  formatClock,
  getLocalTimeZone,
  getTodayDateKey,
  getYesterdayDateKey,
  type VolumeUnit,
} from './uiUtils.js';

export type ModalRequest =
  | { kind: 'breast_manual' }
  | { kind: 'bottle_manual' }
  | { kind: 'bottle_finish'; event: BottleFeedEvent }
  | { kind: 'sleep_manual' }
  | { kind: 'diaper_details' }
  | { kind: 'spit_up' }
  | { kind: 'pumping_manual' }
  | { kind: 'pumping_finish'; event: PumpingEvent }
  | { kind: 'tummy_time_manual' }
  | { kind: 'edit'; event: TrackingEvent };

interface DashboardViewProps {
  babyId: string;
  userId: string;
  userName: string | null;
  events: TrackingEvent[];
  timers: ActiveTimersForBaby;
  nowMs: number;
  volumeUnit: VolumeUnit;
  canAccessPumping?: boolean;
  onOpenModal: (req: ModalRequest) => void;
  onDiaperQuickLogged: (event: DiaperEvent) => void;
  onViewTimeline: (dateKey?: string) => void;
}

export function DashboardView({
  babyId,
  userId,
  userName,
  events,
  timers,
  nowMs,
  volumeUnit,
  canAccessPumping = true,
  onOpenModal,
  onDiaperQuickLogged,
  onViewTimeline,
}: DashboardViewProps) {
  const {
    t,
    formatDurationShort,
    formatLocalTime,
    formatTimeAgo,
    formatVolume,
  } = useI18n();
  const timeZone = getLocalTimeZone();
  const todayKey = getTodayDateKey(timeZone, nowMs);
  const yesterdayKey = getYesterdayDateKey(timeZone, nowMs);
  const [selectedSummaryDateOverride, setSelectedSummaryDateOverride] =
    useState<string | null>(null);

  const selectedSummaryDateKey = selectedSummaryDateOverride ?? todayKey;
  const isSummaryToday = selectedSummaryDateKey === todayKey;
  const isSummaryYesterday = selectedSummaryDateKey === yesterdayKey;
  const canGoNextSummaryDay = selectedSummaryDateKey < todayKey;

  const todayStats = computeDailyStats(events, todayKey, timeZone, nowMs);
  const summaryStats = isSummaryToday
    ? todayStats
    : computeDailyStats(events, selectedSummaryDateKey, timeZone, nowMs);
  const lastActivity = computeLastActivitySummary(events, nowMs);

  const todayVitaminEvent =
    lastActivity.lastVitamin &&
    toLocalDateKey(Date.parse(lastActivity.lastVitamin.startedAt), timeZone) ===
      todayKey
      ? lastActivity.lastVitamin
      : null;
  const vitaminGivenToday = todayStats.vitaminGiven;

  const lastBreast = lastActivity.lastBreastFeed;
  const lastSide = lastBreast?.lastSide ?? null;
  const activeBreast = timers.breastFeed;
  const activeBottle = timers.bottleFeed;
  const activeSleep = timers.sleep;
  const activePumping = timers.pumping;
  const activeTummyTime = timers.tummyTime;

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function handlePrevSummaryDay() {
    setSelectedSummaryDateOverride(addDays(selectedSummaryDateKey, -1));
  }

  function handleNextSummaryDay() {
    if (!canGoNextSummaryDay) return;
    const nextKey = addDays(selectedSummaryDateKey, 1);
    setSelectedSummaryDateOverride(nextKey >= todayKey ? null : nextKey);
  }

  function handleTodaySummary() {
    setSelectedSummaryDateOverride(null);
  }

  async function runAction(actionKey: string, fn: () => Promise<unknown>) {
    if (busyAction !== null) return;
    setBusyAction(actionKey);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('dashboard.actionFailed'),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleQuickDiaper(kind: DiaperKind) {
    await runAction(`diaper:${kind}`, async () => {
      const created = await logDiaper({
        babyId,
        kind,
        userId,
        userName,
      });
      onDiaperQuickLogged(created);
    });
  }

  async function handleToggleVitamin(given: boolean) {
    await runAction(`vitamin:${given ? 'yes' : 'no'}`, () =>
      toggleVitaminForLocalDay({
        babyId,
        dateKey: todayKey,
        timeZone,
        given,
        userId,
        userName,
        nowMs,
      }),
    );
  }

  const summaryHeading = isSummaryToday
    ? t('dashboard.todaysSummary', { date: selectedSummaryDateKey })
    : isSummaryYesterday
      ? t('dashboard.yesterdaysSummary', { date: selectedSummaryDateKey })
      : t('dashboard.daySummary', { date: selectedSummaryDateKey });

  return (
    <div className="space-y-6">
      {actionError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label={t('common.dismissError')}
            className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg hover:bg-rose-100 dark:hover:bg-rose-900/50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Quick Actions & Live Timers */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* Breastfeeding Card */}
        <section
          aria-label={t('dashboard.breastfeeding')}
          className="bt-card bt-card-breast p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-breast inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <BabyIcon className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.breastfeeding')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {!lastBreast
                    ? t('dashboard.noSideYet')
                    : lastBreast.isOngoing
                      ? t('dashboard.feedingNow')
                      : lastSide
                        ? t('dashboard.lastBreastFeed', {
                            side:
                              lastSide === 'left'
                                ? t('common.left')
                                : t('common.right'),
                            duration: formatDurationShort(
                              lastBreast.durationSeconds,
                            ),
                            ago: formatTimeAgo(lastBreast.secondsSinceEnd),
                          })
                        : t('dashboard.lastBreastFeedNoSide', {
                            duration: formatDurationShort(
                              lastBreast.durationSeconds,
                            ),
                            ago: formatTimeAgo(lastBreast.secondsSinceEnd),
                          })}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenModal({ kind: 'breast_manual' })}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-xl px-2.5 text-xs font-medium text-teal-700 hover:bg-teal-50 dark:text-teal-300 dark:hover:bg-teal-950"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('dashboard.log')}</span>
            </button>
          </div>

          {activeBreast ? (() => {
            const elapsed = computeBreastFeedElapsed(activeBreast, nowMs);
            return (
              <div className="space-y-3">
                <div className="rounded-xl bg-teal-50 p-3 dark:bg-teal-950/60">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">
                      {elapsed.isPaused
                        ? t('common.paused')
                        : t('dashboard.activeSide', {
                            side:
                              elapsed.activeSide === 'left'
                                ? t('common.left')
                                : t('common.right'),
                          })}
                    </span>
                    <span className="tabular-nums-clock font-mono text-2xl font-bold text-teal-800 dark:text-teal-200">
                      {formatClock(elapsed.totalSeconds)}
                    </span>
                  </div>
                  <div className="tabular-nums-clock mt-1 flex justify-between text-xs text-teal-700/80 dark:text-teal-300/80">
                    <span>
                      {t('dashboard.leftClock', {
                        clock: formatClock(elapsed.leftSeconds),
                      })}
                    </span>
                    <span>
                      {t('dashboard.rightClock', {
                        clock: formatClock(elapsed.rightSeconds),
                      })}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void runAction('breast_toggle', () =>
                        elapsed.isPaused
                          ? resumeBreastFeed({ babyId, userId })
                          : pauseBreastFeed({ babyId, userId }),
                      )
                    }
                    className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl border border-slate-200 bg-slate-50 text-xs font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
                  >
                    {elapsed.isPaused ? (
                      <>
                        <Play className="h-3.5 w-3.5" />
                        <span>{t('dashboard.resume')}</span>
                      </>
                    ) : (
                      <>
                        <Pause className="h-3.5 w-3.5" />
                        <span>{t('dashboard.pause')}</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void runAction('breast_switch', () =>
                        switchBreastSide({ babyId, userId }),
                      )
                    }
                    className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl border border-slate-200 bg-slate-50 text-xs font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    <span>{t('dashboard.switch')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void runAction('breast_finish', () =>
                        finishBreastFeed({ babyId, userId }),
                      )
                    }
                    className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl bg-teal-600 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('dashboard.finish')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    aria-label={t('dashboard.discardBreastAria')}
                    onClick={() =>
                      void runAction('breast_discard', () =>
                        deleteEvent(activeBreast.id, userId),
                      )
                    }
                    className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })() : (
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  void runAction('breast_start_left', () =>
                    startBreastFeed({
                      babyId,
                      side: 'left',
                      userId,
                      userName,
                    }),
                  )
                }
                className="bt-focus-ring min-h-[48px] rounded-xl bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-700 disabled:opacity-60"
              >
                {t('dashboard.startLeft')}
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  void runAction('breast_start_right', () =>
                    startBreastFeed({
                      babyId,
                      side: 'right',
                      userId,
                      userName,
                    }),
                  )
                }
                className="bt-focus-ring min-h-[48px] rounded-xl bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-teal-700 disabled:opacity-60"
              >
                {t('dashboard.startRight')}
              </button>
            </div>
          )}
        </section>

        {/* Bottle Feeding Card */}
        <section
          aria-label={t('dashboard.bottleFeeding')}
          className="bt-card bt-card-bottle p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-bottle inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <Milk className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.bottleFeeding')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {lastActivity.lastBottleFeed
                    ? t('dashboard.lastBottle', {
                        volume: formatVolume(
                          lastActivity.lastBottleFeed.volumeMl,
                          volumeUnit,
                        ),
                        ago: formatTimeAgo(
                          lastActivity.lastBottleFeed.secondsSinceEnd,
                        ),
                      })
                    : t('dashboard.noBottlesToday')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenModal({ kind: 'bottle_manual' })}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-xl px-2.5 text-xs font-medium text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('dashboard.log')}</span>
            </button>
          </div>

          {activeBottle ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-sky-50 p-3 dark:bg-sky-950/60">
                <span className="text-xs font-semibold uppercase text-sky-700 dark:text-sky-300">
                  {t('dashboard.bottleInProgress')}
                </span>
                <span className="tabular-nums-clock font-mono text-2xl font-bold text-sky-800 dark:text-sky-200">
                  {formatClock(
                    Math.max(0, (nowMs - Date.parse(activeBottle.startedAt)) / 1000),
                  )}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onOpenModal({ kind: 'bottle_finish', event: activeBottle })
                  }
                  className="bt-focus-ring col-span-3 inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-sky-600 px-3 text-sm font-semibold text-white hover:bg-sky-700"
                >
                  <Check className="h-4 w-4" />
                  <span>{t('dashboard.finishLogVolume')}</span>
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  aria-label={t('dashboard.discardBottleAria')}
                  onClick={() =>
                    void runAction('bottle_discard', () =>
                      deleteEvent(activeBottle.id, userId),
                    )
                  }
                  className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction('bottle_start', () =>
                  startBottleFeed({
                    babyId,
                    userId,
                    userName,
                    milkType: 'breastmilk',
                  }),
                )
              }
              className="bt-focus-ring min-h-[48px] w-full rounded-xl bg-sky-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-sky-700 disabled:opacity-60"
            >
              {t('dashboard.startBottle')}
            </button>
          )}
        </section>

        {/* Sleep Card (auto-ended when a new feed or diaper is logged) */}
        <section
          aria-label={t('dashboard.sleep')}
          className="bt-card bt-card-sleep p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-sleep inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <Moon className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.sleep')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {lastActivity.lastSleep
                    ? lastActivity.lastSleep.isOngoing
                      ? t('dashboard.sleepingNow')
                      : t('dashboard.awakeAgo', {
                          ago: formatTimeAgo(
                            lastActivity.lastSleep.secondsSinceEnd,
                          ),
                        })
                    : t('dashboard.noSleepLogged')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenModal({ kind: 'sleep_manual' })}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-xl px-2.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('dashboard.log')}</span>
            </button>
          </div>

          {activeSleep ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-indigo-50 p-3 dark:bg-indigo-950/60">
                <span className="text-xs font-semibold uppercase text-indigo-700 dark:text-indigo-300">
                  {activeSleep.payload.category === 'night'
                    ? t('dashboard.nightSleep')
                    : t('dashboard.nap')}
                </span>
                <span className="tabular-nums-clock font-mono text-2xl font-bold text-indigo-800 dark:text-indigo-200">
                  {formatClock(
                    Math.max(0, (nowMs - Date.parse(activeSleep.startedAt)) / 1000),
                  )}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void runAction('sleep_finish', () =>
                      finishSleep({ babyId, userId }),
                    )
                  }
                  className="bt-focus-ring col-span-3 inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  <Check className="h-4 w-4" />
                  <span>{t('dashboard.wakeUp')}</span>
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  aria-label={t('dashboard.discardSleepAria')}
                  onClick={() =>
                    void runAction('sleep_discard', () =>
                      deleteEvent(activeSleep.id, userId),
                    )
                  }
                  className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  void runAction('sleep_start_nap', () =>
                    startSleep({
                      babyId,
                      category: 'nap',
                      userId,
                      userName,
                    }),
                  )
                }
                className="bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-60"
              >
                <Sun className="h-4 w-4" />
                <span>{t('dashboard.startNap')}</span>
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  void runAction('sleep_start_night', () =>
                    startSleep({
                      babyId,
                      category: 'night',
                      userId,
                      userName,
                    }),
                  )
                }
                className="bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-slate-900 disabled:opacity-60 dark:bg-indigo-900 dark:hover:bg-indigo-800"
              >
                <Moon className="h-4 w-4" />
                <span>{t('dashboard.startNight')}</span>
              </button>
            </div>
          )}
        </section>

        {/* 1-Tap Diaper Card */}
        <section
          aria-label={t('dashboard.diaperLog')}
          className="bt-card bt-card-diaper p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-diaper inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <Droplets className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.diaperLog')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {lastActivity.lastDiaper
                    ? t('dashboard.lastDiaper', {
                        kind: t(
                          `modals.diaper.kind.${lastActivity.lastDiaper.kind}`,
                        ),
                        ago: formatTimeAgo(
                          lastActivity.lastDiaper.secondsSinceStart,
                        ),
                      })
                    : t('dashboard.noDiapersLogged')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenModal({ kind: 'diaper_details' })}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-xl px-2.5 text-xs font-medium text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('dashboard.log')}</span>
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleQuickDiaper('wet')}
              className="bt-focus-ring min-h-[48px] rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
            >
              {t('dashboard.wet')}
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleQuickDiaper('poopy')}
              className="bt-focus-ring min-h-[48px] rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-900 hover:bg-orange-100 disabled:opacity-60 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-200"
            >
              {t('dashboard.poopy')}
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleQuickDiaper('both')}
              className="bt-focus-ring min-h-[48px] rounded-xl border border-amber-300 bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60"
            >
              {t('dashboard.both')}
            </button>
          </div>
        </section>

        {/* Spit-Up Card */}
        <section
          aria-label={t('dashboard.spitUp')}
          className="bt-card bt-card-spitup p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-spitup inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <Sparkles className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.spitUp')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {lastActivity.lastSpitUp
                    ? t('dashboard.lastSpitUp', {
                        severity: lastActivity.lastSpitUp.severity
                          ? t(`common.${lastActivity.lastSpitUp.severity}`)
                          : t('dashboard.loggedFallback'),
                        ago: formatTimeAgo(
                          lastActivity.lastSpitUp.secondsSinceStart,
                        ),
                      })
                    : t('dashboard.noneLoggedToday')}
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenModal({ kind: 'spit_up' })}
            className="bt-focus-ring inline-flex min-h-[48px] w-full items-center justify-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
          >
            <Plus className="h-4 w-4" />
            <span>{t('dashboard.logSpitUp')}</span>
          </button>
        </section>

        {/* Daily Vitamins Card */}
        <section
          aria-label={t('dashboard.vitamins')}
          className="bt-card bt-card-vitamin p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-vitamin inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <Pill className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.vitamins')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {vitaminGivenToday && todayVitaminEvent
                    ? t('dashboard.vitaminsGivenToday', {
                        time: formatLocalTime(
                          todayVitaminEvent.startedAt,
                          timeZone,
                        ),
                      })
                    : t('dashboard.vitaminsNotGivenToday')}
                </p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              aria-pressed={vitaminGivenToday}
              disabled={busyAction !== null}
              onClick={() => void handleToggleVitamin(true)}
              className={`bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold transition disabled:opacity-60 ${
                vitaminGivenToday
                  ? 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200 dark:hover:bg-emerald-900/60'
              }`}
            >
              {vitaminGivenToday && <Check className="h-4 w-4" />}
              <span>{t('dashboard.vitaminsYes')}</span>
            </button>
            <button
              type="button"
              aria-pressed={!vitaminGivenToday}
              disabled={busyAction !== null}
              onClick={() => void handleToggleVitamin(false)}
              className={`bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold transition disabled:opacity-60 ${
                !vitaminGivenToday
                  ? 'border-slate-800 bg-slate-800 text-white hover:bg-slate-700 dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-slate-300'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <span>{t('dashboard.vitaminsNo')}</span>
            </button>
          </div>
        </section>

        {/* Pumping Card */}
        {canAccessPumping && (
        <section
          aria-label={t('dashboard.pumping')}
          className="bt-card bt-card-pumping p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-pumping inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <GlassWater className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.pumping')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {activePumping
                    ? t('dashboard.pumpingNow')
                    : lastActivity.lastPumping
                      ? lastActivity.lastPumping.volumeMl !== null &&
                        lastActivity.lastPumping.durationSeconds > 0
                        ? t('dashboard.lastPumpingFull', {
                            volume: formatVolume(
                              lastActivity.lastPumping.volumeMl,
                              volumeUnit,
                            ),
                            duration: formatDurationShort(
                              lastActivity.lastPumping.durationSeconds,
                            ),
                            ago: formatTimeAgo(
                              lastActivity.lastPumping.secondsSinceEnd,
                            ),
                          })
                        : lastActivity.lastPumping.volumeMl !== null
                          ? t('dashboard.lastPumpingVol', {
                              volume: formatVolume(
                                lastActivity.lastPumping.volumeMl,
                                volumeUnit,
                              ),
                              ago: formatTimeAgo(
                                lastActivity.lastPumping.secondsSinceEnd,
                              ),
                            })
                          : t('dashboard.lastPumpingDur', {
                              duration: formatDurationShort(
                                lastActivity.lastPumping.durationSeconds,
                              ),
                              ago: formatTimeAgo(
                                lastActivity.lastPumping.secondsSinceEnd,
                              ),
                            })
                      : t('dashboard.noPumpingLogged')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenModal({ kind: 'pumping_manual' })}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-xl px-2.5 text-xs font-medium text-purple-700 hover:bg-purple-50 dark:text-purple-300 dark:hover:bg-purple-950"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('dashboard.log')}</span>
            </button>
          </div>

          {activePumping ? (
            <div className="space-y-3">
              <div className="rounded-xl bg-purple-50 p-3 dark:bg-purple-950/60">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-purple-700 dark:text-purple-300">
                    {t('dashboard.pumpingInProgress')}
                  </span>
                  <span className="tabular-nums-clock font-mono text-2xl font-bold text-purple-800 dark:text-purple-200">
                    {formatClock(
                      Math.max(
                        0,
                        (nowMs - Date.parse(activePumping.startedAt)) / 1000,
                      ),
                    )}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() =>
                    onOpenModal({
                      kind: 'pumping_finish',
                      event: activePumping,
                    })
                  }
                  className="bt-focus-ring col-span-3 inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-purple-600 px-3 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-60"
                >
                  <Check className="h-4 w-4" />
                  <span>{t('dashboard.finishLogVolume')}</span>
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void runAction('pumping:discard', () =>
                      deleteEvent(activePumping.id, userId),
                    )
                  }
                  aria-label={t('dashboard.discardPumpingAria')}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction('pumping:start', () =>
                  startPumping({ babyId, userId, userName }),
                )
              }
              className="bt-focus-ring min-h-[48px] w-full rounded-xl bg-purple-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-purple-700 disabled:opacity-60"
            >
              {t('dashboard.startPump')}
            </button>
          )}
        </section>
        )}

        {/* Tummy Time Card */}
        <section
          aria-label={t('dashboard.tummyTime')}
          className="bt-card bt-card-tummy p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="bt-badge-tummy inline-flex h-9 w-9 items-center justify-center rounded-xl">
                <Activity className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('dashboard.tummyTime')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {activeTummyTime
                    ? t('dashboard.tummyTimeNow')
                    : lastActivity.lastTummyTime
                      ? t('dashboard.lastTummyTime', {
                          duration: formatDurationShort(
                            lastActivity.lastTummyTime.durationSeconds,
                          ),
                          ago: formatTimeAgo(
                            lastActivity.lastTummyTime.secondsSinceEnd,
                          ),
                        })
                      : t('dashboard.noTummyTimeLogged')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onOpenModal({ kind: 'tummy_time_manual' })}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-xl px-2.5 text-xs font-medium text-orange-700 hover:bg-orange-50 dark:text-orange-300 dark:hover:bg-orange-950"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{t('dashboard.log')}</span>
            </button>
          </div>

          {activeTummyTime ? (
            <div className="space-y-3">
              <div className="rounded-xl bg-orange-50 p-3 dark:bg-orange-950/60">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">
                    {t('dashboard.tummyTimeInProgress')}
                  </span>
                  <span className="tabular-nums-clock font-mono text-2xl font-bold text-orange-800 dark:text-orange-200">
                    {formatClock(
                      Math.max(
                        0,
                        (nowMs - Date.parse(activeTummyTime.startedAt)) / 1000,
                      ),
                    )}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void runAction('tummy:finish', () =>
                      finishTummyTime({ babyId, userId }),
                    )
                  }
                  className="bt-focus-ring col-span-3 inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-orange-600 px-3 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-60"
                >
                  <Check className="h-4 w-4" />
                  <span>{t('dashboard.finish')}</span>
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void runAction('tummy:discard', () =>
                      deleteEvent(activeTummyTime.id, userId),
                    )
                  }
                  aria-label={t('dashboard.discardTummyTimeAria')}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction('tummy:start', () =>
                  startTummyTime({ babyId, userId, userName }),
                )
              }
              className="bt-focus-ring min-h-[48px] w-full rounded-xl bg-orange-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-orange-700 disabled:opacity-60"
            >
              {t('dashboard.startTummyTime')}
            </button>
          )}
        </section>
      </section>

      {/* Daily KPI Summary Cards */}
      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <h2
            aria-live="polite"
            className="text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            {summaryHeading}
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={t('timeline.previousDayAria')}
                onClick={handlePrevSummaryDay}
                className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {!isSummaryToday && (
                <button
                  type="button"
                  onClick={handleTodaySummary}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {t('timeline.today')}
                </button>
              )}
              <button
                type="button"
                aria-label={t('timeline.nextDayAria')}
                disabled={!canGoNextSummaryDay}
                onClick={handleNextSummaryDay}
                className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:enabled:hover:bg-slate-800"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => onViewTimeline(selectedSummaryDateKey)}
              className="bt-focus-ring inline-flex min-h-[44px] items-center rounded-xl px-2 text-sm font-medium text-teal-600 hover:underline dark:text-teal-400"
            >
              {t('dashboard.viewFullTimeline')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <div className="bt-card min-w-0 p-4">
            <div className="flex flex-wrap items-center justify-between gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span>{t('dashboard.lastFeedAndSleep')}</span>
              </span>
              {!isSummaryToday && (
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {t('dashboard.liveBadge')}
                </span>
              )}
            </div>
            <div className="mt-2 space-y-1 text-sm">
              <p className="font-semibold text-slate-900 dark:text-slate-100">
                {t('dashboard.feedLabel')}{' '}
                {lastActivity.lastFeed
                  ? lastActivity.lastFeed.isOngoing
                    ? t('dashboard.activeNow')
                    : formatTimeAgo(lastActivity.lastFeed.secondsSinceEnd)
                  : '—'}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {t('dashboard.sleepLabel')}{' '}
                {lastActivity.lastSleep
                  ? lastActivity.lastSleep.isOngoing
                    ? t('dashboard.sleepingNow')
                    : formatTimeAgo(lastActivity.lastSleep.secondsSinceEnd)
                  : '—'}
              </p>
            </div>
          </div>

          <DailySummaryCards
            stats={summaryStats}
            volumeUnit={volumeUnit}
            isToday={isSummaryToday}
            categories={
              canAccessPumping
                ? ALL_SUMMARY_CATEGORIES
                : NON_PARENT_SUMMARY_CATEGORIES
            }
          />
        </div>
      </section>
    </div>
  );
}
