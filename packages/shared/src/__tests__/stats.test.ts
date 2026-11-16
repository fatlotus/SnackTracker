import { describe, expect, it } from 'vitest';
import type { TrackingEvent } from '../schemas.js';
import {
  addDays,
  computeDailyStats,
  computeDateRangeStats,
  computeLastActivitySummary,
  computePeriodAverages,
  getEventsForLocalDay,
  localDayBounds,
  mlToOz,
  ozToMl,
  toLocalDateKey,
} from '../stats.js';

const BABY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
let seq = 1;

function nextId(): string {
  const n = String(seq++).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
}

function makeBase(startedAt: string, endedAt: string | null = startedAt) {
  return {
    id: nextId(),
    babyId: BABY_ID,
    startedAt,
    endedAt,
    notes: null,
    loggedByUserId: USER_ID,
    loggedByName: 'Alex',
    updatedByUserId: USER_ID,
    createdAt: startedAt,
    updatedAt: endedAt ?? startedAt,
    deletedAt: null,
    serverSeq: 0,
  };
}

describe('DST-safe timezone helpers', () => {
  const tz = 'America/New_York';

  it('computes local date keys and addDays accurately', () => {
    expect(toLocalDateKey('2026-03-08T04:30:00.000Z', tz)).toBe('2026-03-07');
    expect(toLocalDateKey('2026-03-08T05:30:00.000Z', tz)).toBe('2026-03-08');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('handles DST spring-forward (23h day) and fall-back (25h day)', () => {
    // 2026-03-08 is spring-forward in America/New_York (EST -> EDT at 02:00)
    const springBounds = localDayBounds('2026-03-08', tz);
    expect(springBounds.endMs - springBounds.startMs).toBe(23 * 3600 * 1000);

    // 2026-11-01 is fall-back in America/New_York (EDT -> EST at 02:00)
    const fallBounds = localDayBounds('2026-11-01', tz);
    expect(fallBounds.endMs - fallBounds.startMs).toBe(25 * 3600 * 1000);

    // Standard day is 24h
    const normalBounds = localDayBounds('2026-06-15', tz);
    expect(normalBounds.endMs - normalBounds.startMs).toBe(24 * 3600 * 1000);
  });

  it('converts ml <-> oz accurately', () => {
    const ml = 120;
    const oz = mlToOz(ml);
    expect(oz).toBeCloseTo(4.05768, 4);
    expect(ozToMl(oz)).toBeCloseTo(120, 6);
  });

  it('throws RangeError on invalid dateKey in addDays and computeDateRangeStats', () => {
    expect(() => addDays('not-a-date', 1)).toThrow(RangeError);
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() =>
      computeDateRangeStats([], 'not-a-date', '2026-06-02', tz),
    ).toThrow(RangeError);
    expect(() =>
      computeDateRangeStats([], '2026-06-01', '2026-02-30', tz),
    ).toThrow(RangeError);
  });
});

describe('computeDailyStats & midnight splits', () => {
  const tz = 'America/New_York'; // EDT (-04:00) in June

  it('splits multi-day sleep across local midnight boundaries', () => {
    // Starts 2026-06-01 22:00 EDT (2026-06-02T02:00:00Z)
    // Ends   2026-06-03 06:00 EDT (2026-06-03T10:00:00Z) -> 32 hours total:
    // June 1: 2h (7200s), June 2: 24h (86400s), June 3: 6h (21600s)
    const sleep: TrackingEvent = {
      ...makeBase('2026-06-02T02:00:00.000Z', '2026-06-03T10:00:00.000Z'),
      type: 'sleep',
      payload: { category: 'night', location: 'crib' },
    };

    const d1 = computeDailyStats([sleep], '2026-06-01', tz);
    const d2 = computeDailyStats([sleep], '2026-06-02', tz);
    const d3 = computeDailyStats([sleep], '2026-06-03', tz);

    expect(d1.nightSleepSeconds).toBe(7200);
    expect(d1.totalSleepSeconds).toBe(7200);
    expect(d1.sleepSessionCount).toBe(1);
    expect(d1.nightCount).toBe(1);

    expect(d2.nightSleepSeconds).toBe(86400);
    expect(d2.totalSleepSeconds).toBe(86400);
    expect(d2.sleepSessionCount).toBe(0);

    expect(d3.nightSleepSeconds).toBe(21600);
    expect(d3.totalSleepSeconds).toBe(21600);
    expect(d3.sleepSessionCount).toBe(0);
  });

  it('splits sleep accurately across DST spring-forward and fall-back nights', () => {
    // Spring-forward: 2026-03-08 00:00 EST (05:00Z) to 2026-03-09 00:00 EDT (04:00Z) -> 23h
    const springSleep: TrackingEvent = {
      ...makeBase('2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'),
      type: 'sleep',
      payload: { category: 'night' },
    };
    const springStats = computeDailyStats([springSleep], '2026-03-08', tz);
    expect(springStats.totalSleepSeconds).toBe(23 * 3600);

    // Fall-back: 2026-11-01 00:00 EDT (04:00Z) to 2026-11-02 00:00 EST (05:00Z) -> 25h
    const fallSleep: TrackingEvent = {
      ...makeBase('2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'),
      type: 'sleep',
      payload: { category: 'night' },
    };
    const fallStats = computeDailyStats([fallSleep], '2026-11-01', tz);
    expect(fallStats.totalSleepSeconds).toBe(25 * 3600);
  });

  it('clamps ongoing timers (endedAt: null) to nowMs and excludes soft-deleted events', () => {
    const ongoingNap: TrackingEvent = {
      ...makeBase('2026-06-10T14:00:00.000Z', null), // 10:00 EDT
      type: 'sleep',
      payload: { category: 'nap' },
    };
    const deletedNap: TrackingEvent = {
      ...makeBase('2026-06-10T15:00:00.000Z', '2026-06-10T16:00:00.000Z'),
      type: 'sleep',
      deletedAt: '2026-06-10T16:05:00.000Z',
      payload: { category: 'nap' },
    };
    const nowMs = Date.parse('2026-06-10T14:45:00.000Z'); // 45 mins later

    const stats = computeDailyStats([ongoingNap, deletedNap], '2026-06-10', tz, nowMs);
    expect(stats.napSleepSeconds).toBe(45 * 60);
    expect(stats.sleepSessionCount).toBe(1);
    expect(stats.napCount).toBe(1);
  });

  it('splits breast_feed segments across midnight and falls back when segments empty', () => {
    // 2026-06-01 23:50 EDT = 2026-06-02T03:50:00Z
    // Left: 23:50 - 00:05 EDT (10m on June 1, 5m on June 2)
    // Right: 00:05 - 00:15 EDT (10m on June 2)
    const bfSplit: TrackingEvent = {
      ...makeBase('2026-06-02T03:50:00.000Z', '2026-06-02T04:15:00.000Z'),
      type: 'breast_feed',
      payload: {
        segments: [
          {
            side: 'left',
            startedAt: '2026-06-02T03:50:00.000Z',
            endedAt: '2026-06-02T04:05:00.000Z',
          },
          {
            side: 'right',
            startedAt: '2026-06-02T04:05:00.000Z',
            endedAt: '2026-06-02T04:15:00.000Z',
          },
        ],
        pausedAt: null,
        totalLeftSeconds: 900,
        totalRightSeconds: 600,
      },
    };

    // Empty segments fallback on June 2
    const bfFallback: TrackingEvent = {
      ...makeBase('2026-06-02T14:00:00.000Z', '2026-06-02T14:20:00.000Z'),
      type: 'breast_feed',
      payload: {
        segments: [],
        pausedAt: null,
        totalLeftSeconds: 400,
        totalRightSeconds: 500,
      },
    };

    const june1 = computeDailyStats([bfSplit, bfFallback], '2026-06-01', tz);
    expect(june1.breastLeftSeconds).toBe(600);
    expect(june1.breastRightSeconds).toBe(0);
    expect(june1.breastFeedCount).toBe(1);
    expect(june1.lastBreastSide).toBe('left');

    const june2 = computeDailyStats([bfSplit, bfFallback], '2026-06-02', tz);
    expect(june2.breastLeftSeconds).toBe(300 + 400);
    expect(june2.breastRightSeconds).toBe(600 + 500);
    expect(june2.breastTotalSeconds).toBe(1800);
    expect(june2.breastFeedCount).toBe(1);
    expect(june2.lastBreastSide).toBe('right');
  });

  it('handles bottle_feed (including 0 ml and null ml), clinical diaper counting, and spit_up', () => {
    const events: TrackingEvent[] = [
      {
        ...makeBase('2026-06-10T12:00:00.000Z', '2026-06-10T12:15:00.000Z'),
        type: 'bottle_feed',
        payload: { volumeMl: 90, milkType: 'breastmilk' },
      },
      {
        ...makeBase('2026-06-10T15:00:00.000Z', '2026-06-10T15:05:00.000Z'),
        type: 'bottle_feed',
        payload: { volumeMl: 0, milkType: 'formula' },
      },
      {
        ...makeBase('2026-06-10T18:00:00.000Z', '2026-06-10T18:10:00.000Z'),
        type: 'bottle_feed',
        payload: { volumeMl: null },
      },
      {
        ...makeBase('2026-06-10T13:00:00.000Z'),
        type: 'diaper',
        payload: { kind: 'wet' },
      },
      {
        ...makeBase('2026-06-10T14:00:00.000Z'),
        type: 'diaper',
        payload: { kind: 'poopy', hasRash: true },
      },
      {
        ...makeBase('2026-06-10T16:00:00.000Z'),
        type: 'diaper',
        payload: { kind: 'both', hasRash: false },
      },
      {
        ...makeBase('2026-06-10T12:20:00.000Z'),
        type: 'spit_up',
        payload: { severity: 'medium', relatedFeedId: nextId(), relatedFeedType: 'bottle_feed' },
      },
      {
        ...makeBase('2026-06-10T17:00:00.000Z'),
        type: 'spit_up',
        payload: { severity: 'large', relatedFeedId: null, relatedFeedType: null },
      },
    ];

    const stats = computeDailyStats(events, '2026-06-10', tz);
    expect(stats.bottleFeedCount).toBe(3);
    expect(stats.bottleTotalMl).toBe(90);
    expect(stats.bottleTotalSeconds).toBe(30 * 60);
    expect(stats.bottleMlByMilkType).toEqual({ breastmilk: 90, formula: 0 });

    // Clinical diaper counting: 1 wet + 1 poopy + 1 both => 2 wet, 2 poopy, 1 both, 3 events
    expect(stats.wetCount).toBe(2);
    expect(stats.poopyCount).toBe(2);
    expect(stats.bothCount).toBe(1);
    expect(stats.diaperEventCount).toBe(3);
    expect(stats.rashCount).toBe(1);

    expect(stats.spitUpCount).toBe(2);
    expect(stats.spitUpBySeverity).toEqual({
      small: 0,
      medium: 1,
      large: 1,
      unspecified: 0,
    });
    expect(stats.linkedSpitUpCount).toBe(1);
    expect(stats.standaloneSpitUpCount).toBe(1);
  });
});

describe('range stats, period averages, last activity, and day events', () => {
  const tz = 'UTC';

  it('zero-fills date range and computes 7/14/30-day averages', () => {
    const events: TrackingEvent[] = [
      {
        ...makeBase('2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'),
        type: 'sleep',
        payload: { category: 'nap' },
      },
      {
        ...makeBase('2026-06-03T12:00:00.000Z', '2026-06-03T12:10:00.000Z'),
        type: 'bottle_feed',
        payload: { volumeMl: 140, milkType: 'formula' },
      },
    ];

    const range7 = computeDateRangeStats(events, '2026-06-01', '2026-06-07', tz);
    expect(range7).toHaveLength(7);
    expect(range7[1]!.totalSleepSeconds).toBe(0);

    const avg7 = computePeriodAverages(range7);
    expect(avg7.days).toBe(7);
    expect(avg7.totals.totalSleepSeconds).toBe(3600);
    expect(avg7.averagesPerDay.bottleTotalMl).toBe(20);

    const range14 = computeDateRangeStats(events, '2026-06-01', '2026-06-14', tz);
    expect(computePeriodAverages(range14).days).toBe(14);

    const range30 = computeDateRangeStats(events, '2026-06-01', '2026-06-30', tz);
    expect(computePeriodAverages(range30).days).toBe(30);
  });

  it('computes last activity summary including ongoing timers and getEventsForLocalDay', () => {
    const ongoingSleep: TrackingEvent = {
      ...makeBase('2026-06-01T23:00:00.000Z', null),
      type: 'sleep',
      payload: { category: 'night' },
    };
    const bottle: TrackingEvent = {
      ...makeBase('2026-06-01T20:00:00.000Z', '2026-06-01T20:15:00.000Z'),
      type: 'bottle_feed',
      payload: { volumeMl: 100 },
    };
    const nowMs = Date.parse('2026-06-02T01:00:00.000Z');

    const summary = computeLastActivitySummary([bottle, ongoingSleep], nowMs);
    expect(summary.lastSleep?.isOngoing).toBe(true);
    expect(summary.lastSleep?.secondsSinceEnd).toBe(0);
    expect(summary.lastSleep?.secondsSinceStart).toBe(7200);
    expect(summary.lastFeed?.feedType).toBe('bottle_feed');
    expect(summary.lastBottleFeed?.volumeMl).toBe(100);
    expect(summary.lastFeed?.secondsSinceEnd).toBe(4 * 3600 + 45 * 60);

    const day2Events = getEventsForLocalDay([bottle, ongoingSleep], '2026-06-02', tz, nowMs);
    expect(day2Events).toHaveLength(1);
    expect(day2Events[0]!.id).toBe(ongoingSleep.id);
  });

  it('T5-SHARED-1: handles paused/ongoing breast_feed segments, startDateKey > endDateKey, and computePeriodAverages([])', () => {
    const pausedBf: TrackingEvent = {
      ...makeBase('2026-06-10T10:00:00.000Z', null),
      type: 'breast_feed',
      payload: {
        segments: [
          {
            side: 'left',
            startedAt: '2026-06-10T10:00:00.000Z',
            endedAt: null,
          },
        ],
        pausedAt: '2026-06-10T10:05:00.000Z', // 5 min = 300s
        totalLeftSeconds: 300,
        totalRightSeconds: 0,
      },
    };

    const ongoingBf: TrackingEvent = {
      ...makeBase('2026-06-10T12:00:00.000Z', null),
      type: 'breast_feed',
      payload: {
        segments: [
          {
            side: 'right',
            startedAt: '2026-06-10T12:00:00.000Z',
            endedAt: null,
          },
        ],
        pausedAt: null,
        totalLeftSeconds: 0,
        totalRightSeconds: 0,
      },
    };

    const nowMs = Date.parse('2026-06-10T12:12:00.000Z'); // 12 min = 720s after ongoingBf start
    const stats = computeDailyStats([pausedBf, ongoingBf], '2026-06-10', tz, nowMs);
    expect(stats.breastLeftSeconds).toBe(300);
    expect(stats.breastRightSeconds).toBe(720);
    expect(stats.breastTotalSeconds).toBe(1020);
    expect(stats.breastFeedCount).toBe(2);
    expect(stats.lastBreastSide).toBe('right');

    // Reversed date range returns []
    expect(
      computeDateRangeStats([pausedBf], '2026-06-15', '2026-06-10', tz),
    ).toEqual([]);

    // Empty period averages returns 0 days and zeroed metrics
    const emptyAvg = computePeriodAverages([]);
    expect(emptyAvg.days).toBe(0);
    expect(emptyAvg.totals.totalSleepSeconds).toBe(0);
    expect(emptyAvg.totals.totalFeedCount).toBe(0);
    expect(emptyAvg.averagesPerDay.totalSleepSeconds).toBe(0);
    expect(emptyAvg.averagesPerDay.bottleTotalMl).toBe(0);
  });

  it('aggregates vitamin events, concurrent offline logs, soft-deletes, DST boundaries, and period averages', () => {
    const vit1: TrackingEvent = {
      ...makeBase('2026-03-08T13:00:00.000Z', '2026-03-08T13:00:00.000Z'),
      type: 'vitamin',
      payload: {},
    };
    const vit2Concurrent: TrackingEvent = {
      ...makeBase('2026-03-08T14:30:00.000Z', '2026-03-08T14:30:00.000Z'),
      type: 'vitamin',
      payload: {},
    };
    const vitDeleted: TrackingEvent = {
      ...makeBase('2026-03-09T13:00:00.000Z', '2026-03-09T13:00:00.000Z'),
      deletedAt: '2026-03-09T13:05:00.000Z',
      type: 'vitamin',
      payload: {},
    };
    const vitFallBack: TrackingEvent = {
      ...makeBase('2026-11-01T16:00:00.000Z', '2026-11-01T16:00:00.000Z'),
      type: 'vitamin',
      payload: {},
    };

    const nyTz = 'America/New_York';
    // 0 events
    const emptyStats = computeDailyStats([], '2026-03-07', nyTz);
    expect(emptyStats.vitaminCount).toBe(0);
    expect(emptyStats.vitaminGiven).toBe(false);

    // 2 concurrent events on spring-forward DST day (2026-03-08)
    const dstSpringStats = computeDailyStats([vit1, vit2Concurrent], '2026-03-08', nyTz);
    expect(dstSpringStats.vitaminCount).toBe(2);
    expect(dstSpringStats.vitaminGiven).toBe(true);

    // Soft-deleted event on 2026-03-09
    const deletedStats = computeDailyStats([vitDeleted], '2026-03-09', nyTz);
    expect(deletedStats.vitaminCount).toBe(0);
    expect(deletedStats.vitaminGiven).toBe(false);

    // Fall-back DST day (2026-11-01)
    const dstFallStats = computeDailyStats([vitFallBack], '2026-11-01', nyTz);
    expect(dstFallStats.vitaminCount).toBe(1);
    expect(dstFallStats.vitaminGiven).toBe(true);

    // Period averages counts days where vitaminGiven is true (2 days out of 3)
    const avg = computePeriodAverages([emptyStats, dstSpringStats, dstFallStats]);
    expect(avg.totals.vitaminDaysCount).toBe(2);

    // LastActivitySummary picks up latest active vitamin
    const summary = computeLastActivitySummary(
      [vit1, vit2Concurrent, vitDeleted],
      Date.parse('2026-03-08T15:00:00.000Z'),
    );
    expect(summary.lastVitamin?.event.id).toBe(vit2Concurrent.id);
    expect(summary.lastVitamin?.secondsSinceStart).toBe(1800);
  });
});
