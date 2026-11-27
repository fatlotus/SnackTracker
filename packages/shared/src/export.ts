import { z } from 'zod';
import {
  BabySchema,
  isoDateSchema,
  isoDateTimeSchema,
  TrackingEventSchema,
  type Baby,
  type TrackingEvent,
} from './schemas.js';
import {
  computeDateRangeStats,
  computePeriodAverages,
  formatLocalDateTime,
  toLocalDateKey,
  type DailyStats,
  type PeriodAverages,
  type PeriodMetrics,
} from './stats.js';

// ============================================================================
// RFC 4180 CSV Escaping & Formula-Injection Neutralization
// ============================================================================

const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }

  let str = typeof value === 'string' ? value : String(value);

  if (str.length > 0 && FORMULA_INJECTION_RE.test(str)) {
    str = `'${str}`;
  }

  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replaceAll('"', '""')}"`;
  }

  return str;
}

function formatCsvRow(cells: readonly (string | number | boolean | null | undefined)[]): string {
  return cells.map(escapeCsvCell).join(',');
}

// ============================================================================
// CSV Exporters
// ============================================================================

export interface ExportEventsCsvOptions {
  timeZone: string;
  includeHeader?: boolean;
  nowMs?: number;
  includePumping?: boolean;
}

const EVENTS_CSV_HEADERS = [
  'id',
  'type',
  'localDate',
  'startedAtLocal',
  'endedAtLocal',
  'durationMinutes',
  'breastLeftMinutes',
  'breastRightMinutes',
  'volumeMl',
  'milkType',
  'sleepCategory',
  'sleepLocation',
  'diaperKind',
  'diaperAmount',
  'stoolColor',
  'stoolConsistency',
  'hasRash',
  'spitUpSeverity',
  'relatedFeedId',
  'pumpingSide',
  'pumpingLeftMl',
  'pumpingRightMl',
  'tummyTimeMood',
  'notes',
  'loggedBy',
] as const;

const EVENTS_CSV_HEADERS_NO_PUMPING = [
  'id',
  'type',
  'localDate',
  'startedAtLocal',
  'endedAtLocal',
  'durationMinutes',
  'breastLeftMinutes',
  'breastRightMinutes',
  'volumeMl',
  'milkType',
  'sleepCategory',
  'sleepLocation',
  'diaperKind',
  'diaperAmount',
  'stoolColor',
  'stoolConsistency',
  'hasRash',
  'spitUpSeverity',
  'relatedFeedId',
  'tummyTimeMood',
  'notes',
  'loggedBy',
] as const;

function roundMinutes(seconds: number): string {
  return (seconds / 60).toFixed(1);
}

/**
 * Exports non-deleted tracking events to RFC 4180 CSV with formula-injection
 * neutralization and local-timezone timestamps.
 * Distinguishes `volumeMl === 0` (`"0"`) from `volumeMl === null` (`""`).
 */
