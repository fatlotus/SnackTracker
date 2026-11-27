import { useEffect, useState } from 'react';
import {
  addDays,
  computeDailyStats,
  getEventsForLocalDay,
  type TrackingEvent,
} from '@baby-tracker/shared';
import {
  Activity,
  Baby as BabyIcon,
  ChevronLeft,
  ChevronRight,
  Droplets,
  GlassWater,
  Milk,
  Moon,
  Pencil,
  Pill,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { deleteEvent } from '../lib/store.js';
import { useI18n } from '../lib/i18n.js';
import {
  ALL_SUMMARY_CATEGORIES,
  DailySummaryCards,
  NON_PARENT_SUMMARY_CATEGORIES,
  type SummaryCardCategory,
} from './DailySummaryCards.js';
import {
  getLocalTimeZone,
  getTodayDateKey,
  getYesterdayDateKey,
  type VolumeUnit,
} from './uiUtils.js';

type TimelineFilter =
  | 'all'
  | 'feeds'
  | 'sleep'
  | 'diaper'
  | 'spit_up'
  | 'vitamin'
  | 'pumping'
  | 'tummy_time';

interface TimelineViewProps {
  events: TrackingEvent[];
  userId: string;
  volumeUnit: VolumeUnit;
  nowMs: number;
  canAccessPumping?: boolean;
  initialDateKey?: string | null;
  onEditEvent: (event: TrackingEvent) => void;
}

export function TimelineView({
  events,
  userId,
  volumeUnit,
  nowMs,
  canAccessPumping = true,
  initialDateKey = null,
  onEditEvent,
}: TimelineViewProps) {
  const { t, locale, formatDurationShort, formatLocalTime, formatVolume } =
    useI18n();
  const timeZone = getLocalTimeZone();
  const todayKey = getTodayDateKey(timeZone, nowMs);
  const yesterdayKey = getYesterdayDateKey(timeZone, nowMs);

  const [selectedDateOverride, setSelectedDateOverride] = useState<string | null>(
    () => (initialDateKey && initialDateKey !== todayKey ? initialDateKey : null),
  );
  const selectedDateKey = selectedDateOverride ?? todayKey;

  function selectDate(dateKey: string) {
    setSelectedDateOverride(dateKey === todayKey ? null : dateKey);
  }

  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!canAccessPumping && filter === 'pumping') {
      setFilter('all');
    }
  }, [canAccessPumping, filter]);

  const activeFilter: TimelineFilter =
    !canAccessPumping && filter === 'pumping' ? 'all' : filter;

  async function handleDeleteEvent(eventId: string) {
    setDeleteError(null);
    try {
      await deleteEvent(eventId, userId);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : t('timeline.deleteFailed'),
      );
    }
  }

  const dailyStats = computeDailyStats(events, selectedDateKey, timeZone, nowMs);
  const dayEvents = getEventsForLocalDay(
    events,
    selectedDateKey,
    timeZone,
    nowMs,
  )
    .filter((e) => canAccessPumping || e.type !== 'pumping')
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const filtered = dayEvents.filter((e) => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'feeds') {
      return e.type === 'breast_feed' || e.type === 'bottle_feed';
    }
    if (activeFilter === 'sleep') return e.type === 'sleep';
    if (activeFilter === 'diaper') return e.type === 'diaper';
    if (activeFilter === 'spit_up') return e.type === 'spit_up';
    if (activeFilter === 'pumping') return canAccessPumping && e.type === 'pumping';
    if (activeFilter === 'tummy_time') return e.type === 'tummy_time';
    return e.type === 'vitamin';
  });

  const visibleSummaryCategories: readonly SummaryCardCategory[] =
    activeFilter === 'all'
      ? canAccessPumping
        ? ALL_SUMMARY_CATEGORIES
        : NON_PARENT_SUMMARY_CATEGORIES
      : activeFilter === 'feeds'
        ? ['feeding']
        : activeFilter === 'sleep'
          ? ['sleep']
          : activeFilter === 'diaper' || activeFilter === 'spit_up'
            ? ['diapers']
            : activeFilter === 'pumping'
              ? canAccessPumping
                ? ['pumping']
                : []
              : activeFilter === 'tummy_time'
                ? ['tummy_time']
                : [];

  function renderSummary(event: TrackingEvent): {
    title: string;
    detail: string;
    icon: React.ReactNode;
    badgeClass: string;
    cardClass: string;
  } {
    switch (event.type) {
      case 'breast_feed': {
        const leftMin = Math.round(event.payload.totalLeftSeconds / 60);
        const rightMin = Math.round(event.payload.totalRightSeconds / 60);
        const totalSec =
          event.payload.totalLeftSeconds + event.payload.totalRightSeconds;
        return {
          title: t('timeline.breastTitle'),
          detail:
            event.endedAt === null
              ? t('timeline.activeTimer')
              : locale === 'zh-CN'
                ? `${formatDurationShort(totalSec)}（左 ${leftMin}分 · 右 ${rightMin}分）`
                : `${formatDurationShort(totalSec)} (L ${leftMin}m · R ${rightMin}m)`,
          icon: <BabyIcon className="h-4 w-4" />,
          badgeClass: 'bt-badge-breast',
          cardClass: 'bt-card-breast',
        };
      }
      case 'bottle_feed': {
        const vol = formatVolume(event.payload.volumeMl, volumeUnit);
        const milk = event.payload.milkType
          ? ` · ${t(`modals.bottle.milk.${event.payload.milkType}`)}`
          : '';
        return {
          title: t('timeline.bottleTitle'),
          detail:
            event.endedAt === null
              ? t('timeline.activeTimer')
              : `${vol}${milk}`,
          icon: <Milk className="h-4 w-4" />,
          badgeClass: 'bt-badge-bottle',
          cardClass: 'bt-card-bottle',
        };
      }
      case 'sleep': {
        const durSec =
          event.endedAt !== null
            ? Math.max(
                0,
                (Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 1000,
              )
            : Math.max(0, (nowMs - Date.parse(event.startedAt)) / 1000);
        const loc = event.payload.location
          ? ` · ${t(`modals.sleep.loc.${event.payload.location}`)}`
          : '';
        return {
          title:
            event.payload.category === 'night'
              ? t('timeline.nightSleepTitle')
              : t('timeline.napTitle'),
          detail: `${event.endedAt === null ? t('timeline.sleepingPrefix') : ''}${formatDurationShort(durSec)}${loc}`,
          icon: <Moon className="h-4 w-4" />,
          badgeClass: 'bt-badge-sleep',
          cardClass: 'bt-card-sleep',
        };
      }
      case 'diaper': {
        const parts: string[] = [t(`modals.diaper.kind.${event.payload.kind}`)];
        if (event.payload.amount) parts.push(t(`common.${event.payload.amount}`));
        if (event.payload.hasRash) parts.push(t('timeline.rash'));
        return {
          title: t('timeline.diaperTitle'),
          detail: parts.join(' · '),
          icon: <Droplets className="h-4 w-4" />,
          badgeClass: 'bt-badge-diaper',
          cardClass: 'bt-card-diaper',
        };
      }
      case 'spit_up': {
        const sev = event.payload.severity
          ? t(`common.${event.payload.severity}`)
          : t('dashboard.loggedFallback');
        const linked = event.payload.relatedFeedId
          ? t('timeline.linkedToFeed')
          : '';
        return {
          title: t('timeline.spitUpTitle'),
          detail: `${sev}${linked}`,
          icon: <Sparkles className="h-4 w-4" />,
          badgeClass: 'bt-badge-spitup',
          cardClass: 'bt-card-spitup',
        };
      }
      case 'vitamin': {
        return {
          title: t('timeline.vitaminTitle'),
          detail: t('timeline.vitaminDetail'),
          icon: <Pill className="h-4 w-4" />,
          badgeClass: 'bt-badge-vitamin',
          cardClass: 'bt-card-vitamin',
        };
      }
      case 'pumping': {
        const durSec =
          event.endedAt !== null
            ? Math.max(
                0,
                (Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 1000,
              )
            : Math.max(0, (nowMs - Date.parse(event.startedAt)) / 1000);
        const parts: string[] = [];
        if (event.endedAt === null) {
          parts.push(t('timeline.activeTimer'));
        } else {
          if (event.payload.volumeMl !== null) {
            parts.push(formatVolume(event.payload.volumeMl, volumeUnit));
          }
          if (durSec > 0) {
            parts.push(formatDurationShort(durSec));
          }
          if (event.payload.side) {
            parts.push(t(`modals.pumping.side.${event.payload.side}`));
          }
          if (parts.length === 0) {
            parts.push(t('dashboard.loggedFallback'));
          }
        }
        return {
          title: t('timeline.pumpingTitle'),
          detail: parts.join(' · '),
          icon: <GlassWater className="h-4 w-4" />,
          badgeClass: 'bt-badge-pumping',
          cardClass: 'bt-card-pumping',
        };
      }
      case 'tummy_time': {
        const durSec =
          event.endedAt !== null
            ? Math.max(
                0,
                (Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 1000,
              )
            : Math.max(0, (nowMs - Date.parse(event.startedAt)) / 1000);
        const mood = event.payload.mood
          ? ` · ${t(`modals.tummy.mood.${event.payload.mood}`)}`
          : '';
        return {
          title: t('timeline.tummyTimeTitle'),
          detail: `${event.endedAt === null ? t('timeline.tummyTimePrefix') : ''}${formatDurationShort(durSec)}${mood}`,
          icon: <Activity className="h-4 w-4" />,
          badgeClass: 'bt-badge-tummy',
          cardClass: 'bt-card-tummy',
        };
      }
    }
  }

  return (
    <div className="space-y-4">
      {deleteError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
        >
          <span>{deleteError}</span>
          <button
            type="button"
            onClick={() => setDeleteError(null)}
            aria-label={t('common.dismissError')}
            className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg hover:bg-rose-100 dark:hover:bg-rose-900/50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Day Navigation */}
      <div className="bt-card flex flex-wrap items-center justify-between gap-2 p-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={t('timeline.previousDayAria')}
            onClick={() => selectDate(addDays(selectedDateKey, -1))}
            className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            type="date"
            aria-label={t('timeline.selectDateAria')}
            value={selectedDateKey}
            onChange={(e) => {
              if (e.target.value) selectDate(e.target.value);
            }}
            className="bt-focus-ring min-h-[44px] rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium dark:border-slate-700 dark:bg-slate-950"
          />
          <button
            type="button"
            aria-label={t('timeline.nextDayAria')}
            onClick={() => selectDate(addDays(selectedDateKey, 1))}
            className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={selectedDateKey === yesterdayKey}
            onClick={() => selectDate(yesterdayKey)}
            className={`bt-focus-ring min-h-[44px] rounded-xl px-3 text-xs font-semibold ${
              selectedDateKey === yesterdayKey
                ? 'bg-teal-600 text-white'
                : 'border border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'
            }`}
          >
            {t('timeline.yesterday')}
          </button>
          <button
            type="button"
            aria-pressed={selectedDateKey === todayKey}
            onClick={() => selectDate(todayKey)}
            className={`bt-focus-ring min-h-[44px] rounded-xl px-3 text-xs font-semibold ${
              selectedDateKey === todayKey
                ? 'bg-teal-600 text-white'
                : 'border border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'
            }`}
          >
            {t('timeline.today')}
          </button>
        </div>
      </div>

      {/* Selected Day Summary */}
      {visibleSummaryCategories.length > 0 && (
        <section
          aria-label={t('timeline.daySummaryAria', { date: selectedDateKey })}
          className={`grid gap-3 ${
            visibleSummaryCategories.length === 1
              ? 'grid-cols-1'
              : visibleSummaryCategories.length === 4
                ? 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-4'
                : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
          }`}
        >
          <DailySummaryCards
            stats={dailyStats}
            volumeUnit={volumeUnit}
            isToday={selectedDateKey === todayKey}
            categories={visibleSummaryCategories}
            compact
          />
        </section>
      )}

      {/* Category Filter */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { id: 'all', label: t('timeline.filter.all') },
            { id: 'feeds', label: t('timeline.filter.feeds') },
            { id: 'sleep', label: t('timeline.filter.sleep') },
            { id: 'diaper', label: t('timeline.filter.diaper') },
            { id: 'spit_up', label: t('timeline.filter.spit_up') },
            { id: 'vitamin', label: t('timeline.filter.vitamin') },
            ...(canAccessPumping
              ? [{ id: 'pumping', label: t('timeline.filter.pumping') } as const]
              : []),
            { id: 'tummy_time', label: t('timeline.filter.tummy_time') },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={activeFilter === tab.id}
            onClick={() => setFilter(tab.id)}
            className={`bt-focus-ring min-h-[44px] rounded-xl px-3.5 text-sm font-medium transition ${
              activeFilter === tab.id
                ? 'bg-slate-900 text-white dark:bg-teal-600'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Chronological List */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          {t('timeline.noEvents', { date: selectedDateKey })}
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((event) => {
            const info = renderSummary(event);
            const timeLabel =
              event.endedAt && event.endedAt !== event.startedAt
                ? `${formatLocalTime(event.startedAt, timeZone)} – ${formatLocalTime(event.endedAt, timeZone)}`
                : formatLocalTime(event.startedAt, timeZone);

            return (
              <div
                key={event.id}
                className={`bt-card ${info.cardClass} flex items-start justify-between gap-3 p-3.5`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${info.badgeClass}`}
                  >
                    {info.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                        {info.title}
                      </span>
                      <span className="tabular-nums-clock text-xs text-slate-500 dark:text-slate-400">
                        {timeLabel}
                      </span>
                    </div>
                    <p className="text-sm text-slate-700 dark:text-slate-300">
                      {info.detail}
                    </p>
                    {event.notes && (
                      <p className="mt-1 text-xs italic text-slate-500 dark:text-slate-400">
                        “{event.notes}”
                      </p>
                    )}
                    {event.loggedByName && (
                      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                        {t('timeline.loggedBy', { name: event.loggedByName })}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {event.type !== 'vitamin' && (
                    <button
                      type="button"
                      aria-label={t('timeline.editAria', { title: info.title })}
                      onClick={() => onEditEvent(event)}
                      className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={t('timeline.deleteAria', { title: info.title })}
                    onClick={() => void handleDeleteEvent(event.id)}
                    className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-rose-500 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/60"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
