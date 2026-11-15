import type { Baby, TrackingEvent } from './schemas.js';
import {
  computeDateRangeStats,
  computePeriodAverages,
  formatLocalDateTime,
  toLocalDateKey,
  type DailyStats,
  type PeriodAverages,
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
  const { timeZone, includeHeader = true, nowMs = Date.now() } = options;

  const activeSorted = events
    .filter((e) => e.deletedAt == null)
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const lines: string[] = [];
  if (includeHeader) {
    lines.push(formatCsvRow(EVENTS_CSV_HEADERS));
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
      event.type === 'diaper' || event.type === 'spit_up'
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
    }

    lines.push(
      formatCsvRow([
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
        event.notes ?? '',
        event.loggedByName ?? event.loggedByUserId,
      ]),
    );
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
] as const;

export function exportDailyStatsToCsv(
  dailyStats: readonly DailyStats[],
  includeHeader = true,
): string {
  const lines: string[] = [];
  if (includeHeader) {
    lines.push(formatCsvRow(DAILY_STATS_CSV_HEADERS));
  }

  for (const day of dailyStats) {
    lines.push(
      formatCsvRow([
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
      ]),
    );
  }

  return lines.join('\r\n');
}

// ============================================================================
// Versioned JSON Backup Export
// ============================================================================

export interface BabyDataJsonExport {
  schemaVersion: 1;
  exportedAt: string;
  timeZone: string;
  dateRange: {
    startDateKey: string;
    endDateKey: string;
  };
  baby: Baby;
  summary: PeriodAverages;
  dailyStats: DailyStats[];
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
  } = options;

  const activeEvents = events
    .filter((e) => {
      if (e.deletedAt != null) return false;
      const dayKey = toLocalDateKey(e.startedAt, timeZone);
      return dayKey >= startDateKey && dayKey <= endDateKey;
    })
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const dailyStats = computeDateRangeStats(
    events,
    startDateKey,
    endDateKey,
    timeZone,
    nowMs,
  );
  const summary = computePeriodAverages(dailyStats);

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
  } = options;

  const isMd = format === 'markdown';
  const dailyStats = computeDateRangeStats(
    events,
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
  ];

  for (const row of summaryRows) {
    lines.push(isMd ? `- ${row}` : `* ${row}`);
  }

  lines.push('');
  lines.push(isMd ? '## Day-by-Day Breakdown' : 'DAY-BY-DAY BREAKDOWN');

  for (const day of dailyStats) {
    const dayLine = `${day.dateKey}: Sleep ${formatHoursMinutes(day.totalSleepSeconds)}, Feeds ${day.totalFeedCount} (Breast ${formatHoursMinutes(day.breastTotalSeconds)}, Bottle ${Math.round(day.bottleTotalMl)} ml), Diapers ${day.wetCount}W/${day.poopyCount}P, Spit-ups ${day.spitUpCount}`;
    lines.push(isMd ? `- ${dayLine}` : `  ${dayLine}`);
  }

  // Notable clinical notes: rash flags, large spit-ups, caregiver notes
  const activeInRange = events
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
