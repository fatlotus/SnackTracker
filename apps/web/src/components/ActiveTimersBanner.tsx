import { useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Baby as BabyIcon,
  Check,
  GlassWater,
  Milk,
  Moon,
  Pause,
  Play,
  Sun,
  Trash2,
} from 'lucide-react';
import type { BottleFeedEvent, PumpingEvent } from '@baby-tracker/shared';
import { useI18n } from '../lib/i18n.js';
import {
  computeBreastFeedElapsed,
  deleteEvent,
  finishBreastFeed,
  finishSleep,
  finishTummyTime,
  pauseBreastFeed,
  resumeBreastFeed,
  switchBreastSide,
  type ActiveTimersForBaby,
} from '../lib/store.js';
import { formatClock } from './uiUtils.js';

interface ActiveTimersBannerProps {
  babyId: string;
  userId: string;
  timers: ActiveTimersForBaby;
  nowMs: number;
  canAccessPumping?: boolean;
  onFinishBottle: (event: BottleFeedEvent) => void;
  onFinishPumping: (event: PumpingEvent) => void;
}

export function ActiveTimersBanner({
  babyId,
  userId,
  timers,
  nowMs,
  canAccessPumping = true,
  onFinishBottle,
  onFinishPumping,
}: ActiveTimersBannerProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function runTimerAction(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const { breastFeed, bottleFeed, sleep, pumping, tummyTime } = timers;
  const visiblePumping = canAccessPumping ? pumping : null;
  if (!breastFeed && !bottleFeed && !sleep && !visiblePumping && !tummyTime) {
    return null;
  }

  return (
    <div className="no-print sticky top-[57px] z-20 border-b border-teal-200/80 bg-teal-50/95 px-3 py-2 backdrop-blur dark:border-teal-900/80 dark:bg-teal-950/90 lg:top-0 lg:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
        {breastFeed && (() => {
          const elapsed = computeBreastFeedElapsed(breastFeed, nowMs);
          return (
            <div className="bt-card bt-card-breast flex flex-1 min-w-[260px] flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="bt-badge-breast inline-flex h-8 w-8 items-center justify-center rounded-lg">
                  <BabyIcon className="h-4 w-4" />
                </span>
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100">
                    <span>{t('timers.breast')}</span>
                    <span className="bt-badge-breast rounded px-1.5 py-0.5 text-[11px] uppercase">
                      {elapsed.isPaused
                        ? t('timers.paused')
                        : elapsed.activeSide === 'left'
                          ? t('timers.left')
                          : t('timers.right')}
                    </span>
                  </div>
                  <div className="tabular-nums-clock font-mono text-sm font-bold text-teal-700 dark:text-teal-300">
                    {formatClock(elapsed.totalSeconds)}{' '}
                    <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400">
                      ({t('timers.leftShort')} {formatClock(elapsed.leftSeconds)} ·{' '}
                      {t('timers.rightShort')} {formatClock(elapsed.rightSeconds)})
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() =>
                      elapsed.isPaused
                        ? resumeBreastFeed({ babyId, userId })
                        : pauseBreastFeed({ babyId, userId }),
                    )
                  }
                  aria-label={
                    elapsed.isPaused
                      ? t('timers.resumeBreastAria')
                      : t('timers.pauseBreastAria')
                  }
                  className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-stone-200 bg-stone-50 px-2.5 text-xs font-medium text-slate-700 hover:bg-stone-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  {elapsed.isPaused ? (
                    <Play className="h-4 w-4" />
                  ) : (
                    <Pause className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => switchBreastSide({ babyId, userId }))
                  }
                  aria-label={t('timers.switchSideAria')}
                  title={t('timers.switchSideTitle')}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-stone-200 bg-stone-50 px-2.5 text-xs font-medium text-slate-700 hover:bg-stone-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                  <span>{t('timers.switch')}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => finishBreastFeed({ babyId, userId }))
                  }
                  className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-teal-600 px-3 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>{t('timers.finish')}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => deleteEvent(breastFeed.id, userId))
                  }
                  aria-label={t('timers.discardBreastAria')}
                  title={t('timers.discardTitle')}
                  className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })()}

        {bottleFeed && (() => {
          const secs = Math.max(0, (nowMs - Date.parse(bottleFeed.startedAt)) / 1000);
          return (
            <div className="bt-card bt-card-bottle flex flex-1 min-w-[240px] items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="bt-badge-bottle inline-flex h-8 w-8 items-center justify-center rounded-lg">
                  <Milk className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {t('timers.bottleFeeding')}
                  </div>
                  <div className="tabular-nums-clock font-mono text-sm font-bold text-sky-700 dark:text-sky-300">
                    {formatClock(secs)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onFinishBottle(bottleFeed)}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>{t('timers.finish')}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => deleteEvent(bottleFeed.id, userId))
                  }
                  aria-label={t('timers.discardBottleAria')}
                  className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })()}

        {sleep && (() => {
          const secs = Math.max(0, (nowMs - Date.parse(sleep.startedAt)) / 1000);
          const isNight = sleep.payload.category === 'night';
          return (
            <div className="bt-card bt-card-sleep flex flex-1 min-w-[240px] items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="bt-badge-sleep inline-flex h-8 w-8 items-center justify-center rounded-lg">
                  {isNight ? (
                    <Moon className="h-4 w-4" />
                  ) : (
                    <Sun className="h-4 w-4" />
                  )}
                </span>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {isNight ? t('timers.nightSleep') : t('timers.nap')}
                  </div>
                  <div className="tabular-nums-clock font-mono text-sm font-bold text-indigo-700 dark:text-indigo-300">
                    {formatClock(secs)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => finishSleep({ babyId, userId }))
                  }
                  className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>{t('timers.wakeUp')}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => deleteEvent(sleep.id, userId))
                  }
                  aria-label={t('timers.discardSleepAria')}
                  className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })()}

        {visiblePumping && (() => {
          const secs = Math.max(
            0,
            (nowMs - Date.parse(visiblePumping.startedAt)) / 1000,
          );
          return (
            <div className="bt-card bt-card-pumping flex flex-1 min-w-[240px] items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="bt-badge-pumping inline-flex h-8 w-8 items-center justify-center rounded-lg">
                  <GlassWater className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {t('timers.pumping')}
                  </div>
                  <div className="tabular-nums-clock font-mono text-sm font-bold text-purple-700 dark:text-purple-300">
                    {formatClock(secs)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onFinishPumping(visiblePumping)}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-purple-600 px-3 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-60"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>{t('timers.finish')}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() =>
                      deleteEvent(visiblePumping.id, userId),
                    )
                  }
                  aria-label={t('timers.discardPumpingAria')}
                  className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })()}

        {tummyTime && (() => {
          const secs = Math.max(0, (nowMs - Date.parse(tummyTime.startedAt)) / 1000);
          return (
            <div className="bt-card bt-card-tummy flex flex-1 min-w-[240px] items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="bt-badge-tummy inline-flex h-8 w-8 items-center justify-center rounded-lg">
                  <Activity className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {t('timers.tummyTime')}
                  </div>
                  <div className="tabular-nums-clock font-mono text-sm font-bold text-orange-700 dark:text-orange-300">
                    {formatClock(secs)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => finishTummyTime({ babyId, userId }))
                  }
                  className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-orange-600 px-3 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-60"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>{t('timers.finish')}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runTimerAction(() => deleteEvent(tummyTime.id, userId))
                  }
                  aria-label={t('timers.discardTummyTimeAria')}
                  className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:text-rose-400 dark:hover:bg-rose-950/60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
