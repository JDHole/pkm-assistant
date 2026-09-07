/**
 * consolidationRunState.test.js — kubełek 2 (2026-07-29).
 *
 * Dwie decyzje `ConsolidationProgressModal`, których sam modal nie da się przetestować w node
 * (`obsidian` w imporcie): kiedy zamknięcie okna ma zwolnić centrum operacji i z czego startuje
 * panel review. Przebiegi budujemy PRAWDZIWYM `ConsolidationRun` — maszyna stanów ma pilnować,
 * że układamy tylko osiągalne kombinacje.
 */
import test from 'ava';
import { isRunStuck, resolveStepDraft } from './consolidationRunState.js';
import { ConsolidationRun, STEP_STATUS, STEP_KIND } from '../memory/index.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/** Przebieg wzorowany na produkcyjnym planie: paczki L1 + zakłódkowany L2. */
function makeRun(l1Count = 1, { withL2 = true } = {}) {
    const steps = [];
    for (let i = 1; i <= l1Count; i++) {
        steps.push({ id: `l1_batch_${i}`, kind: STEP_KIND.L1, index: i, total: l1Count, status: STEP_STATUS.PENDING });
    }
    if (withL2) steps.push({ id: 'l2', kind: STEP_KIND.L2, status: STEP_STATUS.GATED });
    return new ConsolidationRun({ steps, agentName: 'Jaskier' });
}

// ── isRunStuck ────────────────────────────────────────────────────────────────────

test('świeży przebieg (nic jeszcze nie ruszyło) NIE jest utknięty', t => {
    t.false(isRunStuck(makeRun(2)));
});

test('krok w biegu NIE jest utknięciem — przebieg mieli w tle', t => {
    const run = makeRun(2);
    run.startStep('l1_batch_1');
    t.false(isRunStuck(run));
});

test('krok czekający na decyzję NIE jest utknięciem — user ma co kliknąć', t => {
    const run = makeRun(1);
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'propozycja' });
    t.false(isRunStuck(run));
});

test('krok w trakcie zapisu NIE jest utknięciem', t => {
    const run = makeRun(1);
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'propozycja' });
    run.beginApply('l1_batch_1', { accepted: true });
    t.false(isRunStuck(run));
});

test('SCENARIUSZ-ZABÓJCA: padnięta L1 + zakłódkowany L2 = utknięty', t => {
    const run = makeRun(1);
    run.startStep('l1_batch_1');
    run.failStep('l1_batch_1', new Error('model zamilkł'));

    t.false(run.isSettled(), 'gated L2 trzyma przebieg przy życiu');
    t.true(isRunStuck(run), 'nikt już nie kliknie Ponów/Pomiń — centrum trzeba zwolnić');
});

test('częściowo zrobiony przebieg z padem i kłódką też jest utknięty', t => {
    const run = makeRun(2);
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'ok' });
    run.beginApply('l1_batch_1', { accepted: true });
    run.completeStep('l1_batch_1', { name: 'a_l1.md' });
    run.startStep('l1_batch_2');
    run.failStep('l1_batch_2', new Error('zwis'));

    t.true(isRunStuck(run));
});

test('krok świeżo odgatowany (pending) NIE jest utknięciem — generator zaraz po niego sięgnie', t => {
    // Review kubełka 2, P3-1: okno wyścigu przy odgatowywaniu L2. Po zapisaniu ostatniej
    // paczki L1 `generateGatedSteps` robi ungate PRZED pierwszym await — w tym oknie kroki
    // to [done…, pending] i zamknięcie modalu NIE może zwolnić centrum (generacja L2 leci).
    const run = makeRun(1);
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'ok' });
    run.beginApply('l1_batch_1', { accepted: true });
    run.completeStep('l1_batch_1', { name: 'a_l1.md' });
    run.ungate('l2');

    t.false(isRunStuck(run), 'pending = robota przed nami, nie trup');
});

test('rozstrzygnięty przebieg NIE jest utknięty (domyka go finishIfSettled)', t => {
    const run = makeRun(1, { withL2: false });
    run.startStep('l1_batch_1');
    run.failStep('l1_batch_1', new Error('zwis'));

    t.true(run.isSettled());
    t.false(isRunStuck(run));
});

test('brak przebiegu / przebieg bez kroków → false', t => {
    t.false(isRunStuck(null));
    t.false(isRunStuck(undefined));
    t.false(isRunStuck({}));
    t.false(isRunStuck(new ConsolidationRun({ steps: [] })));
});

// ── resolveStepDraft ──────────────────────────────────────────────────────────────

test('szkic L1: pierwsze wywołanie kopiuje propozycję, drugie oddaje TEN SAM obiekt', t => {
    const run = makeRun(1, { withL2: false });
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'wersja modelu' });
    const step = run.getStep('l1_batch_1')!;

    const first = resolveStepDraft(step);
    t.is(first.body, 'wersja modelu');

    const second = resolveStepDraft(step);
    t.is(second, first, 'ten sam obiekt = edycje mają gdzie przeżyć');
});

