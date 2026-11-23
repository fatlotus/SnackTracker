import { useEffect, useState, type FormEvent } from 'react';
import type { User } from '@baby-tracker/shared';
import { Baby as BabyIcon, Link2, WifiOff } from 'lucide-react';
import { login, register } from '../lib/auth.js';
import { useI18n } from '../lib/i18n.js';
import { isNavigatorOffline } from '../lib/sync.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';

interface AuthViewProps {
  pendingInviteCode: string | null;
  onAuthenticated: (user: User) => void;
  onClearInvite?: () => void;
}

export function AuthView({
  pendingInviteCode,
  onAuthenticated,
  onClearInvite,
}: AuthViewProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const verifyConnectivity = async () => {
      if (!isNavigatorOffline()) {
        if (!cancelled) setIsOffline(false);
        return;
      }
      try {
        const res = await fetch('/healthz', { cache: 'no-store' });
        if (!cancelled) setIsOffline(!res.ok);
      } catch {
        if (!cancelled) setIsOffline(true);
      }
    };

    const handleOnline = () => {
      if (!cancelled) setIsOffline(false);
    };
    const handleOffline = () => {
      if (!cancelled) setIsOffline(true);
    };

    void verifyConnectivity();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user =
        mode === 'login'
          ? await login({ email: email.trim(), password })
          : await register({
              email: email.trim(),
              password,
              displayName: displayName.trim(),
            });
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bt-surface min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2.5">
          <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-md shadow-teal-600/20">
            <BabyIcon className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t('auth.title')}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t('auth.subtitle')}
          </p>
        </div>

        {pendingInviteCode && (
          <div className="flex items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-200">
            <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-teal-600 dark:text-teal-400" />
            <div className="flex-1">
              <p className="font-semibold">{t('auth.invitePending')}</p>
              <p className="mt-0.5 text-xs opacity-90">
                {t('auth.invitePromptPrefix')}{' '}
                <code className="rounded bg-teal-100 px-1.5 py-0.5 font-mono font-semibold dark:bg-teal-900">
                  {pendingInviteCode}
                </code>
                .
              </p>
            </div>
            {onClearInvite && (
              <button
                type="button"
                onClick={onClearInvite}
                className="text-xs underline opacity-75 hover:opacity-100"
              >
                {t('auth.dismiss')}
              </button>
            )}
          </div>
        )}

        {isOffline && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
            <WifiOff className="h-4 w-4 shrink-0" />
            <span>{t('auth.offlineNotice')}</span>
          </div>
        )}

        <div className="bt-card p-6">
          <div className="mb-4 flex justify-end">
            <LanguageSwitcher />
          </div>

          <div
            role="tablist"
            aria-label={t('auth.modeAria')}
            className="mb-5 grid grid-cols-2 rounded-xl bg-stone-100 p-1 dark:bg-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`bt-focus-ring min-h-[44px] rounded-lg text-sm font-medium transition ${
                mode === 'login'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t('auth.signIn')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`bt-focus-ring min-h-[44px] rounded-lg text-sm font-medium transition ${
                mode === 'register'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t('auth.createAccount')}
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label
                  htmlFor="auth-display-name"
                  className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  {t('auth.yourName')}
                </label>
                <input
                  id="auth-display-name"
                  type="text"
                  required
                  autoComplete="name"
                  placeholder={t('auth.yourNamePlaceholder')}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
            )}

            <div>
              <label
                htmlFor="auth-email"
                className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                {t('auth.email')}
              </label>
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="auth-password"
                className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                {t('auth.password')}
              </label>
              <input
                id="auth-password"
                type="password"
                required
                minLength={mode === 'register' ? 8 : 1}
                autoComplete={
                  mode === 'login' ? 'current-password' : 'new-password'
                }
                placeholder={
                  mode === 'register'
                    ? t('auth.passwordRegisterPlaceholder')
                    : t('auth.passwordLoginPlaceholder')
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="bt-focus-ring min-h-[44px] w-full rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
            >
              {submitting
                ? mode === 'login'
                  ? t('auth.signingIn')
                  : t('auth.creatingAccount')
                : mode === 'login'
                  ? t('auth.signIn')
                  : t('auth.createAccount')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
