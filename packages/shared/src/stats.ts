import type {
  BreastFeedEvent,
  BottleFeedEvent,
  BreastSide,
  DiaperEvent,
  DiaperKind,
  MilkType,
  SleepCategory,
  SleepEvent,
  SpitUpEvent,
  SpitUpSeverity,
  TrackingEvent,
  VitaminEvent,
} from './schemas.js';

// ============================================================================
// Constants & Unit Conversions
// ============================================================================

export const ML_PER_OZ = 29.5735295625;

export function mlToOz(ml: number): number {
  return ml / ML_PER_OZ;
}

export function ozToMl(oz: number): number {
  return oz * ML_PER_OZ;
}

// ============================================================================
// DST-Safe Timezone & Calendar Helpers (Pure Intl.DateTimeFormat)
// ============================================================================

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dateFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dateTimeFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dateTimeFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function toEpochMs(isoOrMs: string | number): number {
  return typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
}

/**
 * Formats an ISO-8601 timestamp or epoch ms into a `YYYY-MM-DD` local date key
 * in the specified IANA timezone.
 */
export function toLocalDateKey(
  isoOrMs: string | number,
  timeZone: string,
): string {
  const ms = toEpochMs(isoOrMs);
  const parts = getDateFormatter(timeZone).formatToParts(new Date(ms));
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/**
 * Formats an ISO-8601 timestamp or epoch ms into `YYYY-MM-DD HH:mm:ss`
 * in the specified IANA timezone.
 */
export function formatLocalDateTime(
  isoOrMs: string | number,
  timeZone: string,
): string {
  const ms = toEpochMs(isoOrMs);
  const parts = getDateTimeFormatter(timeZone).formatToParts(new Date(ms));
  let year = '';
  let month = '';
  let day = '';
  let hour = '00';
  let minute = '00';
  let second = '00';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
    else if (part.type === 'hour') hour = part.value === '24' ? '00' : part.value;
    else if (part.type === 'minute') minute = part.value;
    else if (part.type === 'second') second = part.value;
  }
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const match = DATE_KEY_RE.exec(dateKey);
  if (!match) {
    throw new RangeError(`Invalid dateKey "${dateKey}": expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar dateKey "${dateKey}"`);
  }
  return { year, month, day };
}

/**
 * Adds `days` (positive or negative) to a `YYYY-MM-DD` date key using pure
 * UTC calendar arithmetic (immune to DST).
 */
export function addDays(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKey(dateKey);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalClockAsUtcMs(utcMs: number, timeZone: string): number {
  const parts = getDateTimeFormatter(timeZone).formatToParts(new Date(utcMs));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') {
      const h = Number(part.value);
      hour = h === 24 ? 0 : h;
    } else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, 0);
}

function localMidnightMs(dateKey: string, timeZone: string): number {
  const { year, month, day } = parseDateKey(dateKey);
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let candidate = targetLocalAsUtc;

  // Iterative offset refinement handles DST transitions accurately
  for (let i = 0; i < 3; i++) {
    const localAsUtc = getLocalClockAsUtcMs(candidate, timeZone);
    const diff = targetLocalAsUtc - localAsUtc;
    if (diff === 0) break;
    candidate += diff;
  }

  return candidate;
}

/**
 * Returns the exact UTC epoch millisecond bounds `[startMs, endMs)` for a local
 * calendar day in `timeZone`. On DST spring-forward days this is 23h; on
 * fall-back days this is 25h.
 */
export function localDayBounds(
  dateKey: string,
  timeZone: string,
): { startMs: number; endMs: number } {
  const startMs = localMidnightMs(dateKey, timeZone);
  const nextDateKey = addDays(dateKey, 1);
  const endMs = localMidnightMs(nextDateKey, timeZone);
  return { startMs, endMs };
}

function overlapSeconds(
  segStartMs: number,
  segEndMs: number,
  dayStartMs: number,
  dayEndMs: number,
): number {
  const start = Math.max(segStartMs, dayStartMs);
  const end = Math.min(segEndMs, dayEndMs);
  return end > start ? (end - start) / 1000 : 0;
}

