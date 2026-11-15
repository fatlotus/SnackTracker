import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeBabyAgeLabel,
  formatDurationShort,
  formatTimeAgo,
  formatVolume,
} from '../components/uiUtils.js';
import { detectInitialLocale, LOCALE_STORAGE_KEY } from './i18n.js';
import i18nSource from './i18n.tsx?raw';

/**
 * Extracts a top-level object literal dictionary (`const <name> ... = { ... }`)
 * from `i18n.tsx` source without modifying `i18n.tsx`.
 */
function extractDictionary(
  source: string,
  constName: string,
): Record<string, string> {
  const declRegex = new RegExp(`const\\s+${constName}\\b[^=]*=\\s*\\{`);
  const match = declRegex.exec(source);
  if (!match) {
    throw new Error(`Could not find dictionary declaration for ${constName}`);
  }

  let i = match.index + match[0].length;
  const result: Record<string, string> = {};

  const skipWhitespaceAndComments = () => {
    while (i < source.length) {
      const ch = source[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i += 1;
      } else if (ch === '/' && source[i + 1] === '/') {
        i += 2;
        while (i < source.length && source[i] !== '\n') i += 1;
      } else if (ch === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
          i += 1;
        }
        i += 2;
      } else {
        break;
      }
    }
  };

  const readString = (): string => {
    const quote = source[i];
    if (quote !== "'" && quote !== '"') {
      throw new Error(
        `Expected string literal at offset ${i} in ${constName}, got ${JSON.stringify(source.slice(i, i + 20))}`,
      );
    }
    i += 1;
    let out = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        const next = source[i + 1];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next !== undefined) out += next;
        i += 2;
      } else if (ch === quote) {
        i += 1;
        return out;
      } else {
        out += ch;
        i += 1;
      }
    }
    throw new Error(`Unterminated string literal in ${constName}`);
  };

  while (i < source.length) {
    skipWhitespaceAndComments();
    if (source[i] === '}') {
      return result;
    }
    const key = readString();
    skipWhitespaceAndComments();
    if (source[i] !== ':') {
      throw new Error(`Expected ':' after key ${key} in ${constName}`);
    }
    i += 1;
    skipWhitespaceAndComments();
    const value = readString();
    result[key] = value;
    skipWhitespaceAndComments();
    if (source[i] === ',') {
      i += 1;
    }
  }

  throw new Error(`Unexpected end of source while parsing ${constName}`);
}

function extractPlaceholders(template: string): string[] {
  const matches = template.match(/\{(\w+)\}/g) ?? [];
  return [...matches].sort();
}

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

describe('i18n dictionaries & parity', () => {
  it('maintains 100% key parity, non-empty values, and matching placeholders between en-US and zh-CN', () => {
    const enUS = extractDictionary(i18nSource, 'enUS');
    const zhCN = extractDictionary(i18nSource, 'zhCN');

    const enKeys = Object.keys(enUS);
    const zhKeys = Object.keys(zhCN);

    expect(enKeys.length).toBeGreaterThan(100);
    expect(zhKeys.length).toBe(enKeys.length);

    const enSet = new Set(enKeys);
    const zhSet = new Set(zhKeys);

    const missingInZh = enKeys.filter((k) => !zhSet.has(k));
    const extraInZh = zhKeys.filter((k) => !enSet.has(k));
    expect(missingInZh).toEqual([]);
    expect(extraInZh).toEqual([]);

    for (const key of enKeys) {
      const enVal = enUS[key];
      const zhVal = zhCN[key];
      expect(enVal, `en-US key "${key}" should be non-empty`).toBeTruthy();
      expect(
        enVal.trim().length,
        `en-US key "${key}" should not be whitespace-only`,
      ).toBeGreaterThan(0);
      expect(zhVal, `zh-CN key "${key}" should be non-empty`).toBeTruthy();
      expect(
        zhVal.trim().length,
        `zh-CN key "${key}" should not be whitespace-only`,
      ).toBeGreaterThan(0);

      expect(
        extractPlaceholders(zhVal),
        `Placeholders for key "${key}" must match between en-US and zh-CN`,
      ).toEqual(extractPlaceholders(enVal));
    }
  });
});

