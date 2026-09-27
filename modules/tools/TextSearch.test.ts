import test from 'ava';
import { runTextSearch } from './TextSearch.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

function fixture(files: Record<string, string>, forbidden: string[] = []) {
  const reads: string[] = [];
  const paths = Object.keys(files);
  const adapter = {
    async list(folder: string) {
      const prefix = `${folder.replace(/\/$/, '')}/`;
      const outFiles = new Set<string>(), folders = new Set<string>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) outFiles.add(path); else folders.add(`${prefix}${rest.slice(0, slash)}`);
      }
      return { files: [...outFiles], folders: [...folders] };
    },
    async read(path: string) { reads.push(path); if (!(path in files)) throw new Error('missing'); return files[path]!; },
    async exists(path: string) { return path in files; },
    async stat(path: string) { return path in files ? { size: new TextEncoder().encode(files[path]!).length } : null; },
  };
  const context: BuiltinToolExecutionContext = {
    resultBudgetChars: 600, effectiveResultBudgetChars: 600, shouldAbort: () => false,
    authorizeFileRead: path => ({ allowed: !forbidden.includes(path) }),
    serializeFinalResult: value => JSON.stringify(value),
  };
  return { vault: { adapter }, context, reads };
}

test('text search treats query as a literal and **/ matches the folder root', async t => {
  const f = fixture({ 'Notes/root.js': 'x.a\nnext x.a', 'Notes/sub/a.js': 'x.a' });
  const result = await runTextSearch({ query: 'x.a', where: { folder: 'Notes', glob: '**/*.js' } }, f.vault, f.context) as any;
  t.is(result.status, 'complete');
  t.deepEqual(result.results.map((hit: any) => [hit.path, hit.offset, hit.line, hit.column]), [
    ['Notes/root.js', 0, 1, 0], ['Notes/root.js', 9, 2, 5], ['Notes/sub/a.js', 0, 1, 0],
  ]);
  t.is(result.total, 3);
});

test('forbidden candidate is authorized before read and its path is never returned', async t => {
  const f = fixture({ 'Notes/ok.md': 'needle', 'Notes/private.md': 'needle' }, ['Notes/private.md']);
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context) as any;
  t.deepEqual(f.reads, ['Notes/ok.md']);
  t.false(JSON.stringify(result).includes('Notes/private.md'));
  t.is(result.status, 'partial');
  t.deepEqual(result.scan.reasons, ['access_skipped']);
  t.is(result.scan.skipped_access, 1);
});

test('exact path distinguishes missing and unsupported types without a read', async t => {
  const f = fixture({});
  t.deepEqual(await runTextSearch({ query: 'x', where: { path: 'Notes/a.pdf' } }, f.vault, f.context), { success: false, code: 'unsupported_type', isError: true });
  t.deepEqual(await runTextSearch({ query: 'x', where: { path: 'Notes/missing.md' } }, f.vault, f.context), { success: false, code: 'file_missing', isError: true });
  t.deepEqual(f.reads, []);
});

test('abort after an in-flight file read is explicit and incomplete', async t => {
  const f = fixture({ 'Notes/a.md': 'needle', 'Notes/b.md': 'needle' });
  let reads = 0;
  f.context.shouldAbort = () => reads >= 1;
  const orig = f.vault.adapter.read;
  f.vault.adapter.read = async path => { const text = await orig(path); reads++; return text; };
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context) as any;
  t.is(result.status, 'aborted');
  t.true(result.scan.truncated);
  t.deepEqual(result.scan.reasons, ['aborted']);
    t.is(result.scan.read, 1);
});

