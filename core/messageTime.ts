import { getLocale, t } from './i18n/index.js';

/** Render once at message creation; the clock can be supplied by callers and tests. */
export function messageTime(clock: () => Date = () => new Date(), locale = getLocale()): string {
    const date = clock();
    const pad = (n: number) => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const zone = `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    const day = new Intl.DateTimeFormat(locale === 'pl' ? 'pl-PL' : 'en-US', { weekday: 'long' }).format(date);
    const value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}, ${day}, ${zone}`;
    return t('message.time_line', { value }, locale);
}
