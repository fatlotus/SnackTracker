import { describe, expect, it } from 'vitest';
import type { Baby, TrackingEvent } from '../schemas.js';
import {
  escapeCsvCell,
  exportBabyDataToJson,
  exportDailyStatsToCsv,
  exportEventsToCsv,
  generatePediatricianSummary,
} from '../export.js';
import { computeDateRangeStats } from '../stats.js';

const BABY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const baby: Baby = {
  id: BABY_ID,
  name: 'Maya',
  dob: '2026-05-01',
  birthWeightGrams: 3350,
  avatarColor: '#4f46e5',
  notes: null,
  isArchived: false,
  createdByUserId: USER_ID,
  createdAt: '2026-05-01T08:00:00.000Z',
  updatedAt: '2026-05-01T08:00:00.000Z',
  deletedAt: null,
  serverSeq: 1,
};

const events: TrackingEvent[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    babyId: BABY_ID,
    type: 'bottle_feed',
    startedAt: '2026-06-01T14:00:00.000Z', // 10:00 EDT
    endedAt: '2026-06-01T14:15:00.000Z',
    notes: '=SUM(A1:A5), "quoted"\nline2',
    loggedByUserId: USER_ID,
    loggedByName: 'Alex',
    updatedByUserId: USER_ID,
    createdAt: '2026-06-01T14:00:00.000Z',
    updatedAt: '2026-06-01T14:15:00.000Z',
    deletedAt: null,
    serverSeq: 1,
    payload: { volumeMl: 0, milkType: 'formula' },
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    babyId: BABY_ID,
    type: 'bottle_feed',
    startedAt: '2026-06-01T16:00:00.000Z', // 12:00 EDT
    endedAt: '2026-06-01T16:10:00.000Z',
    notes: null,
    loggedByUserId: USER_ID,
    loggedByName: 'Alex',
    updatedByUserId: USER_ID,
    createdAt: '2026-06-01T16:00:00.000Z',
    updatedAt: '2026-06-01T16:10:00.000Z',
    deletedAt: null,
    serverSeq: 2,
    payload: { volumeMl: null, milkType: 'breastmilk' },
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    babyId: BABY_ID,
    type: 'diaper',
    startedAt: '2026-06-01T17:00:00.000Z', // 13:00 EDT
    endedAt: '2026-06-01T17:00:00.000Z',
    notes: 'Mild redness',
    loggedByUserId: USER_ID,
    loggedByName: 'Sam',
    updatedByUserId: USER_ID,
    createdAt: '2026-06-01T17:00:00.000Z',
    updatedAt: '2026-06-01T17:00:00.000Z',
    deletedAt: null,
    serverSeq: 3,
    payload: { kind: 'both', hasRash: true },
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    babyId: BABY_ID,
    type: 'spit_up',
    startedAt: '2026-06-01T17:30:00.000Z',
    endedAt: '2026-06-01T17:30:00.000Z',
    notes: null,
    loggedByUserId: USER_ID,
    loggedByName: 'Sam',
    updatedByUserId: USER_ID,
    createdAt: '2026-06-01T17:30:00.000Z',
    updatedAt: '2026-06-01T17:30:00.000Z',
    deletedAt: null,
    serverSeq: 4,
    payload: { severity: 'large' },
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    babyId: BABY_ID,
    type: 'sleep',
    startedAt: '2026-06-01T18:00:00.000Z',
    endedAt: '2026-06-01T19:00:00.000Z',
    notes: 'Deleted event should not appear',
    loggedByUserId: USER_ID,
    loggedByName: 'Sam',
    updatedByUserId: USER_ID,
    createdAt: '2026-06-01T18:00:00.000Z',
    updatedAt: '2026-06-01T19:00:00.000Z',
    deletedAt: '2026-06-01T19:05:00.000Z',
    serverSeq: 5,
    payload: { category: 'nap' },
  },
];

describe('CSV escaping & formula injection', () => {
  it('neutralizes formula prefixes and applies RFC 4180 quoting', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+cmd')).toBe("'+cmd");
    expect(escapeCsvCell('-cmd')).toBe("'-cmd");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('\tbad')).toBe("'\tbad");
    expect(escapeCsvCell('\rbad')).toBe('"\'\rbad"');
    expect(escapeCsvCell('a, "b"')).toBe('"a, ""b"""');
    expect(escapeCsvCell(0)).toBe('0');
    expect(escapeCsvCell(null)).toBe('');
  });

  it('exports events to CSV distinguishing 0 ml from null and excluding soft-deleted', () => {
    const csv = exportEventsToCsv(events, { timeZone: 'America/New_York' });
    expect(csv).not.toContain('Deleted event should not appear');
    // Formula neutralization + RFC 4180 quoting
    expect(csv).toContain('"\'=SUM(A1:A5), ""quoted""\nline2"');
    // Local time 10:00 EDT
    expect(csv).toContain('2026-06-01 10:00:00');

    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(5); // header + 4 active events
    // Row 1 (0 ml): volumeMl column (index 8) is "0"
    expect(lines[1]!).toContain(',0,formula,');
    // Row 2 (null ml): volumeMl column (index 8) is ""
    expect(lines[2]!).toContain(',,breastmilk,');
  });

  it('exports daily stats to CSV', () => {
    const daily = computeDateRangeStats(
      events,
      '2026-06-01',
      '2026-06-02',
      'America/New_York',
    );
    const csv = exportDailyStatsToCsv(daily);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]!).toContain('2026-06-01,');
    expect(lines[2]!).toContain('2026-06-02,');
  });
});

