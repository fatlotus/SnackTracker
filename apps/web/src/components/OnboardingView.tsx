import { useState, type FormEvent } from 'react';
import type { Baby, User } from '@baby-tracker/shared';
import { Baby as BabyIcon, LogOut, UserPlus } from 'lucide-react';
import { acceptInvite } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { createBaby } from '../lib/store.js';
import { syncOnce } from '../lib/sync.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';
import { getTodayDateKey, parseInviteInput } from './uiUtils.js';

const AVATAR_COLORS = [
  '#0f766e',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#d97706',
  '#059669',
];

interface OnboardingViewProps {
  user: User;
  onBabyReady: (baby: Baby) => void;
  onLogout: () => void;
}

export function OnboardingView({
  user,
  onBabyReady,
  onLogout,
}: OnboardingViewProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [dob, setDob] = useState(() => getTodayDateKey());
  const [birthWeightGrams, setBirthWeightGrams] = useState('');
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0]!);
  const [notes, setNotes] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [inviteInput, setInviteInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function handleCreateBaby(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const weightNum = birthWeightGrams.trim()
        ? Math.round(Number(birthWeightGrams))
        : null;
      const baby = await createBaby({
        name: name.trim(),
        dob,
        birthWeightGrams:
          weightNum && Number.isFinite(weightNum) && weightNum > 0
            ? weightNum
            : null,
        avatarColor,
        notes: notes.trim() ? notes.trim() : null,
        createdByUserId: user.id,
        createdByDisplayName: user.displayName,
      });
      void syncOnce();
      onBabyReady(baby);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : t('onboarding.createFailed'),
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleJoinInvite(e: FormEvent) {
    e.preventDefault();
    setJoinError(null);
    const code = parseInviteInput(inviteInput);
    if (!code || code.length < 4) {
      setJoinError(t('onboarding.invalidInvite'));
      return;
    }
    setJoining(true);
    try {
      const res = await acceptInvite({ code });
      await syncOnce();
      onBabyReady(res.baby);
    } catch (err) {
      setJoinError(
        err instanceof Error ? err.message : t('onboarding.joinFailed'),
      );
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="bt-surface min-h-screen px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              {t('onboarding.welcome', { name: user.displayName })}
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {t('onboarding.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher variant="compact" />
            <button
              type="button"
              onClick={onLogout}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-stone-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-stone-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <LogOut className="h-4 w-4" />
              <span>{t('onboarding.signOut')}</span>
            </button>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <form
            onSubmit={handleCreateBaby}
            className="bt-card bt-card-breast space-y-4 p-6"
          >
            <div className="flex items-center gap-2.5">
              <div className="bt-badge-breast flex h-10 w-10 items-center justify-center rounded-xl">
                <BabyIcon className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {t('onboarding.addBabyTitle')}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t('onboarding.addBabySubtitle')}
                </p>
              </div>
            </div>

            <div>
              <label
                htmlFor="onboard-baby-name"
                className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                {t('onboarding.babyName')}
              </label>
              <input
                id="onboard-baby-name"
                type="text"
                required
                placeholder={t('onboarding.babyNamePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="onboard-baby-dob"
                  className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  {t('onboarding.dob')}
                </label>
                <input
                  id="onboard-baby-dob"
                  type="date"
                  required
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label
                  htmlFor="onboard-baby-weight"
                  className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  {t('onboarding.birthWeight')}
                </label>
                <input
                  id="onboard-baby-weight"
                  type="number"
                  min={200}
                  max={20000}
                  placeholder={t('onboarding.birthWeightPlaceholder')}
                  value={birthWeightGrams}
                  onChange={(e) => setBirthWeightGrams(e.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
                {t('onboarding.colorTag')}
              </span>
              <div className="flex gap-2">
                {AVATAR_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={t('onboarding.selectColorAria', { color })}
                    onClick={() => setAvatarColor(color)}
                    className={`bt-focus-ring h-9 w-9 rounded-full border-2 transition ${
                      avatarColor === color
                        ? 'scale-110 border-slate-900 dark:border-white'
                        : 'border-transparent opacity-80 hover:opacity-100'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="onboard-baby-notes"
                className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                {t('onboarding.notesOptional')}
              </label>
              <input
                id="onboard-baby-notes"
                type="text"
                placeholder={t('onboarding.notesPlaceholder')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>

            {createError && (
              <p className="text-sm text-rose-600 dark:text-rose-400">
                {createError}
              </p>
            )}

            <button
              type="submit"
              disabled={creating}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
            >
              {creating
                ? t('onboarding.creating')
                : t('onboarding.createBabyProfile')}
            </button>
          </form>

          <form
            onSubmit={handleJoinInvite}
            className="bt-card bt-card-sleep flex flex-col justify-between space-y-4 p-6"
          >
            <div className="space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="bt-badge-sleep flex h-10 w-10 items-center justify-center rounded-xl">
                  <UserPlus className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    {t('onboarding.joinTitle')}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('onboarding.joinSubtitle')}
                  </p>
                </div>
              </div>

              <div>
                <label
                  htmlFor="onboard-invite-code"
                  className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  {t('onboarding.inviteCodeLabel')}
                </label>
                <input
                  id="onboard-invite-code"
                  type="text"
                  required
                  placeholder={t('onboarding.inviteCodePlaceholder')}
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>

              {joinError && (
                <p className="text-sm text-rose-600 dark:text-rose-400">
                  {joinError}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={joining}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {joining ? t('onboarding.joining') : t('onboarding.joinButton')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
