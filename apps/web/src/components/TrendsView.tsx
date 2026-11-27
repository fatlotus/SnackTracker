import { useState } from 'react';
import {
  addDays,
  computeDateRangeStats,
  computePeriodAverages,
  type TrackingEvent,
} from '@baby-tracker/shared';
import { useI18n } from '../lib/i18n.js';
import {
  getLocalTimeZone,
  getTodayDateKey,
  type VolumeUnit,
} from './uiUtils.js';

interface TrendsViewProps {
  events: TrackingEvent[];
  volumeUnit: VolumeUnit;
  nowMs: number;
  canAccessPumping?: boolean;
}

export function TrendsView({
  events,
  volumeUnit,
  nowMs,
  canAccessPumping = true,
}: TrendsViewProps) {
  const { t, locale, formatDurationShort, formatVolume, buildTrendSeries } =
    useI18n();
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const timeZone = getLocalTimeZone();
  const endDateKey = getTodayDateKey(timeZone, nowMs);
  const startDateKey = addDays(endDateKey, -(days - 1));

  const dailyStats = computeDateRangeStats(
    events,
    startDateKey,
    endDateKey,
    timeZone,
    nowMs,
  );
  const { averagesPerDay } = computePeriodAverages(dailyStats);
  const series = buildTrendSeries(dailyStats, volumeUnit);

  const maxSleepHours = Math.max(
    1,
    ...series.map((d) => d.totalSleepHours),
  );
  const maxFeedCount = Math.max(
    1,
    ...series.map((d) => d.breastFeedCount + d.bottleFeedCount),
  );
  const maxDiaperCount = Math.max(
    1,
    ...series.map((d) => d.wetDiapers + d.poopyDiapers),
  );
  const maxPumpingVolume = Math.max(
    1,
    ...series.map((d) => d.pumpingVolume),
  );
  const maxTummyMinutes = Math.max(
    1,
    ...series.map((d) => d.tummyTimeMinutes),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t('trends.title')}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.rangeLabel', {
              start: startDateKey,
              end: endDateKey,
              tz: timeZone,
            })}
          </p>
        </div>

        <div className="bt-card inline-flex p-1">
          {([7, 14, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={`bt-focus-ring min-h-[44px] rounded-lg px-3 text-sm font-medium ${
                days === d
                  ? 'bg-teal-600 text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {t('trends.daysUnit', { days: d })}
            </button>
          ))}
        </div>
      </div>

      {/* Period Averages */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="bt-card bt-card-sleep p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.avgSleepDay')}
          </p>
          <p className="tabular-nums-clock mt-1 text-xl font-bold text-indigo-700 dark:text-indigo-300">
            {formatDurationShort(averagesPerDay.totalSleepSeconds)}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.napNight', {
              nap: formatDurationShort(averagesPerDay.napSleepSeconds),
              night: formatDurationShort(averagesPerDay.nightSleepSeconds),
            })}
          </p>
        </div>
        <div className="bt-card bt-card-breast p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.avgFeedsDay')}
          </p>
          <p className="tabular-nums-clock mt-1 text-xl font-bold text-teal-700 dark:text-teal-300">
            {averagesPerDay.totalFeedCount.toFixed(1)}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.bottleAvg', {
              vol: formatVolume(averagesPerDay.bottleTotalMl, volumeUnit),
            })}
          </p>
        </div>
        <div className="bt-card bt-card-diaper p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.avgDiapersDay')}
          </p>
          <p className="tabular-nums-clock mt-1 text-xl font-bold text-amber-700 dark:text-amber-300">
            {t('trends.wetPoopyAvg', {
              wet: averagesPerDay.wetCount.toFixed(1),
              poopy: averagesPerDay.poopyCount.toFixed(1),
            })}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.changesPerDay', {
              count: averagesPerDay.diaperEventCount.toFixed(1),
            })}
          </p>
        </div>
        <div className="bt-card bt-card-spitup p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.avgSpitUpsDay')}
          </p>
          <p className="tabular-nums-clock mt-1 text-xl font-bold text-rose-700 dark:text-rose-300">
            {averagesPerDay.spitUpCount.toFixed(1)}
          </p>
        </div>
        {canAccessPumping && (
          <div className="bt-card bt-card-pumping p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('trends.avgPumpingDay')}
            </p>
            <p className="tabular-nums-clock mt-1 text-xl font-bold text-purple-700 dark:text-purple-300">
              {formatVolume(averagesPerDay.pumpingTotalMl, volumeUnit)}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('trends.pumpingSessionsAvg', {
                count: averagesPerDay.pumpingCount.toFixed(1),
              })}
            </p>
          </div>
        )}
        <div className="bt-card bt-card-tummy p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.avgTummyTimeDay')}
          </p>
          <p className="tabular-nums-clock mt-1 text-xl font-bold text-orange-700 dark:text-orange-300">
            {formatDurationShort(averagesPerDay.tummyTimeTotalSeconds)}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('trends.tummyTimeSessionsAvg', {
              count: averagesPerDay.tummyTimeCount.toFixed(1),
            })}
          </p>
        </div>
      </div>

      {/* Sleep Chart */}
      <div className="bt-card bt-card-sleep p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('trends.sleepChartTitle')}</h3>
          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-xs bg-indigo-400" /> {t('trends.nap')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-xs bg-indigo-700" /> {t('trends.night')}
            </span>
          </div>
        </div>
        <div
          role="img"
          aria-label={t('trends.sleepChartAria', {
            days,
            avg: formatDurationShort(averagesPerDay.totalSleepSeconds),
          })}
          className="flex h-40 items-end gap-1.5 overflow-x-auto pb-1"
        >
          {series.map((d) => {
            const napPct = (d.napHours / maxSleepHours) * 100;
            const nightPct = (d.nightHours / maxSleepHours) * 100;
            return (
              <div
                key={d.dateKey}
                className="flex min-w-[20px] flex-1 flex-col items-center gap-1"
                title={
                  locale === 'zh-CN'
                    ? `${d.dateKey}：共 ${d.totalSleepHours}小时（小睡 ${d.napHours}小时，夜睡 ${d.nightHours}小时）`
                    : `${d.dateKey}: ${d.totalSleepHours}h total (Nap ${d.napHours}h, Night ${d.nightHours}h)`
                }
              >
                <div className="flex h-28 w-full flex-col justify-end overflow-hidden rounded-t-md bg-slate-100 dark:bg-slate-800">
                  <div
                    className="w-full bg-indigo-400 transition-all"
                    style={{ height: `${napPct}%` }}
                  />
                  <div
                    className="w-full bg-indigo-700 transition-all"
                    style={{ height: `${nightPct}%` }}
                  />
                </div>
                <span className="tabular-nums-clock text-[10px] text-slate-500 dark:text-slate-400">
                  {d.shortLabel}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Feeds & Diapers Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="bt-card bt-card-breast p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('trends.feedsChartTitle')}</h3>
            <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-xs bg-teal-500" /> {t('trends.breast')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-xs bg-sky-500" /> {t('trends.bottle')}
              </span>
            </div>
          </div>
          <div
            role="img"
            aria-label={t('trends.feedsChartAria', {
              days,
              avg: averagesPerDay.totalFeedCount.toFixed(1),
            })}
            className="flex h-36 items-end gap-1.5 overflow-x-auto pb-1"
          >
            {series.map((d) => {
              const breastPct = (d.breastFeedCount / maxFeedCount) * 100;
              const bottlePct = (d.bottleFeedCount / maxFeedCount) * 100;
              return (
                <div
                  key={d.dateKey}
                  className="flex min-w-[20px] flex-1 flex-col items-center gap-1"
                  title={
                    locale === 'zh-CN'
                      ? `${d.dateKey}：母乳 ${d.breastFeedCount}次，奶瓶 ${d.bottleFeedCount}次（${d.bottleVolume} ${t(`common.${volumeUnit}`)}）`
                      : `${d.dateKey}: ${d.breastFeedCount} breast, ${d.bottleFeedCount} bottle (${d.bottleVolume} ${volumeUnit})`
                  }
                >
                  <div className="flex h-24 w-full flex-col justify-end overflow-hidden rounded-t-md bg-slate-100 dark:bg-slate-800">
                    <div
                      className="w-full bg-teal-500"
                      style={{ height: `${breastPct}%` }}
                    />
                    <div
                      className="w-full bg-sky-500"
                      style={{ height: `${bottlePct}%` }}
                    />
                  </div>
                  <span className="tabular-nums-clock text-[10px] text-slate-500 dark:text-slate-400">
                    {d.shortLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bt-card bt-card-diaper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('trends.diapersChartTitle')}</h3>
            <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-xs bg-amber-400" /> {t('trends.wet')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-xs bg-orange-600" /> {t('trends.poopy')}
              </span>
            </div>
          </div>
          <div
            role="img"
            aria-label={t('trends.diapersChartAria', {
              days,
              wet: averagesPerDay.wetCount.toFixed(1),
              poopy: averagesPerDay.poopyCount.toFixed(1),
            })}
            className="flex h-36 items-end gap-1.5 overflow-x-auto pb-1"
          >
            {series.map((d) => {
              const wetPct = (d.wetDiapers / maxDiaperCount) * 100;
              const poopyPct = (d.poopyDiapers / maxDiaperCount) * 100;
              return (
                <div
                  key={d.dateKey}
                  className="flex min-w-[20px] flex-1 flex-col items-center gap-1"
                  title={
                    locale === 'zh-CN'
                      ? `${d.dateKey}：嘘嘘 ${d.wetDiapers}次，便便 ${d.poopyDiapers}次`
                      : `${d.dateKey}: ${d.wetDiapers} wet, ${d.poopyDiapers} poopy`
                  }
                >
                  <div className="flex h-24 w-full flex-col justify-end overflow-hidden rounded-t-md bg-slate-100 dark:bg-slate-800">
                    <div
                      className="w-full bg-amber-400"
                      style={{ height: `${wetPct}%` }}
                    />
                    <div
                      className="w-full bg-orange-600"
                      style={{ height: `${poopyPct}%` }}
                    />
                  </div>
                  <span className="tabular-nums-clock text-[10px] text-slate-500 dark:text-slate-400">
                    {d.shortLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Pumping & Tummy Time Charts */}
      <div
        className={
          canAccessPumping ? 'grid gap-4 lg:grid-cols-2' : 'grid gap-4'
        }
      >
        {canAccessPumping && (
          <div className="bt-card bt-card-pumping p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {t('trends.pumpingChartTitle', {
                  unit: t(`common.${volumeUnit}`),
                })}
              </h3>
            </div>
            <div
              role="img"
              aria-label={t('trends.pumpingChartAria', {
                days,
                avg: formatVolume(averagesPerDay.pumpingTotalMl, volumeUnit),
              })}
              className="flex h-36 items-end gap-1.5 overflow-x-auto pb-1"
            >
              {series.map((d) => {
                const pct = (d.pumpingVolume / maxPumpingVolume) * 100;
                return (
                  <div
                    key={d.dateKey}
                    className="flex min-w-[20px] flex-1 flex-col items-center gap-1"
                    title={
                      locale === 'zh-CN'
                        ? `${d.dateKey}：${d.pumpingVolume} ${t(`common.${volumeUnit}`)}（${d.pumpingCount}次）`
                        : `${d.dateKey}: ${d.pumpingVolume} ${volumeUnit} (${d.pumpingCount} sessions)`
                    }
                  >
                    <div className="flex h-24 w-full flex-col justify-end overflow-hidden rounded-t-md bg-slate-100 dark:bg-slate-800">
                      <div
                        className="w-full bg-purple-500 transition-all"
                        style={{ height: `${pct}%` }}
                      />
                    </div>
                    <span className="tabular-nums-clock text-[10px] text-slate-500 dark:text-slate-400">
                      {d.shortLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="bt-card bt-card-tummy p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              {t('trends.tummyTimeChartTitle')}
            </h3>
          </div>
          <div
            role="img"
            aria-label={t('trends.tummyTimeChartAria', {
              days,
              avg: formatDurationShort(averagesPerDay.tummyTimeTotalSeconds),
            })}
            className="flex h-36 items-end gap-1.5 overflow-x-auto pb-1"
          >
            {series.map((d) => {
              const pct = (d.tummyTimeMinutes / maxTummyMinutes) * 100;
              return (
                <div
                  key={d.dateKey}
                  className="flex min-w-[20px] flex-1 flex-col items-center gap-1"
                  title={
                    locale === 'zh-CN'
                      ? `${d.dateKey}：${t('trends.minutesShort', { min: d.tummyTimeMinutes })}（${d.tummyTimeCount}次）`
                      : `${d.dateKey}: ${t('trends.minutesShort', { min: d.tummyTimeMinutes })} (${d.tummyTimeCount} sessions)`
                  }
                >
                  <div className="flex h-24 w-full flex-col justify-end overflow-hidden rounded-t-md bg-slate-100 dark:bg-slate-800">
                    <div
                      className="w-full bg-orange-500 transition-all"
                      style={{ height: `${pct}%` }}
                    />
                  </div>
                  <span className="tabular-nums-clock text-[10px] text-slate-500 dark:text-slate-400">
                    {d.shortLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