describe('JSON & pediatrician summary exporters', () => {
  it('exports versioned JSON backup excluding soft-deleted events', () => {
    const json = exportBabyDataToJson({
      baby,
      events,
      startDateKey: '2026-06-01',
      endDateKey: '2026-06-02',
      timeZone: 'America/New_York',
      exportedAt: '2026-06-02T12:00:00.000Z',
    });

    expect(json.schemaVersion).toBe(1);
    expect(json.exportedAt).toBe('2026-06-02T12:00:00.000Z');
    expect(json.dailyStats).toHaveLength(2);
    expect(json.events).toHaveLength(4);
    expect(json.summary.totals.rashCount).toBe(1);
  });

  it('generates text and markdown pediatrician summaries with clinical notes', () => {
    const md = generatePediatricianSummary({
      baby,
      events,
      startDateKey: '2026-06-01',
      endDateKey: '2026-06-02',
      timeZone: 'America/New_York',
      format: 'markdown',
    });
    expect(md).toContain('# Pediatrician Summary: Maya');
    expect(md).toContain('## Period Totals & Daily Averages');
    expect(md).toContain('## Day-by-Day Breakdown');
    expect(md).toContain('## Notable Clinical Notes');
    expect(md).toContain('Diaper rash noted: Mild redness');
    expect(md).toContain('Large spit-up');

    const text = generatePediatricianSummary({
      baby,
      events,
      startDateKey: '2026-06-01',
      endDateKey: '2026-06-02',
      timeZone: 'America/New_York',
      format: 'text',
    });
    expect(text).toContain('PEDIATRICIAN SUMMARY: Maya');
    expect(text).toContain('NOTABLE CLINICAL NOTES');
    expect(text).toContain('4 weeks, 4 days old');
  });

  it('T5-SHARED-1: exports breast_feed, sleep, ongoing timer, includeHeader: false, and handles edge ages and null birthWeightGrams', () => {
    const extraEvents: TrackingEvent[] = [
      {
        id: '00000000-0000-4000-8000-000000000010',
        babyId: BABY_ID,
        type: 'breast_feed',
        startedAt: '2026-06-01T10:00:00.000Z',
        endedAt: '2026-06-01T10:25:00.000Z',
        notes: null,
        loggedByUserId: USER_ID,
        loggedByName: 'Alex',
        updatedByUserId: USER_ID,
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:25:00.000Z',
        deletedAt: null,
        serverSeq: 10,
        payload: {
          segments: [
            {
              side: 'left',
              startedAt: '2026-06-01T10:00:00.000Z',
              endedAt: '2026-06-01T10:15:00.000Z',
            },
            {
              side: 'right',
              startedAt: '2026-06-01T10:15:00.000Z',
              endedAt: '2026-06-01T10:25:00.000Z',
            },
          ],
          pausedAt: null,
          totalLeftSeconds: 900,
          totalRightSeconds: 600,
        },
      },
      {
        id: '00000000-0000-4000-8000-000000000011',
        babyId: BABY_ID,
        type: 'sleep',
        startedAt: '2026-06-01T12:00:00.000Z',
        endedAt: null, // ongoing timer
        notes: 'Ongoing nap',
        loggedByUserId: USER_ID,
        loggedByName: 'Sam',
        updatedByUserId: USER_ID,
        createdAt: '2026-06-01T12:00:00.000Z',
        updatedAt: '2026-06-01T12:00:00.000Z',
        deletedAt: null,
        serverSeq: 11,
        payload: { category: 'nap', location: 'crib' },
      },
    ];

    const nowMs = Date.parse('2026-06-01T12:45:00.000Z'); // 45m ongoing
    const csvNoHeader = exportEventsToCsv(extraEvents, {
      timeZone: 'UTC',
      includeHeader: false,
      nowMs,
    });
    const lines = csvNoHeader.split('\r\n');
    expect(lines).toHaveLength(2);
    // Row 0: breast_feed with 25.0 total, 15.0 left, 10.0 right
    expect(lines[0]!).toContain(',breast_feed,2026-06-01,2026-06-01 10:00:00,2026-06-01 10:25:00,25.0,15.0,10.0,');
    // Row 1: ongoing sleep with empty endedAtLocal, 45.0 duration, nap, crib
    expect(lines[1]!).toContain(',sleep,2026-06-01,2026-06-01 12:00:00,,45.0,,,,,nap,crib,');

    // Pediatrician summary: <14d (1 day old) + birthWeightGrams: null
    const newbornBaby: Baby = {
      ...baby,
      dob: '2026-05-31',
      birthWeightGrams: null,
    };
    const newbornSummary = generatePediatricianSummary({
      baby: newbornBaby,
      events: [],
      startDateKey: '2026-06-01',
      endDateKey: '2026-06-01',
      timeZone: 'UTC',
      format: 'text',
    });
    expect(newbornSummary).toContain('1 day old');
    expect(newbornSummary).not.toContain('Birth Weight');

    // Pediatrician summary: >=60d (2 months old)
    const olderBaby: Baby = {
      ...baby,
      dob: '2026-04-01',
      birthWeightGrams: null,
    };
    const olderSummary = generatePediatricianSummary({
      baby: olderBaby,
      events: [],
      startDateKey: '2026-06-01',
      endDateKey: '2026-06-01',
      timeZone: 'UTC',
      format: 'markdown',
    });
    expect(olderSummary).toContain('2 months old');
    expect(olderSummary).not.toContain('Birth Weight');
  });
});