export function exportEventsToCsv(
  events: readonly TrackingEvent[],
  options: ExportEventsCsvOptions,
): string {
  const {
    timeZone,
    includeHeader = true,
    nowMs = Date.now(),
    includePumping = true,
  } = options;

  const activeSorted = events
    .filter((e) => e.deletedAt == null && (includePumping || e.type !== 'pumping'))
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const lines: string[] = [];
  if (includeHeader) {
    lines.push(
      formatCsvRow(
        includePumping ? EVENTS_CSV_HEADERS : EVENTS_CSV_HEADERS_NO_PUMPING,
      ),
    );
  }

  for (const event of activeSorted) {
    const startMs = Date.parse(event.startedAt);
    const localDate = toLocalDateKey(startMs, timeZone);
    const startedAtLocal = formatLocalDateTime(startMs, timeZone);
    const endedAtLocal =
      event.endedAt !== null ? formatLocalDateTime(event.endedAt, timeZone) : '';

    const effectiveEndMs =
      event.endedAt !== null ? Date.parse(event.endedAt) : Math.max(startMs, nowMs);
    const durationMinutes =
      event.type === 'diaper' ||
      event.type === 'spit_up' ||
      event.type === 'vitamin'
        ? ''
        : roundMinutes(Math.max(0, (effectiveEndMs - startMs) / 1000));

    let breastLeftMinutes = '';
    let breastRightMinutes = '';
    let volumeMl: string | number = '';
    let milkType = '';
    let sleepCategory = '';
    let sleepLocation = '';
    let diaperKind = '';
    let diaperAmount = '';
    let stoolColor = '';
    let stoolConsistency = '';
    let hasRash: string | boolean = '';
    let spitUpSeverity = '';
    let relatedFeedId = '';
    let pumpingSide = '';
    let pumpingLeftMl: string | number = '';
    let pumpingRightMl: string | number = '';
    let tummyTimeMood = '';

    switch (event.type) {
      case 'breast_feed':
        breastLeftMinutes = roundMinutes(event.payload.totalLeftSeconds);
        breastRightMinutes = roundMinutes(event.payload.totalRightSeconds);
        break;
      case 'bottle_feed':
        volumeMl =
          event.payload.volumeMl === null ? '' : String(event.payload.volumeMl);
        milkType = event.payload.milkType ?? '';
        break;
      case 'sleep':
        sleepCategory = event.payload.category;
        sleepLocation = event.payload.location ?? '';
        break;
      case 'diaper':
        diaperKind = event.payload.kind;
        diaperAmount = event.payload.amount ?? '';
        stoolColor = event.payload.stoolColor ?? '';
        stoolConsistency = event.payload.stoolConsistency ?? '';
        hasRash =
          event.payload.hasRash === undefined ? '' : event.payload.hasRash;
        break;
      case 'spit_up':
        spitUpSeverity = event.payload.severity ?? '';
        relatedFeedId = event.payload.relatedFeedId ?? '';
        break;
      case 'vitamin':
        break;
      case 'pumping':
        volumeMl =
          event.payload.volumeMl === null ? '' : String(event.payload.volumeMl);
        pumpingSide = event.payload.side ?? '';
        pumpingLeftMl =
          event.payload.leftVolumeMl == null
            ? ''
            : String(event.payload.leftVolumeMl);
        pumpingRightMl =
          event.payload.rightVolumeMl == null
            ? ''
            : String(event.payload.rightVolumeMl);
        break;
      case 'tummy_time':
        tummyTimeMood = event.payload.mood ?? '';
        break;
    }

    const rowCells: (string | number | boolean | null | undefined)[] = [
      event.id,
      event.type,
      localDate,
      startedAtLocal,
      endedAtLocal,
      durationMinutes,
      breastLeftMinutes,
      breastRightMinutes,
      volumeMl,
      milkType,
      sleepCategory,
      sleepLocation,
      diaperKind,
      diaperAmount,
      stoolColor,
      stoolConsistency,
      hasRash,
      spitUpSeverity,
      relatedFeedId,
    ];
    if (includePumping) {
      rowCells.push(pumpingSide, pumpingLeftMl, pumpingRightMl);
    }
    rowCells.push(
      tummyTimeMood,
      event.notes ?? '',
      event.loggedByName ?? event.loggedByUserId,
    );

    lines.push(formatCsvRow(rowCells));
  }

  return lines.join('\r\n');
}

const DAILY_STATS_CSV_HEADERS = [
  'date',
  'totalSleepMinutes',
  'napSleepMinutes',
  'nightSleepMinutes',
  'sleepSessions',
  'breastFeedCount',
  'breastLeftMinutes',
  'breastRightMinutes',
  'bottleFeedCount',
  'bottleTotalMl',
  'wetDiapers',
  'poopyDiapers',
  'bothDiapers',
  'diaperEvents',
  'rashCount',
  'spitUpCount',
  'vitaminGiven',
  'pumpingSessions',
  'pumpingMinutes',
  'pumpingTotalMl',
  'tummyTimeSessions',
  'tummyTimeMinutes',
] as const;

const DAILY_STATS_CSV_HEADERS_NO_PUMPING = [
  'date',
  'totalSleepMinutes',
  'napSleepMinutes',
  'nightSleepMinutes',
  'sleepSessions',
  'breastFeedCount',
  'breastLeftMinutes',
  'breastRightMinutes',
  'bottleFeedCount',
  'bottleTotalMl',
  'wetDiapers',
  'poopyDiapers',
  'bothDiapers',
  'diaperEvents',
  'rashCount',
  'spitUpCount',
  'vitaminGiven',
  'tummyTimeSessions',
  'tummyTimeMinutes',
] as const;

export interface ExportDailyStatsCsvOptions {
  includeHeader?: boolean;
  includePumping?: boolean;
}