// ============================================================================
// Stats Types & Aggregation
// ============================================================================

export interface DailyStats {
  dateKey: string;

  // Sleep
  totalSleepSeconds: number;
  napSleepSeconds: number;
  nightSleepSeconds: number;
  sleepSessionCount: number;
  napCount: number;
  nightCount: number;

  // Breast feeding
  breastLeftSeconds: number;
  breastRightSeconds: number;
  breastTotalSeconds: number;
  breastFeedCount: number;
  lastBreastSide: BreastSide | null;

  // Bottle feeding
  bottleTotalSeconds: number;
  bottleFeedCount: number;
  bottleTotalMl: number;
  bottleMlByMilkType: Partial<Record<MilkType, number>>;

  // Combined feeding
  totalFeedCount: number;

  // Diaper (clinical counting: `both` increments wetCount, poopyCount, AND bothCount)
  wetCount: number;
  poopyCount: number;
  bothCount: number;
  diaperEventCount: number;
  rashCount: number;

  // Spit-up
  spitUpCount: number;
  spitUpBySeverity: {
    small: number;
    medium: number;
    large: number;
    unspecified: number;
  };
  linkedSpitUpCount: number;
  standaloneSpitUpCount: number;

  // Vitamins
  vitaminCount: number;
  vitaminGiven: boolean;
}

export function createEmptyDailyStats(dateKey: string): DailyStats {
  return {
    dateKey,
    totalSleepSeconds: 0,
    napSleepSeconds: 0,
    nightSleepSeconds: 0,
    sleepSessionCount: 0,
    napCount: 0,
    nightCount: 0,
    breastLeftSeconds: 0,
    breastRightSeconds: 0,
    breastTotalSeconds: 0,
    breastFeedCount: 0,
    lastBreastSide: null,
    bottleTotalSeconds: 0,
    bottleFeedCount: 0,
    bottleTotalMl: 0,
    bottleMlByMilkType: {},
    totalFeedCount: 0,
    wetCount: 0,
    poopyCount: 0,
    bothCount: 0,
    diaperEventCount: 0,
    rashCount: 0,
    spitUpCount: 0,
    spitUpBySeverity: {
      small: 0,
      medium: 0,
      large: 0,
      unspecified: 0,
    },
    linkedSpitUpCount: 0,
    standaloneSpitUpCount: 0,
    vitaminCount: 0,
    vitaminGiven: false,
  };
}

function effectiveEventEndMs(event: TrackingEvent, nowMs: number): number {
  if (event.endedAt !== null) {
    return Date.parse(event.endedAt);
  }
  return Math.max(Date.parse(event.startedAt), nowMs);
}

function isActiveEvent(event: TrackingEvent): boolean {
  return event.deletedAt == null;
}

/**
 * Computes aggregated statistics for a single local calendar day (`dateKey`) in `timeZone`.
 * - Soft-deleted events (`deletedAt != null`) are excluded.
 * - Ongoing timers (`endedAt === null`) are clamped to `nowMs`.
 * - Sleep, bottle durations, and breast-feed segments are split across local midnight boundaries.
 */
