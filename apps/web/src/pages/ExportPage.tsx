import { useState } from 'react';
import {
  addDays,
  computeDateRangeStats,
  computePeriodAverages,
  exportBabyDataToJson,
  exportDailyStatsToCsv,
  exportEventsToCsv,
  generatePediatricianSummary,
  localDayBounds,
  type Baby,
  type TrackingEvent,
} from '@baby-tracker/shared';
import { Check, Copy, Download, FileJson, FileSpreadsheet, Printer } from 'lucide-react';
import { useI18n } from '../lib/i18n.js';
import {
  downloadTextFile,
  getLocalTimeZone,
  getTodayDateKey,
  type VolumeUnit,
} from '../components/uiUtils.js';

type Preset = '24h' | '7d' | '14d' | '30d' | 'custom';

interface ExportPageProps {
  baby: Baby;
  events: TrackingEvent[];
  volumeUnit: VolumeUnit;
  nowMs: number;
}

export function ExportPage({
  baby,
  events,
  volumeUnit,
  nowMs,
}: ExportPageProps) {
  const { t, locale, formatDurationShort, formatVolume } = useI18n();
  const timeZone = getLocalTimeZone();
  const todayKey = getTodayDateKey(timeZone, nowMs);

  const [preset, setPreset] = useState<Preset>('7d');
  const [customStart, setCustomStart] = useState(() => addDays(todayKey, -6));
  const [customEnd, setCustomEnd] = useState(todayKey);
  const [copied, setCopied] = useState(false);

  const startDateKey =
    preset === '24h'
      ? addDays(todayKey, -1)
      : preset === '7d'
        ? addDays(todayKey, -6)
        : preset === '14d'
          ? addDays(todayKey, -13)
          : preset === '30d'
            ? addDays(todayKey, -29)
            : customStart;

  const endDateKey = preset === 'custom' ? customEnd : todayKey;

  const validRange = startDateKey <= endDateKey;
  const dailyStats = validRange
    ? computeDateRangeStats(events, startDateKey, endDateKey, timeZone, nowMs)
    : [];
  const { days, totals, averagesPerDay } = computePeriodAverages(dailyStats);
  const daysLabel =
    days === 1
      ? t('export.daysSingular', { count: days })
      : t('export.daysPlural', { count: days });

  const rangeEvents = validRange
    ? (() => {
        const rangeStartMs = localDayBounds(startDateKey, timeZone).startMs;
        const rangeEndMs = localDayBounds(endDateKey, timeZone).endMs;
        return events.filter((e) => {
          if (e.deletedAt != null) return false;
          const evStartMs = Date.parse(e.startedAt);
          const evEndMs = e.endedAt ? Date.parse(e.endedAt) : nowMs;
          if (evEndMs <= evStartMs) {
            return evStartMs >= rangeStartMs && evStartMs < rangeEndMs;
          }
          return evStartMs < rangeEndMs && evEndMs > rangeStartMs;
        });
      })()
    : [];

  const slugName = baby.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'baby';

  function handleDownloadEventsCsv() {
    const csv = exportEventsToCsv(rangeEvents, { timeZone, nowMs });
    downloadTextFile(
      `${slugName}-events-${startDateKey}-to-${endDateKey}.csv`,
      csv,
      'text/csv;charset=utf-8',
    );
  }

  function handleDownloadDailyStatsCsv() {
    const csv = exportDailyStatsToCsv(dailyStats);
    downloadTextFile(
      `${slugName}-daily-stats-${startDateKey}-to-${endDateKey}.csv`,
      csv,
      'text/csv;charset=utf-8',
    );
  }

  function handleDownloadJson() {
    const jsonObj = exportBabyDataToJson({
      baby,
      events,
      startDateKey,
      endDateKey,
      timeZone,
      nowMs,
    });
    downloadTextFile(
      `${slugName}-backup-${startDateKey}-to-${endDateKey}.json`,
      JSON.stringify(jsonObj, null, 2),
      'application/json;charset=utf-8',
    );
  }

  async function handleCopySummary() {
    const summaryText = generatePediatricianSummary({
      baby,
      events,
      startDateKey,
      endDateKey,
      timeZone,
      format: 'text',
      nowMs,
    });
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard fallback
      const ta = document.createElement('textarea');
      ta.value = summaryText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }

  return (
    <div className="space-y-6">
      {/* Screen UI (hidden on print) */}
      <div className="no-print space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t('export.title')}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('export.subtitle')}
          </p>
        </div>

        {/* Date Range Presets */}
        <div className="bt-card space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: '24h', label: t('export.preset.24h') },
                { id: '7d', label: t('export.preset.7d') },
                { id: '14d', label: t('export.preset.14d') },
                { id: '30d', label: t('export.preset.30d') },
                { id: 'custom', label: t('export.preset.custom') },
              ] as const
            ).map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={preset === p.id}
                onClick={() => setPreset(p.id)}
                className={`bt-focus-ring min-h-[44px] rounded-xl px-3.5 text-sm font-medium transition ${
                  preset === p.id
                    ? 'bg-teal-600 text-white'
                    : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="export-custom-start"
                  className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t('export.startDate')}
                </label>
                <input
                  id="export-custom-start"
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label
                  htmlFor="export-custom-end"
                  className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t('export.endDate')}
                </label>
                <input
                  id="export-custom-end"
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
          )}

          {!validRange && (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              {t('export.invalidRange')}
            </p>
          )}
        </div>

        {/* Summary Preview */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="bt-card p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.period')}
            </p>
            <p className="tabular-nums-clock mt-1 text-lg font-bold">
              {daysLabel}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.eventsCount', { count: rangeEvents.length })}
            </p>
          </div>
          <div className="bt-card bt-card-sleep p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.sleepAvgDay')}
            </p>
            <p className="tabular-nums-clock mt-1 text-lg font-bold">
              {formatDurationShort(averagesPerDay.totalSleepSeconds)}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.total', {
                val: formatDurationShort(totals.totalSleepSeconds),
              })}
            </p>
          </div>
          <div className="bt-card bt-card-breast p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.feedsAvgDay')}
            </p>
            <p className="tabular-nums-clock mt-1 text-lg font-bold">
              {averagesPerDay.totalFeedCount.toFixed(1)}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.bottlePerDay', {
                vol: formatVolume(averagesPerDay.bottleTotalMl, volumeUnit),
              })}
            </p>
          </div>
          <div className="bt-card bt-card-diaper p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.diapersAvgDay')}
            </p>
            <p className="tabular-nums-clock mt-1 text-lg font-bold">
              {t('export.wetPoopyAvg', {
                wet: averagesPerDay.wetCount.toFixed(1),
                poopy: averagesPerDay.poopyCount.toFixed(1),
              })}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.spitUpsTotal', { count: totals.spitUpCount })}
            </p>
          </div>
        </div>

        {/* Export Actions */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <button
            type="button"
            disabled={!validRange}
            onClick={handleDownloadEventsCsv}
            className="bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            <span>{t('export.downloadEventsCsv')}</span>
          </button>

          <button
            type="button"
            disabled={!validRange}
            onClick={handleDownloadDailyStatsCsv}
            className="bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>{t('export.downloadDailyStatsCsv')}</span>
          </button>

          <button
            type="button"
            disabled={!validRange}
            onClick={handleDownloadJson}
            className="bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <FileJson className="h-4 w-4" />
            <span>{t('export.downloadJsonBackup')}</span>
          </button>

          <button
            type="button"
            disabled={!validRange}
            onClick={() => void handleCopySummary()}
            className="bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 text-teal-600" />
                <span>{t('export.copiedSummary')}</span>
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                <span>{t('export.copySummaryText')}</span>
              </>
            )}
          </button>

          <button
            type="button"
            disabled={!validRange}
            onClick={() => window.print()}
            className="bt-focus-ring inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            <Printer className="h-4 w-4" />
            <span>{t('export.printClinicalReport')}</span>
          </button>
        </div>
      </div>

      {/* Printable Clinical Report (.print-only) */}
      <section className="print-only space-y-4">
        <header className="border-b border-slate-300 pb-3">
          <h1 className="text-2xl font-bold">
            {t('export.printTitle', { name: baby.name })}
          </h1>
          <p className="text-sm">
            {t('export.printDob', { dob: baby.dob })}
            {baby.birthWeightGrams != null
              ? t('export.printBirthWeight', { grams: baby.birthWeightGrams })
              : ''}
          </p>
          <p className="text-sm">
            {t('export.printPeriod', {
              start: startDateKey,
              end: endDateKey,
              days: daysLabel,
              tz: timeZone,
            })}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 border-b border-slate-300 pb-3 text-sm">
          <div>
            <strong>{t('export.col.sleep')}：</strong>
            {locale === 'zh-CN'
              ? `总计 ${formatDurationShort(totals.totalSleepSeconds)}（日均 ${formatDurationShort(averagesPerDay.totalSleepSeconds)}；共 ${totals.sleepSessionCount} 次）`
              : `${formatDurationShort(totals.totalSleepSeconds)} total (${formatDurationShort(averagesPerDay.totalSleepSeconds)}/day avg; ${totals.sleepSessionCount} sessions)`}
          </div>
          <div>
            <strong>{t('export.col.feeds')}：</strong>
            {locale === 'zh-CN'
              ? `共 ${totals.totalFeedCount} 次（日均 ${averagesPerDay.totalFeedCount.toFixed(1)} 次）— 母乳 ${totals.breastFeedCount} 次，奶瓶 ${totals.bottleFeedCount} 次（总计 ${Math.round(totals.bottleTotalMl)} ${t('common.ml')}）`
              : `${totals.totalFeedCount} total (${averagesPerDay.totalFeedCount.toFixed(1)}/day avg) — Breast: ${totals.breastFeedCount}, Bottle: ${totals.bottleFeedCount} (${Math.round(totals.bottleTotalMl)} ml total)`}
          </div>
          <div>
            <strong>{t('timeline.diaperTitle')}：</strong>
            {locale === 'zh-CN'
              ? `共更换 ${totals.diaperEventCount} 次 — ${totals.wetCount} 嘘嘘（日均 ${averagesPerDay.wetCount.toFixed(1)}），${totals.poopyCount} 便便（日均 ${averagesPerDay.poopyCount.toFixed(1)}）${totals.rashCount > 0 ? `，${totals.rashCount} 次红屁股` : ''}`
              : `${totals.diaperEventCount} changes — ${totals.wetCount} wet (${averagesPerDay.wetCount.toFixed(1)}/day), ${totals.poopyCount} poopy (${averagesPerDay.poopyCount.toFixed(1)}/day)${totals.rashCount > 0 ? `, ${totals.rashCount} rash` : ''}`}
          </div>
          <div>
            <strong>{t('export.col.spitUp')}：</strong>
            {locale === 'zh-CN'
              ? `共 ${totals.spitUpCount} 次（日均 ${averagesPerDay.spitUpCount.toFixed(1)} 次）`
              : `${totals.spitUpCount} total (${averagesPerDay.spitUpCount.toFixed(1)}/day avg)`}
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-base font-bold">
            {t('export.dayByDayBreakdown')}
          </h2>
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-400">
                <th className="py-1 pr-2">{t('export.col.date')}</th>
                <th className="py-1 pr-2">{t('export.col.sleep')}</th>
                <th className="py-1 pr-2">{t('export.col.feeds')}</th>
                <th className="py-1 pr-2">{t('export.col.breast')}</th>
                <th className="py-1 pr-2">{t('export.col.bottle')}</th>
                <th className="py-1 pr-2">{t('export.col.wetPoopy')}</th>
                <th className="py-1">{t('export.col.spitUp')}</th>
              </tr>
            </thead>
            <tbody>
              {dailyStats.map((d) => (
                <tr key={d.dateKey} className="border-b border-slate-200">
                  <td className="tabular-nums-clock py-1 pr-2">{d.dateKey}</td>
                  <td className="tabular-nums-clock py-1 pr-2">
                    {formatDurationShort(d.totalSleepSeconds)}
                  </td>
                  <td className="tabular-nums-clock py-1 pr-2">
                    {d.totalFeedCount}
                  </td>
                  <td className="tabular-nums-clock py-1 pr-2">
                    {formatDurationShort(d.breastTotalSeconds)}
                  </td>
                  <td className="tabular-nums-clock py-1 pr-2">
                    {Math.round(d.bottleTotalMl)} {t('common.ml')}
                  </td>
                  <td className="tabular-nums-clock py-1 pr-2">
                    {d.wetCount} / {d.poopyCount}
                  </td>
                  <td className="tabular-nums-clock py-1">{d.spitUpCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
