/**
 * `withAuthorNote` - dokleja stałą notkę autora pod treścią notatek wydania, w języku
 * interfejsu, bez dotykania plików `releases/*.md`. Czysty plik (zero `obsidian`/DOM),
 * wzór: `modules/chat/saveSessionSectionLabel.ts`, `modules/artifacts/artifactStatusLabel.ts`.
 */
import test from 'ava';

import { setLocale } from '../../core/i18n/index.js';
import { withAuthorNote } from './releaseNotesContent.js';

test.serial('en: dokleja literalny angielski callout pod oryginalną treścią', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    const notes = '# Release 2.2.7\n\nSome fixes.';
    const result = withAuthorNote(notes);

    t.true(result.startsWith(notes), 'oryginalna treść musi zostać na początku');
    t.true(
        result.endsWith(
            '\n\n---\n\n> [!NOTE]\n> **A note from the author.** PKM Assistant is built by one person - '
            + 'a non-programmer with Claude Code doing the typing, a solo "vibe-dev" project. It is early '
            + 'days: rough edges exist, and fixes ship continuously as you report them, but each one takes '
            + 'time. If the plugin helps you, the best support is a bug report, an idea, a star on the '
            + 'repo, or a word of patience. Thank you for being here at the start of the road.\n',
        ),
        `wynik nie kończy się literalnym angielskim calloutem: ${result.slice(-200)}`,
    );
});

test.serial('pl: dokleja notkę po polsku', t => {
    setLocale('pl');
    t.teardown(() => setLocale('en'));

    const notes = '# Wydanie 2.2.7\n\nPoprawki.';
    const result = withAuthorNote(notes);

    t.true(result.startsWith(notes));
    t.true(result.includes('Słowo od autora'), 'brak polskiej notki autora w wyniku');
    t.true(result.includes('> [!NOTE]'), 'brak callout Obsidiana');
});

test.serial('pusta treść notatki nadal dostaje notkę autora', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    const result = withAuthorNote('');

    t.true(result.includes('A note from the author'), 'pusta treść musi nadal dostać notkę');
    t.true(result.startsWith('---'), 'pusta treść: notka zaczyna się od separatora, nie od śmieciowych pustych linii');
});

test.serial('trailing whitespace oryginalnej treści jest przycinany przed doklejeniem separatora', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    const result = withAuthorNote('# Release\n\nBody text.   \n\n\n');

    t.true(result.startsWith('# Release\n\nBody text.\n\n---\n\n> [!NOTE]\n>'));
});
