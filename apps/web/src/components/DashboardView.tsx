import { useState } from 'react';
import {
  ArrowLeftRight,
  Baby as BabyIcon,
  Check,
  Clock,
  Droplets,
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
  computeDailyStats,
  computeLastActivitySummary,
  toLocalDateKey,
  type DiaperKind,
  type TrackingEvent,
} from '@baby-tracker/shared';
import {
  computeBreastFeedElapsed,
  deleteEvent,
  finishBreastFeed,
  finishSleep,
  logDiaper,
  pauseBreastFeed,
  resumeBreastFeed,
  startBottleFeed,
  startBreastFeed,
  startSleep,
  switchBreastSide,
  toggleVitaminForLocalDay,
  type ActiveTimersForBaby,
} from '../lib/store.js';
import type { BottleFeedEvent, DiaperEvent } from '@baby-tracker/shared';
import { useI18n } from '../lib/i18n.js';
import {
  formatClock,
  getLocalTimeZone,
  getTodayDateKey,
  type VolumeUnit,
} from './uiUtils.js';

export type ModalRequest =
  | { kind: 'breast_manual' }
  | { kind: 'bottle_manual' }
  | { kind: 'bottle_finish'; event: BottleFeedEvent }
  | { kind: 'sleep_manual' }
  | { kind: 'diaper_details' }
  | { kind: 'spit_up' }
  | { kind: 'edit'; event: TrackingEvent };

interface DashboardViewProps {
  babyId: string;
  userId: string;
  userName: string | null;
  events: TrackingEvent[];
  timers: ActiveTimersForBaby;
  nowMs: number;
  volumeUnit: VolumeUnit;
  onOpenModal: (req: ModalRequest) => void;
  onDiaperQuickLogged: (event: DiaperEvent) => void;
  onViewTimeline: () => void;
}