export function exportDailyStatsToCsv(
  dailyStats: readonly DailyStats[],
  options: boolean | ExportDailyStatsCsvOptions = true,
): string {
  const includeHeader =
    typeof options === 'boolean' ? options : (options.includeHeader ?? true);
  const includePumping =
    typeof options === 'boolean' ? true : (options.includePumping ?? true);

  const lines: string[] = [];
  if (includeHeader) {
    lines.push(
      formatCsvRow(
        includePumping
          ? DAILY_STATS_CSV_HEADERS
          : DAILY_STATS_CSV_HEADERS_NO_PUMPING,
      ),
    );
  }

  for (const day of dailyStats) {
    const rowCells: (string | number | boolean | null | undefined)[] = [
      day.dateKey,
      roundMinutes(day.totalSleepSeconds),
      roundMinutes(day.napSleepSeconds),
      roundMinutes(day.nightSleepSeconds),
      day.sleepSessionCount,
      day.breastFeedCount,
      roundMinutes(day.breastLeftSeconds),
      roundMinutes(day.breastRightSeconds),
      day.bottleFeedCount,
      day.bottleTotalMl,
      day.wetCount,
      day.poopyCount,
      day.bothCount,
      day.diaperEventCount,
      day.rashCount,
      day.spitUpCount,
      day.vitaminGiven,
    ];
    if (includePumping) {
      rowCells.push(
        day.pumpingCount,
        roundMinutes(day.pumpingTotalSeconds),
        day.pumpingTotalMl,
      );
    }
    rowCells.push(
      day.tummyTimeCount,
      roundMinutes(day.tummyTimeTotalSeconds),
    );
    lines.push(formatCsvRow(rowCells));
  }

  return lines.join('\r\n');
}

// ============================================================================
// Versioned JSON Backup Export
// ============================================================================

type PumpingStatKeys =
  | 'pumpingCount'
  | 'pumpingTotalSeconds'
  | 'pumpingTotalMl';

export type ExportDailyStats =
  | DailyStats
  | Omit<DailyStats, PumpingStatKeys>;

export type ExportPeriodAverages =
  | PeriodAverages
  | {
      days: number;
      totals: Omit<PeriodMetrics, PumpingStatKeys>;
      averagesPerDay: Omit<PeriodMetrics, PumpingStatKeys>;
    };

function stripPumpingKeys<T extends Record<PumpingStatKeys, unknown>>(
  obj: T,
): Omit<T, PumpingStatKeys> {
  const {
    pumpingCount: _pumpingCount,
    pumpingTotalSeconds: _pumpingTotalSeconds,
    pumpingTotalMl: _pumpingTotalMl,
    ...rest
  } = obj;
  return rest;
}

export interface BabyDataJsonExport {
  schemaVersion: 1;
  exportedAt: string;
  timeZone: string;
  dateRange: {
    startDateKey: string;
    endDateKey: string;
  };
  baby: Baby;
  summary: ExportPeriodAverages;
  dailyStats: ExportDailyStats[];
  events: TrackingEvent[];
}

export interface ExportBabyDataOptions {
  baby: Baby;
  events: readonly TrackingEvent[];
  startDateKey: string;
  endDateKey: string;
  timeZone: string;
  exportedAt?: string;
  nowMs?: number;
  includePumping?: boolean;
}

export function exportBabyDataToJson(
  options: ExportBabyDataOptions,
): BabyDataJsonExport {
  const {
    baby,
    events,
    startDateKey,
    endDateKey,
    timeZone,
    nowMs = Date.now(),
    exportedAt = new Date(nowMs).toISOString(),
    includePumping = true,
  } = options;

  const filteredEvents = includePumping
    ? events
    : events.filter((e) => e.type !== 'pumping');

  const activeEvents = filteredEvents
    .filter((e) => {
      if (e.deletedAt != null) return false;
      const dayKey = toLocalDateKey(e.startedAt, timeZone);
      return dayKey >= startDateKey && dayKey <= endDateKey;
    })
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const rawDailyStats = computeDateRangeStats(
    filteredEvents,
    startDateKey,
    endDateKey,
    timeZone,
    nowMs,
  );
  const rawSummary = computePeriodAverages(rawDailyStats);

  const dailyStats: ExportDailyStats[] = includePumping
    ? rawDailyStats
    : rawDailyStats.map(stripPumpingKeys);

  const summary: ExportPeriodAverages = includePumping
    ? rawSummary
    : {
        days: rawSummary.days,
        totals: stripPumpingKeys(rawSummary.totals),
        averagesPerDay: stripPumpingKeys(rawSummary.averagesPerDay),
      };

  return {
    schemaVersion: 1,
    exportedAt,
    timeZone,
    dateRange: { startDateKey, endDateKey },
    baby,
    summary,
    dailyStats,
    events: activeEvents,
  };
}

// ============================================================================
// Versioned JSON Backup Import
// ============================================================================

export const MAX_IMPORT_EVENTS = 50_000;

export const ImportBabyJsonSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: isoDateTimeSchema.optional(),
  timeZone: z.string().min(1).max(100).optional(),
  dateRange: z
    .object({
      startDateKey: isoDateSchema,
      endDateKey: isoDateSchema,
    })
    .optional(),
  baby: BabySchema,
  events: z.array(TrackingEventSchema).max(MAX_IMPORT_EVENTS),
});

