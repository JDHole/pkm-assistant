import test from 'ava';
import { Platform } from 'obsidian';
import { getLocale, setLocale } from '../../../core/i18n/index.js';
import { TriggerPopup } from './TriggerPopup.js';

for (const locale of ['pl', 'en']) {
    for (const platform of ['phone', 'tablet', 'desktop']) {
        test.serial(`U19 header renders, filters and resets: ${platform}, ${locale}`, t => {
            const previous = { isPhone: Platform.isPhone, isMobile: Platform.isMobile, locale: getLocale() };
            Platform.isPhone = platform === 'phone';
            Platform.isMobile = platform !== 'desktop';
            setLocale(locale);
            const wrapper = createDiv();
            const textarea = wrapper.createEl('textarea');
            // The harness DOM does not supply parentElement for createEl children.
            Object.defineProperty(textarea, 'parentElement', { configurable: true, value: wrapper });
            const popup = new TriggerPopup(null, null, textarea, {
                slashCommands: [{ name: '/save' }, { name: '/clear' }],
            });
            t.teardown(() => {
                popup.close();
                wrapper.remove();
                Platform.isPhone = previous.isPhone;
                Platform.isMobile = previous.isMobile;
                setLocale(previous.locale);
            });
            const hint = platform === 'phone'
                ? (locale === 'pl' ? 'Wpisuj aby filtrować' : 'Type to filter')
                : 'Wpisuj aby filtrować • ↑↓ Enter Esc';
            const filtered = platform === 'phone' && locale === 'en' ? 'Filter: save' : 'Filtr: save';
            popup.open();
            // The harness querySelector is a no-op. Supply the browser lookup on
            // the shell produced by open(), so setFilter updates the real header.
            const shell = popup.popupEl!;
            shell.querySelector = ((selector: string) => Array.from(shell.children)
                .find(child => child.className.split(' ').includes(selector.slice(1))) ?? null) as typeof shell.querySelector;
            const header = () => shell.querySelector('.pkm-trigger-popup__header')?.textContent;
            t.is(header(), hint);
            popup.setFilter('save');
            t.is(header(), filtered);
            t.deepEqual(popup.filteredItems.map(item => item.name), ['/save']);
            popup.setFilter('');
            t.is(header(), hint);
            t.deepEqual(popup.filteredItems.map(item => item.name), ['/save', '/clear']);
        });
    }
}