export function computeDailyStats(
  events: readonly TrackingEvent[],
  dateKey: string,
  timeZone: string,
  nowMs: number = Date.now(),
): DailyStats {
  const stats = createEmptyDailyStats(dateKey);
  const { startMs: dayStartMs, endMs: dayEndMs } = localDayBounds(
    dateKey,
    timeZone,
  );

  // Sort chronologically so lastBreastSide reflects the latest event/segment
  const activeEvents = events
    .filter(isActiveEvent)
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  for (const event of activeEvents) {
    const startMs = Date.parse(event.startedAt);
    const endMs = effectiveEventEndMs(event, nowMs);
    const startDateKey = toLocalDateKey(startMs, timeZone);
    const startsOnDay = startDateKey === dateKey;

    switch (event.type) {
      case 'sleep': {
        const secs = overlapSeconds(startMs, endMs, dayStartMs, dayEndMs);
        if (secs > 0) {
          stats.totalSleepSeconds += secs;
          if (event.payload.category === 'nap') {
            stats.napSleepSeconds += secs;
          } else {
            stats.nightSleepSeconds += secs;
          }
        }
        if (startsOnDay) {
          stats.sleepSessionCount += 1;
          if (event.payload.category === 'nap') {
            stats.napCount += 1;
          } else {
            stats.nightCount += 1;
          }
        }
        break;
      }

      case 'breast_feed': {
        const { segments, pausedAt, totalLeftSeconds, totalRightSeconds } =
          event.payload;

        if (segments.length > 0) {
          for (const seg of segments) {
            const segStartMs = Date.parse(seg.startedAt);
            let segEndMs: number;
            if (seg.endedAt !== null) {
              segEndMs = Date.parse(seg.endedAt);
            } else if (event.endedAt !== null) {
              segEndMs = Date.parse(event.endedAt);
            } else if (pausedAt !== null) {
              segEndMs = Date.parse(pausedAt);
            } else {
              segEndMs = Math.max(segStartMs, nowMs);
            }

            const secs = overlapSeconds(segStartMs, segEndMs, dayStartMs, dayEndMs);
            if (secs > 0) {
              if (seg.side === 'left') {
                stats.breastLeftSeconds += secs;
              } else {
                stats.breastRightSeconds += secs;
              }
            }

            // Track last breast side if segment starts or overlaps this day
            if (
              secs > 0 ||
              toLocalDateKey(segStartMs, timeZone) === dateKey
            ) {
              stats.lastBreastSide = seg.side;
            }
          }
        } else if (startsOnDay) {
          // Fallback when segments is empty: attribute totals to startedAt day
          stats.breastLeftSeconds += totalLeftSeconds;
          stats.breastRightSeconds += totalRightSeconds;
          if (totalRightSeconds > 0 && totalLeftSeconds === 0) {
            stats.lastBreastSide = 'right';
          } else if (totalLeftSeconds > 0 && totalRightSeconds === 0) {
            stats.lastBreastSide = 'left';
          }
        }

        if (startsOnDay) {
          stats.breastFeedCount += 1;
        }
        break;
      }

      case 'bottle_feed': {
        const secs = overlapSeconds(startMs, endMs, dayStartMs, dayEndMs);
        if (secs > 0) {
          stats.bottleTotalSeconds += secs;
        }
        if (startsOnDay) {
          stats.bottleFeedCount += 1;
          const ml = event.payload.volumeMl ?? 0;
          stats.bottleTotalMl += ml;
          if (event.payload.milkType) {
            const prev = stats.bottleMlByMilkType[event.payload.milkType] ?? 0;
            stats.bottleMlByMilkType[event.payload.milkType] = prev + ml;
          }
        }
        break;
      }

      case 'diaper': {
        if (startsOnDay) {
          stats.diaperEventCount += 1;
          const { kind, hasRash } = event.payload;
          if (kind === 'wet') {
            stats.wetCount += 1;
          } else if (kind === 'poopy') {
            stats.poopyCount += 1;
          } else if (kind === 'both') {
            stats.wetCount += 1;
            stats.poopyCount += 1;
            stats.bothCount += 1;
          }
          if (hasRash === true) {
            stats.rashCount += 1;
          }
        }
        break;
      }

      case 'spit_up': {
        if (startsOnDay) {
          stats.spitUpCount += 1;
          const sev = event.payload.severity ?? 'unspecified';
          stats.spitUpBySeverity[sev] += 1;
          if (event.payload.relatedFeedId != null) {
            stats.linkedSpitUpCount += 1;
          } else {
            stats.standaloneSpitUpCount += 1;
          }
        }
        break;
      }

      case 'vitamin': {
        if (startsOnDay) {
          stats.vitaminCount += 1;
          stats.vitaminGiven = true;
        }
        break;
      }
    }
  }

  stats.breastTotalSeconds = stats.breastLeftSeconds + stats.breastRightSeconds;
  stats.totalFeedCount = stats.breastFeedCount + stats.bottleFeedCount;

  return stats;
}

/**
 * Computes zero-filled `DailyStats` for every local day in `[startDateKey, endDateKey]` inclusive.
 */
