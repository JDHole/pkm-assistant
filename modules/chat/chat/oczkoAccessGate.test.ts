/**
 * Strażnik PO ŹRÓDLE: wołacz Oczka (i @-wzmianki) przepuszczają ścieżki przez PEŁNĄ bramkę
 * uprawnień agenta tury — K23 / AUD-security-119.
 *
 * DLACZEGO PO ŹRÓDLE, A NIE BEHAWIORALNIE: `chat_model.ts` importuje `obsidian` (`Notice`)
 * i całą warstwę UI, więc w AVA nie da się go zaimportować. Ten sam wzór i ten sam powód,
 * co `core/PKMEnv.boot_timing.test.ts` — plik czyta własne źródło zamiast wołać moduł.
 * Zachowanie samej bramki obrazów jest przetestowane naprawdę, po stronie producenta:
 * `modules/multimodal/active_note.test.ts` (testy K23).
 *
 * CO PILNUJE: żeby nikt po cichu nie wyciął przekazania predykatu — bez niego Oczko wraca
 * do stanu ze znaleziska, czyli wczytuje osadzone `![[…]]` obrazy z dowolnego miejsca
 * w vaultcie (także ze strefy No-Go) i wysyła ich bajty do dostawcy modelu.
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./chat_model.ts', import.meta.url), 'utf8');

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, nie opisów historii (wzór stopSemantics.test.ts). */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Ciało funkcji najwyższego poziomu — od sygnatury do domknięcia w kolumnie 0. */
function fnBody(name: string): string {
    const re = new RegExp(`export async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`);
    return source.match(re)?.[1] || '';
}

/** To samo dla funkcji modułowej (nieeksportowanej), po odcięciu komentarzy. */
function plainFnBody(name: string): string {
    const re = new RegExp(`\\nfunction ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`);
    return code.match(re)?.[1] || '';
}

test('K23: wolacz Oczka przekazuje predykat dostepu do obrazow', t => {
    const body = fnBody('_buildActiveNoteContext');
    t.not(body, '', 'nie znalazłem ciała _buildActiveNoteContext — zmieniła się sygnatura');

    t.regex(body, /buildActiveNoteContext\(\s*this\.app/, 'Oczko przestało być wołane z this.app');
    t.regex(
        body,
        /canReadImage\s*:/,
        'wołacz Oczka przestał przekazywać predykat canReadImage — osadzone obrazy wracają bez bramki'
    );
});

// AUD-testy-025: SAMA DECYZJA bramki (pełne `checkPermission('vault.read', …)`, fail-closed bez
// systemu uprawnień, fail-closed przy rzucie) mieszka od tej naprawy w `vaultReadGate.ts` i ma tam
// testy ZACHOWANIA — `vaultReadGate.test.ts`. Dawny strażnik mierzył tu obecność napisu
// `checkPermission(agent, 'vault.read'`, więc podmiana `return …allowed === true;` na
// `checkPermission(…); return true;` (bramka otwarta na oścież) przechodziła na zielono.
// Tutaj pilnujemy już tylko OKABLOWANIA: że `chat_model.ts` podaje bramce trzy właściwe rzeczy
// z pluginu i niczego nie liczy sam.

test('K23: predykat woła wspólną bramkę i podaje jej system uprawnień + agenta tury', t => {
    t.regex(
        source,
        /import \{ createVaultReadPredicate \} from '\.\/vaultReadGate\.js';/,
        'predykat przestał brać decyzję z vaultReadGate — logika wraca do pliku, którego AVA nie zaimportuje'
    );
    t.regex(
        source,
        /return createVaultReadPredicate\(\{[\s\S]{0,400}?permissionSystem:\s*view\?\.plugin\?\.permissionSystem,/,
        'bramka przestała dostawać `plugin.permissionSystem` — to ta sama bramka co narzędzie `read`'
    );
    t.regex(
        source,
        /resolveAgent:\s*\(\)\s*=>\s*view\?\.plugin\?\.agentManager\?\.getActiveAgent\?\.\(\)/,
        'predykat przestał ustalać agenta tury'
    );
    t.regex(
        source,
        /onError:\s*\([\s\S]{0,40}?\)\s*=>\s*log\.warn\('Chat',\s*'vault\.read gate threw/,
        'rzut bramki musi trafiać do logu — cicha odmowa czyni śledztwo ślepym'
    );
});

test('K23: predykat NIE MA innej drogi wyjścia niż wspólna bramka (AUD-testy-025)', t => {
    // Bez tej asercji wystarczyło dopisać `if (view) return () => true;` PRZED wywołaniem
    // bramki: napis `createVaultReadPredicate(` zostawał w źródle, a Oczko i @-wzmianki
    // przepuszczały każdą ścieżkę. Ciało predykatu ma być JEDNYM returnem.
    const body = plainFnBody('_vaultReadPredicate');
    t.not(body, '', 'nie znalazłem ciała _vaultReadPredicate — zmieniła się sygnatura');
    const returns = body.match(/\breturn\b/g) || [];
    t.is(returns.length, 1, `predykat ma ${returns.length} wyjść — każde dodatkowe omija bramkę uprawnień`);
    t.regex(body.trimStart(), /^return createVaultReadPredicate\(\{/,
        'pierwszą (i jedyną) instrukcją predykatu musi być oddanie wspólnej bramki');
});

test('K23: chat_model.ts nie liczy dostępu sam (żadnej drugiej kopii bramki)', t => {
    t.false(
        /checkPermission\(/.test(code),
        'wróciło własne wołanie checkPermission w chat_model.ts — decyzja ma być JEDNA, w vaultReadGate.ts'
    );
    t.false(
        /allowed === true/.test(code),
        'wróciło własne rozstrzyganie werdyktu uprawnień w chat_model.ts'
    );
});

test('K23: @-wzmianki nie stoja juz na golym AccessGuard._isNoGo', t => {
    // Szukamy WYWOŁANIA, nie wzmianki — nazwa pada też w komentarzu tłumaczącym, po czym
    // ta gałąź została przepięta (inaczej strażnik zapalałby się od własnej dokumentacji).
    t.false(
        /AccessGuard\._isNoGo\s*\(/.test(source),
        'wróciło gołe AccessGuard._isNoGo — pełna bramka (whitelista focusFolders, pliki chronione, admin_access) znów pomijana'
    );
    t.false(
        /^import \{[^}]*AccessGuard[^}]*\} from/m.test(source),
        'AccessGuard wrócił do importów chat_model — o dostępie ma tu decydować checkPermission, nie pojedynczy strażnik'
    );
    const mentions = fnBody('_resolveMentions');
    t.not(mentions, '', 'nie znalazłem ciała _resolveMentions — zmieniła się sygnatura');
    t.regex(mentions, /const canRead = _vaultReadPredicate\(this\);/,
        '@-wzmianki przestały pytać wspólnego predykatu o dostęp');
    // AUD-testy-025: obecność napisu `canRead(` NIE wystarcza — `if (false && !canRead(m.path))`
    // zostawia napis i przepuszcza każdą wzmiankę. Pilnujemy KSZTAŁTU gałęzi: warunek
    // z negacją i pominięcie wzmianki (`continue`) w środku.
    t.regex(mentions, /if\s*\(!canRead\(m\.path\)\)\s*\{[\s\S]{0,200}?continue;/,
        'wzmianka bez prawa odczytu musi być POMIJANA (continue), nie tylko odnotowana w logu');
});