describe('detectInitialLocale', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to en-US when navigator.language is en-US and storage is empty', () => {
    const localStorage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage });
    vi.stubGlobal('navigator', { language: 'en-US' });

    expect(detectInitialLocale()).toBe('en-US');
  });

  it('defaults to en-US for non-zh navigator languages when storage is empty', () => {
    const localStorage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage });
    vi.stubGlobal('navigator', { language: 'fr-FR' });

    expect(detectInitialLocale()).toBe('en-US');
  });

  it('switches to zh-CN when navigator.language is zh-CN or zh-Hans', () => {
    const localStorage = createMemoryStorage();
    vi.stubGlobal('window', { localStorage });

    vi.stubGlobal('navigator', { language: 'zh-CN' });
    expect(detectInitialLocale()).toBe('zh-CN');

    vi.stubGlobal('navigator', { language: 'zh-Hans' });
    expect(detectInitialLocale()).toBe('zh-CN');
  });

  it('respects localStorage.getItem(LOCALE_STORAGE_KEY) over navigator.language', () => {
    vi.stubGlobal('window', {
      localStorage: createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'zh-CN' }),
    });
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(detectInitialLocale()).toBe('zh-CN');

    vi.stubGlobal('window', {
      localStorage: createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'en-US' }),
    });
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    expect(detectInitialLocale()).toBe('en-US');
  });

  it('falls back to navigator.language if localStorage contains an unsupported locale', () => {
    vi.stubGlobal('window', {
      localStorage: createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'es-ES' }),
    });
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    expect(detectInitialLocale()).toBe('zh-CN');
  });
});

describe('uiUtils locale formatting (en-US & zh-CN)', () => {
  it('formats formatDurationShort for en-US and zh-CN', () => {
    expect(formatDurationShort(0, 'en-US')).toBe('0m');
    expect(formatDurationShort(25, 'en-US')).toBe('<1m');
    expect(formatDurationShort(900, 'en-US')).toBe('15m');
    expect(formatDurationShort(3600, 'en-US')).toBe('1h');
    expect(formatDurationShort(5400, 'en-US')).toBe('1h 30m');

    expect(formatDurationShort(0, 'zh-CN')).toBe('0分钟');
    expect(formatDurationShort(25, 'zh-CN')).toBe('<1分钟');
    expect(formatDurationShort(900, 'zh-CN')).toBe('15分钟');
    expect(formatDurationShort(3600, 'zh-CN')).toBe('1小时');
    expect(formatDurationShort(5400, 'zh-CN')).toBe('1小时30分钟');
  });

  it('formats formatTimeAgo for en-US and zh-CN', () => {
    expect(formatTimeAgo(15, 'en-US')).toBe('just now');
    expect(formatTimeAgo(600, 'en-US')).toBe('10m ago');
    expect(formatTimeAgo(7200, 'en-US')).toBe('2h ago');
    expect(formatTimeAgo(9000, 'en-US')).toBe('2h 30m ago');
    expect(formatTimeAgo(93600, 'en-US')).toBe('1d 2h ago');

    expect(formatTimeAgo(15, 'zh-CN')).toBe('刚刚');
    expect(formatTimeAgo(600, 'zh-CN')).toBe('10分钟前');
    expect(formatTimeAgo(7200, 'zh-CN')).toBe('2小时前');
    expect(formatTimeAgo(9000, 'zh-CN')).toBe('2小时30分钟前');
    expect(formatTimeAgo(93600, 'zh-CN')).toBe('1天2小时前');
  });

  it('formats formatVolume for en-US and zh-CN', () => {
    expect(formatVolume(null, 'ml', 'en-US')).toBe('—');
    expect(formatVolume(120, 'ml', 'en-US')).toBe('120 ml');
    expect(formatVolume(60, 'oz', 'en-US')).toBe('2.0 oz');

    expect(formatVolume(null, 'ml', 'zh-CN')).toBe('—');
    expect(formatVolume(120, 'ml', 'zh-CN')).toBe('120 毫升');
    expect(formatVolume(60, 'oz', 'zh-CN')).toBe('2.0 盎司');
  });

  it('formats computeBabyAgeLabel for en-US and zh-CN', () => {
    expect(computeBabyAgeLabel('2026-05-01', '2026-05-10', 'en-US')).toBe('9d old');
    expect(computeBabyAgeLabel('2026-04-01', '2026-04-15', 'en-US')).toBe('2w old');
    expect(computeBabyAgeLabel('2026-04-01', '2026-04-20', 'en-US')).toBe('2w 5d old');
    expect(computeBabyAgeLabel('2026-01-01', '2026-04-05', 'en-US')).toBe('3mo old');

    expect(computeBabyAgeLabel('2026-05-01', '2026-05-10', 'zh-CN')).toBe('9天');
    expect(computeBabyAgeLabel('2026-04-01', '2026-04-15', 'zh-CN')).toBe('2周');
    expect(computeBabyAgeLabel('2026-04-01', '2026-04-20', 'zh-CN')).toBe('2周5天');
    expect(computeBabyAgeLabel('2026-01-01', '2026-04-05', 'zh-CN')).toBe('3个月');
  });
});
