import {
  addDays,
  mlToOz,
  ozToMl,
  toLocalDateKey,
  type BreastFeedSegment,
  type DailyStats,
} from '@baby-tracker/shared';

export type VolumeUnit = 'ml' | 'oz';
export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'baby-tracker-theme';
export const VOLUME_UNIT_STORAGE_KEY = 'baby-tracker-volume-unit';
export const ACTIVE_BABY_STORAGE_KEY = 'baby-tracker-active-baby-id';

export function getLocalTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function getTodayDateKey(
  timeZone: string = getLocalTimeZone(),
  nowMs: number = Date.now(),
): string {
  return toLocalDateKey(nowMs, timeZone);
}

export function getYesterdayDateKey(
  timeZone: string = getLocalTimeZone(),
  nowMs: number = Date.now(),
): string {
  return addDays(getTodayDateKey(timeZone, nowMs), -1);
}

/**
 * Formats seconds as `MM:SS` when < 1 hour, or `H:MM:SS` when >= 1 hour.
 */
export function formatClock(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Formats seconds into a compact human duration such as `1h 23m`, `45m`, or `<1m`.
 */
export function formatDurationShort(
  totalSeconds: number,
  locale: string = 'en-US',
): string {
  const isZh = locale.toLowerCase().startsWith('zh');
  const clamped = Math.max(0, Math.round(totalSeconds));
  if (clamped < 60) {
    if (isZh) {
      return clamped === 0 ? '0分钟' : '<1分钟';
    }
    return clamped === 0 ? '0m' : '<1m';
  }
  const totalMinutes = Math.round(clamped / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (isZh) {
    if (hours === 0) {
      return `${minutes}分钟`;
    }
    if (minutes === 0) {
      return `${hours}小时`;
    }
    return `${hours}小时${minutes}分钟`;
  }
  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

/**
 * Formats elapsed seconds since an activity as `just now`, `12m ago`, `2h 15m ago`, or `1d 3h ago`.
 */
export function formatTimeAgo(
  seconds: number,
  locale: string = 'en-US',
): string {
  const isZh = locale.toLowerCase().startsWith('zh');
  const clamped = Math.max(0, Math.floor(seconds));
  if (clamped < 60) {
    return isZh ? '刚刚' : 'just now';
  }
  const totalMinutes = Math.floor(clamped / 60);
  if (totalMinutes < 60) {
    return isZh ? `${totalMinutes}分钟前` : `${totalMinutes}m ago`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    if (isZh) {
      return minutes > 0
        ? `${hours}小时${minutes}分钟前`
        : `${hours}小时前`;
    }
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (isZh) {
    return remHours > 0 ? `${days}天${remHours}小时前` : `${days}天前`;
  }
  return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

/**
 * Formats an ISO timestamp into a local time string like `2:35 PM` in `timeZone`.
 */
export function formatLocalTime(
  iso: string,
  timeZone: string = getLocalTimeZone(),
  locale: string = 'en-US',
): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat(locale || undefined, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

/**
 * Converts an ISO timestamp into a `YYYY-MM-DDTHH:mm` string in the local runtime timezone
 * for `<input type="datetime-local">`.
 */
export function toLocalDateTimeInputValue(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

/**
 * Parses a `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`) into an ISO-8601 UTC string.
 */
export function fromLocalDateTimeInputValue(localStr: string): string {
  const trimmed = localStr.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(trimmed);
  if (match) {
    const dt = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0,
    );
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString();
    }
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new RangeError(`Invalid local datetime value: "${localStr}"`);
  }
  return new Date(parsed).toISOString();
}

/**
 * Formats a volume in ml for display in either `ml` or `oz`.
 */
export function formatVolume(
  volumeMl: number | null | undefined,
  unit: VolumeUnit,
  locale: string = 'en-US',
): string {
  if (volumeMl === null || volumeMl === undefined) {
    return '—';
  }
  const isZh = locale.toLowerCase().startsWith('zh');
  if (unit === 'oz') {
    const val = mlToOz(volumeMl).toFixed(1);
    return isZh ? `${val} 盎司` : `${val} oz`;
  }
  const ml = Math.round(volumeMl);
  return isZh ? `${ml} 毫升` : `${ml} ml`;
}

/**
 * Formats a numeric volume in ml into an input string in `unit` (`ml` or `oz`).
 * Preserves `0` as `"0"`.
 */
export function volumeMlToInputString(
  volumeMl: number | null | undefined,
  unit: VolumeUnit,
): string {
  if (volumeMl === null || volumeMl === undefined) {
    return '';
  }
  if (unit === 'oz') {
    const oz = mlToOz(volumeMl);
    return volumeMl === 0 ? '0' : oz.toFixed(1);
  }
  return String(Math.round(volumeMl));
}

/**
 * Parses a user-entered volume string in `unit` (`ml` or `oz`) to `ml`.
 * Returns `null` if blank, and `0` if `"0"`.
 */
export function parseVolumeInputToMl(
  raw: string,
  unit: VolumeUnit,
): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  if (num === 0) return 0;
  return unit === 'oz' ? Math.round(ozToMl(num) * 10) / 10 : Math.round(num);
}

/**
 * Extracts an invite code from `/join/<code>` pathname, `?join=<code>` query param,
 * or a raw invite code/URL pasted by the user.
 */
export function extractInviteCodeFromLocation(
  pathname: string,
  search: string = '',
): string | null {
  const pathMatch = /\/join\/([A-Za-z0-9_-]{4,64})\/?$/i.exec(pathname.trim());
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1];
  }
  if (search) {
    const queryStr = search.startsWith('?') ? search.slice(1) : search;
    const params = new URLSearchParams(queryStr);
    const joinParam = params.get('join')?.trim();
    if (joinParam && joinParam.length >= 4 && joinParam.length <= 64) {
      return joinParam;
    }
  }
  return null;
}

/**
 * Parses a pasted invite code or full `/join/<code>` URL into the raw invite code.
 */
export function parseInviteInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed);
      return extractInviteCodeFromLocation(url.pathname, url.search) ?? trimmed;
    }
  } catch {
    // fall through
  }
  const extracted = extractInviteCodeFromLocation(trimmed, '');
  return extracted ?? trimmed;
}