export function DashboardView({
  babyId,
  userId,
  userName,
  events,
  timers,
  nowMs,
  volumeUnit,
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
  const dailyStats = computeDailyStats(events, todayKey, timeZone, nowMs);
  const lastActivity = computeLastActivitySummary(events, nowMs);

  const todayVitaminEvent =
    lastActivity.lastVitamin &&
    toLocalDateKey(Date.parse(lastActivity.lastVitamin.startedAt), timeZone) ===
      todayKey
      ? lastActivity.lastVitamin
      : null;
  const vitaminGivenToday = dailyStats.vitaminGiven;

  const lastBreast = lastActivity.lastBreastFeed;
  const lastSide = lastBreast?.lastSide ?? null;
  const activeBreast = timers.breastFeed;
  const activeBottle = timers.bottleFeed;
  const activeSleep = timers.sleep;

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const breastmilkMl = dailyStats.bottleMlByMilkType.breastmilk ?? 0;
  const formulaMl = dailyStats.bottleMlByMilkType.formula ?? 0;

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
          <div className="mb-3 flex items-center justify-between">
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
              <span>{t('dashboard.manual')}</span>
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
          <div className="mb-3 flex items-center justify-between">
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
              <span>{t('dashboard.logBottle')}</span>
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
                  className="bt-focus-ring col-span-3 min-h-[44px] rounded-xl bg-sky-600 text-sm font-semibold text-white hover:bg-sky-700"
                >
                  {t('dashboard.finishEnterVolume')}
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
            <div className="grid grid-cols-2 gap-2.5">
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
                className="bt-focus-ring min-h-[48px] rounded-xl bg-sky-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-sky-700 disabled:opacity-60"
              >
                {t('dashboard.startBottle')}
              </button>
              <button
                type="button"
                onClick={() => onOpenModal({ kind: 'bottle_manual' })}
                className="bt-focus-ring min-h-[48px] rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200"
              >
                {t('dashboard.quickEntry')}
              </button>
            </div>
          )}
        </section>

        {/* Sleep Card (auto-ended when a new feed or diaper is logged) */}
        <section
          aria-label={t('dashboard.sleep')}
          className="bt-card bt-card-sleep p-4"
        >
          <div className="mb-3 flex items-center justify-between">
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
              <span>{t('dashboard.manual')}</span>
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
                  className="bt-focus-ring col-span-3 min-h-[44px] rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  {t('dashboard.wakeUp')}
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
                <span>{t('dashboard.nightSleep')}</span>
              </button>
            </div>
          )}
        </section>

        {/* 1-Tap Diaper Card */}
        <section
          aria-label={t('dashboard.diaperLog')}
          className="bt-card bt-card-diaper p-4"
        >
          <div className="mb-3 flex items-center justify-between">
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
              <span>{t('dashboard.details')}</span>
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
          <div className="mb-3 flex items-center gap-2.5">
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
          <button
            type="button"
            onClick={() => onOpenModal({ kind: 'spit_up' })}
            className="bt-focus-ring min-h-[48px] w-full rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
          >
            {t('dashboard.logSpitUp')}
          </button>
        </section>

        {/* Daily Vitamins Card */}
        <section
          aria-label={t('dashboard.vitamins')}
          className="bt-card bt-card-vitamin p-4"
        >
          <div className="mb-3 flex items-center justify-between">
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
      </section>

      {/* Daily KPI Summary Cards */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {t('dashboard.todaysSummary', { date: todayKey })}
          </h2>
          <button
            type="button"
            onClick={onViewTimeline}
            className="bt-focus-ring inline-flex min-h-[44px] items-center rounded-xl px-2 text-sm font-medium text-teal-600 hover:underline dark:text-teal-400"
          >
            {t('dashboard.viewFullTimeline')}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="bt-card p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              <Clock className="h-3.5 w-3.5" />
              <span>{t('dashboard.lastFeedAndSleep')}</span>
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

          <div className="bt-card bt-card-breast p-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('dashboard.feedingToday')}
            </div>
            <div className="tabular-nums-clock mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
              {dailyStats.totalFeedCount}{' '}
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                {t('dashboard.feedsUnit')}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              {t('dashboard.breastSummary', {
                total: formatDurationShort(dailyStats.breastTotalSeconds),
                left: Math.round(dailyStats.breastLeftSeconds / 60),
                right: Math.round(dailyStats.breastRightSeconds / 60),
              })}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {t('dashboard.bottleSummary', {
                total: formatVolume(dailyStats.bottleTotalMl, volumeUnit),
              })}
              {(breastmilkMl > 0 || formulaMl > 0) &&
                t('dashboard.bottleBreakdown', {
                  bm: formatVolume(breastmilkMl, volumeUnit),
                  fm: formatVolume(formulaMl, volumeUnit),
                })}
            </p>
          </div>

          <div className="bt-card bt-card-sleep p-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('dashboard.sleepToday')}
            </div>
            <div className="tabular-nums-clock mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
              {formatDurationShort(dailyStats.totalSleepSeconds)}
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              {t('dashboard.napSummary', {
                duration: formatDurationShort(dailyStats.napSleepSeconds),
                count: dailyStats.napCount,
              })}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {t('dashboard.nightSummary', {
                duration: formatDurationShort(dailyStats.nightSleepSeconds),
                count: dailyStats.nightCount,
              })}
            </p>
          </div>

          <div className="bt-card bt-card-diaper p-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('dashboard.diapersAndSpitUp')}
            </div>
            <div className="tabular-nums-clock mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
              {t('dashboard.wetPoopySummary', {
                wet: dailyStats.wetCount,
                poopy: dailyStats.poopyCount,
              })}
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              {t('dashboard.changesCount', {
                count: dailyStats.diaperEventCount,
              })}
              {dailyStats.rashCount > 0
                ? t('dashboard.rashCount', { count: dailyStats.rashCount })
                : ''}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {t('dashboard.spitUpsCount', { count: dailyStats.spitUpCount })}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
