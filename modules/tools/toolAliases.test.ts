import test from 'ava';
import {
    isSearchAlias, resolveSearchAlias, SEARCH_ALIASES,
    isPrimitiveAlias, isToolAlias, resolveToolAlias, PRIMITIVE_ALIASES,
    isArtifactAlias, ARTIFACT_ALIASES
} from './toolAliases.js';

test('isSearchAlias: rozpoznaje stare nazwy retrieval, nie żywe narzędzia', t => {
    t.true(isSearchAlias('vault_grep'));
    t.true(isSearchAlias('memory_sessions'));
    t.false(isSearchAlias('vault_read'));
    t.false(isSearchAlias('search'));
    t.false(isSearchAlias('memory_save'));
});

test('resolveSearchAlias: nieznana nazwa spoza aliasów → null (→ dotychczasowy błąd)', t => {
    t.is(resolveSearchAlias('vault_read', { path: 'a.md' }), null);
    t.is(resolveSearchAlias('nonexistent', {}), null);
});

test('vault_grep → search {query, mode:keyword, where:{folder,glob}}', t => {
    const r = resolveSearchAlias('vault_grep', { pattern: 'foo', folder: 'P', glob: '*.md' })!;
    t.is(r.name, 'search');
    t.deepEqual(r.arguments, { query: 'foo', mode: 'keyword', where: { folder: 'P', glob: '*.md' } });
});

test('vault_search → search {query, where:{folder}}', t => {
    t.deepEqual(resolveSearchAlias('vault_search', { query: 'x', folder: 'P' })!.arguments,
        { query: 'x', where: { folder: 'P' } });
    // bez folderu → gołe query
    t.deepEqual(resolveSearchAlias('vault_search', { query: 'x' })!.arguments, { query: 'x' });
});

test('vault_semantic → search {query, mode:semantic} (puste where usunięte)', t => {
    t.deepEqual(resolveSearchAlias('vault_semantic', { query: 'x' })!.arguments,
        { query: 'x', mode: 'semantic' });
});

test('vault_glob → search {where:{glob}}', t => {
    t.deepEqual(resolveSearchAlias('vault_glob', { pattern: '**/*.md' })!.arguments,
        { where: { glob: '**/*.md' } });
});

test('vault_filter_yaml → search {where:{yaml, folder}}', t => {
    t.deepEqual(resolveSearchAlias('vault_filter_yaml', { filter: { status: 'wip' }, folder: 'P' })!.arguments,
        { where: { yaml: { status: 'wip' }, folder: 'P' } });
});

test('vault_links → search {where:{links_from, links_to}}', t => {
    t.deepEqual(resolveSearchAlias('vault_links', { from: 'A', to: 'B' })!.arguments,
        { where: { links_from: 'A', links_to: 'B' } });
});

test('memory_* → search ze scope:memory', t => {
    t.deepEqual(resolveSearchAlias('memory_grep', { pattern: 'x' })!.arguments,
        { query: 'x', mode: 'keyword', scope: 'memory' });
    t.deepEqual(resolveSearchAlias('memory_semantic', { query: 'x' })!.arguments,
        { query: 'x', mode: 'semantic', scope: 'memory' });
    t.deepEqual(resolveSearchAlias('memory_filter_yaml', { filter: { t: '1' } })!.arguments,
        { scope: 'memory', where: { yaml: { t: '1' } } });
    t.deepEqual(resolveSearchAlias('memory_links', { from: 'A' })!.arguments,
        { scope: 'memory', where: { links_from: 'A' } });
});

test('memory_sessions → search scope:memory folder:sessions', t => {
    t.deepEqual(resolveSearchAlias('memory_sessions', { query: 'x' })!.arguments,
        { query: 'x', scope: 'memory', where: { folder: 'sessions' } });
});

