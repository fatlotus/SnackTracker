import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  Baby,
  BabyInvitePublic,
  BabyMember,
  InviteRole,
  User,
} from '@baby-tracker/shared';
import {
  Archive,
  Check,
  Copy,
  Link2,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  acceptInvite,
  createBabyInvite,
  listBabyMembers as fetchBabyMembersApi,
  removeBabyMember,
} from '../lib/api.js';
import {
  createBaby,
  listBabyMembers as listBabyMembersIdb,
  updateBaby,
} from '../lib/store.js';
import { syncOnce, type SyncStatus } from '../lib/sync.js';
import { useI18n } from '../lib/i18n.js';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';
import {
  getTodayDateKey,
  parseInviteInput,
  type ThemePreference,
  type VolumeUnit,
} from '../components/uiUtils.js';

interface SettingsSharePageProps {
  user: User;
  baby: Baby;
  syncStatus: SyncStatus;
  theme: ThemePreference;
  volumeUnit: VolumeUnit;
  onChangeTheme: (theme: ThemePreference) => void;
  onChangeVolumeUnit: (unit: VolumeUnit) => void;
  onSelectBaby: (babyId: string) => void;
  onLogout: () => void;
}

export function SettingsSharePage({
  user,
  baby,
  syncStatus,
  theme,
  volumeUnit,
  onChangeTheme,
  onChangeVolumeUnit,
  onSelectBaby,
  onLogout,
}: SettingsSharePageProps) {
  const { t, locale } = useI18n();
  // Edit Baby Profile
  const [editName, setEditName] = useState(baby.name);
  const [editDob, setEditDob] = useState(baby.dob);
  const [editWeight, setEditWeight] = useState(
    baby.birthWeightGrams != null ? String(baby.birthWeightGrams) : '',
  );
  const [editNotes, setEditNotes] = useState(baby.notes ?? '');
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    setEditName(baby.name);
    setEditDob(baby.dob);
    setEditWeight(
      baby.birthWeightGrams != null ? String(baby.birthWeightGrams) : '',
    );
    setEditNotes(baby.notes ?? '');
    setProfileError(null);
    setConfirmArchive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baby.id]);

  // Add another baby
  const [showAddBaby, setShowAddBaby] = useState(false);
  const [newBabyName, setNewBabyName] = useState('');
  const [newBabyDob, setNewBabyDob] = useState(() => getTodayDateKey());
  const [addBabyError, setAddBabyError] = useState<string | null>(null);

  // Sharing & Members
  const [members, setMembers] = useState<BabyMember[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<InviteRole>('caregiver');
  const [generatedInvite, setGeneratedInvite] =
    useState<BabyInvitePublic | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Join another baby
  const [joinInput, setJoinInput] = useState('');
  const [joinMsg, setJoinMsg] = useState<string | null>(null);

  const membersSeqRef = useRef(0);

  const loadMembers = useCallback(async () => {
    const seq = ++membersSeqRef.current;
    const targetBabyId = baby.id;
    setMembersError(null);
    try {
      const res = await fetchBabyMembersApi(targetBabyId);
      if (seq !== membersSeqRef.current) return;
      setMembers(res.members.filter((m) => !m.deletedAt));
    } catch {
      // Fallback to IDB cache when offline
      try {
        const local = await listBabyMembersIdb(targetBabyId);
        if (seq !== membersSeqRef.current) return;
        setMembers(local);
      } catch (err) {
        if (seq !== membersSeqRef.current) return;
        setMembersError(
          err instanceof Error ? err.message : t('settings.err.loadMembers'),
        );
      }
    }
  }, [baby.id, t]);

  useEffect(() => {
    void loadMembers();
    return () => {
      membersSeqRef.current += 1;
    };
  }, [loadMembers]);

  async function handleSaveBaby(e: FormEvent) {
    e.preventDefault();
    setProfileError(null);
    try {
      const w = editWeight.trim() ? Math.round(Number(editWeight)) : null;
      await updateBaby(baby.id, {
        name: editName.trim(),
        dob: editDob,
        birthWeightGrams: w && Number.isFinite(w) && w > 0 ? w : null,
        notes: editNotes.trim() ? editNotes.trim() : null,
      });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
    } catch (err) {
      setProfileError(
        err instanceof Error ? err.message : t('settings.err.saveBaby'),
      );
    }
  }

  async function handleArchiveBaby() {
    setProfileError(null);
    try {
      await updateBaby(baby.id, { isArchived: true });
      setConfirmArchive(false);
    } catch (err) {
      setProfileError(
        err instanceof Error ? err.message : t('settings.err.archiveBaby'),
      );
    }
  }

  async function handleCreateAnotherBaby(e: FormEvent) {
    e.preventDefault();
    if (!newBabyName.trim()) return;
    setAddBabyError(null);
    try {
      const created = await createBaby({
        name: newBabyName.trim(),
        dob: newBabyDob,
        createdByUserId: user.id,
      });
      setNewBabyName('');
      setShowAddBaby(false);
      onSelectBaby(created.id);
    } catch (err) {
      setAddBabyError(
        err instanceof Error ? err.message : t('settings.err.createBaby'),
      );
    }
  }

  async function handleGenerateInvite() {
    setInviteError(null);
    try {
      const res = await createBabyInvite(baby.id, {
        role: inviteRole,
        expiresInHours: 48,
      });
      setGeneratedInvite(res.invite);
    } catch (err) {
      setInviteError(
        err instanceof Error ? err.message : t('settings.err.generateInvite'),
      );
    }
  }

  async function handleCopyInviteLink() {
    if (!generatedInvite) return;
    setInviteError(null);
    const origin =
      typeof window !== 'undefined' ? window.location.origin : '';
    const link = `${origin}/join/${generatedInvite.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      setInviteError(
        err instanceof Error ? err.message : t('settings.err.copyInvite'),
      );
    }
  }

  async function handleRemoveMember(targetUserId: string) {
    setMembersError(null);
    try {
      await removeBabyMember(baby.id, targetUserId);
      await syncOnce();
      await loadMembers();
    } catch (err) {
      setMembersError(
        err instanceof Error ? err.message : t('settings.err.removeMember'),
      );
    }
  }

  async function handleJoinByCode(e: FormEvent) {
    e.preventDefault();
    setJoinMsg(null);
    const code = parseInviteInput(joinInput);
    if (!code || code.length < 4) {
      setJoinMsg(t('settings.err.invalidInvite'));
      return;
    }
    try {
      const res = await acceptInvite({ code });
      await syncOnce();
      setJoinInput('');
      onSelectBaby(res.baby.id);
    } catch (err) {
      setJoinMsg(
        err instanceof Error ? err.message : t('settings.err.joinBaby'),
      );
    }
  }

  const inviteUrl =
    generatedInvite && typeof window !== 'undefined'
      ? `${window.location.origin}/join/${generatedInvite.code}`
      : generatedInvite
        ? `/join/${generatedInvite.code}`
        : '';

  const formatRole = (role: string) => {
    if (locale === 'zh-CN') {
      if (role === 'owner') return '创建者';
      if (role === 'caregiver') return '照护者';
      if (role === 'viewer') return '查看者';
    }
    return role;
  };

  const syncStateLabel =
    syncStatus.state === 'offline'
      ? t('app.sync.offline')
      : syncStatus.state === 'syncing'
        ? t('app.sync.syncing')
        : syncStatus.state === 'error'
          ? t('app.sync.error')
          : t('app.sync.synced');

  return (
    <div className="space-y-6">
      {/* Baby Profile */}
      <section className="bt-card space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            {t('settings.babyProfileTitle', { name: baby.name })}
          </h2>
          <button
            type="button"
            onClick={() => setShowAddBaby((v) => !v)}
            className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <Plus className="h-4 w-4" />
            <span>{t('settings.addAnotherBaby')}</span>
          </button>
        </div>

        {showAddBaby && (
          <form
            onSubmit={handleCreateAnotherBaby}
            className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/50 p-4 dark:border-teal-900 dark:bg-teal-950/30"
          >
            <h3 className="text-sm font-semibold">{t('settings.newBaby')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="new-baby-name"
                  className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t('settings.babyName')}
                </label>
                <input
                  id="new-baby-name"
                  type="text"
                  required
                  placeholder={t('settings.babyNamePlaceholder')}
                  value={newBabyName}
                  onChange={(e) => setNewBabyName(e.target.value)}
                  className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label
                  htmlFor="new-baby-dob"
                  className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t('settings.dob')}
                </label>
                <input
                  id="new-baby-dob"
                  type="date"
                  required
                  value={newBabyDob}
                  onChange={(e) => setNewBabyDob(e.target.value)}
                  className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            {addBabyError && (
              <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
                {addBabyError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddBaby(false)}
                className="bt-focus-ring min-h-[44px] rounded-xl px-3 text-sm"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="bt-focus-ring min-h-[44px] rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white"
              >
                {t('settings.createBaby')}
              </button>
            </div>
          </form>
        )}

        <form onSubmit={handleSaveBaby} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label
                htmlFor="edit-baby-name"
                className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                {t('settings.name')}
              </label>
              <input
                id="edit-baby-name"
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div>
              <label
                htmlFor="edit-baby-dob"
                className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                {t('settings.dobShort')}
              </label>
              <input
                id="edit-baby-dob"
                type="date"
                required
                value={editDob}
                onChange={(e) => setEditDob(e.target.value)}
                className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div>
              <label
                htmlFor="edit-baby-weight"
                className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
              >
                {t('settings.birthWeight')}
              </label>
              <input
                id="edit-baby-weight"
                type="number"
                min={200}
                max={20000}
                value={editWeight}
                onChange={(e) => setEditWeight(e.target.value)}
                className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="edit-baby-notes"
              className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              {t('settings.notes')}
            </label>
            <input
              id="edit-baby-notes"
              type="text"
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          {profileError && (
            <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
              {profileError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {confirmArchive ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-rose-700 dark:text-rose-300">
                  {t('settings.archiveConfirm', { name: baby.name })}
                </span>
                <button
                  type="button"
                  onClick={() => void handleArchiveBaby()}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center rounded-xl bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700"
                >
                  {t('settings.confirmArchive')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmArchive(false)}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center rounded-xl border border-slate-300 px-3 text-xs font-medium dark:border-slate-700"
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmArchive(true)}
                className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-rose-200 px-3 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400"
              >
                <Archive className="h-4 w-4" />
                <span>{t('settings.archiveBaby')}</span>
              </button>
            )}
            <button
              type="submit"
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700"
            >
              {profileSaved ? (
                <>
                  <Check className="h-4 w-4" />
                  <span>{t('common.saved')}</span>
                </>
              ) : (
                <span>{t('settings.saveChanges')}</span>
              )}
            </button>
          </div>
        </form>
      </section>

      {/* Family & Sharing */}
      <section className="bt-card bt-card-sleep space-y-4 p-5">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-teal-600" />
          <h2 className="text-base font-semibold">
            {t('settings.familyCaregivers')}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('settings.inviteRoleAria')}
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as InviteRole)}
            className="bt-focus-ring min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="caregiver">{t('settings.role.caregiver')}</option>
            <option value="viewer">{t('settings.role.viewer')}</option>
          </select>
          <button
            type="button"
            onClick={() => void handleGenerateInvite()}
            className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            <Link2 className="h-4 w-4" />
            <span>{t('settings.generateInviteLink')}</span>
          </button>
        </div>

        {inviteError && (
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {inviteError}
          </p>
        )}

        {generatedInvite && (
          <div className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3.5 dark:border-indigo-900 dark:bg-indigo-950/50">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                {t('settings.codeLabel')} <code>{generatedInvite.code}</code> (
                {formatRole(generatedInvite.role)})
              </span>
              <button
                type="button"
                onClick={() => void handleCopyInviteLink()}
                className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg bg-white px-3 text-xs font-semibold text-indigo-700 shadow-xs dark:bg-slate-900 dark:text-indigo-300"
              >
                {copiedLink ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('settings.copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>{t('settings.copyLink')}</span>
                  </>
                )}
              </button>
            </div>
            <p className="break-all font-mono text-xs text-indigo-700 dark:text-indigo-300">
              {inviteUrl}
            </p>
          </div>
        )}

        {membersError && (
          <p className="text-sm text-rose-600 dark:text-rose-400">
            {membersError}
          </p>
        )}

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {members.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between py-2.5 text-sm"
            >
              <div>
                <span className="font-medium">
                  {m.displayName ?? m.userId}
                  {m.userId === user.id ? t('settings.youSuffix') : ''}
                </span>
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {formatRole(m.role)}
                </span>
              </div>
              {m.role !== 'owner' && (
                <button
                  type="button"
                  onClick={() => void handleRemoveMember(m.userId)}
                  className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>
                    {m.userId === user.id
                      ? t('settings.leave')
                      : t('settings.remove')}
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Join another baby */}
        <form
          onSubmit={handleJoinByCode}
          className="border-t border-slate-100 pt-4 dark:border-slate-800"
        >
          <label
            htmlFor="join-invite-code"
            className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400"
          >
            {t('settings.joinAnotherBaby')}
          </label>
          <div className="flex gap-2">
            <input
              id="join-invite-code"
              type="text"
              placeholder={t('settings.joinPlaceholder')}
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              className="bt-focus-ring min-h-[44px] flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <button
              type="submit"
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white dark:bg-slate-100 dark:text-slate-900"
            >
              <UserPlus className="h-4 w-4" />
              <span>{t('settings.join')}</span>
            </button>
          </div>
          {joinMsg && (
            <p role="alert" className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">
              {joinMsg}
            </p>
          )}
        </form>
      </section>

      {/* Preferences & Account */}
      <section className="bt-card space-y-4 p-5">
        <h2 className="text-base font-semibold">
          {t('settings.preferencesAccount')}
        </h2>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {locale === 'zh-CN' ? '语言' : 'Language'}
          </span>
          <LanguageSwitcher testId="settings-language-switcher" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('settings.theme')}
            </span>
            <div className="grid grid-cols-3 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              {(['light', 'dark', 'system'] as const).map((themeOpt) => (
                <button
                  key={themeOpt}
                  type="button"
                  aria-pressed={theme === themeOpt}
                  onClick={() => onChangeTheme(themeOpt)}
                  className={`bt-focus-ring min-h-[44px] rounded-lg text-xs font-semibold capitalize ${
                    theme === themeOpt
                      ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t(`settings.theme.${themeOpt}`)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('settings.bottleVolumeUnit')}
            </span>
            <div className="grid grid-cols-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              {(['ml', 'oz'] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={volumeUnit === u}
                  onClick={() => onChangeVolumeUnit(u)}
                  className={`bt-focus-ring min-h-[44px] rounded-lg text-xs font-semibold uppercase ${
                    volumeUnit === u
                      ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t(`common.${u}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {t('settings.signedInAs')} <strong>{user.displayName}</strong> (
            {user.email}) · {t('settings.syncLabel')}{' '}
            <strong className="capitalize">{syncStateLabel}</strong>{' '}
            {t('settings.pendingCount', { count: syncStatus.pendingCount })}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void syncOnce()}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 px-3 text-xs font-semibold hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <RefreshCw
                className={`h-4 w-4 ${syncStatus.state === 'syncing' ? 'animate-spin' : ''}`}
              />
              <span>{t('settings.syncNow')}</span>
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="bt-focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white hover:bg-rose-700"
            >
              <LogOut className="h-4 w-4" />
              <span>{t('settings.signOut')}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
