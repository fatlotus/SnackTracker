import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  BottleFeedEvent,
  BreastFeedEvent,
  DiaperAmount,
  DiaperEvent,
  DiaperKind,
  MilkType,
  RelatedFeedType,
  SleepCategory,
  SleepEvent,
  SleepLocation,
  SpitUpEvent,
  SpitUpSeverity,
  TrackingEvent,
} from '@baby-tracker/shared';
import { X } from 'lucide-react';
import { nowIso, uuidv4 } from '../lib/db.js';
import {
  createEvent,
  finishBottleFeed,
  logBottleFeed,
  logDiaper,
  logSleep,
  logSpitUp,
  updateEvent,
} from '../lib/store.js';
import { useI18n } from '../lib/i18n.js';
import {
  buildManualBreastFeedSegments,
  fromLocalDateTimeInputValue,
  getLocalTimeZone,
  parseVolumeInputToMl,
  toLocalDateTimeInputValue,
  volumeMlToInputString,
  type VolumeUnit,
} from './uiUtils.js';

function ModalShell({
  title,
  accentClass = '',
  onClose,
  children,
}: {
  title: string;
  accentClass?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-2xl ${accentClass}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('modals.closeAria')}
            className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// Breast Feed Manual / Edit Modal
// ============================================================================

export function BreastFeedModal({
  babyId,
  userId,
  userName,
  existing,
  onClose,
}: {
  babyId: string;
  userId: string;
  userName: string | null;
  existing?: BreastFeedEvent;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const defaultStart = existing
    ? toLocalDateTimeInputValue(existing.startedAt)
    : toLocalDateTimeInputValue(new Date(Date.now() - 15 * 60_000).toISOString());

  const [startedLocal, setStartedLocal] = useState(defaultStart);
  const [leftMinutes, setLeftMinutes] = useState(
    existing ? String(Math.round(existing.payload.totalLeftSeconds / 60)) : '10',
  );
  const [rightMinutes, setRightMinutes] = useState(
    existing ? String(Math.round(existing.payload.totalRightSeconds / 60)) : '0',
  );
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const leftMin = Math.max(0, Number(leftMinutes) || 0);
    const rightMin = Math.max(0, Number(rightMinutes) || 0);
    const preserveSubMinuteDuration =
      Boolean(existing) &&
      leftMin === 0 &&
      rightMin === 0 &&
      existing!.payload.totalLeftSeconds + existing!.payload.totalRightSeconds > 0;

    if (leftMin === 0 && rightMin === 0 && !preserveSubMinuteDuration) {
      setError(t('modals.breast.minError'));
      return;
    }

    setSaving(true);
    try {
      const startedAtIso = fromLocalDateTimeInputValue(startedLocal);
      const now = nowIso();

      if (existing) {
        await updateEvent(existing.id, (prev) => {
          if (prev.type !== 'breast_feed') {
            throw new Error('Expected breast_feed event');
          }
          if (preserveSubMinuteDuration) {
            const oldStartMs = Date.parse(prev.startedAt);
            const newStartMs = Date.parse(startedAtIso);
            const deltaMs =
              Number.isFinite(oldStartMs) && Number.isFinite(newStartMs)
                ? newStartMs - oldStartMs
                : 0;
            const shiftedSegments = prev.payload.segments.map((seg) => ({
              ...seg,
              startedAt: new Date(
                Date.parse(seg.startedAt) + deltaMs,
              ).toISOString(),
              endedAt: seg.endedAt
                ? new Date(Date.parse(seg.endedAt) + deltaMs).toISOString()
                : null,
            }));
            const totalMs =
              (prev.payload.totalLeftSeconds + prev.payload.totalRightSeconds) *
              1000;
            const shiftedEndedAt = prev.endedAt
              ? new Date(
                  Math.max(newStartMs, Date.parse(prev.endedAt) + deltaMs),
                ).toISOString()
              : new Date(newStartMs + totalMs).toISOString();

            return {
              ...prev,
              startedAt: startedAtIso,
              endedAt: shiftedEndedAt,
              notes: notes.trim() ? notes.trim() : null,
              updatedByUserId: userId,
              payload: {
                ...prev.payload,
                segments: shiftedSegments,
                pausedAt: null,
              },
            };
          }
          const built = buildManualBreastFeedSegments(startedAtIso, leftMin, rightMin);
          return {
            ...prev,
            startedAt: startedAtIso,
            endedAt: built.endedAt,
            notes: notes.trim() ? notes.trim() : null,
            updatedByUserId: userId,
            payload: {
              segments: built.segments,
              pausedAt: null,
              totalLeftSeconds: built.totalLeftSeconds,
              totalRightSeconds: built.totalRightSeconds,
            },
          };
        });
      } else {
        const built = buildManualBreastFeedSegments(startedAtIso, leftMin, rightMin);
        const event: BreastFeedEvent = {
          id: uuidv4(),
          babyId,
          type: 'breast_feed',
          startedAt: startedAtIso,
          endedAt: built.endedAt,
          notes: notes.trim() ? notes.trim() : null,
          loggedByUserId: userId,
          loggedByName: userName,
          updatedByUserId: userId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          serverSeq: 0,
          payload: {
            segments: built.segments,
            pausedAt: null,
            totalLeftSeconds: built.totalLeftSeconds,
            totalRightSeconds: built.totalRightSeconds,
          },
        };
        await createEvent(event);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.breast.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={existing ? t('modals.breast.editTitle') : t('modals.breast.logTitle')}
      accentClass="bt-card-breast"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="breast-start" className="mb-1 block text-sm font-medium">
            {t('modals.breast.startTime')}
          </label>
          <input
            id="breast-start"
            type="datetime-local"
            required
            value={startedLocal}
            onChange={(e) => setStartedLocal(e.target.value)}
            className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="breast-left" className="mb-1 block text-sm font-medium">
              {t('modals.breast.leftMin')}
            </label>
            <input
              id="breast-left"
              type="number"
              min={0}
              max={180}
              value={leftMinutes}
              onChange={(e) => setLeftMinutes(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          <div>
            <label htmlFor="breast-right" className="mb-1 block text-sm font-medium">
              {t('modals.breast.rightMin')}
            </label>
            <input
              id="breast-right"
              type="number"
              min={0}
              max={180}
              value={rightMinutes}
              onChange={(e) => setRightMinutes(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
        </div>
        <div>
          <label htmlFor="breast-notes" className="mb-1 block text-sm font-medium">
            {t('common.notes')}
          </label>
          <textarea
            id="breast-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('modals.breast.notesPlaceholder')}
            className="bt-focus-ring w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="bt-focus-ring min-h-[44px] rounded-xl border border-slate-300 px-4 text-sm font-medium dark:border-slate-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="bt-focus-ring min-h-[44px] rounded-xl bg-teal-600 px-5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ============================================================================
// Bottle Feed Modal (Finish Active, Manual Entry, or Edit)
// ============================================================================

const MILK_TYPE_VALUES: MilkType[] = [
  'breastmilk',
  'formula',
  'mixed',
  'fortified',
  'other',
];

export function BottleFeedModal({
  babyId,
  userId,
  userName,
  volumeUnit,
  existing,
  finishingActive,
  onClose,
}: {
  babyId: string;
  userId: string;
  userName: string | null;
  volumeUnit: VolumeUnit;
  existing?: BottleFeedEvent;
  finishingActive?: BottleFeedEvent;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const target = finishingActive ?? existing;
  const nowStr = toLocalDateTimeInputValue(new Date().toISOString());

  const [unit, setUnit] = useState<VolumeUnit>(volumeUnit);
  const [volumeStr, setVolumeStr] = useState(
    target ? volumeMlToInputString(target.payload.volumeMl, volumeUnit) : '',
  );
  const [milkType, setMilkType] = useState<MilkType>(
    target?.payload.milkType ?? 'breastmilk',
  );
  const [startedLocal, setStartedLocal] = useState(
    target ? toLocalDateTimeInputValue(target.startedAt) : nowStr,
  );
  const [endedLocal, setEndedLocal] = useState(
    finishingActive
      ? nowStr
      : existing?.endedAt
        ? toLocalDateTimeInputValue(existing.endedAt)
        : nowStr,
  );
  const [notes, setNotes] = useState(target?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function handleUnitToggle(nextUnit: VolumeUnit) {
    if (nextUnit === unit) return;
    const ml = parseVolumeInputToMl(volumeStr, unit);
    setUnit(nextUnit);
    setVolumeStr(volumeMlToInputString(ml, nextUnit));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const volumeMl = parseVolumeInputToMl(volumeStr, unit);
    if (volumeStr.trim() !== '' && volumeMl === null) {
      setError(t('modals.bottle.invalidVolume'));
      return;
    }

    setSaving(true);
    try {
      const startedAtIso = fromLocalDateTimeInputValue(startedLocal);
      const endedAtIso = fromLocalDateTimeInputValue(endedLocal);
      if (Date.parse(endedAtIso) < Date.parse(startedAtIso)) {
        setError(t('modals.bottle.endBeforeStart'));
        setSaving(false);
        return;
      }

      if (finishingActive) {
        await finishBottleFeed({
          babyId,
          userId,
          volumeMl,
          milkType,
          at: endedAtIso,
          notes: notes.trim() ? notes.trim() : null,
        });
      } else if (existing) {
        await updateEvent(existing.id, (prev) => {
          if (prev.type !== 'bottle_feed') {
            throw new Error('Expected bottle_feed event');
          }
          return {
            ...prev,
            startedAt: startedAtIso,
            endedAt: endedAtIso,
            notes: notes.trim() ? notes.trim() : null,
            updatedByUserId: userId,
            payload: {
              volumeMl,
              milkType,
            },
          };
        });
      } else {
        await logBottleFeed({
          babyId,
          userId,
          userName,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          volumeMl,
          milkType,
          notes: notes.trim() ? notes.trim() : null,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.bottle.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={
        finishingActive
          ? t('modals.bottle.finishTitle')
          : existing
            ? t('modals.bottle.editTitle')
            : t('modals.bottle.logTitle')
      }
      accentClass="bt-card-bottle"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="bottle-volume" className="text-sm font-medium">
              {t('modals.bottle.volumeLabel', { unit: t(`common.${unit}`) })}
            </label>
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
              {(['ml', 'oz'] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={unit === u}
                  onClick={() => handleUnitToggle(u)}
                  className={`bt-focus-ring min-h-[44px] min-w-[44px] rounded-md px-2.5 py-1 font-medium ${
                    unit === u
                      ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t(`common.${u}`)}
                </button>
              ))}
            </div>
          </div>
          <input
            id="bottle-volume"
            type="number"
            min={0}
            max={2000}
            step="any"
            placeholder={
              unit === 'oz'
                ? t('modals.bottle.volumePlaceholderOz')
                : t('modals.bottle.volumePlaceholderMl')
            }
            value={volumeStr}
            onChange={(e) => setVolumeStr(e.target.value)}
            className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>

        <div>
          <label htmlFor="bottle-milk-type" className="mb-1 block text-sm font-medium">
            {t('modals.bottle.milkType')}
          </label>
          <select
            id="bottle-milk-type"
            value={milkType}
            onChange={(e) => setMilkType(e.target.value as MilkType)}
            className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {MILK_TYPE_VALUES.map((m) => (
              <option key={m} value={m}>
                {t(`modals.bottle.milk.${m}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="bottle-start" className="mb-1 block text-sm font-medium">
              {t('modals.bottle.startTime')}
            </label>
            <input
              id="bottle-start"
              type="datetime-local"
              required
              disabled={Boolean(finishingActive)}
              value={startedLocal}
              onChange={(e) => setStartedLocal(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          <div>
            <label htmlFor="bottle-end" className="mb-1 block text-sm font-medium">
              {t('modals.bottle.endTime')}
            </label>
            <input
              id="bottle-end"
              type="datetime-local"
              required
              value={endedLocal}
              onChange={(e) => setEndedLocal(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
        </div>

        <div>
          <label htmlFor="bottle-notes" className="mb-1 block text-sm font-medium">
            {t('common.notes')}
          </label>
          <textarea
            id="bottle-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('common.optionalNotes')}
            className="bt-focus-ring w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>

        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="bt-focus-ring min-h-[44px] rounded-xl border border-slate-300 px-4 text-sm font-medium dark:border-slate-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="bt-focus-ring min-h-[44px] rounded-xl bg-sky-600 px-5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
          >
            {saving ? t('common.saving') : t('modals.bottle.saveBottle')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ============================================================================
// Sleep Modal (Manual Entry or Edit)
// ============================================================================

const SLEEP_LOCATION_VALUES: (SleepLocation | '')[] = [
  '',
  'crib',
  'bassinet',
  'contact',
  'stroller',
  'car_seat',
  'other',
];

export function SleepModal({
  babyId,
  userId,
  userName,
  existing,
  onClose,
}: {
  babyId: string;
  userId: string;
  userName: string | null;
  existing?: SleepEvent;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const defaultStart = existing
    ? toLocalDateTimeInputValue(existing.startedAt)
    : toLocalDateTimeInputValue(new Date(Date.now() - 45 * 60_000).toISOString());
  const defaultEnd = existing?.endedAt
    ? toLocalDateTimeInputValue(existing.endedAt)
    : toLocalDateTimeInputValue(new Date().toISOString());

  const [category, setCategory] = useState<SleepCategory>(
    existing?.payload.category ?? 'nap',
  );
  const [location, setLocation] = useState<SleepLocation | ''>(
    existing?.payload.location ?? '',
  );
  const [startedLocal, setStartedLocal] = useState(defaultStart);
  const [endedLocal, setEndedLocal] = useState(defaultEnd);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const startedAtIso = fromLocalDateTimeInputValue(startedLocal);
      const endedAtIso = fromLocalDateTimeInputValue(endedLocal);
      if (Date.parse(endedAtIso) < Date.parse(startedAtIso)) {
        setError(t('modals.sleep.endBeforeStart'));
        setSaving(false);
        return;
      }

      if (existing) {
        await updateEvent(existing.id, (prev) => {
          if (prev.type !== 'sleep') {
            throw new Error('Expected sleep event');
          }
          return {
            ...prev,
            startedAt: startedAtIso,
            endedAt: endedAtIso,
            notes: notes.trim() ? notes.trim() : null,
            updatedByUserId: userId,
            payload: {
              category,
              ...(location ? { location } : {}),
            },
          };
        });
      } else {
        await logSleep({
          babyId,
          category,
          ...(location ? { location } : {}),
          userId,
          userName,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          notes: notes.trim() ? notes.trim() : null,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.sleep.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={existing ? t('modals.sleep.editTitle') : t('modals.sleep.logTitle')}
      accentClass="bt-card-sleep"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(['nap', 'night'] as const).map((cat) => (
            <button
              key={cat}
              type="button"
              aria-pressed={category === cat}
              onClick={() => setCategory(cat)}
              className={`bt-focus-ring min-h-[44px] rounded-xl border text-sm font-medium capitalize ${
                category === cat
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
                  : 'border-slate-300 dark:border-slate-700'
              }`}
            >
              {cat === 'nap' ? t('modals.sleep.nap') : t('modals.sleep.night')}
            </button>
          ))}
        </div>

        <div>
          <label htmlFor="sleep-location" className="mb-1 block text-sm font-medium">
            {t('modals.sleep.location')}
          </label>
          <select
            id="sleep-location"
            value={location}
            onChange={(e) => setLocation(e.target.value as SleepLocation | '')}
            className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {SLEEP_LOCATION_VALUES.map((loc) => (
              <option key={loc} value={loc}>
                {t(`modals.sleep.loc.${loc || 'unspecified'}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="sleep-start" className="mb-1 block text-sm font-medium">
              {t('modals.sleep.fellAsleep')}
            </label>
            <input
              id="sleep-start"
              type="datetime-local"
              required
              value={startedLocal}
              onChange={(e) => setStartedLocal(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          <div>
            <label htmlFor="sleep-end" className="mb-1 block text-sm font-medium">
              {t('modals.sleep.wokeUp')}
            </label>
            <input
              id="sleep-end"
              type="datetime-local"
              required
              value={endedLocal}
              onChange={(e) => setEndedLocal(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
        </div>

        <div>
          <label htmlFor="sleep-notes" className="mb-1 block text-sm font-medium">
            {t('common.notes')}
          </label>
          <textarea
            id="sleep-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('modals.sleep.notesPlaceholder')}
            className="bt-focus-ring w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>

        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="bt-focus-ring min-h-[44px] rounded-xl border border-slate-300 px-4 text-sm font-medium dark:border-slate-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="bt-focus-ring min-h-[44px] rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving ? t('common.saving') : t('modals.sleep.saveSleep')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ============================================================================
// Diaper Details / Edit Modal
// ============================================================================

export function DiaperModal({
  babyId,
  userId,
  userName,
  existing,
  onClose,
}: {
  babyId: string;
  userId: string;
  userName: string | null;
  existing?: DiaperEvent;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<DiaperKind>(existing?.payload.kind ?? 'wet');
  const [amount, setAmount] = useState<DiaperAmount | ''>(
    existing?.payload.amount ?? '',
  );
  const [stoolColor, setStoolColor] = useState(
    existing?.payload.stoolColor ?? '',
  );
  const [stoolConsistency, setStoolConsistency] = useState(
    existing?.payload.stoolConsistency ?? '',
  );
  const [hasRash, setHasRash] = useState(existing?.payload.hasRash ?? false);
  const [startedLocal, setStartedLocal] = useState(
    existing
      ? toLocalDateTimeInputValue(existing.startedAt)
      : toLocalDateTimeInputValue(new Date().toISOString()),
  );
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const startedAtIso = fromLocalDateTimeInputValue(startedLocal);
      if (existing) {
        await updateEvent(existing.id, (prev) => {
          if (prev.type !== 'diaper') {
            throw new Error('Expected diaper event');
          }
          return {
            ...prev,
            startedAt: startedAtIso,
            endedAt: startedAtIso,
            notes: notes.trim() ? notes.trim() : null,
            updatedByUserId: userId,
            payload: {
              kind,
              ...(amount ? { amount } : {}),
              ...(stoolColor.trim() ? { stoolColor: stoolColor.trim() } : {}),
              ...(stoolConsistency.trim()
                ? { stoolConsistency: stoolConsistency.trim() }
                : {}),
              hasRash,
            },
          };
        });
      } else {
        await logDiaper({
          babyId,
          kind,
          userId,
          userName,
          startedAt: startedAtIso,
          ...(amount ? { amount } : {}),
          ...(stoolColor.trim() ? { stoolColor: stoolColor.trim() } : {}),
          ...(stoolConsistency.trim()
            ? { stoolConsistency: stoolConsistency.trim() }
            : {}),
          hasRash,
          notes: notes.trim() ? notes.trim() : null,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.diaper.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={existing ? t('modals.diaper.editTitle') : t('modals.diaper.logTitle')}
      accentClass="bt-card-diaper"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {(['wet', 'poopy', 'both'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`bt-focus-ring min-h-[44px] rounded-xl border text-sm font-medium capitalize ${
                kind === k
                  ? 'border-amber-600 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                  : 'border-slate-300 dark:border-slate-700'
              }`}
            >
              {t(`modals.diaper.kind.${k}`)}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="diaper-amount" className="mb-1 block text-sm font-medium">
              {t('modals.diaper.amount')}
            </label>
            <select
              id="diaper-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value as DiaperAmount | '')}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="">{t('common.unspecified')}</option>
              <option value="small">{t('common.small')}</option>
              <option value="medium">{t('common.medium')}</option>
              <option value="large">{t('common.large')}</option>
            </select>
          </div>
          <div>
            <label htmlFor="diaper-time" className="mb-1 block text-sm font-medium">
              {t('modals.diaper.time')}
            </label>
            <input
              id="diaper-time"
              type="datetime-local"
              required
              value={startedLocal}
              onChange={(e) => setStartedLocal(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
        </div>

        {(kind === 'poopy' || kind === 'both') && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="diaper-stool-color" className="mb-1 block text-sm font-medium">
                {t('modals.diaper.stoolColor')}
              </label>
              <input
                id="diaper-stool-color"
                type="text"
                placeholder={t('modals.diaper.stoolColorPlaceholder')}
                value={stoolColor}
                onChange={(e) => setStoolColor(e.target.value)}
                className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div>
              <label htmlFor="diaper-stool-consistency" className="mb-1 block text-sm font-medium">
                {t('modals.diaper.consistency')}
              </label>
              <input
                id="diaper-stool-consistency"
                type="text"
                placeholder={t('modals.diaper.consistencyPlaceholder')}
                value={stoolConsistency}
                onChange={(e) => setStoolConsistency(e.target.value)}
                className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
          </div>
        )}

        <label className="flex min-h-[44px] items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-800">
          <input
            type="checkbox"
            checked={hasRash}
            onChange={(e) => setHasRash(e.target.checked)}
            className="h-5 w-5 rounded border-slate-300 text-rose-600"
          />
          <span className="text-sm font-medium">{t('modals.diaper.rashObserved')}</span>
        </label>

        <div>
          <label htmlFor="diaper-notes" className="mb-1 block text-sm font-medium">
            {t('common.notes')}
          </label>
          <textarea
            id="diaper-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('common.optionalNotes')}
            className="bt-focus-ring w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>

        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="bt-focus-ring min-h-[44px] rounded-xl border border-slate-300 px-4 text-sm font-medium dark:border-slate-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="bt-focus-ring min-h-[44px] rounded-xl bg-amber-600 px-5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {saving ? t('common.saving') : t('modals.diaper.saveDiaper')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ============================================================================
// Spit-Up Modal (Standalone or Linked to Recent Feed)
// ============================================================================

export function SpitUpModal({
  babyId,
  userId,
  userName,
  recentEvents,
  existing,
  onClose,
}: {
  babyId: string;
  userId: string;
  userName: string | null;
  recentEvents: TrackingEvent[];
  existing?: SpitUpEvent;
  onClose: () => void;
}) {
  const { t, formatLocalTime } = useI18n();
  const timeZone = getLocalTimeZone();
  const recentFeeds = recentEvents
    .filter(
      (e): e is BreastFeedEvent | BottleFeedEvent =>
        !e.deletedAt && (e.type === 'breast_feed' || e.type === 'bottle_feed'),
    )
    .slice(0, 8);

  const [severity, setSeverity] = useState<SpitUpSeverity>(
    existing?.payload.severity ?? 'small',
  );
  const [relatedFeedId, setRelatedFeedId] = useState<string>(
    existing?.payload.relatedFeedId ?? '',
  );
  const [startedLocal, setStartedLocal] = useState(
    existing
      ? toLocalDateTimeInputValue(existing.startedAt)
      : toLocalDateTimeInputValue(new Date().toISOString()),
  );
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const startedAtIso = fromLocalDateTimeInputValue(startedLocal);
      const linkedFeed = recentFeeds.find((f) => f.id === relatedFeedId);
      const relatedFeedType: RelatedFeedType | null = linkedFeed
        ? linkedFeed.type
        : existing?.payload.relatedFeedId === relatedFeedId
          ? existing.payload.relatedFeedType ?? null
          : null;

      if (existing) {
        await updateEvent(existing.id, (prev) => {
          if (prev.type !== 'spit_up') {
            throw new Error('Expected spit_up event');
          }
          return {
            ...prev,
            startedAt: startedAtIso,
            endedAt: startedAtIso,
            notes: notes.trim() ? notes.trim() : null,
            updatedByUserId: userId,
            payload: {
              severity,
              relatedFeedId: relatedFeedId || null,
              relatedFeedType,
            },
          };
        });
      } else {
        await logSpitUp({
          babyId,
          userId,
          userName,
          startedAt: startedAtIso,
          severity,
          relatedFeedId: relatedFeedId || null,
          relatedFeedType,
          notes: notes.trim() ? notes.trim() : null,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.spitUp.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={existing ? t('modals.spitUp.editTitle') : t('modals.spitUp.logTitle')}
      accentClass="bt-card-spitup"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <span className="mb-1.5 block text-sm font-medium">
            {t('modals.spitUp.severity')}
          </span>
          <div className="grid grid-cols-3 gap-2">
            {(['small', 'medium', 'large'] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                aria-pressed={severity === sev}
                onClick={() => setSeverity(sev)}
                className={`bt-focus-ring min-h-[44px] rounded-xl border text-sm font-medium capitalize ${
                  severity === sev
                    ? 'border-rose-600 bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-200'
                    : 'border-slate-300 dark:border-slate-700'
                }`}
              >
                {t(`common.${sev}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="spitup-related-feed" className="mb-1 block text-sm font-medium">
            {t('modals.spitUp.relatedFeed')}
          </label>
          <select
            id="spitup-related-feed"
            value={relatedFeedId}
            onChange={(e) => setRelatedFeedId(e.target.value)}
            className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">{t('modals.spitUp.standalone')}</option>
            {recentFeeds.map((f) => (
              <option key={f.id} value={f.id}>
                {t('modals.spitUp.feedAt', {
                  type:
                    f.type === 'breast_feed'
                      ? t('modals.spitUp.feedBreast')
                      : t('modals.spitUp.feedBottle'),
                  time: formatLocalTime(f.startedAt, timeZone),
                })}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="spitup-time" className="mb-1 block text-sm font-medium">
            {t('modals.spitUp.time')}
          </label>
          <input
            id="spitup-time"
            type="datetime-local"
            required
            value={startedLocal}
            onChange={(e) => setStartedLocal(e.target.value)}
            className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>

        <div>
          <label htmlFor="spitup-notes" className="mb-1 block text-sm font-medium">
            {t('common.notes')}
          </label>
          <textarea
            id="spitup-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('common.optionalNotes')}
            className="bt-focus-ring w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>

        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="bt-focus-ring min-h-[44px] rounded-xl border border-slate-300 px-4 text-sm font-medium dark:border-slate-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="bt-focus-ring min-h-[44px] rounded-xl bg-rose-600 px-5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
          >
            {saving ? t('common.saving') : t('modals.spitUp.saveSpitUp')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