export function computeDateRangeStats(
  events: readonly TrackingEvent[],
  startDateKey: string,
  endDateKey: string,
  timeZone: string,
  nowMs: number = Date.now(),
): DailyStats[] {
  parseDateKey(startDateKey);
  parseDateKey(endDateKey);
  if (startDateKey > endDateKey) {
    return [];
  }

  const results: DailyStats[] = [];
  let current = startDateKey;
  while (current <= endDateKey) {
    results.push(computeDailyStats(events, current, timeZone, nowMs));
    current = addDays(current, 1);
  }
  return results;
}

export interface PeriodMetrics {
  totalSleepSeconds: number;
  napSleepSeconds: number;
  nightSleepSeconds: number;
  sleepSessionCount: number;
  breastLeftSeconds: number;
  breastRightSeconds: number;
  breastTotalSeconds: number;
  breastFeedCount: number;
  bottleTotalSeconds: number;
  bottleFeedCount: number;
  bottleTotalMl: number;
  totalFeedCount: number;
  wetCount: number;
  poopyCount: number;
  bothCount: number;
  diaperEventCount: number;
  rashCount: number;
  spitUpCount: number;
  vitaminDaysCount: number;
}

export interface PeriodAverages {
  days: number;
  totals: PeriodMetrics;
  averagesPerDay: PeriodMetrics;
}

function createEmptyMetrics(): PeriodMetrics {
  return {
    totalSleepSeconds: 0,
    napSleepSeconds: 0,
    nightSleepSeconds: 0,
    sleepSessionCount: 0,
    breastLeftSeconds: 0,
    breastRightSeconds: 0,
    breastTotalSeconds: 0,
    breastFeedCount: 0,
    bottleTotalSeconds: 0,
    bottleFeedCount: 0,
    bottleTotalMl: 0,
    totalFeedCount: 0,
    wetCount: 0,
    poopyCount: 0,
    bothCount: 0,
    diaperEventCount: 0,
    rashCount: 0,
    spitUpCount: 0,
    vitaminDaysCount: 0,
  };
}

/**
 * Computes totals and per-day averages across a list of `DailyStats` (e.g. 7, 14, or 30 days).
 */
export function computePeriodAverages(
  dailyStats: readonly DailyStats[],
): PeriodAverages {
  const days = dailyStats.length;
  const totals = createEmptyMetrics();

  for (const day of dailyStats) {
    totals.totalSleepSeconds += day.totalSleepSeconds;
    totals.napSleepSeconds += day.napSleepSeconds;
    totals.nightSleepSeconds += day.nightSleepSeconds;
    totals.sleepSessionCount += day.sleepSessionCount;
    totals.breastLeftSeconds += day.breastLeftSeconds;
    totals.breastRightSeconds += day.breastRightSeconds;
    totals.breastTotalSeconds += day.breastTotalSeconds;
    totals.breastFeedCount += day.breastFeedCount;
    totals.bottleTotalSeconds += day.bottleTotalSeconds;
    totals.bottleFeedCount += day.bottleFeedCount;
    totals.bottleTotalMl += day.bottleTotalMl;
    totals.totalFeedCount += day.totalFeedCount;
    totals.wetCount += day.wetCount;
    totals.poopyCount += day.poopyCount;
    totals.bothCount += day.bothCount;
    totals.diaperEventCount += day.diaperEventCount;
    totals.rashCount += day.rashCount;
    totals.spitUpCount += day.spitUpCount;
    if (day.vitaminGiven) {
      totals.vitaminDaysCount += 1;
    }
  }

  const divisor = days > 0 ? days : 1;
  const averagesPerDay: PeriodMetrics = {
    totalSleepSeconds: totals.totalSleepSeconds / divisor,
    napSleepSeconds: totals.napSleepSeconds / divisor,
    nightSleepSeconds: totals.nightSleepSeconds / divisor,
    sleepSessionCount: totals.sleepSessionCount / divisor,
    breastLeftSeconds: totals.breastLeftSeconds / divisor,
    breastRightSeconds: totals.breastRightSeconds / divisor,
    breastTotalSeconds: totals.breastTotalSeconds / divisor,
    breastFeedCount: totals.breastFeedCount / divisor,
    bottleTotalSeconds: totals.bottleTotalSeconds / divisor,
    bottleFeedCount: totals.bottleFeedCount / divisor,
    bottleTotalMl: totals.bottleTotalMl / divisor,
    totalFeedCount: totals.totalFeedCount / divisor,
    wetCount: totals.wetCount / divisor,
    poopyCount: totals.poopyCount / divisor,
    bothCount: totals.bothCount / divisor,
    diaperEventCount: totals.diaperEventCount / divisor,
    rashCount: totals.rashCount / divisor,
    spitUpCount: totals.spitUpCount / divisor,
    vitaminDaysCount: totals.vitaminDaysCount / divisor,
  };

  return { days, totals, averagesPerDay };
}