export function resolveThemeIsDark(
  theme: ThemePreference,
  prefersDark: boolean,
): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return prefersDark;
}

export function computeBabyAgeLabel(
  dob: string,
  refDateKey: string = getTodayDateKey(),
  locale: string = 'en-US',
): string {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ry, rm, rd] = refDateKey.split('-').map(Number);
  if (!by || !bm || !bd || !ry || !rm || !rd) return '';
  const birthMs = Date.UTC(by, bm - 1, bd);
  const refMs = Date.UTC(ry, rm - 1, rd);
  const totalDays = Math.max(0, Math.floor((refMs - birthMs) / 86_400_000));
  const isZh = locale.toLowerCase().startsWith('zh');
  if (totalDays < 14) {
    return isZh ? `${totalDays}天` : `${totalDays}d old`;
  }
  if (totalDays < 60) {
    const weeks = Math.floor(totalDays / 7);
    const rem = totalDays % 7;
    if (isZh) {
      return rem > 0 ? `${weeks}周${rem}天` : `${weeks}周`;
    }
    return rem > 0 ? `${weeks}w ${rem}d old` : `${weeks}w old`;
  }
  const months = Math.max(2, Math.floor(totalDays / 30.4375));
  return isZh ? `${months}个月` : `${months}mo old`;
}

/**
 * Builds valid `BreastFeedSegment[]` and `endedAt` for manual breast feed logging/editing.
 */
export function buildManualBreastFeedSegments(
  startedAtIso: string,
  leftMinutes: number,
  rightMinutes: number,
): {
  segments: BreastFeedSegment[];
  endedAt: string;
  totalLeftSeconds: number;
  totalRightSeconds: number;
} {
  const startMs = Date.parse(startedAtIso);
  const safeLeftSec = Math.max(0, Math.round(leftMinutes * 60));
  const safeRightSec = Math.max(0, Math.round(rightMinutes * 60));
  const segments: BreastFeedSegment[] = [];
  let cursorMs = startMs;

  if (safeLeftSec > 0) {
    const endMs = cursorMs + safeLeftSec * 1000;
    segments.push({
      side: 'left',
      startedAt: new Date(cursorMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
    });
    cursorMs = endMs;
  }

  if (safeRightSec > 0) {
    const endMs = cursorMs + safeRightSec * 1000;
    segments.push({
      side: 'right',
      startedAt: new Date(cursorMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
    });
    cursorMs = endMs;
  }

  return {
    segments,
    endedAt: new Date(cursorMs).toISOString(),
    totalLeftSeconds: safeLeftSec,
    totalRightSeconds: safeRightSec,
  };
}

export interface TrendDayPoint {
  dateKey: string;
  shortLabel: string;
  napHours: number;
  nightHours: number;
  totalSleepHours: number;
  breastFeedCount: number;
  bottleFeedCount: number;
  bottleVolume: number;
  wetDiapers: number;
  poopyDiapers: number;
}

export function buildTrendSeries(
  dailyStats: readonly DailyStats[],
  unit: VolumeUnit = 'ml',
  locale: string = 'en-US',
): TrendDayPoint[] {
  const isZh = locale.toLowerCase().startsWith('zh');
  return dailyStats.map((day) => {
    const parts = day.dateKey.split('-');
    const shortLabel =
      parts.length === 3
        ? isZh
          ? `${Number(parts[1])}月${Number(parts[2])}日`
          : `${Number(parts[1])}/${Number(parts[2])}`
        : day.dateKey;
    return {
      dateKey: day.dateKey,
      shortLabel,
      napHours: Math.round((day.napSleepSeconds / 3600) * 10) / 10,
      nightHours: Math.round((day.nightSleepSeconds / 3600) * 10) / 10,
      totalSleepHours: Math.round((day.totalSleepSeconds / 3600) * 10) / 10,
      breastFeedCount: day.breastFeedCount,
      bottleFeedCount: day.bottleFeedCount,
      bottleVolume:
        unit === 'oz'
          ? Math.round(mlToOz(day.bottleTotalMl) * 10) / 10
          : Math.round(day.bottleTotalMl),
      wetDiapers: day.wetCount,
      poopyDiapers: day.poopyCount,
    };
  });
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