export type ImportBabyJson = z.infer<typeof ImportBabyJsonSchema>;

export type ParseBabyDataJsonResult =
  | { ok: true; data: ImportBabyJson }
  | {
      ok: false;
      error: 'invalid_json' | 'unsupported_version' | 'validation_failed';
      message: string;
    };

export function parseBabyDataJson(rawText: string): ParseBabyDataJsonResult {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    return {
      ok: false,
      error: 'invalid_json',
      message: err instanceof Error ? err.message : 'Invalid JSON syntax',
    };
  }

  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'schemaVersion' in raw &&
    (raw as Record<string, unknown>).schemaVersion !== 1
  ) {
    return {
      ok: false,
      error: 'unsupported_version',
      message: `Unsupported schemaVersion: ${String((raw as Record<string, unknown>).schemaVersion)}`,
    };
  }

  const parsed = ImportBabyJsonSchema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const pathStr = firstIssue?.path.length
      ? `${firstIssue.path.join('.')}: `
      : '';
    return {
      ok: false,
      error: 'validation_failed',
      message: firstIssue
        ? `${pathStr}${firstIssue.message}`
        : 'Backup file failed schema validation',
    };
  }

  return { ok: true, data: parsed.data };
}

// ============================================================================
// Pediatrician Text / Markdown Summary
// ============================================================================

export interface PediatricianSummaryOptions {
  baby: Baby;
  events: readonly TrackingEvent[];
  startDateKey: string;
  endDateKey: string;
  timeZone: string;
  format?: 'text' | 'markdown';
  nowMs?: number;
  includePumping?: boolean;
}

function formatAgeFromDob(dob: string, referenceDateKey: string): string {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ry, rm, rd] = referenceDateKey.split('-').map(Number);
  const birthMs = Date.UTC(by!, bm! - 1, bd!);
  const refMs = Date.UTC(ry!, rm! - 1, rd!);
  const totalDays = Math.max(0, Math.floor((refMs - birthMs) / 86_400_000));

  if (totalDays < 14) {
    return `${totalDays} day${totalDays === 1 ? '' : 's'} old`;
  }
  if (totalDays < 60) {
    const weeks = Math.floor(totalDays / 7);
    const remDays = totalDays % 7;
    return remDays > 0
      ? `${weeks} week${weeks === 1 ? '' : 's'}, ${remDays} day${remDays === 1 ? '' : 's'} old`
      : `${weeks} week${weeks === 1 ? '' : 's'} old`;
  }
  const months = Math.max(2, Math.floor(totalDays / 30.4375));
  return `${months} month${months === 1 ? '' : 's'} old`;
}

