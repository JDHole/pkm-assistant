/**
 * K19 (AUD-security-117 / 131) — kolejka wiadomości czatu wozi PROWENIENCJĘ razem z tekstem.
 *
 * Do K19 `_queuedMessage` był gołym stringiem, a oba dreny (kontynuacja pętli w
 * `_chatBeforeContinue` i `set_generating(false)`) nadawały mu twardo `HUMAN_MESSAGE_META`.
 * Tekst maszynowy zakolejkowany w trakcie tury — np. treść artefaktu wstawiona w pole
 * wpisywania przez `artifactSummon` — wracał więc z przywilejami człowieka.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { queueChatMessage, readQueuedMessage, queuedOwnerMatches, evaluateQueuedDrain, evaluateStopQueueCancel } from './queuedMessage.js';
import { registerUrlsIfHuman } from './messagePrivileges.js';
import { HUMAN_MESSAGE_META, MACHINE_MESSAGE_META, machineMeta } from '../../../core/index.js';

// ── pakowanie do slotu ──

test('tekst maszynowy wchodzi do kolejki i WYCHODZI jako machine', t => {
    const slot = queueChatMessage('## Artefakt\nŹródła: https://evil.example', MACHINE_MESSAGE_META);
    t.is(readQueuedMessage(slot)?.meta.origin, 'machine');
});

test('tekst człowieka wychodzi jako human', t => {
    const slot = queueChatMessage('napisz notatkę', HUMAN_MESSAGE_META);
    t.is(readQueuedMessage(slot)?.meta.origin, 'human');
});

test('brak znacznika = maszyna (fail-closed)', t => {
    t.is(queueChatMessage('cokolwiek').meta.origin, 'machine');
    t.is(queueChatMessage('cokolwiek', {}).meta.origin, 'machine');
    // MouseEvent wpięty jako pierwszy argument listenera kliknięcia:
    t.is(queueChatMessage('cokolwiek', { type: 'click' }).meta.origin, 'machine');
    t.is(queueChatMessage('cokolwiek', 'human').meta.origin, 'machine');
});

test('pozostałe pola meta jadą dalej, ale origin jest nie do podmienienia', t => {
    const slot = queueChatMessage('wynik suba', machineMeta({ _subTaskNotification: true, subTaskId: 'task-7' }));
    t.is(slot.meta.origin, 'machine');
    t.is(slot.meta.subTaskId, 'task-7');
    // Próba przemycenia pieczątki człowieka w meta maszynowej wysyłki — `machineMeta`
    // dokłada `origin` jako ostatni, więc podmiana nie przechodzi:
    t.is(queueChatMessage('x', machineMeta({ origin: 'human', spoofed: true })).meta.origin, 'machine');
});

// ── odczyt slotu ──

test('pusty slot to null', t => {
    t.is(readQueuedMessage(null), null);
    t.is(readQueuedMessage(undefined), null);
    t.is(readQueuedMessage(''), null);
    t.is(readQueuedMessage({ text: '' }), null);
});

test('goły string w slocie (stary kształt) dostaje pieczątkę MASZYNY', t => {
    const out = readQueuedMessage('tekst wrzucony po staremu');
    t.is(out?.text, 'tekst wrzucony po staremu');
    t.is(out?.meta.origin, 'machine', 'brak proweniencji nie awansuje do przywilejów człowieka');
});

test('slot bez meta też jest maszyną', t => {
    t.is(readQueuedMessage({ text: 'bez meta' })?.meta.origin, 'machine');
});

// ── skutek dla bramki przywilejów: rejestr adresów ──

test('dren kolejki maszynowej NIE zasila rejestru adresów (web_read dalej odmawia)', t => {
    const url = 'https://evil.example/collect?q=kolejka-maszynowa';
    const slot = queueChatMessage(`Źródła: ${url}`, MACHINE_MESSAGE_META);
    const queued = readQueuedMessage(slot)!;
    let registered = 0;
    const n = registerUrlsIfHuman(queued.text, queued.meta, () => { registered += 1; return 1; });
    t.is(n, 0);
    t.is(registered, 0, 'registerUrlsFromText nie może zostać nawet zawołane');
});

test('dren kolejki ludzkiej zasila rejestr (regresja K7 nie wraca)', t => {
    const queued = readQueuedMessage(queueChatMessage('zobacz https://ok.example', HUMAN_MESSAGE_META))!;
    let registered = 0;
    t.is(registerUrlsIfHuman(queued.text, queued.meta, () => { registered += 1; return 1; }), 1);
    t.is(registered, 1);
});

// ── Strażnik PO ŹRÓDLE ──
// `chat_streaming.ts` ciągnie `obsidian`, więc drenów nie da się odpalić w AVA.

const streamingSource = readFileSync(fileURLToPath(new URL('./chat_streaming.ts', import.meta.url)), 'utf8');

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, nie opisów historii w komentarzach. */
const streamingCode = streamingSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('żadna gałąź opróżniania kolejki nie nadaje HUMAN_MESSAGE_META', t => {
    t.false(
        streamingCode.includes('HUMAN_MESSAGE_META'),
        'twarda pieczątka człowieka w chat_streaming.ts = powrót AUD-security-117/131',
    );
});

