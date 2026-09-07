/**
 * Minimal i18n system for the PKM Assistant plugin.
 * Usage:
 *   import { t, setLocale } from '../i18n/index.js';
 *   setLocale('en');       // call once on plugin init
 *   t('tool.vault_read');  // => "Read note"
 */

import { pl } from './pl.js';
import { en } from './en.js';

/**
 * Słowniki to płaskie mapy `klucz → tekst` (dekret bazy nr 6 kampanii TS: ŻADNEJ unii
 * ~1900 kluczy — `t()` bierze zwykły `string`, a nieznany klucz wraca sam do siebie).
 * Indeks po `string`, bo kod języka przychodzi z ustawień usera, nie z literału.
 */
const locales: Record<string, Record<string, string>> = { pl, en };
let currentLocale = 'en';

/**
 * Set the active locale. Call on plugin init + when user changes language setting.
 * Rozpoznawane kody: `'pl'` i `'en'`. Typ parametru to jednak `string`, bo realni wołacze
 * podają `settings.language` (dowolny tekst z dysku) — nieznany kod jest po cichu ignorowany,
 * i dokładnie po to jest tu `if`.
 * @param {string} lang
 */
export function setLocale(lang: string): void {
  if (locales[lang]) currentLocale = lang;
}

/** Get current locale code */
export function getLocale(): string {
  return currentLocale;
}

/** Get locale string for date/number formatting (e.g. 'pl-PL', 'en-US') */
export function getDateLocale(): string {
  return currentLocale === 'pl' ? 'pl-PL' : 'en-US';
}

/**
 * Translate a key. Supports simple {{param}} interpolation.
 * Falls back: (forced or current) locale → English → key itself.
 * @param {string} key - dot-separated key, e.g. 'tool.vault_read'
 * @param {Object} [params] - interpolation params, e.g. { count: 5 }
 * @param {string} [locale] - E2.8 A6 (S9): wymuś konkretny locale (`'pl'`/`'en'` — per-agent
 *   język odpowiedzi); pomiń → aktualny globalny locale (dotychczasowe zachowanie).
 *   Nierozpoznany kod = to samo co pominięcie.
 * @returns {string}
 */
export function t(key: string, params?: Record<string, unknown>, locale?: string): string {
  const loc = locale && locales[locale] ? locale : currentLocale;
  let str = locales[loc]?.[key] ?? locales.en?.[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // Werdykt Kuby 2026-08-31: split/join zamiast replace(RegExp, String(v)) - wartosc parametru
      // trafia do napisu DOSLOWNIE (tekstowy zamiennik replace interpretuje $&, $`, $', $$), a przy
      // okazji zero kompilacji regexa na kazde wywolanie.
      str = str.split(`{{${k}}}`).join(String(v));
    }
  }
  return str;
}
