import { describe, expect, it } from 'vitest';
import { createEmptyDailyStats } from '@baby-tracker/shared';
import {
  buildManualBreastFeedSegments,
  buildTrendSeries,
  computeBabyAgeLabel,
  computeDurationMinutes,
  extractInviteCodeFromLocation,
  formatClock,
  formatDurationShort,
  formatTimeAgo,
  formatVolume,
  fromLocalDateTimeInputValue,
  parseDurationMinutesInput,
  parseInviteInput,
  parseVolumeInputToMl,
  resolveThemeIsDark,
  subtractMinutesFromLocalDateTime,
  toLocalDateTimeInputValue,
  volumeMlToInputString,
} from './uiUtils.js';

describe('uiUtils', () => {
  it('formats clock durations for sub-hour and multi-hour timers', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3661)).toBe('1:01:01');
    expect(formatClock(-10)).toBe('00:00');
  });

  it('formats compact durations and time-ago strings', () => {
    expect(formatDurationShort(0)).toBe('0m');
    expect(formatDurationShort(25)).toBe('<1m');
    expect(formatDurationShort(900)).toBe('15m');
    expect(formatDurationShort(3600)).toBe('1h');
    expect(formatDurationShort(5400)).toBe('1h 30m');

    expect(formatTimeAgo(15)).toBe('just now');
    expect(formatTimeAgo(600)).toBe('10m ago');
    expect(formatTimeAgo(7200)).toBe('2h ago');
    expect(formatTimeAgo(9000)).toBe('2h 30m ago');
    expect(formatTimeAgo(93600)).toBe('1d 2h ago');
  });

  it('converts local datetime-local input strings round-trip', () => {
    const localInput = '2026-05-10T14:35';
    const iso = fromLocalDateTimeInputValue(localInput);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(toLocalDateTimeInputValue(iso)).toBe(localInput);
  });

  it('handles volume conversion and preserves 0 ml', () => {
    expect(formatVolume(null, 'ml')).toBe('—');
    expect(formatVolume(0, 'ml')).toBe('0 ml');
    expect(formatVolume(120, 'ml')).toBe('120 ml');
    expect(formatVolume(60, 'oz')).toBe('2.0 oz');

    expect(volumeMlToInputString(0, 'ml')).toBe('0');
    expect(volumeMlToInputString(0, 'oz')).toBe('0');
    expect(volumeMlToInputString(null, 'ml')).toBe('');

    expect(parseVolumeInputToMl('0', 'ml')).toBe(0);
    expect(parseVolumeInputToMl('0', 'oz')).toBe(0);
    expect(parseVolumeInputToMl('', 'ml')).toBeNull();
    expect(parseVolumeInputToMl('120', 'ml')).toBe(120);
    expect(parseVolumeInputToMl('4', 'oz')).toBeCloseTo(118.3, 1);
  });

  it('extracts invite codes from /join/<code> paths, query params, and pasted URLs', () => {
    expect(extractInviteCodeFromLocation('/join/abc123XYZ', '')).toBe('abc123XYZ');
    expect(extractInviteCodeFromLocation('/join/code-99/', '')).toBe('code-99');
    expect(extractInviteCodeFromLocation('/', '?join=mycode42')).toBe('mycode42');
    expect(extractInviteCodeFromLocation('/', '')).toBeNull();

    expect(parseInviteInput('https://tracker.example.com/join/share77')).toBe('share77');
    expect(parseInviteInput('share77')).toBe('share77');
  });

  it('resolves theme preference against system preference', () => {
    expect(resolveThemeIsDark('dark', false)).toBe(true);
    expect(resolveThemeIsDark('light', true)).toBe(false);
    expect(resolveThemeIsDark('system', true)).toBe(true);
    expect(resolveThemeIsDark('system', false)).toBe(false);
  });

  it('computes baby age labels and manual breast feed segments', () => {
    expect(computeBabyAgeLabel('2026-05-01', '2026-05-10')).toBe('9d old');
    expect(computeBabyAgeLabel('2026-04-01', '2026-04-20')).toBe('2w 5d old');
    expect(computeBabyAgeLabel('2026-01-01', '2026-04-05')).toBe('3mo old');

    const manual = buildManualBreastFeedSegments('2026-05-10T12:00:00.000Z', 10, 5);
    expect(manual.totalLeftSeconds).toBe(600);
    expect(manual.totalRightSeconds).toBe(300);
    expect(manual.segments).toHaveLength(2);
    expect(manual.endedAt).toBe('2026-05-10T12:15:00.000Z');
  });

  it('builds trend series from daily stats in ml or oz', () => {
    const day = createEmptyDailyStats('2026-05-10');
    day.napSleepSeconds = 3600;
    day.nightSleepSeconds = 28800;
    day.totalSleepSeconds = 32400;
    day.breastFeedCount = 5;
    day.bottleFeedCount = 2;
    day.bottleTotalMl = 240;
    day.wetCount = 6;
    day.poopyCount = 3;
    day.pumpingCount = 2;
    day.pumpingTotalMl = 180;
    day.tummyTimeCount = 3;
    day.tummyTimeTotalSeconds = 900;

    const mlSeries = buildTrendSeries([day], 'ml');
    expect(mlSeries[0]).toEqual({
      dateKey: '2026-05-10',
      shortLabel: '5/10',
      napHours: 1,
      nightHours: 8,
      totalSleepHours: 9,
      breastFeedCount: 5,
      bottleFeedCount: 2,
      bottleVolume: 240,
      wetDiapers: 6,
      poopyDiapers: 3,
      pumpingVolume: 180,
      pumpingCount: 2,
      tummyTimeMinutes: 15,
      tummyTimeCount: 3,
    });

    const ozSeries = buildTrendSeries([day], 'oz');
    expect(ozSeries[0]?.bottleVolume).toBeCloseTo(8.1, 1);
    expect(ozSeries[0]?.pumpingVolume).toBeCloseTo(6.1, 1);
  });

  it('computes duration minutes between local datetime-local values', () => {
    expect(computeDurationMinutes('2026-05-10T14:00', '2026-05-10T14:12')).toBe(12);
    expect(computeDurationMinutes('2026-05-10T14:00', '2026-05-10T14:45')).toBe(45);
    expect(computeDurationMinutes('2026-05-10T14:00', '2026-05-10T16:05')).toBe(125);
    expect(computeDurationMinutes('2026-05-10T14:00', '2026-05-10T14:00')).toBe(0);
    // Across midnight
    expect(computeDurationMinutes('2026-05-09T23:53', '2026-05-10T00:05')).toBe(12);
    // End before start -> null
    expect(computeDurationMinutes('2026-05-10T14:15', '2026-05-10T14:00')).toBeNull();
    // Invalid / empty strings -> null
    expect(computeDurationMinutes('', '2026-05-10T14:00')).toBeNull();
    expect(computeDurationMinutes('2026-05-10T14:00', '')).toBeNull();
    expect(computeDurationMinutes('not-a-date', '2026-05-10T14:00')).toBeNull();
    expect(computeDurationMinutes('2026-05-10T14:00', 'invalid')).toBeNull();
  });

  it('parses duration minute inputs with validation and overflow guards', () => {
    expect(parseDurationMinutesInput('0')).toBe(0);
    expect(parseDurationMinutesInput('12')).toBe(12);
    expect(parseDurationMinutesInput(' 45 ')).toBe(45);
    expect(parseDurationMinutesInput('12.4')).toBe(12);
    expect(parseDurationMinutesInput('')).toBeNull();
    expect(parseDurationMinutesInput('   ')).toBeNull();
    expect(parseDurationMinutesInput('-5')).toBeNull();
    expect(parseDurationMinutesInput('abc')).toBeNull();
    expect(parseDurationMinutesInput('NaN')).toBeNull();
    expect(parseDurationMinutesInput('Infinity')).toBeNull();
    expect(parseDurationMinutesInput('1e20')).toBeNull();
  });

  it('subtracts minutes from local datetime values across midnight, month, and year rollovers', () => {
    expect(subtractMinutesFromLocalDateTime('2026-05-10T14:12', 12)).toBe(
      '2026-05-10T14:00',
    );
    expect(subtractMinutesFromLocalDateTime('2026-05-10T14:12', 0)).toBe(
      '2026-05-10T14:12',
    );
    // Midnight rollover
    expect(subtractMinutesFromLocalDateTime('2026-05-10T00:05', 12)).toBe(
      '2026-05-09T23:53',
    );
    // Month rollover
    expect(subtractMinutesFromLocalDateTime('2026-03-01T00:10', 20)).toBe(
      '2026-02-28T23:50',
    );
    // Year rollover
    expect(subtractMinutesFromLocalDateTime('2026-01-01T00:05', 12)).toBe(
      '2025-12-31T23:53',
    );
    // Invalid / negative / overflowing inputs -> null
    expect(subtractMinutesFromLocalDateTime('2026-05-10T14:12', -1)).toBeNull();
    expect(subtractMinutesFromLocalDateTime('2026-05-10T14:12', Number.NaN)).toBeNull();
    expect(
      subtractMinutesFromLocalDateTime('2026-05-10T14:12', Number.POSITIVE_INFINITY),
    ).toBeNull();
    expect(subtractMinutesFromLocalDateTime('2026-05-10T14:12', 1e15)).toBeNull();
    expect(subtractMinutesFromLocalDateTime('', 12)).toBeNull();
    expect(subtractMinutesFromLocalDateTime('invalid', 12)).toBeNull();

    // Round-trip consistency
    const end = '2026-05-10T00:05';
    const start = subtractMinutesFromLocalDateTime(end, 37);
    expect(start).toBe('2026-05-09T23:28');
    expect(computeDurationMinutes(start!, end)).toBe(37);
  });
});
