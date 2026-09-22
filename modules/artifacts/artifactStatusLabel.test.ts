import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { artifactStatusLabel } from './artifactStatusLabel.js';
import { defaultStatusy, BUILTIN_PLAN_TYPE_NAME, BUILTIN_NOTATKA_TYPE_NAME, BUILTIN_RAPORT_TYPE_NAME, builtinTypeContent } from './ArtifactTypeLoader.js';

// Status artefaktu (`do-akceptacji`/`uwagi`/`zaakceptowany`/`zamkniety`/`w-trakcie`/`gotowy`/
// `szkic`) jest identyfikatorem silnika - w PLIKU i w PROMPCIE zostaje bez zmian, w każdym
// języku interfejsu (artifactButtons.ts, ArtifactStore.archive, basesView, harness czytają go
// po dokładnym tekście). Tu testujemy WYŁĄCZNIE etykietę dla oczu usera, tam gdzie status
// rysuje sam plugin (blok w notatce, panel profilu agenta).

test.serial('angielski interfejs: siedem statusów silnika dostaje angielskie etykiety', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(artifactStatusLabel('do-akceptacji'), 'Awaiting approval');
    t.is(artifactStatusLabel('uwagi'), 'Sent back with notes');
    t.is(artifactStatusLabel('zaakceptowany'), 'Approved');
    t.is(artifactStatusLabel('zamkniety'), 'Closed');
    t.is(artifactStatusLabel('w-trakcie'), 'In progress');
    t.is(artifactStatusLabel('gotowy'), 'Done');
    t.is(artifactStatusLabel('szkic'), 'Draft');
});

test.serial('polski interfejs: te same siedem statusów dostaje polskie etykiety', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    t.is(artifactStatusLabel('do-akceptacji'), 'Do akceptacji');
    t.is(artifactStatusLabel('uwagi'), 'Uwagi');
    t.is(artifactStatusLabel('zaakceptowany'), 'Zaakceptowany');
    t.is(artifactStatusLabel('zamkniety'), 'Zamknięty');
    t.is(artifactStatusLabel('w-trakcie'), 'W trakcie');
    t.is(artifactStatusLabel('gotowy'), 'Gotowy');
    t.is(artifactStatusLabel('szkic'), 'Szkic');
});

// Agent z typem EN (decyzja właściciela 19.09: nowy typ EN dostaje statusy EN w pliku) - literały
// EN muszą dostać etykietę tak samo jak PL, w BIEŻĄCYM języku interfejsu (nie w języku pliku).
test.serial('literały EN dostają etykietę w polskim interfejsie', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    t.is(artifactStatusLabel('pending-approval'), 'Do akceptacji');
    t.is(artifactStatusLabel('remarks'), 'Uwagi');
    t.is(artifactStatusLabel('accepted'), 'Zaakceptowany');
    t.is(artifactStatusLabel('closed'), 'Zamknięty');
    t.is(artifactStatusLabel('in-progress'), 'W trakcie');
    t.is(artifactStatusLabel('ready'), 'Gotowy');
    t.is(artifactStatusLabel('draft'), 'Szkic');
});

test.serial('literały EN dostają etykietę w angielskim interfejsie (jak dotąd)', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(artifactStatusLabel('pending-approval'), 'Awaiting approval');
    t.is(artifactStatusLabel('closed'), 'Closed');
});

test.serial('nieznany status (typ usera, ręczna wartość) pokazuje się dosłownie, nie pod cudzą etykietą', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(artifactStatusLabel('moj-status'), 'moj-status');
});

test.serial('białe znaki dookoła statusu są ucinane przed dopasowaniem', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(artifactStatusLabel('  zamkniety '), 'Closed');
});

test.serial('pusty / null / undefined status pokazuje myślnik, nie pusty string', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(artifactStatusLabel(null), '—');
    t.is(artifactStatusLabel(undefined), '—');
    t.is(artifactStatusLabel(''), '—');
    t.is(artifactStatusLabel('   '), '—');
});

// Reguła z CLAUDE.md modułu: nowy status wbudowanego typu = nowa rola w `artifactStatuses.ts` +
// klucze w obu słownikach. Bez strażnika status dopisany do `statusy:` w tekście fabrycznym
// przechodzi wszystkie bramki, a user widzi surowy token. Źródłem listy są SAME teksty
// fabryczne (PL i EN, każdy z WŁASNYM zestawem literałów od 19.09) plus domyślne statusy typu
// usera - nie ręcznie utrzymywana kopia.
test.serial('każdy status z tekstów fabrycznych typów (PL+EN) i z defaultStatusy() ma etykietę', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const statuses = new Set<string>(defaultStatusy());
    for (const name of [BUILTIN_PLAN_TYPE_NAME, BUILTIN_NOTATKA_TYPE_NAME, BUILTIN_RAPORT_TYPE_NAME] as const) {
        for (const locale of ['pl', 'en']) {
            const line = builtinTypeContent(name, locale).split(/\r?\n/).find(l => l.startsWith('statusy:'));
            t.truthy(line, `${name}/${locale}: brak linii statusy: w tekście fabrycznym`);
            for (const s of (line || '').replace(/^statusy:\s*\[|\]\s*$/g, '').split(',')) statuses.add(s.trim());
        }
    }
    t.deepEqual([...statuses].sort(), [
        'accepted', 'closed', 'do-akceptacji', 'draft', 'gotowy', 'in-progress',
        'pending-approval', 'ready', 'remarks', 'uwagi', 'w-trakcie', 'zaakceptowany', 'zamkniety',
    ]);
    for (const s of statuses) t.not(artifactStatusLabel(s), s, `status "${s}" nie ma etykiety - user zobaczy surowy identyfikator`);
});
