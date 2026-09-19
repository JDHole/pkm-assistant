import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { artifactStatusLabel } from './artifactStatusLabel.js';

// Status artefaktu (`do-akceptacji`/`uwagi`/`zaakceptowany`/`zamkniety`/`w-trakcie`/`gotowy`/
// `szkic`) jest identyfikatorem silnika - w PLIKU i w PROMPCIE zostaje bez zmian, w każdym
// języku interfejsu (artifactButtons.ts, ArtifactStore.archive, basesView, harness czytają go
// po dokładnym tekście). Tu testujemy WYŁĄCZNIE etykietę dla oczu usera, tam gdzie status
// rysuje sam plugin (blok w notatce, panel profilu agenta).

test.serial('angielski interfejs: siedem statusów silnika dostaje angielskie etykiety', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(artifactStatusLabel('do-akceptacji'), 'Awaiting approval');
    t.is(artifactStatusLabel('uwagi'), 'Changes requested');
    t.is(artifactStatusLabel('zaakceptowany'), 'Approved');
    t.is(artifactStatusLabel('zamkniety'), 'Closed');
    t.is(artifactStatusLabel('w-trakcie'), 'In progress');
    t.is(artifactStatusLabel('gotowy'), 'Ready');
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
