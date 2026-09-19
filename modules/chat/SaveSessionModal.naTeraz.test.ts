/**
 * Test ZACHOWANIA (nie regex po źródle) - `SaveSessionModal.ts` importuje `obsidian`
 * (`Modal`), ale od atrapy `obsidian` w harnessie (2026-09-11,
 * `test-support/register-obsidian-for-ava.mjs`) DA SIĘ ją zaimportować i skonstruować wprost
 * w AVA (patrz `modules/chat/CLAUDE.md`, "Watchdog vs test bez `ChatView`" - ta sama atrapa
 * odblokowała już `chat/chat_session.test.ts`). Konstruktor `SaveSessionModal` woła
 * `_normalizeUpdate` na `opts.brainUpdates` bez dotykania DOM-u, więc test nie musi otwierać
 * modala (`.open()`/`.onOpen()`) - sprawdza pole `brainUpdates` po konstrukcji, dokładnie tak,
 * jak robi to sam kod.
 *
 * Pinuje realne zachowanie normalizacji sekcji "Na teraz" opisane w `naTerazUpdate.ts`: brak
 * sekcji i nieznany nagłówek pliku (`'## Bieżące'`) normalizują się do `'user'`, rozpoznany
 * klucz `'environment'` zostaje.
 */
import test from 'ava';

import { SaveSessionModal } from './SaveSessionModal.js';

test('SaveSessionModal normalizuje brainUpdates.section przy konstrukcji', t => {
    const modal = new SaveSessionModal({} as never, {
        brainUpdates: [
            { action: 'ADD', content: 'a' },
            { action: 'ADD', section: '## Bieżące', content: 'b' },
            { action: 'ADD', section: 'environment', content: 'c' },
        ],
    });

    t.deepEqual(
        modal.brainUpdates.map(u => u.section),
        ['user', 'user', 'environment'],
    );
});

test('setProposals normalizuje brainUpdates.section tą samą regułą', t => {
    const modal = new SaveSessionModal({} as never, { state: 'loading' });

    modal.setProposals({
        brainUpdates: [
            { action: 'ADD', content: 'a' },
            { action: 'ADD', section: '## Bieżące', content: 'b' },
            { action: 'ADD', section: 'environment', content: 'c' },
        ],
    });

    t.deepEqual(
        modal.brainUpdates.map(u => u.section),
        ['user', 'user', 'environment'],
    );
});
