/**
 * Pin-list strażnik dla kasacji martwego CSS.
 *
 * Dlaczego pin, nie "każdy selektor ma wołacza w .ts": ten arkusz i src/styles.css mają dużo
 * klas budowanych szablonem (`cs-agent-grid--${col}col`, `cs-connector-status--${status}`,
 * `cs-skillbar__token-row--${role}` itd.) - pełny strażnik "klasa z CSS musi mieć literalne
 * odbicie w .ts" dawałby fałszywe alarmy na tych rodzinach. Zamiast tego: pinujemy KONKRETNE
 * selektory, potwierdzone jako martwe, które zostały skasowane - test czerwienieje,
 * jeśli ktoś je kiedyś przez pomyłkę przywróci (np. cherry-pick, revert częściowy).
 *
 * Obok pinu negatywnego (martwe selektory NIE wracają) stoi pin pozytywny (żywe sąsiadki
 * zostają, w tym repin .cs-mem-entry__input → .cs-mem-entry__edit-input).
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const sidebarCss = readFileSync(
    fileURLToPath(new URL('./sidebar/SidebarViews.css', import.meta.url)),
    'utf8',
);
const rootStylesCss = readFileSync(
    fileURLToPath(new URL('../../src/styles.css', import.meta.url)),
    'utf8',
);

// ─── SidebarViews.css: martwe selektory ───
const deadSidebarSelectors = [
    // Rodzina .cs-picker__row* + .cs-picker__list (11 reguł)
    'cs-picker__list',
    'cs-picker__row',
    'cs-picker__row--assigned',
    'cs-picker__row-icon',
    'cs-picker__row-name',
    'cs-picker__row-badges',
    'cs-picker__row-actions',
    // Producent (agentHasSubAgent/renderAgentLinks) bez wołacza - reguły martwe już dziś
    'cs-item-card__agents',
    'cs-agent-link',
    // Pojedyncze sieroty
    'cs-comm-msg__context',
    'cs-profile-hero__badge',
    'cs-shard__detail',
    // Blok pamięci - .cs-mem-add* (rozjazd bez żywego bliźniaka w tym pliku,
    // bo cs-mem-add-row jest już stylowane w src/styles.css:1019) + .cs-mem-entry--editing
    'cs-mem-add {',
    'cs-mem-add:hover',
    'cs-mem-add svg',
    'cs-mem-entry--editing',
    // Rodzina .cs-comm-row* (6 reguł, w tym .theme-light override)
    '.cs-comm-row {',
    '.cs-comm-row:hover',
    'cs-comm-row__name',
    'cs-comm-row__badge',
    // .cs-mem-item--empty*
    'cs-mem-item--empty',
    // Stara nazwa reguły - repięta na cs-mem-entry__edit-input, nie ma już prawa istnieć
    // jako WŁASNY selektor (osobny check niżej pilnuje dokładnie tego)
];

test('SidebarViews.css nie zawiera skasowanych martwych selektorów', t => {
    for (const sel of deadSidebarSelectors) {
        t.false(sidebarCss.includes(sel), `martwy selektor wrócił do SidebarViews.css: ${sel}`);
    }
});

test('SidebarViews.css: .cs-mem-entry__input (stara martwa nazwa) nie istnieje jako selektor', t => {
    // Substring "cs-mem-entry__input" istniałby jako fałszywy alarm w "cs-mem-entry__edit-input"
    // gdyby ktoś zmienił nazwę na coś zawierające ten fragment - sprawdzamy dokładnie starą formę
    // z otwierającą klamrą / pseudo-klasą, którą kasacja usunęła.
    t.false(sidebarCss.includes('.cs-mem-entry__input {'));
    t.false(sidebarCss.includes('.cs-mem-entry__input:focus'));
});

test('SidebarViews.css: żywe sąsiadki martwych rodzin zostały (pin pozytywny)', t => {
    t.true(sidebarCss.includes('.cs-picker { margin: 8px 0; }'), '.cs-picker (root pickera) żyje');
    t.true(sidebarCss.includes('cs-picker__empty'), 'reszta rodziny .cs-picker (dropdown) żyje');
    t.true(sidebarCss.includes('.cs-shard__action'), '.cs-shard__action żyje po wycięciu __detail z grupy');
    t.true(sidebarCss.includes('.cs-mem-entry__edit-input {'), 'repin na żywą nazwę malowaną w profile_memory.ts');
    t.true(sidebarCss.includes('.cs-mem-entry__edit-input:focus'), 'repin :focus też przeniesiony');
    t.true(sidebarCss.includes('cs-mem-entry__text'), '.cs-mem-entry__text (żywa) nie ruszona');
    t.true(sidebarCss.includes('cs-mem-item__size'), '.cs-mem-item__size (żywa) nie ruszona');
    t.true(sidebarCss.includes('cs-comm-home-chip'), '.cs-comm-home-chip (inna rodzina, żywa) nie ruszona');
});

// ─── src/styles.css: martwe selektory ───
const deadRootSelectors = [
    // [data-agent-color=...] - 8 reguł, atrybutu nikt nie nadaje
    '[data-agent-color=',
    // Utility classes bez producenta w kodzie
    '.cs-agent-accent {',
    '.cs-agent-bg {',
    '.cs-agent-border {',
    '.cs-agent-glow {',
    '.cs-crystal-enter {',
    '.cs-send-pulse {',
    '.cs-message-enter {',
    '.cs-connector-pulse {',
    // Keyframes przechodnio martwe (jedyny animation: użytkownik był w martwej klasie wyżej)
    '@keyframes cs-send-pulse',
    '@keyframes cs-connector-pulse',
    // .cs-archive-modal__cost-line - reguła osierocona, bo ArchiveModal (jedyny konsument) już nie istnieje
    '.cs-archive-modal__cost-line',
];

test('src/styles.css nie zawiera skasowanych martwych selektorów/keyframes', t => {
    for (const sel of deadRootSelectors) {
        t.false(rootStylesCss.includes(sel), `martwy selektor/keyframe wrócił do src/styles.css: ${sel}`);
    }
});

test('src/styles.css: żywe zmienne/keyframes/klasy z tego samego bloku zostały (pin pozytywny)', t => {
    t.true(rootStylesCss.includes('--cs-agent-glow:'), 'zmienna --cs-agent-glow (inna rzecz niż klasa .cs-agent-glow) żyje');
    t.true(rootStylesCss.includes('.cs-breathing {'), '.cs-breathing (jedyna żywa utility class w bloku) żyje');
    t.true(rootStylesCss.includes('@keyframes cs-crystal-build'), 'cs-crystal-build żywy przez chat_view.css');
    t.true(rootStylesCss.includes('@keyframes cs-message-enter'), 'cs-message-enter żywy przez chat_view.css (bezpośrednio, nie przez utility class)');
    t.true(rootStylesCss.includes('@keyframes cs-glow-pulse'), 'cs-glow-pulse nietknięty');
    t.true(rootStylesCss.includes('input.cs-mem-input {'), 'żywy następca .cs-mem-add* (src/styles.css:~1015) nie ruszony');
    t.true(rootStylesCss.includes('.cs-mem-add-row {'), 'żywy następca .cs-mem-add* (src/styles.css:~1019) nie ruszony');
    // JEDYNA żywa klasa powiadomień - kontener guzików akcji stawia ją `NoticeCenter`.
    t.true(rootStylesCss.includes('.pkm-notice-actions'), 'klasa kontenera guzików powiadomienia zniknęła z arkusza');
});
