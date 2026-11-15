import test, { type ExecutionContext } from 'ava';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterDraftStorage, DesktopDraftStorage, DRAFT_ROOT } from './index.js';
import type { DraftStorageIO } from './index.js';
import { MemoryAdapter } from './test-support/MemoryAdapter.js';

const blob = `${DRAFT_ROOT}/sample/blobs/abc`;
const manifest = `${DRAFT_ROOT}/sample/manifests/000001.json`;
const bytes = new Uint8Array([0, 255, 13, 128]);
type Factory = (t: ExecutionContext) => { port: DraftStorageIO; failPublish: () => void };
function contract(name: string, factory: Factory) {
    test(`${name}: empty listing, binary roundtrip and immutable blobs`, async t => {
        const { port } = factory(t);
        t.deepEqual(await port.list(DRAFT_ROOT), []);
        await port.writeBlob(blob, bytes);
        await port.writeBlob(blob, bytes);
        t.deepEqual([...await port.read(blob)], [0, 255, 13, 128]);
        await t.throwsAsync(async () => port.writeBlob(blob, new Uint8Array([1])), { code: 'integrity-error' });
        t.deepEqual([...await port.read(blob)], [0, 255, 13, 128]);
        t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/blobs`), ['abc']);
    });
    test(`${name}: create-only publication and GC removal`, async t => {
        const { port } = factory(t);
        t.is(await port.publish(manifest, bytes, () => true), 'published');
        await t.throwsAsync(async () => port.publish(manifest, new Uint8Array([8]), () => true));
        t.deepEqual([...await port.read(manifest)], [0, 255, 13, 128]);
        t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/manifests`), ['000001.json']);
        await port.remove!(manifest);
        t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/manifests`), []);
    });
    test(`${name}: cancellation leaves no target and permits retry`, async t => {
        const { port } = factory(t);
        t.is(await port.publish(manifest, bytes, () => false), 'cancelled');
        t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/manifests`), []);
        await t.throwsAsync(async () => port.read(manifest));
        t.is(await port.publish(manifest, bytes, () => true), 'published');
        t.deepEqual([...await port.read(manifest)], [0, 255, 13, 128]);
    });
    test(`${name}: rejected publication leaves no target and preserves old generation`, async t => {
        const { port, failPublish } = factory(t);
        t.is(await port.publish(manifest, bytes, () => true), 'published');
        failPublish();
        await t.throwsAsync(async () => port.publish(`${DRAFT_ROOT}/sample/manifests/000002.json`, bytes, () => true));
        t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/manifests`), ['000001.json']);
        t.deepEqual([...await port.read(manifest)], [0, 255, 13, 128]);
    });
    test(`${name}: every entry point rejects paths outside the namespace`, async t => {
        const { port } = factory(t);
        for (const path of ['', '/absolute', '../other', 'notes/a.md', `${DRAFT_ROOT}-other/a`, `${DRAFT_ROOT}/../x`,
            `${DRAFT_ROOT}/a//b`, `${DRAFT_ROOT}/a/./b`, `${DRAFT_ROOT}/a/`, `${DRAFT_ROOT}/a\\b`, `${DRAFT_ROOT}/a\0b`, 'C:/file']) {
            for (const operation of [() => port.list(path), () => port.read(path), () => port.remove!(path),
                () => port.writeBlob(path, bytes), () => port.publish(path, bytes, () => true)]) {
                await t.throwsAsync(async () => operation(), { code: 'invalid-path' });
            }
        }
        await port.writeBlob(blob, bytes);
        t.deepEqual([...await port.read(blob)], [0, 255, 13, 128]);
    });
}
contract('adapter', () => {
    const adapter = new MemoryAdapter();
    return { port: new AdapterDraftStorage(adapter), failPublish: () => {
        adapter.before = async operation => { if (operation === 'rename') throw new Error('Unavailable'); };
    } };
});
contract('desktop real filesystem', t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'draft-contract-'));
    t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
    let fail = false;
    return { port: new DesktopDraftStorage({ ...fs, linkSync: (from, to) => {
        if (fail) throw new Error('Unavailable');
        fs.linkSync(from, to);
    } }, directory), failPublish: () => { fail = true; } };
});
