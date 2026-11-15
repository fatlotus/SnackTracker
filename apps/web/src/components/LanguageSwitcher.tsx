import { Languages } from 'lucide-react';
import { useI18n, type Locale } from '../lib/i18n.js';

interface LanguageSwitcherProps {
  testId?: string;
  variant?: 'compact' | 'full';
}

const OPTIONS: { locale: Locale; labelKey: 'lang.en' | 'lang.zh' }[] = [
  { locale: 'en-US', labelKey: 'lang.en' },
  { locale: 'zh-CN', labelKey: 'lang.zh' },
];

export function LanguageSwitcher({
  testId = 'language-switcher',
  variant = 'full',
}: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();
  const isCompact = variant === 'compact';

  return (
    <div
      role="group"
      aria-label={t('lang.ariaLabel')}
      data-testid={testId || undefined}
      className={`inline-flex items-center rounded-xl border border-stone-200 bg-stone-100/90 p-0.5 shadow-2xs dark:border-slate-700 dark:bg-slate-800/90 ${
        isCompact ? 'gap-0.5' : 'gap-1'
      }`}
    >
      {!isCompact && (
        <span className="pl-2 pr-0.5 text-slate-500 dark:text-slate-400" aria-hidden="true">
          <Languages className="h-3.5 w-3.5" />
        </span>
      )}
      {OPTIONS.map((opt) => {
        const active = locale === opt.locale;
        return (
          <button
            key={opt.locale}
            type="button"
            aria-pressed={active}
            onClick={() => setLocale(opt.locale)}
            className={`bt-focus-ring rounded-lg font-semibold transition ${
              isCompact
                ? 'min-h-[38px] px-2 text-xs'
                : 'min-h-[36px] px-2.5 text-xs'
            } ${
              active
                ? 'bg-white text-teal-700 shadow-xs dark:bg-slate-900 dark:text-teal-300'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            {t(opt.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