// ============================================================================
// Last Activity Summary & Local-Day Event Filtering
// ============================================================================

export interface LastTimedActivity<T extends TrackingEvent = TrackingEvent> {
  event: T;
  startedAt: string;
  endedAt: string | null;
  isOngoing: boolean;
  secondsSinceStart: number;
  secondsSinceEnd: number;
}

export interface LastBreastFeedSummary extends LastTimedActivity<BreastFeedEvent> {
  lastSide: BreastSide | null;
  durationSeconds: number;
}

export interface LastBottleFeedSummary extends LastTimedActivity<BottleFeedEvent> {
  volumeMl: number | null;
}

export interface LastSleepSummary extends LastTimedActivity<SleepEvent> {
  category: SleepCategory;
}

export interface LastDiaperSummary {
  event: DiaperEvent;
  startedAt: string;
  kind: DiaperKind;
  secondsSinceStart: number;
}

export interface LastSpitUpSummary {
  event: SpitUpEvent;
  startedAt: string;
  severity: SpitUpSeverity | null;
  secondsSinceStart: number;
}

export interface LastVitaminSummary {
  event: VitaminEvent;
  startedAt: string;
  secondsSinceStart: number;
}

export interface LastActivitySummary {
  lastFeed:
    | (LastTimedActivity<BreastFeedEvent | BottleFeedEvent> & {
        feedType: 'breast_feed' | 'bottle_feed';
      })
    | null;
  lastBreastFeed: LastBreastFeedSummary | null;
  lastBottleFeed: LastBottleFeedSummary | null;
  lastSleep: LastSleepSummary | null;
  lastDiaper: LastDiaperSummary | null;
  lastSpitUp: LastSpitUpSummary | null;
  lastVitamin: LastVitaminSummary | null;
}

function buildTimedActivity<T extends TrackingEvent>(
  event: T,
  nowMs: number,
): LastTimedActivity<T> {
  const startMs = Date.parse(event.startedAt);
  const isOngoing = event.endedAt === null;
  const endMs = isOngoing ? nowMs : Date.parse(event.endedAt!);
  return {
    event,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    isOngoing,
    secondsSinceStart: Math.max(0, (nowMs - startMs) / 1000),
    secondsSinceEnd: isOngoing ? 0 : Math.max(0, (nowMs - endMs) / 1000),
  };
}

function getLastSideFromBreastEvent(event: BreastFeedEvent): BreastSide | null {
  const { segments, totalLeftSeconds, totalRightSeconds } = event.payload;
  if (segments.length > 0) {
    return segments[segments.length - 1]!.side;
  }
  if (totalRightSeconds > 0 && totalLeftSeconds === 0) return 'right';
  if (totalLeftSeconds > 0 && totalRightSeconds === 0) return 'left';
  return null;
}

function getDurationSecondsFromBreastEvent(event: BreastFeedEvent): number {
  const { segments, totalLeftSeconds, totalRightSeconds } = event.payload;
  const total = Math.max(0, totalLeftSeconds + totalRightSeconds);
  if (total > 0 || segments.length === 0) {
    return total;
  }
  let closedSum = 0;
  for (const seg of segments) {
    if (seg.endedAt !== null) {
      closedSum += Math.max(
        0,
        (Date.parse(seg.endedAt) - Date.parse(seg.startedAt)) / 1000,
      );
    }
  }
  return closedSum;
}