function formatHoursMinutes(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function generatePediatricianSummary(
  options: PediatricianSummaryOptions,
): string {
  const {
    baby,
    events,
    startDateKey,
    endDateKey,
    timeZone,
    format = 'text',
    nowMs = Date.now(),
    includePumping = true,
  } = options;

  const isMd = format === 'markdown';
  const filteredEvents = includePumping
    ? events
    : events.filter((e) => e.type !== 'pumping');

  const dailyStats = computeDateRangeStats(
    filteredEvents,
    startDateKey,
    endDateKey,
    timeZone,
    nowMs,
  );
  const { days, totals, averagesPerDay } = computePeriodAverages(dailyStats);
  const ageLabel = formatAgeFromDob(baby.dob, endDateKey);

  const lines: string[] = [];

  if (isMd) {
    lines.push(`# Pediatrician Summary: ${baby.name}`);
    lines.push('');
    lines.push(`- **DOB:** ${baby.dob} (${ageLabel})`);
    lines.push(`- **Period:** ${startDateKey} to ${endDateKey} (${days} day${days === 1 ? '' : 's'}, ${timeZone})`);
    if (baby.birthWeightGrams != null) {
      lines.push(`- **Birth Weight:** ${baby.birthWeightGrams} g`);
    }
    lines.push('');
    lines.push('## Period Totals & Daily Averages');
  } else {
    lines.push(`PEDIATRICIAN SUMMARY: ${baby.name}`);
    lines.push(`DOB: ${baby.dob} (${ageLabel})`);
    lines.push(`Period: ${startDateKey} to ${endDateKey} (${days} day${days === 1 ? '' : 's'}, ${timeZone})`);
    if (baby.birthWeightGrams != null) {
      lines.push(`Birth Weight: ${baby.birthWeightGrams} g`);
    }
    lines.push('');
    lines.push('PERIOD TOTALS & DAILY AVERAGES');
  }

  const summaryRows = [
    `Sleep: ${formatHoursMinutes(totals.totalSleepSeconds)} total (${formatHoursMinutes(averagesPerDay.totalSleepSeconds)}/day avg; ${totals.sleepSessionCount} sessions)`,
    `Feeding: ${totals.totalFeedCount} feeds total (${averagesPerDay.totalFeedCount.toFixed(1)}/day avg) — Breast: ${totals.breastFeedCount} (${formatHoursMinutes(totals.breastTotalSeconds)}), Bottle: ${totals.bottleFeedCount} (${Math.round(totals.bottleTotalMl)} ml total, ${Math.round(averagesPerDay.bottleTotalMl)} ml/day avg)`,
    `Diapers: ${totals.diaperEventCount} changes — ${totals.wetCount} wet (${averagesPerDay.wetCount.toFixed(1)}/day), ${totals.poopyCount} poopy (${averagesPerDay.poopyCount.toFixed(1)}/day), ${totals.bothCount} both${totals.rashCount > 0 ? `, ${totals.rashCount} rash flag(s)` : ''}`,
    `Spit-Up: ${totals.spitUpCount} total (${averagesPerDay.spitUpCount.toFixed(1)}/day avg)`,
    `Vitamins: ${totals.vitaminDaysCount}/${days} day${days === 1 ? '' : 's'} given`,
    ...(includePumping
      ? [
          `Pumping: ${totals.pumpingCount} sessions (${Math.round(totals.pumpingTotalMl)} ml total, ${Math.round(averagesPerDay.pumpingTotalMl)} ml/day avg; ${formatHoursMinutes(totals.pumpingTotalSeconds)} total)`,
        ]
      : []),
    `Tummy Time: ${formatHoursMinutes(totals.tummyTimeTotalSeconds)} total (${formatHoursMinutes(averagesPerDay.tummyTimeTotalSeconds)}/day avg; ${totals.tummyTimeCount} sessions)`,
  ];

  for (const row of summaryRows) {
    lines.push(isMd ? `- ${row}` : `* ${row}`);
  }

  lines.push('');
  lines.push(isMd ? '## Day-by-Day Breakdown' : 'DAY-BY-DAY BREAKDOWN');

  for (const day of dailyStats) {
    const pumpingSegment = includePumping
      ? `, Pumping ${day.pumpingCount} (${Math.round(day.pumpingTotalMl)} ml)`
      : '';
    const dayLine = `${day.dateKey}: Sleep ${formatHoursMinutes(day.totalSleepSeconds)}, Feeds ${day.totalFeedCount} (Breast ${formatHoursMinutes(day.breastTotalSeconds)}, Bottle ${Math.round(day.bottleTotalMl)} ml), Diapers ${day.wetCount}W/${day.poopyCount}P, Spit-ups ${day.spitUpCount}, Vitamins ${day.vitaminGiven ? 'Yes' : 'No'}${pumpingSegment}, Tummy Time ${formatHoursMinutes(day.tummyTimeTotalSeconds)} (${day.tummyTimeCount})`;
    lines.push(isMd ? `- ${dayLine}` : `  ${dayLine}`);
  }

  // Notable clinical notes: rash flags, large spit-ups, caregiver notes
  const activeInRange = filteredEvents
    .filter((e) => {
      if (e.deletedAt != null) return false;
      const dayKey = toLocalDateKey(e.startedAt, timeZone);
      return dayKey >= startDateKey && dayKey <= endDateKey;
    })
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const clinicalNotes: string[] = [];
  for (const ev of activeInRange) {
    const localTime = formatLocalDateTime(ev.startedAt, timeZone);
    if (ev.type === 'diaper' && ev.payload.hasRash === true) {
      clinicalNotes.push(`[${localTime}] Diaper rash noted${ev.notes ? `: ${ev.notes}` : ''}`);
    } else if (ev.type === 'spit_up' && ev.payload.severity === 'large') {
      clinicalNotes.push(`[${localTime}] Large spit-up${ev.notes ? `: ${ev.notes}` : ''}`);
    } else if (ev.notes && ev.notes.trim().length > 0) {
      clinicalNotes.push(`[${localTime}] (${ev.type}) ${ev.notes.trim()}`);
    }
  }

  if (clinicalNotes.length > 0) {
    lines.push('');
    lines.push(isMd ? '## Notable Clinical Notes' : 'NOTABLE CLINICAL NOTES');
    for (const note of clinicalNotes) {
      lines.push(isMd ? `- ${note}` : `* ${note}`);
    }
  }

  return lines.join('\n');
}
