import test from 'ava';
import { buildSemanticNote } from './semanticNote.js';
import type { VaultIndexerStatus } from './semanticNote.js';
import { t as tr } from '../../core/i18n/index.js';

const pluginWith = (status: VaultIndexerStatus) => ({ vaultIndexer: { getStatus: () => status } });

test('memory scope note explains isolation regardless of index status', t => {
    const note = buildSemanticNote({ plugin: pluginWith({ status: 'ready' }), scope: 'memory' });
    t.is(note, tr('mcp.semantic.unavailable_memory'));
    t.true(note.length > 0);
});

test('vault + no_provider → provider note', t => {
    const note = buildSemanticNote({ plugin: pluginWith({ status: 'no_provider' }), scope: 'vault' });
    t.is(note, tr('mcp.semantic.unavailable_no_provider'));
});

test('vault + building → progress note carries counts', t => {
    const status = { status: 'building', progress: { indexed: 3, total: 10 } };
    const note = buildSemanticNote({ plugin: pluginWith(status), scope: 'vault' });
    t.is(note, tr('mcp.semantic.unavailable_building', { indexed: 3, total: 10 }));
    t.true(note.includes('3'));
    t.true(note.includes('10'));
});

test('vault + disabled_mobile → mobile note', t => {
    const note = buildSemanticNote({ plugin: pluginWith({ status: 'disabled_mobile' }), scope: 'vault' });
    t.is(note, tr('mcp.semantic.unavailable_mobile'));
});

test('vault + error → error note carries lastError', t => {
    const note = buildSemanticNote({ plugin: pluginWith({ status: 'error', lastError: 'boom' }), scope: 'vault' });
    t.is(note, tr('mcp.semantic.unavailable_error', { error: 'boom' }));
    t.true(note.includes('boom'));
});

test('vault + missing indexer → safe provider-note default', t => {
    const note = buildSemanticNote({ plugin: {}, scope: 'vault' });
    t.is(note, tr('mcp.semantic.unavailable_no_provider'));
});
