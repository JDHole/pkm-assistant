/**
 * Strażnik pilnuje, żeby teksty widoczne dla usera (PL: "Błąd:", "Nieznany błąd",
 * "Brak dopasowań", "% kontekstu"; EN: "Saved to …!", "Save failed", "Error: …") szły przez
 * `t()`, nie były wpisane na twardo.
 *
 * `chat_streaming.ts` / `chat_session.ts` / `chat_messages.ts` importują `obsidian`, więc AVA
 * nie może ich zaimportować bezpośrednio - strażnik czyta ŹRÓDŁO regexami (wzór: `stopSemantics.test.ts`).
 * `TriggerPopup.ts` jest importowalny (ma już `TriggerPopup.test.ts` behawioralny), ale
 * `_renderItems()` dotyka `document`, którego AVA/tsx nie ma - dla TEJ linii też strażnik po źródle.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const streaming = readSource('./chat_streaming.ts');
const triggerPopup = readSource('./TriggerPopup.ts');
const session = readSource('./chat_session.ts');
const messages = readSource('./chat_messages.ts');

// ── chat_streaming.ts: "Błąd:" / "Nieznany błąd" / "Error: …" ──────────────

test('chat_streaming.ts nie ma już twardego "Błąd:" ani "Error:" w treści', t => {
    t.notRegex(streaming, /`Błąd: \$\{/, 'sub-agent error response wracał twardym polskim prefiksem');
    t.notRegex(streaming, /'Nieznany błąd'/, 'fallback nieznanego błędu miał być kluczem i18n, nie literałem');
    t.notRegex(streaming, /`Error: \$\{/, 'handle_error renderował twardy angielski prefiks');
});

test('chat_streaming.ts woła t(\'chat.streaming.error_prefix\') we wszystkich 4 miejscach', t => {
    const calls = streaming.match(/t\('chat\.streaming\.error_prefix'/g) || [];
    t.is(calls.length, 4, `oczekiwano 4 wywołań (2× sub-agent error w _chatOnToolResults, 2× handle_error), znaleziono ${calls.length}`);
});

test('chat_streaming.ts reużywa istniejący klucz chat.subagent_notification.unknown_error zamiast duplikować "nieznany błąd"', t => {
    t.regex(streaming, /t\('chat\.subagent_notification\.unknown_error'\)/,
        'nieznany błąd suba ma iść przez wspólny klucz, nie przez własny duplikat');
});

// ── TriggerPopup.ts: "Brak dopasowań" ───────────────────────────────────────

test('TriggerPopup.ts nie ma już twardego "Brak dopasowań"', t => {
    t.notRegex(triggerPopup, /'Brak dopasowań'/);
    t.regex(triggerPopup, /t\('chat\.trigger_popup\.no_matches'\)/, 'pusta lista wyników musi iść przez t()');
});

// ── chat_session.ts: "Saved to …!" / "Save failed" ──────────────────────────

test('chat_session.ts nie ma już twardego "Saved to …!" ani "Save failed"', t => {
    t.notRegex(session, /`Saved to \$\{/, 'pasek autosave renderował angielski tekst niezależnie od locale');
    t.notRegex(session, /'Save failed'/);
    t.regex(session, /t\('chat\.session\.autosave_saved'/, 'sukces autosave musi iść przez t()');
    t.regex(session, /t\('chat\.session\.autosave_failed'\)/, 'błąd autosave musi iść przez t()');
});

// ── chat_messages.ts: "% kontekstu" ─────────────────────────────────────────

test('chat_messages.ts nie ma już twardego "% kontekstu"', t => {
    t.notRegex(messages, /\$\{percent\}% kontekstu/, 'etykieta procentu kontekstu nie może renderować twardego polskiego sufiksu niezależnie od locale');
    t.regex(messages, /t\('chat\.msg\.trim_context_percent'/, 'procent kontekstu musi iść przez t()');
});