test('Stop remains aborted when final JSON budget trims earlier hits', async t => {
  const f = fixture({ 'Notes/a.md': 'needle', 'Notes/b.md': 'needle' });
  f.context.effectiveResultBudgetChars = 316;
  let reads = 0;
  const originalRead = f.vault.adapter.read;
  f.vault.adapter.read = async path => { const content = await originalRead(path); reads++; return content; };
  f.context.shouldAbort = () => reads === 2;
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context) as any;
  t.is(reads, 2);
  t.is(result.status, 'aborted');
  t.is(result.scan.read, 2);
  t.true(result.scan.reasons.includes('aborted'));
  t.true(result.scan.reasons.includes('result_budget'));
  t.true(JSON.stringify(result).length <= 316);
});

test('tiny result cap fails before listing or reading', async t => {
  const f = fixture({ 'Notes/a.md': 'needle' });
  f.context.effectiveResultBudgetChars = 1;
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context);
  t.is(result, 'B');
  t.deepEqual(f.reads, []);
});

test('adversarial wildcard pattern is matched by bounded glob logic', async t => {
  const f = fixture({ 'Notes/aaaaaaaaaab.js': 'needle' });
  let listings = 0;
  const list = f.vault.adapter.list;
  f.vault.adapter.list = async path => { listings++; return list(path); };
  const result = await runTextSearch({ query: 'needle', where: {
    folder: 'Notes', glob: '*a*a*a*a*a*a*a*a*a*a*b.js',
  } }, f.vault, f.context);
  t.is((result as any).status, 'complete');
  t.is((result as any).total, 1);
  t.is(listings, 1);
});

test('result cap returns valid partial JSON with a result_budget reason', async t => {
  const files = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Notes/${String(i).padStart(2, '0')}-entry.md`, 'needle']));
  const f = fixture(files);
  f.context.effectiveResultBudgetChars = 600;
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context) as any;
  t.is(result.status, 'partial');
  t.true(result.scan.reasons.includes('result_budget'));
  t.true(JSON.stringify(result).length <= 600);
  t.true(result.total > 0);
  t.true(result.total < 24);
});

test('enumeration stops at the configured candidate ceiling and reports partial scan', async t => {
  const files = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`Notes/${String(i).padStart(4, '0')}.md`, 'absent']));
  const f = fixture(files);
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context) as any;
  t.is(result.status, 'partial');
  t.is(result.scan.candidates, 2000);
  t.true(result.scan.reasons.includes('candidate_limit'));
  t.true(result.scan.reasons.includes('file_limit'));
    t.is(result.scan.read, 200);
});

test('oversized adapter listing touches at most the candidate cap', async t => {
  const f = fixture({});
  const paths = Array.from({ length: 10000 }, (_, i) => `Notes/${String(i).padStart(5, '0')}.md`);
  let touched = 0;
  const observed = new Proxy(paths, { get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/.test(property)) touched++;
    return Reflect.get(target, property, receiver);
  } });
  f.vault.adapter.list = async () => ({ files: observed, folders: [] });
  f.vault.adapter.stat = async () => ({ size: 0 });
  f.vault.adapter.read = async () => 'absent';
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context) as any;
  t.is(touched, 2000);
  t.is(result.scan.candidates, 2000);
  t.is(result.scan.read, 200);
  t.is(result.status, 'partial');
  t.true(result.scan.reasons.includes('candidate_limit'));
});

test('Stop interrupts materialization immediately after a listing entry is touched', async t => {
  const f = fixture({});
  const paths = Array.from({ length: 10000 }, (_, i) => `Notes/${String(i).padStart(5, '0')}.md`);
  let touched = 0;
  const observed = new Proxy(paths, { get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/.test(property)) touched++;
    return Reflect.get(target, property, receiver);
  } });
  f.vault.adapter.list = async () => ({ files: observed, folders: [] });
  f.context.shouldAbort = () => touched >= 1;
  const result = await runTextSearch({ query: 'needle', where: { folder: 'Notes', glob: '**/*.md' } }, f.vault, f.context) as any;
  t.is(touched, 1);
  t.is(result.status, 'aborted');
  t.deepEqual(result.scan.reasons, ['aborted']);
  t.is(result.scan.read, 0);
});