test('memory_summaries → search scope:memory folder wg level', t => {
    t.deepEqual(resolveSearchAlias('memory_summaries', { query: 'x', level: 'L1' })!.arguments,
        { query: 'x', scope: 'memory', where: { folder: 'summaries/L1' } });
    t.deepEqual(resolveSearchAlias('memory_summaries', { query: 'x', level: 'all' })!.arguments,
        { query: 'x', scope: 'memory', where: { folder: 'summaries' } });
    t.deepEqual(resolveSearchAlias('memory_summaries', { query: 'x' })!.arguments,
        { query: 'x', scope: 'memory', where: { folder: 'summaries' } });
});

test('SEARCH_ALIASES pokrywa wszystkie 12 skasowanych narzędzi', t => {
    t.deepEqual(Object.keys(SEARCH_ALIASES).sort(), [
        'memory_filter_yaml', 'memory_grep', 'memory_links', 'memory_semantic',
        'memory_sessions', 'memory_summaries',
        'vault_filter_yaml', 'vault_glob', 'vault_grep', 'vault_links',
        'vault_search', 'vault_semantic'
    ].sort());
});

// ───────────────────────── E2.6 prymitywy plikowe ─────────────────────────

test('isPrimitiveAlias / isToolAlias rozpoznają dawne prymitywy plikowe', t => {
    t.true(isPrimitiveAlias('vault_read'));
    t.true(isPrimitiveAlias('memory_read'));
    t.true(isPrimitiveAlias('memory_list_summaries'));
    t.false(isPrimitiveAlias('read'));
    t.false(isPrimitiveAlias('vault_grep')); // to search alias, nie prymityw
    t.true(isToolAlias('vault_grep'));  // search alias
    t.true(isToolAlias('vault_read'));  // primitive alias
    t.false(isToolAlias('read'));       // żywe narzędzie, nie alias
});

test('vault_* renamey są argumentowo 1:1', t => {
    t.deepEqual(resolveToolAlias('vault_read', { path: 'a.md' }), { name: 'read', arguments: { path: 'a.md' } });
    t.deepEqual(resolveToolAlias('vault_list', { folder: 'P', recursive: true }), { name: 'list', arguments: { folder: 'P', recursive: true } });
    t.deepEqual(resolveToolAlias('vault_write', { path: 'a.md', content: 'x', mode: 'create' }), { name: 'write', arguments: { path: 'a.md', content: 'x', mode: 'create' } });
    t.deepEqual(resolveToolAlias('vault_delete', { path: 'a.md', trash: false }), { name: 'delete', arguments: { path: 'a.md', trash: false } });
    t.deepEqual(resolveToolAlias('vault_create_folder', { path: 'P/sub' }), { name: 'create_folder', arguments: { path: 'P/sub' } });
});

test('memory_read → read{path, scope:memory}', t => {
    t.deepEqual(resolveToolAlias('memory_read', { filename: 'user_x.md' })!.arguments, { path: 'user_x.md', scope: 'memory' });
    t.is(resolveToolAlias('memory_read', { filename: 'user_x.md' })!.name, 'read');
});

test('memory_read_summary → read{path:summaries/<level>/<file>, scope:memory}', t => {
    t.deepEqual(resolveToolAlias('memory_read_summary', { level: 'L1', filename: 'l1_a.md' })!.arguments,
        { path: 'summaries/L1/l1_a.md', scope: 'memory' });
});

test('memory_list_summaries → list{folder:summaries[/level], scope:memory}', t => {
    t.deepEqual(resolveToolAlias('memory_list_summaries', { level: 'L2' })!.arguments, { folder: 'summaries/L2', scope: 'memory' });
    t.deepEqual(resolveToolAlias('memory_list_summaries', { level: 'all' })!.arguments, { folder: 'summaries', scope: 'memory' });
    t.deepEqual(resolveToolAlias('memory_list_summaries', {})!.arguments, { folder: 'summaries', scope: 'memory' });
});

