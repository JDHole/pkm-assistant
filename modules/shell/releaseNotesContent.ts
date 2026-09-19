/**
 * Notka autora doklejana pod treścią notatek wydania w widoku „Co nowego".
 *
 * Treść jest STAŁA (verbatim z README.md, commit 450c3641) i ma się pojawić ZAWSZE, w języku
 * interfejsu, bez dopisywania jej do plików `releases/*.md` - te zostają czystym materiałem
 * źródłowym wydania. Dlatego sklejka dzieje się tutaj, w czystym pliku obok `ReleaseNotesView.ts`
 * (ten ciągnie `obsidian`, więc AVA go nie zaimportuje - wzór `modules/chat/saveSessionSectionLabel.ts`,
 * `modules/artifacts/artifactStatusLabel.ts`).
 */
import { t } from '../../core/i18n/index.js';

/**
 * Dokleja notkę autora jako Obsidianowy callout `[!NOTE]` pod treścią notatek wydania.
 *
 * Idempotentne: jeśli `notesMarkdown` JUŻ niesie dosłowny tekst notki (drugie wywołanie na
 * wyniku pierwszego, albo treść wklejona ręcznie do `releases/*.md`), funkcja oddaje wejście
 * bez zmian zamiast dokładać drugą kopię.
 *
 * @param notesMarkdown - surowa treść `releases/latest_release.md` (może być pusta)
 */
export function withAuthorNote(notesMarkdown: string): string {
    const note = t('release_notes.author_note');
    if (notesMarkdown.includes(note)) return notesMarkdown;
    const trimmed = notesMarkdown.trimEnd();
    const notePart = `---\n\n> [!NOTE]\n> ${note}\n`;
    return trimmed ? `${trimmed}\n\n${notePart}` : notePart;
}
