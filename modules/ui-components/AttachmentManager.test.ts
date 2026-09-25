/**
 * `AttachmentManager.addTextAttachment` (spec D, "Czat bez ścian" 2.3.0) - dodaje załącznik
 * tekstowy TĄ SAMĄ drogą co `_processFile` dla pliku tekstowego, bez `File`/`Blob` w API
 * publicznym (wołacz jest `chat/selectionMenu.ts`'s "Dodaj jako kontekst", który ma gotowy
 * tekst zaznaczenia, nie plik z dysku).
 *
 * DOM: `AttachmentManager._buildUI()` woła globalne `createDiv`/`createEl` Obsidiana wprost
 * (nie `this.container.createDiv()`) - te globale istnieją dopiero PO tym, jak coś w łańcuchu
 * importów dotknie `obsidian` jako WARTOŚCI (hak modułu AVA przekierowuje wtedy na atrapę
 * `test-support/obsidian.ts` z repo harnessu, a ta atrapa instaluje `dom-shim.ts`'s
 * `installDomShim()` przy własnym imporcie - patrz `modules/ui-components/CLAUDE.md`, gotcha
 * "Testy DOM modali... DZIAŁAJĄ w AVA dzięki atrapie obsidian"). `AttachmentManager.ts` sam
 * `obsidian` nie importuje (tylko `core/i18n`, `crystal-soul`, `core/utils/Logger`, `PluginApi`
 * jako typ) - stąd jawny import niżej WYŁĄCZNIE po efekt uboczny, żeby globale istniały PRZED
 * pierwszym `new AttachmentManager(...)`.
 */
import test from 'ava';
import 'obsidian';
import { setLocale, t } from '../../core/i18n/index.js';
import { AttachmentManager } from './AttachmentManager.js';
import type { PluginApi } from '../../core/index.js';

setLocale('pl');

function makeManager(onReject?: (message: string) => void): AttachmentManager {
    const container = createDiv();
    // `plugin` nie jest czytane nigdzie w ciele klasy poza przypisaniem w konstruktorze -
    // pusty obiekt rzutowany przez `unknown` wystarcza, bez duplikowania kontraktu `PluginApi`.
    const plugin = {} as unknown as PluginApi;
    return new AttachmentManager(container, plugin, { onReject });
}

test('odrzucenie zbyt dużego pliku tekstowego przekazuje komunikat do onReject', async t2 => {
    const rejected: string[] = [];
    const mgr = makeManager(message => rejected.push(message));
    const file = new File(['x'.repeat(100 * 1024 + 1)], 'duzy.txt', { type: 'text/plain' });

    await mgr._processFileList([file]);

    t2.deepEqual(rejected, [t('attach.file_too_large', { name: file.name, size: '100.0 KB' })]);
    t2.is(mgr.attachments.length, 0);
});

test('odrzucenie nieobsługiwanego typu przekazuje komunikat do onReject', async t2 => {
    const rejected: string[] = [];
    const mgr = makeManager(message => rejected.push(message));
    const file = new File(['data'], 'plik.bin', { type: 'application/octet-stream' });

    await mgr._processFileList([file]);

    t2.deepEqual(rejected, [t('attach.unsupported_type', { name: file.name, ext: 'bin', mime: file.type })]);
    t2.is(mgr.attachments.length, 0);
});

test('osiągnięty limit przekazuje jedną odmowę i przerywa przetwarzanie', async t2 => {
    const rejected: string[] = [];
    const mgr = makeManager(message => rejected.push(message));
    for (let i = 0; i < 10; i++) mgr.addTextAttachment({ name: `n${i}.md`, text: 'tekst' });
    const file = new File(['text'], 'za-duzo.txt', { type: 'text/plain' });

    await mgr._processFileList([file]);

    t2.deepEqual(rejected, [t('attach.limit_reached', { max: 10 })]);
    t2.is(mgr.attachments.length, 10);
});

test('addTextAttachment: dodaje 1 załącznik o podanej nazwie i treści', t2 => {
    const mgr = makeManager();
    const result = mgr.addTextAttachment({ name: 'Cytat z czatu 12:34.md', text: 'linia jeden\nlinia dwa' });

    t2.deepEqual(result, { added: true });
    t2.is(mgr.attachments.length, 1);
    t2.like(mgr.attachments[0], {
        type: 'text',
        name: 'Cytat z czatu 12:34.md',
        content: 'linia jeden\nlinia dwa',
        mimeType: 'text/plain',
    });
});

test('addTextAttachment: woła onChange z listą załączników po dodaniu', t2 => {
    const calls: number[] = [];
    const container = createDiv();
    const plugin = {} as unknown as PluginApi;
    const mgr = new AttachmentManager(container, plugin, {
        onChange: (attachments) => calls.push(attachments.length),
    });

    mgr.addTextAttachment({ name: 'a.md', text: 'x' });
    t2.deepEqual(calls, [1]);

    mgr.addTextAttachment({ name: 'b.md', text: 'y' });
    t2.deepEqual(calls, [1, 2]);
});

test('addTextAttachment: dokłada chip do paska (children paska rośnie o jeden)', t2 => {
    const mgr = makeManager();
    const before = mgr.chipBar.children.length;

    mgr.addTextAttachment({ name: 'c.md', text: 'z' });

    t2.is(mgr.chipBar.children.length, before + 1);
});

test('addTextAttachment: limit 10 sztuk - 11. wołanie odmawia z literalnym komunikatem i18n, licznik nie rośnie', t2 => {
    const mgr = makeManager();
    for (let i = 0; i < 10; i++) {
        const r = mgr.addTextAttachment({ name: `n${i}.md`, text: 'krótki' });
        t2.true(r.added, `załącznik ${i} powinien się dodać (limit jeszcze nie osiągnięty)`);
    }
    t2.is(mgr.attachments.length, 10);

    const eleventh = mgr.addTextAttachment({ name: 'n10.md', text: 'krótki' });

    t2.deepEqual(eleventh, { added: false, message: t('attach.limit_reached', { max: 10 }) });
    t2.is(eleventh.message, 'Limit 10 załączników osiągnięty');
    t2.is(mgr.attachments.length, 10, '11. załącznik nie ma prawa wejść do listy');
});

test('addTextAttachment: limit rozmiaru 100 KB - tekst za duży odmawia z literalnym komunikatem i18n, licznik nie rośnie', t2 => {
    const mgr = makeManager();
    // 102401 bajtów ASCII (100 KB + 1 B) - próg to `size > 100*1024`, więc dokładnie o jeden
    // bajt za dużo trafia w gałąź odmowy; `_formatSize` zaokrągla do "100.0 KB".
    const oversized = 'x'.repeat(100 * 1024 + 1);

    const result = mgr.addTextAttachment({ name: 'Cytat z czatu 09:15.md', text: oversized });

    t2.deepEqual(result, {
        added: false,
        message: t('attach.file_too_large', { name: 'Cytat z czatu 09:15.md', size: '100.0 KB' }),
    });
    t2.is(result.message, 'Plik Cytat z czatu 09:15.md za duży (100.0 KB > 100 KB)');
    t2.is(mgr.attachments.length, 0);
});

test('addTextAttachment: tekst dokładnie na granicy 100 KB (nie ponad) jest akceptowany', t2 => {
    const mgr = makeManager();
    const exactly100kb = 'x'.repeat(100 * 1024);

    const result = mgr.addTextAttachment({ name: 'graniczny.md', text: exactly100kb });

    t2.true(result.added);
    t2.is(mgr.attachments.length, 1);
    t2.is(mgr.attachments[0].size, 100 * 1024);
});
