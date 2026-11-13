import test from 'ava';
import { createBuildMarker } from './buildManifest.js';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

test('build marker combines trimmed commit hash with UTC build time', t => {
    t.is(createBuildMarker(() => 'a10ecbd\n', new Date('2026-11-13T12:00:00Z')), 'a10ecbd 2026-11-13T12:00:00.000Z');
});
test('unavailable git still produces a timestamped dev build', t => {
    t.is(createBuildMarker(() => { throw new Error('git missing'); }, new Date('2026-11-13T12:00:00Z')), 'dev 2026-11-13T12:00:00.000Z');
});
test('esbuild define reaches the runtime marker and source execution needs no build', async t => {
    const source = readFileSync(new URL('../modules/diagnostics/buildInfo.ts', import.meta.url), 'utf8');
    const built = await transform(source, { loader: 'ts', format: 'esm', define: { __PKM_BUILD__: JSON.stringify('a10ecbd 2026-11-13T12:00:00.000Z') } });
    const dev = await transform(source, { loader: 'ts', format: 'esm' });
    const read = async (code: string): Promise<unknown> => {
        const module: { BUILD_MARKER: unknown } = await import('data:text/javascript,' + encodeURIComponent(code));
        return module.BUILD_MARKER;
    };
    t.is(await read(built.code), 'a10ecbd 2026-11-13T12:00:00.000Z');
    t.is(await read(dev.code), 'dev');
});