test('oba dreny oddają ZAPAMIĘTANĄ proweniencję', t => {
    // Dren mid-loop (`_chatBeforeContinue`): rejestr adresów pyta o meta z kolejki.
    t.regex(streamingSource, /registerUrlsIfHuman\(\s*queued\.text,\s*queued\.meta,/);
    // Dren po turze (`set_generating(false)`): wysyłka niesie meta z kolejki.
    t.regex(streamingSource, /send_message\(\{\s*meta:\s*queued\.meta\s*\}\)/);
});

test('do kolejki wchodzi się wyłącznie przez queueChatMessage', t => {
    t.regex(streamingSource, /this\._queuedMessage\s*=\s*queueChatMessage\(/);
    // Poza kasowaniem slotu (`= null`) nie ma innych przypisań.
    const assignments = streamingSource.match(/this\._queuedMessage\s*=\s*(?!null)\S+/g) || [];
    t.is(assignments.length, 1, `nieoczekiwane przypisania do kolejki: ${assignments.join(' | ')}`);
});

// ── AUD-bledy-015: slot kolejki należy do ZAKŁADKI, nie do widoku ──
// `set_generating(false)` leci także z `_switchTab` (krok 5), więc dren budził się u agenta,
// który akurat jest na wierzchu: wiadomość napisana do Jaskra jechała modelem Borysa, jego
// promptem, pamięcią i zestawem narzędzi. Slot wozi więc też właściciela.

test('slot pamięta właściciela, a odczyt go oddaje', t => {
    const slot = queueChatMessage('zapisz to do notatki', HUMAN_MESSAGE_META, { agentName: 'Jaskier', tabKey: 'tab-jaskier' });
    t.is(readQueuedMessage(slot)?.owner?.agentName, 'Jaskier');
    t.is(readQueuedMessage(slot)?.owner?.tabKey, 'tab-jaskier');
});

test('rozjazd zakładki blokuje dren (wiadomość NIE leci do cudzego agenta)', t => {
    const slot = queueChatMessage('zapisz to do notatki', HUMAN_MESSAGE_META, { agentName: 'Jaskier', tabKey: 'tab-jaskier' });
    t.false(queuedOwnerMatches(slot, { agentName: 'Borys', tabKey: 'tab-borys' }));
    t.true(queuedOwnerMatches(slot, { agentName: 'Jaskier', tabKey: 'tab-jaskier' }));
});

test('tabKey wygrywa nad nazwą agenta (dwie zakładki tego samego agenta)', t => {
    const slot = queueChatMessage('x', HUMAN_MESSAGE_META, { agentName: 'Borys', tabKey: 'tab-1' });
    t.false(queuedOwnerMatches(slot, { agentName: 'Borys', tabKey: 'tab-2' }));
});

test('bez tabKey porównujemy po agencie (zakładka dostała po drodze nowy klucz)', t => {
    const slot = queueChatMessage('x', HUMAN_MESSAGE_META, { agentName: 'Borys' });
    t.true(queuedOwnerMatches(slot, { agentName: 'Borys', tabKey: 'cokolwiek' }));
    t.false(queuedOwnerMatches(slot, { agentName: 'Klara', tabKey: 'cokolwiek' }));
});

test('slot bez właściciela (stary kształt) drenuje się jak dotąd', t => {
    t.true(queuedOwnerMatches(queueChatMessage('x', HUMAN_MESSAGE_META), { agentName: 'Borys', tabKey: 't' }));
    t.true(queuedOwnerMatches(readQueuedMessage('goły string'), { agentName: 'Borys', tabKey: 't' }));
    t.true(queuedOwnerMatches(null, { agentName: 'Borys', tabKey: 't' }));
});

test('pusty slot i pusty widok nie wywracają porównania', t => {
    const slot = queueChatMessage('x', HUMAN_MESSAGE_META, { agentName: 'Borys', tabKey: 'tab-1' });
    t.false(queuedOwnerMatches(slot, { agentName: '', tabKey: '' }), 'brak aktywnej zakładki = nie ma dokąd wysłać');
    t.false(queuedOwnerMatches(slot, null));
});

// ── AUD-testy-024: DECYZJA DRENU jako zachowanie, nie napis w źródle ──
// Do tej naprawy „czy właściciel kolejki się zgadza" pilnował wyłącznie regex
// `/queuedOwnerMatches\(/` na tekście `chat_streaming.ts` — mutacja
// `if (false && !queuedOwnerMatches(...))` zostawiała napis i cały pakiet zielony.

const jaskier = { agentName: 'Jaskier', tabKey: 'tab-jaskier' };

test('dren: zgodny właściciel + brak trwającej tury → send', t => {
    const slot = queueChatMessage('zapisz to', HUMAN_MESSAGE_META, jaskier);
    const d = evaluateQueuedDrain(slot, jaskier, { isGenerating: false });
    t.is(d.action, 'send');
    t.is(d.queued?.text, 'zapisz to');
    t.is(d.queued?.meta.origin, 'human', 'dren oddaje pieczątkę, z którą wiadomość weszła (K19)');
});

test('dren: rozjazd zakładki → wait_owner, wiadomość ZOSTAJE (AUD-bledy-015)', t => {
    const slot = queueChatMessage('zapisz to', HUMAN_MESSAGE_META, jaskier);
    const d = evaluateQueuedDrain(slot, { agentName: 'Borys', tabKey: 'tab-borys' }, { isGenerating: false });
    t.is(d.action, 'wait_owner');
    t.is(d.queued?.text, 'zapisz to', 'wiadomość wraca do wołacza, żeby mógł pokazać wskaźnik ⏳');
});

test('dren: pusty slot → empty (Stop / zamknięcie widoku zdążyły anulować)', t => {
    t.deepEqual(evaluateQueuedDrain(null, jaskier, { isGenerating: false }), { action: 'empty', queued: null });
    t.deepEqual(evaluateQueuedDrain('', jaskier, {}), { action: 'empty', queued: null });
    t.deepEqual(evaluateQueuedDrain({ text: '' }, jaskier, {}), { action: 'empty', queued: null });
});

test('dren: w oknie 100 ms ruszyła inna tura → wait_generating', t => {
    const slot = queueChatMessage('zapisz to', HUMAN_MESSAGE_META, jaskier);
    t.is(evaluateQueuedDrain(slot, jaskier, { isGenerating: true }).action, 'wait_generating');
});

test('dren: właściciel jest pytany PRZED trwającą turą (obca wiadomość nie ustępuje, tylko czeka)', t => {
    const slot = queueChatMessage('zapisz to', HUMAN_MESSAGE_META, jaskier);
    t.is(evaluateQueuedDrain(slot, { agentName: 'Borys', tabKey: 'tab-borys' }, { isGenerating: true }).action, 'wait_owner');
});

test('dren: slot bez właściciela (stary kształt) jedzie jak dotąd', t => {
    t.is(evaluateQueuedDrain('goły string', jaskier, { isGenerating: false }).action, 'send');
});

// ── AUD-testy-024: STOP kasuje slot kolejki (AUD-bledy-055) ──

test('Stop: pełny slot → kasujemy i oddajemy tekst do PUSTEGO pola wpisywania', t => {
    const slot = queueChatMessage('zapisz to', HUMAN_MESSAGE_META, jaskier);
    const d = evaluateStopQueueCancel(slot, '');
    t.true(d.clearSlot, 'bez kasowania slot leci do modelu 100 ms po kliknięciu Stop');
    t.is(d.restoreText, 'zapisz to', 'tekst nie ginie — user widzi, co przerwał');
    t.is(d.cancelled?.text, 'zapisz to');
});

test('Stop: szkic w polu jest ważniejszy niż odzyskana kopia (duch Z3)', t => {
    const slot = queueChatMessage('zakolejkowane', HUMAN_MESSAGE_META, jaskier);
    const d = evaluateStopQueueCancel(slot, 'szkic, którego user nie wysłał');
    t.true(d.clearSlot, 'slot i tak kasujemy — Stop znaczy Stop');
    t.is(d.restoreText, null, 'pola z żywym szkicem nie nadpisujemy');
});

test('Stop: białe znaki w polu to nie szkic', t => {
    const slot = queueChatMessage('zakolejkowane', HUMAN_MESSAGE_META, jaskier);
    t.is(evaluateStopQueueCancel(slot, '   \n ').restoreText, 'zakolejkowane');
    t.is(evaluateStopQueueCancel(slot, undefined).restoreText, 'zakolejkowane');
});

test('Stop: pusta kolejka → nic nie kasujemy i pola nie dotykamy', t => {
    t.deepEqual(evaluateStopQueueCancel(null, ''), { clearSlot: false, restoreText: null, cancelled: null });
    t.deepEqual(evaluateStopQueueCancel(undefined, 'szkic'), { clearSlot: false, restoreText: null, cancelled: null });
});