/**
 * Computes the most recent activity per category (ignoring soft-deleted events).
 */
export function computeLastActivitySummary(
  events: readonly TrackingEvent[],
  nowMs: number = Date.now(),
): LastActivitySummary {
  // Sort descending by startedAt (most recent first)
  const sorted = events
    .filter(isActiveEvent)
    .slice()
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  let lastBreastFeed: LastBreastFeedSummary | null = null;
  let lastBottleFeed: LastBottleFeedSummary | null = null;
  let lastSleep: LastSleepSummary | null = null;
  let lastDiaper: LastDiaperSummary | null = null;
  let lastSpitUp: LastSpitUpSummary | null = null;
  let lastVitamin: LastVitaminSummary | null = null;
  let lastFeed: LastActivitySummary['lastFeed'] = null;

  for (const event of sorted) {
    if (event.type === 'breast_feed') {
      if (!lastBreastFeed) {
        lastBreastFeed = {
          ...buildTimedActivity(event, nowMs),
          lastSide: getLastSideFromBreastEvent(event),
          durationSeconds: getDurationSecondsFromBreastEvent(event),
        };
      }
      if (!lastFeed) {
        lastFeed = {
          ...buildTimedActivity(event, nowMs),
          feedType: 'breast_feed',
        };
      }
    } else if (event.type === 'bottle_feed') {
      if (!lastBottleFeed) {
        lastBottleFeed = {
          ...buildTimedActivity(event, nowMs),
          volumeMl: event.payload.volumeMl,
        };
      }
      if (!lastFeed) {
        lastFeed = {
          ...buildTimedActivity(event, nowMs),
          feedType: 'bottle_feed',
        };
      }
    } else if (event.type === 'sleep' && !lastSleep) {
      lastSleep = {
        ...buildTimedActivity(event, nowMs),
        category: event.payload.category,
      };
    } else if (event.type === 'diaper' && !lastDiaper) {
      lastDiaper = {
        event,
        startedAt: event.startedAt,
        kind: event.payload.kind,
        secondsSinceStart: Math.max(0, (nowMs - Date.parse(event.startedAt)) / 1000),
      };
    } else if (event.type === 'spit_up' && !lastSpitUp) {
      lastSpitUp = {
        event,
        startedAt: event.startedAt,
        severity: event.payload.severity ?? null,
        secondsSinceStart: Math.max(0, (nowMs - Date.parse(event.startedAt)) / 1000),
      };
    } else if (event.type === 'vitamin' && !lastVitamin) {
      lastVitamin = {
        event,
        startedAt: event.startedAt,
        secondsSinceStart: Math.max(0, (nowMs - Date.parse(event.startedAt)) / 1000),
      };
    }

    if (
      lastFeed &&
      lastBreastFeed &&
      lastBottleFeed &&
      lastSleep &&
      lastDiaper &&
      lastSpitUp &&
      lastVitamin
    ) {
      break;
    }
  }

  return {
    lastFeed,
    lastBreastFeed,
    lastBottleFeed,
    lastSleep,
    lastDiaper,
    lastSpitUp,
    lastVitamin,
  };
}

/**
 * Returns all non-deleted events that start on or overlap the local day `dateKey`
 * in `timeZone`, sorted chronologically by `startedAt` ascending.
 */
export function getEventsForLocalDay(
  events: readonly TrackingEvent[],
  dateKey: string,
  timeZone: string,
  nowMs: number = Date.now(),
): TrackingEvent[] {
  const { startMs: dayStartMs, endMs: dayEndMs } = localDayBounds(
    dateKey,
    timeZone,
  );

  return events
    .filter((event) => {
      if (!isActiveEvent(event)) return false;
      const startMs = Date.parse(event.startedAt);
      if (toLocalDateKey(startMs, timeZone) === dateKey) return true;
      const endMs = effectiveEventEndMs(event, nowMs);
      return endMs > dayStartMs && startMs < dayEndMs;
    })
    .slice()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
