import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  addDays,
  computeDateRangeStats,
  computePeriodAverages,
  exportBabyDataToJson,
  exportDailyStatsToCsv,
  exportEventsToCsv,
  generatePediatricianSummary,
  localDayBounds,
  parseBabyDataJson,
  type Baby,
  type ImportBabyJson,
  type TrackingEvent,
} from '@baby-tracker/shared';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileJson,
  FileSpreadsheet,
  Printer,
  Upload,
} from 'lucide-react';
import { useI18n } from '../lib/i18n.js';
import { importEventsForBaby } from '../lib/store.js';
import {
  downloadTextFile,
  getLocalTimeZone,
  getTodayDateKey,
  type VolumeUnit,
} from '../components/uiUtils.js';

type Preset = '24h' | '7d' | '14d' | '30d' | 'custom';

const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

interface ImportPreviewState {
  fileName: string;
  data: ImportBabyJson;
}

interface ExportPageProps {
  baby: Baby;
  events: TrackingEvent[];
  volumeUnit: VolumeUnit;
  nowMs: number;
  userId: string;
  userName?: string | null;
  canWrite?: boolean;
  canAccessPumping?: boolean;
}

export function ExportPage({
  baby,
  events,
  volumeUnit,
  nowMs,
  userId,
  userName = null,
  canWrite = true,
  canAccessPumping = true,
}: ExportPageProps) {
  const { t, locale, formatDurationShort, formatVolume } = useI18n();
  const timeZone = getLocalTimeZone();
  const todayKey = getTodayDateKey(timeZone, nowMs);

  const [preset, setPreset] = useState<Preset>('7d');
  const [customStart, setCustomStart] = useState(() => addDays(todayKey, -6));
  const [customEnd, setCustomEnd] = useState(todayKey);
  const [copied, setCopied] = useState(false);

  // JSON Backup Import state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreviewState | null>(
    null,
  );
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  useEffect(() => {
    setImportPreview(null);
    setOverwriteExisting(false);
    setImportError(null);
    setImportSuccess(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [baby.id]);

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

  const visibleEvents = canAccessPumping
    ? events
    : events.filter((e) => e.type !== 'pumping');

  const validRange = startDateKey <= endDateKey;
  const dailyStats = validRange
    ? computeDateRangeStats(
        visibleEvents,
        startDateKey,
        endDateKey,
        timeZone,
        nowMs,
      )
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
        return visibleEvents.filter((e) => {
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
    const csv = exportEventsToCsv(rangeEvents, {
      timeZone,
      nowMs,
      includePumping: canAccessPumping,
    });
    downloadTextFile(
      `${slugName}-events-${startDateKey}-to-${endDateKey}.csv`,
      csv,
      'text/csv;charset=utf-8',
    );
  }

  function handleDownloadDailyStatsCsv() {
    const csv = exportDailyStatsToCsv(dailyStats, {
      includePumping: canAccessPumping,
    });
    downloadTextFile(
      `${slugName}-daily-stats-${startDateKey}-to-${endDateKey}.csv`,
      csv,
      'text/csv;charset=utf-8',
    );
  }

  function handleDownloadJson() {
    const jsonObj = exportBabyDataToJson({
      baby,
      events: visibleEvents,
      startDateKey,
      endDateKey,
      timeZone,
      nowMs,
      includePumping: canAccessPumping,
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
      events: visibleEvents,
      startDateKey,
      endDateKey,
      timeZone,
      format: 'text',
      nowMs,
      includePumping: canAccessPumping,
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

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setImportError(null);
    setImportSuccess(null);
    setImportPreview(null);
    setOverwriteExisting(false);
    if (!file) return;

    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setImportError(t('export.importErrorTooLarge'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    try {
      const text = await file.text();
      const parsed = parseBabyDataJson(text);
      if (!parsed.ok) {
        if (parsed.error === 'invalid_json') {
          setImportError(t('export.importErrorInvalidJson'));
        } else if (parsed.error === 'unsupported_version') {
          setImportError(t('export.importErrorUnsupportedVersion'));
        } else {
          setImportError(
            t('export.importErrorValidation', { detail: parsed.message }),
          );
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      setImportPreview({ fileName: file.name, data: parsed.data });
    } catch (err) {
      setImportError(
        t('export.importErrorGeneric', {
          detail: err instanceof Error ? err.message : 'Unknown error',
        }),
      );
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const importDryRun = (() => {
    if (!importPreview) return null;
    const isSameBaby = importPreview.data.baby.id === baby.id;
    const existingActiveIds = new Set(
      events.filter((ev) => !ev.deletedAt).map((ev) => ev.id),
    );

    let totalInFile = 0;
    let pumpingSkippedCount = 0;
    let alreadyExistingCount = 0;
    let toImportCount = 0;

    for (const ev of importPreview.data.events) {
      if (ev.deletedAt != null) continue;
      totalInFile += 1;
      if (!canAccessPumping && ev.type === 'pumping') {
        pumpingSkippedCount += 1;
        continue;
      }
      if (isSameBaby && existingActiveIds.has(ev.id)) {
        alreadyExistingCount += 1;
        if (overwriteExisting) {
          toImportCount += 1;
        }
      } else {
        toImportCount += 1;
      }
    }

    return {
      isSameBaby,
      totalInFile,
      pumpingSkippedCount,
      alreadyExistingCount,
      toImportCount,
    };
  })();

  async function handleConfirmImport() {
    if (!importPreview || !canWrite || importing) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const result = await importEventsForBaby({
        babyId: baby.id,
        backupBabyId: importPreview.data.baby.id,
        events: importPreview.data.events,
        userId,
        userName,
        allowPumping: canAccessPumping,
        overwriteExisting,
      });
      const writtenCount = result.importedCount + result.overwrittenCount;
      const skippedCount =
        result.skippedExistingCount +
        result.skippedPumpingCount +
        result.skippedDeletedCount;
      const skippedPart =
        skippedCount > 0
          ? t('export.importSuccessSkipped', { count: skippedCount })
          : '';
      setImportSuccess(
        t('export.importSuccess', {
          imported: writtenCount,
          skippedPart,
        }),
      );
      setImportPreview(null);
      setOverwriteExisting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setImportError(
        t('export.importErrorGeneric', {
          detail: err instanceof Error ? err.message : 'Unknown error',
        }),
      );
    } finally {
      setImporting(false);
    }
  }

  function handleCancelImport() {
    setImportPreview(null);
    setOverwriteExisting(false);
    setImportError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
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
          {canAccessPumping && (
            <div className="bt-card bt-card-pumping p-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('export.pumpingAvgDay')}
              </p>
              <p className="tabular-nums-clock mt-1 text-lg font-bold">
                {formatVolume(averagesPerDay.pumpingTotalMl, volumeUnit)}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('export.pumpingSessionsTotal', { count: totals.pumpingCount })}
              </p>
            </div>
          )}
          <div className="bt-card bt-card-tummy p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.tummyTimeAvgDay')}
            </p>
            <p className="tabular-nums-clock mt-1 text-lg font-bold">
              {formatDurationShort(averagesPerDay.tummyTimeTotalSeconds)}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('export.tummyTimeSessionsTotal', {
                count: totals.tummyTimeCount,
              })}
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

        {/* Restore from JSON Backup */}
        {canWrite && (
          <section className="bt-card space-y-4 p-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {t('export.importTitle')}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('export.importSubtitle', { name: baby.name })}
              </p>
            </div>

            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={(e) => void handleFileSelect(e)}
                className="sr-only"
                aria-label={t('export.importSelectFile')}
              />
              <button
                type="button"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
                className="bt-focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
              >
                <Upload className="h-4 w-4" />
                <span>{t('export.importSelectFile')}</span>
              </button>
            </div>

            {importError && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
              >
                {importError}
              </div>
            )}

            {importSuccess && (
              <div
                role="status"
                className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
              >
                {importSuccess}
              </div>
            )}

            {importPreview && importDryRun && (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-800/40">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {t('export.importPreviewTitle', {
                      fileName: importPreview.fileName,
                    })}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {t('export.importBackupBaby', {
                      name: importPreview.data.baby.name,
                      dob: importPreview.data.baby.dob,
                    })}
                  </p>
                </div>

                {!importDryRun.isSameBaby && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {t('export.importDifferentBabyWarning', {
                        backupName: importPreview.data.baby.name,
                        activeName: baby.name,
                      })}
                    </span>
                  </div>
                )}

                <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                  {t('export.importSummaryCounts', {
                    total: importDryRun.totalInFile,
                    toImport: importDryRun.toImportCount,
                    existing: importDryRun.alreadyExistingCount,
                  })}
                </p>

                {!canAccessPumping && importDryRun.pumpingSkippedCount > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t('export.importPumpingSkipped', {
                      count: importDryRun.pumpingSkippedCount,
                    })}
                  </p>
                )}

                {importDryRun.isSameBaby &&
                  importDryRun.alreadyExistingCount > 0 && (
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={overwriteExisting}
                        onChange={(e) => setOverwriteExisting(e.target.checked)}
                        className="bt-focus-ring h-4 w-4 rounded border-slate-300 text-teal-600"
                      />
                      <span>{t('export.importOverwriteLabel')}</span>
                    </label>
                  )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={importing || importDryRun.toImportCount === 0}
                    onClick={() => void handleConfirmImport()}
                    className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    {importing
                      ? t('export.importImporting')
                      : t('export.importConfirm', {
                          count: importDryRun.toImportCount,
                        })}
                  </button>
                  <button
                    type="button"
                    disabled={importing}
                    onClick={handleCancelImport}
                    className="bt-focus-ring inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    {t('export.importCancel')}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
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
          {canAccessPumping && (
            <div>
              <strong>{t('export.col.pumping')}：</strong>
              {locale === 'zh-CN'
                ? `共 ${totals.pumpingCount} 次（总计 ${Math.round(totals.pumpingTotalMl)} ${t('common.ml')}，日均 ${Math.round(averagesPerDay.pumpingTotalMl)} ${t('common.ml')}）`
                : `${totals.pumpingCount} sessions (${Math.round(totals.pumpingTotalMl)} ml total, ${Math.round(averagesPerDay.pumpingTotalMl)} ml/day avg)`}
            </div>
          )}
          <div>
            <strong>{t('export.col.tummyTime')}：</strong>
            {locale === 'zh-CN'
              ? `总计 ${formatDurationShort(totals.tummyTimeTotalSeconds)}（日均 ${formatDurationShort(averagesPerDay.tummyTimeTotalSeconds)}；共 ${totals.tummyTimeCount} 次）`
              : `${formatDurationShort(totals.tummyTimeTotalSeconds)} total (${formatDurationShort(averagesPerDay.tummyTimeTotalSeconds)}/day avg; ${totals.tummyTimeCount} sessions)`}
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
                <th className="py-1 pr-2">{t('export.col.spitUp')}</th>
                {canAccessPumping && (
                  <th className="py-1 pr-2">{t('export.col.pumping')}</th>
                )}
                <th className="py-1">{t('export.col.tummyTime')}</th>
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
                  <td className="tabular-nums-clock py-1 pr-2">
                    {d.spitUpCount}
                  </td>
                  {canAccessPumping && (
                    <td className="tabular-nums-clock py-1 pr-2">
                      {Math.round(d.pumpingTotalMl)} {t('common.ml')}
                    </td>
                  )}
                  <td className="tabular-nums-clock py-1">
                    {formatDurationShort(d.tummyTimeTotalSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