test('szkic L1: edycja usera przeżywa zwinięcie i ponowne otwarcie panelu', t => {
    const run = makeRun(1, { withL2: false });
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'wersja modelu' });
    const step = run.getStep('l1_batch_1')!;

    resolveStepDraft(step).body = 'wersja Kuby'; // to robi callback `onChange` z renderera

    t.is(resolveStepDraft(step).body, 'wersja Kuby');
    t.is(step.result!.body, 'wersja modelu', 'propozycja modelu zostaje nietknięta');
});

test('szkic dedupu: odznaczone scalenie i poprawiona treść przeżywają ponowne otwarcie', t => {
    const run = new ConsolidationRun({ steps: [{ id: 'dedup', kind: STEP_KIND.DEDUP, status: STEP_STATUS.PENDING }] });
    run.startStep('dedup');
    run.stepProposalReady('dedup', {
        merges: [
            { sources: ['a.md', 'b.md'], target_name: 'ab', merged_content: 'AB' },
            { sources: ['c.md', 'd.md'], target_name: 'cd', merged_content: 'CD' },
        ],
        deletions: [{ filename: 'e.md' }],
    });
    const step = run.getStep('dedup')!;

    const draft = resolveStepDraft(step, { dedup: true });
    t.true(draft.merges.every(m => m.accepted), 'domyślnie wszystko zaznaczone');
    draft.merges[1].accepted = false;
    draft.merges[0].merged_content = 'AB po poprawce';
    draft.deletions[0].accepted = false;

    const again = resolveStepDraft(step, { dedup: true });
    t.is(again, draft);
    t.false(again.merges[1].accepted);
    t.is(again.merges[0].merged_content, 'AB po poprawce');
    t.false(again.deletions[0].accepted);
    t.is((step.result!.merges as Array<{ merged_content?: string }>)[0].merged_content, 'AB', 'propozycja modelu nietknięta');
});

test('szkic startuje z decyzji usera, gdy ta już zapadła (np. po padzie zapisu)', t => {
    const run = makeRun(1, { withL2: false });
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'wersja modelu' });
    run.beginApply('l1_batch_1', { accepted: true, body: 'wersja Kuby' });

    t.is(resolveStepDraft(run.getStep('l1_batch_1')!).body, 'wersja Kuby');
});

test('szkic radzi sobie z krokiem bez propozycji', t => {
    t.is(resolveStepDraft(null), null);
    t.is(resolveStepDraft({}).body, '');
    t.deepEqual(resolveStepDraft({}, { dedup: true }), { merges: [], deletions: [] });
});

// ── AUD-wydajnosc-019: sekundnik nie przebudowuje całej checklisty ──────────────────
// `ConsolidationProgressModal.ts` importuje `obsidian` (Modal) i AVA go nie zaimportuje —
// strażnik po ŹRÓDLE (ten sam wzór co reszta strażników czatu).

const modalSrc = readFileSync(fileURLToPath(new URL('./ConsolidationProgressModal.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('tyknięcie sekundnika woła punktową aktualizację, nie _renderChecklist (AUD-wydajnosc-019)', t => {
    // release 2.2.0/W2: obsidianmd/prefer-window-timers — `setInterval(...)` → `window.setInterval(...)`.
    // Regex zaktualizowany na nowy tekst źródła; sens strażnika (sekundnik = punktowa aktualizacja) bez zmian.
    t.regex(modalSrc, /this\._tickTimer = window\.setInterval\(\(\) => this\._tickActiveStep\(\), 1000\);/,
        'sekundnik z pełnym renderem przebudowuje WSZYSTKIE wiersze co sekundę przez cały przebieg');
    t.notRegex(modalSrc, /setInterval\([\s\S]{0,120}?_renderChecklist/,
        'w callbacku sekundnika nie ma prawa być pełnego renderu');
});

test('_tickActiveStep podmienia sam tekst czasu aktywnego kroku (AUD-wydajnosc-019)', t => {
    const body = /_tickActiveStep\(\): void \{([\s\S]*?)\n    \}/.exec(modalSrc)?.[1] || '';
    t.true(body.length > 0, 'nie znalazłem _tickActiveStep');
    t.regex(body, /const el = this\._stepTimeEls\.get\(step\.id\);/);
    t.regex(body, /el\.textContent = /, 'aktualizacja ma być podmianą tekstu, nie budową węzłów');
    t.regex(body, /if \(!el\) \{[\s\S]{0,80}?_renderChecklist\(\)/,
        'brak uchwytu (wiersz powstał przy zerowym czasie) = jednorazowy pełny render, potem tania ścieżka');
});

test('render checklisty zapamiętuje uchwyty czasu i czyści je przy przebudowie', t => {
    const render = /_renderChecklist\(\): void \{([\s\S]*?)\n    \}/.exec(modalSrc)?.[1] || '';
    t.regex(render, /this\._stepTimeEls\.clear\(\);/, 'stare uchwyty muszą znikać razem z węzłami');
    const row = /_renderStepRow\(parent: HTMLElement, step: ConsolidationStep\): void \{([\s\S]*?)\n    \}/.exec(modalSrc)?.[1] || '';
    t.regex(row, /this\._stepTimeEls\.set\(step\.id, head\.createSpan\(/,
        'wiersz musi oddać uchwyt do elementu czasu');
});
