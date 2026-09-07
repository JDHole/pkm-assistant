/**
 * Ping skrzynki w system prompcie (S28 Z4/D4) — JEDNA linijka, bez treści i bez ścieżek.
 */
import test from 'ava';
import { PromptBuilder } from './PromptBuilder.js';

type InboxContext = { inboxPing?: { count: number; senders?: string[] } | null };

const agent = { name: 'Tola', personality: '', disabled_tools: [] };

function inboxLines(ctx: InboxContext): string[] {
    const builder = new PromptBuilder();
    const lines: string[] = [];
    builder._injectInboxNotification(lines, ctx as never, agent as never);
    return lines;
}

test('brak nieprzeczytanych = ZERO linijek w prompcie', t => {
    t.deepEqual(inboxLines({}), []);
    t.deepEqual(inboxLines({ inboxPing: null }), []);
    t.deepEqual(inboxLines({ inboxPing: { count: 0, senders: [] } }), []);
});

test('ping to jedna linijka: ile + od kogo, ZERO treści i ZERO ścieżek do plików', t => {
    const lines = inboxLines({ inboxPing: { count: 3, senders: ['Klara', 'Sonny'] } });
    t.is(lines.length, 1);
    const line = lines[0]!;
    t.true(line.includes('3'));
    t.true(line.includes('Klara'));
    t.true(line.includes('Sonny'));
    t.false(line.includes('.pkm-assistant'), 'ping nie zdradza ścieżki skrzynki');
    t.false(line.includes('.md'));
});

test('ping bez znanych nadawców nie renderuje pustego „od:”', t => {
    const line = inboxLines({ inboxPing: { count: 2, senders: [] } })[0]!;
    t.true(line.includes('2'));
    t.false(/\(\s*\)/.test(line));
});
