import type { Baby } from '@baby-tracker/shared';
import { ChevronDown, Plus } from 'lucide-react';
import { useI18n } from '../lib/i18n.js';

interface BabySwitcherProps {
  babies: Baby[];
  activeBaby: Baby;
  onSelectBaby: (babyId: string) => void;
  onManageBabies: () => void;
  compact?: boolean;
}

export function BabySwitcher({
  babies,
  activeBaby,
  onSelectBaby,
  onManageBabies,
  compact = false,
}: BabySwitcherProps) {
  const { t, computeBabyAgeLabel } = useI18n();

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1 min-w-0">
        <div className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white shadow-2xs"
            style={{ backgroundColor: activeBaby.avatarColor || '#0f766e' }}
          >
            {activeBaby.name.slice(0, 1).toUpperCase()}
          </span>
        </div>
        <select
          aria-label={t('babySwitcher.selectAria')}
          value={activeBaby.id}
          onChange={(e) => onSelectBaby(e.target.value)}
          className={`bt-focus-ring w-full appearance-none rounded-xl border border-stone-200 bg-white pl-10 pr-8 font-semibold text-slate-900 shadow-2xs focus:border-teal-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${
            compact ? 'min-h-[44px] py-1.5 text-sm' : 'min-h-[44px] py-2 text-sm'
          }`}
        >
          {babies.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({computeBabyAgeLabel(b.dob)})
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </div>
      {!compact && (
        <button
          type="button"
          onClick={onManageBabies}
          title={t('babySwitcher.manageAria')}
          aria-label={t('babySwitcher.manageAria')}
          className="bt-focus-ring inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-stone-200 bg-white text-slate-700 shadow-2xs hover:bg-stone-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