test('resolveToolAlias przepuszcza dawne aliasy search przez wspólny resolver', t => {
    t.deepEqual(resolveToolAlias('vault_grep', { pattern: 'foo' }), { name: 'search', arguments: { query: 'foo', mode: 'keyword' } });
    t.is(resolveToolAlias('nonexistent', {}), null);
});

test('PRIMITIVE_ALIASES pokrywa 8 dawnych prymitywów', t => {
    t.deepEqual(Object.keys(PRIMITIVE_ALIASES).sort(), [
        'memory_list_summaries', 'memory_read', 'memory_read_summary',
        'vault_create_folder', 'vault_delete', 'vault_list', 'vault_read', 'vault_write'
    ].sort());
});

// ─── E2.9 FAZA D — aliasy artefaktów (chat_todo / plan_review / idea_review) ───

test('isArtifactAlias + isToolAlias rozpoznają skasowane narzędzia', t => {
    t.true(isArtifactAlias('chat_todo'));
    t.true(isArtifactAlias('plan_review'));
    t.true(isArtifactAlias('idea_review'));
    t.false(isArtifactAlias('todo'));
    t.true(isToolAlias('chat_todo'));
    t.deepEqual(Object.keys(ARTIFACT_ALIASES).sort(), ['chat_todo', 'idea_review', 'plan_review']);
});

test('chat_todo create → todo create (items znormalizowane, title)', t => {
    const r = resolveToolAlias('chat_todo', { action: 'create', title: 'Lista', items: ['a', { text: 'b' }, ''] })!;
    t.deepEqual(r, { name: 'todo', arguments: { action: 'create', items: ['a', 'b'], title: 'Lista' } });
});

test('chat_todo update → todo check/uncheck po item_index (heurystyka k<idx+1>)', t => {
    t.deepEqual(resolveToolAlias('chat_todo', { action: 'update', item_index: 1, done: true })!.arguments,
        { action: 'check', blockId: 'k2' });
    t.deepEqual(resolveToolAlias('chat_todo', { action: 'update', item_index: 0, status: 'pending' })!.arguments,
        { action: 'uncheck', blockId: 'k1' });
});

test('chat_todo add_item → todo add; list/remove_item → todo list (read-only)', t => {
    t.deepEqual(resolveToolAlias('chat_todo', { action: 'add_item', text: 'x' })!.arguments, { action: 'add', text: 'x' });
    t.deepEqual(resolveToolAlias('chat_todo', { action: 'list' })!.arguments, { action: 'list' });
    t.deepEqual(resolveToolAlias('chat_todo', { action: 'remove_item', item_index: 2 })!.arguments, { action: 'list' });
});

test('plan_review → artifact_create{typ:plan} — kroki ze steps', t => {
    const r = resolveToolAlias('plan_review', { title: 'Plan X', steps: ['Krok 1', { action: 'Krok 2' }] })!;
    t.is(r.name, 'artifact_create');
    t.is(r.arguments.typ, 'plan');
    t.is(r.arguments.tytul, 'Plan X');
    t.deepEqual(r.arguments.sekcje, [
        { op: 'add_item', heading: 'Kroki', text: 'Krok 1' },
        { op: 'add_item', heading: 'Kroki', text: 'Krok 2' },
    ]);
});

test('plan_review bez steps → kroki wyłuskane z markdownu', t => {
    const r = resolveToolAlias('plan_review', { markdown: '1. Zrób A\n- [ ] Zrób B\n* Zrób C' })!;
    t.deepEqual((r.arguments.sekcje as Array<{ text: string }>).map(s => s.text), ['Zrób A', 'Zrób B', 'Zrób C']);
});

test('idea_review → artifact_create{typ:notatka} — treść jako set_section', t => {
    const r = resolveToolAlias('idea_review', { title: 'Post', markdown: 'Treść posta' })!;
    t.is(r.arguments.typ, 'notatka');
    t.is(r.arguments.tytul, 'Post');
    t.deepEqual(r.arguments.sekcje, [{ op: 'set_section', heading: 'Treść', text: 'Treść posta' }]);
});
