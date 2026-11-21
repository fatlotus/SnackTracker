import type { DailyStats } from '@baby-tracker/shared';
import { useI18n } from '../lib/i18n.js';
import type { VolumeUnit } from './uiUtils.js';

export type SummaryCardCategory =
  | 'feeding'
  | 'sleep'
  | 'diapers'
  | 'pumping'
  | 'tummy_time';

export const ALL_SUMMARY_CATEGORIES: readonly SummaryCardCategory[] = [
  'feeding',
  'sleep',
  'diapers',
  'pumping',
  'tummy_time',
];

interface DailySummaryCardsProps {
  stats: DailyStats;
  volumeUnit: VolumeUnit;
  isToday: boolean;
  categories?: readonly SummaryCardCategory[];
  compact?: boolean;
}

/**
 * Reusable day-level KPI summary cards (Feeding, Sleep, Diapers & Spit-Up, Pumping, Tummy Time).
 * Returns a Fragment so callers can compose the cards directly into their own grid.
 */
export function DailySummaryCards({
  stats,
  volumeUnit,
  isToday,
  categories = ALL_SUMMARY_CATEGORIES,
  compact = false,
}: DailySummaryCardsProps) {
  const { t, formatDurationShort, formatVolume } = useI18n();

  const breastmilkMl = stats.bottleMlByMilkType.breastmilk ?? 0;
  const formulaMl = stats.bottleMlByMilkType.formula ?? 0;
  const padClass = compact ? 'p-3.5 sm:p-4' : 'p-4';
  const metricClass =
    'tabular-nums-clock mt-1 text-xl font-bold text-slate-900 dark:text-slate-100 sm:text-2xl';
  const showFeeding = categories.includes('feeding');
  const showSleep = categories.includes('sleep');
  const showDiapers = categories.includes('diapers');
  const showPumping = categories.includes('pumping');
  const showTummyTime = categories.includes('tummy_time');
  const spanFeedingOnMobile =
    compact && categories.length > 1 && categories.length % 2 === 1;

  return (
    <>
      {showFeeding && (
        <div
          className={`bt-card bt-card-breast min-w-0 ${padClass} ${
            spanFeedingOnMobile ? 'col-span-2 sm:col-span-1' : ''
          }`}
        >
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {isToday ? t('dashboard.feedingToday') : t('dashboard.feeding')}
          </div>
          <div className={metricClass}>
            {stats.totalFeedCount}{' '}
            <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
              {t('dashboard.feedsUnit')}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.breastSummary', {
              total: formatDurationShort(stats.breastTotalSeconds),
              left: Math.round(stats.breastLeftSeconds / 60),
              right: Math.round(stats.breastRightSeconds / 60),
            })}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.bottleSummary', {
              total: formatVolume(stats.bottleTotalMl, volumeUnit),
            })}
            {(breastmilkMl > 0 || formulaMl > 0) &&
              t('dashboard.bottleBreakdown', {
                bm: formatVolume(breastmilkMl, volumeUnit),
                fm: formatVolume(formulaMl, volumeUnit),
              })}
          </p>
        </div>
      )}

      {showSleep && (
        <div className={`bt-card bt-card-sleep min-w-0 ${padClass}`}>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {isToday ? t('dashboard.sleepToday') : t('dashboard.sleep')}
          </div>
          <div className={metricClass}>
            {formatDurationShort(stats.totalSleepSeconds)}
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.napSummary', {
              duration: formatDurationShort(stats.napSleepSeconds),
              count: stats.napCount,
            })}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.nightSummary', {
              duration: formatDurationShort(stats.nightSleepSeconds),
              count: stats.nightCount,
            })}
          </p>
        </div>
      )}

      {showDiapers && (
        <div className={`bt-card bt-card-diaper min-w-0 ${padClass}`}>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {t('dashboard.diapersAndSpitUp')}
          </div>
          <div className={metricClass}>
            {t('dashboard.wetPoopySummary', {
              wet: stats.wetCount,
              poopy: stats.poopyCount,
            })}
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.changesCount', {
              count: stats.diaperEventCount,
            })}
            {stats.rashCount > 0
              ? t('dashboard.rashCount', { count: stats.rashCount })
              : ''}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.spitUpsCount', { count: stats.spitUpCount })}
          </p>
        </div>
      )}

      {showPumping && (
        <div className={`bt-card bt-card-pumping min-w-0 ${padClass}`}>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {isToday ? t('dashboard.pumpingToday') : t('dashboard.pumping')}
          </div>
          <div className={metricClass}>
            {formatVolume(stats.pumpingTotalMl, volumeUnit)}
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.pumpingSummary', {
              count: stats.pumpingCount,
              duration: formatDurationShort(stats.pumpingTotalSeconds),
            })}
          </p>
        </div>
      )}

      {showTummyTime && (
        <div className={`bt-card bt-card-tummy min-w-0 ${padClass}`}>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {isToday ? t('dashboard.tummyTimeToday') : t('dashboard.tummyTime')}
          </div>
          <div className={metricClass}>
            {formatDurationShort(stats.tummyTimeTotalSeconds)}
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            {t('dashboard.tummyTimeSummary', {
              count: stats.tummyTimeCount,
            })}
          </p>
        </div>
      )}
    </>
  );
}
