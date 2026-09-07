import test from 'ava';
import { migrateJsonArtifactsToNotes } from './migrate_json_to_notes.js';

const NOW = () => new Date('2026-07-23T10:00:00Z');

// ── Mock adapter (dotfolder, in-memory) ──
function makeAdapter(initial: Record<string, string> = {}) {
    const files = new Map<string, string>(Object.entries(initial));
    const folders = new Set<string>();
    return {
        files,
        adapter: {
            exists: async (p: string) => files.has(p) || folders.has(p) || [...files.keys()].some((k: string) => k.startsWith(p + '/')),
            read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p)!; },
            write: async (p: string, c: string) => { files.set(p, c); },
            remove: async (p: string) => { files.delete(p); },
            mkdir: async (p: string) => { folders.add(p); },
            list: async (dir: string) => {
                const prefix = dir.endsWith('/') ? dir : dir + '/';
                const out = [];
                for (const k of files.keys()) {
                    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push(k);
                }
                return { files: out, folders: [] };
            },
        },
    };
}

// ── Mock store: nagrywa importInstance ──
function makeStore() {
    const calls: Array<{ typ: string; tytul?: string; agent?: string; status?: string; utworzono?: string; zaktualizowano?: string; body: string }> = [];
    return {
        calls,
        store: {
            importInstance: async (typ: string, opts: { tytul?: string; agent?: string; status?: string; utworzono?: string; zaktualizowano?: string; body: string }) => {
                calls.push({ typ, ...opts });
                return { id: `art-x${calls.length}`, path: `Artefakty/${opts.agent}/x${calls.length}.md` };
            },
        },
    };
}

const jsonFile = (obj: Record<string, unknown>) => JSON.stringify(obj, null, 2);

test('plan_review JSON → notatka typu plan (kroki jako checkboxy) + źródło skasowane + marker', async t => {
    const { adapter, files } = makeAdapter({
        '.pkm-assistant/artifacts/plan-1.json': jsonFile({
            type: 'plan_review', id: 'plan_1', title: 'Porządki', createdBy: 'Jaskier',
            createdAt: '2026-07-01T08:00:00Z',
            data: { artifactType: 'plan_review', markdown: 'Ogarnij folder', status: 'pending_user_approval',
                steps: [{ action: 'Przejrzeć', status: 'done' }, { action: 'Zarchiwizować' }] },
        }),
    });
    const { store, calls } = makeStore();

    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });

    t.is(res.migrated, 1);
    t.is(res.backedUp, 0);
    t.is(calls.length, 1);
    t.is(calls[0].typ, 'plan');
    t.is(calls[0].tytul, 'Porządki');
    t.is(calls[0].agent, 'Jaskier');
    t.is(calls[0].status, 'do-akceptacji');
    t.is(calls[0].utworzono, '2026-07-01');
    t.true(calls[0].body.includes('- [x] Przejrzeć ^k1'));
    t.true(calls[0].body.includes('- [ ] Zarchiwizować ^k2'));
    t.true(calls[0].body.includes('## Uwagi usera'));
    // Źródło skasowane, marker zapisany.
    t.false(files.has('.pkm-assistant/artifacts/plan-1.json'));
    t.true(files.has('.pkm-assistant/artifacts/.migrated-v2'));
});

test('idea_review + stary typ plan → notatka (treść z markdownu)', async t => {
    const { adapter } = makeAdapter({
        '.pkm-assistant/artifacts/idea.json': jsonFile({ type: 'idea_review', title: 'Post', createdBy: 'Klara', data: { markdown: 'Treść posta' } }),
        '.pkm-assistant/artifacts/old.json': jsonFile({ type: 'plan', title: 'Stara myśl', data: { markdown: 'coś' } }),
    });
    const { store, calls } = makeStore();

    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });

    t.is(res.migrated, 2);
    const idea = calls.find(c => c.tytul === 'Post')!;
    t.is(idea.typ, 'notatka');
    t.true(idea.body.includes('## Treść'));
    t.true(idea.body.includes('Treść posta'));
    t.is(calls.find(c => c.tytul === 'Stara myśl')!.typ, 'notatka');
});

test('approved plan → status zaakceptowany', async t => {
    const { adapter } = makeAdapter({
        '.pkm-assistant/artifacts/p.json': jsonFile({ type: 'plan_review', title: 'X', data: { artifactType: 'plan_review', approved: true, steps: [] } }),
    });
    const { store, calls } = makeStore();
    await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.is(calls[0].status, 'zaakceptowany');
});

test('context-session → backup (nie migrowany), źródło przeniesione', async t => {
    const { adapter, files } = makeAdapter({
        '.pkm-assistant/artifacts/ctx.json': jsonFile({ type: 'context-session', title: 'Sesja', data: { markdown: 'brief' } }),
    });
    const { store, calls } = makeStore();

    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });

    t.is(res.migrated, 0);
    t.is(res.backedUp, 1);
    t.is(calls.length, 0);
    t.false(files.has('.pkm-assistant/artifacts/ctx.json'));
    t.true(files.has('.pkm-assistant/artifacts-backup-2026-07-23/ctx.json'));
});

test('uszkodzony JSON → backup (nie gubimy danych)', async t => {
    const { adapter, files } = makeAdapter({
        '.pkm-assistant/artifacts/broken.json': '{ nie-json',
    });
    const { store } = makeStore();
    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.is(res.backedUp, 1);
    t.is(files.get('.pkm-assistant/artifacts-backup-2026-07-23/broken.json'), '{ nie-json');
});

test('zakopany podfolder plan_review/*.json jest wciągany', async t => {
    const { adapter } = makeAdapter({
        '.pkm-assistant/artifacts/plan_review/buried.json': jsonFile({ type: 'plan_review', title: 'Zakopany', data: { steps: ['Krok'] } }),
    });
    const { store, calls } = makeStore();
    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.is(res.migrated, 1);
    t.is(calls[0].tytul, 'Zakopany');
});

test('idempotentny: marker istnieje → skip', async t => {
    const { adapter } = makeAdapter({
        '.pkm-assistant/artifacts/.migrated-v2': 'done',
        '.pkm-assistant/artifacts/p.json': jsonFile({ type: 'plan_review', title: 'X', data: {} }),
    });
    const { store, calls } = makeStore();
    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.true(res.skipped);
    t.is(res.reason, 'already_migrated');
    t.is(calls.length, 0);
});

test('brak folderu artefaktów → skip bez markera', async t => {
    const { adapter } = makeAdapter({});
    const { store } = makeStore();
    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.true(res.skipped);
    t.is(res.reason, 'no_source');
});

test('folder istnieje ale bez JSONów → marker zapisany, skip', async t => {
    const { adapter, files } = makeAdapter({
        '.pkm-assistant/artifacts/types/plan.md': '---\nnazwa: plan\n---\n',
    });
    const { store } = makeStore();
    const res = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.true(res.skipped);
    t.is(res.reason, 'no_files');
    t.true(files.has('.pkm-assistant/artifacts/.migrated-v2'));
});

test('drugi przebieg po udanej migracji nie robi nic (marker)', async t => {
    const { adapter } = makeAdapter({
        '.pkm-assistant/artifacts/p.json': jsonFile({ type: 'plan_review', title: 'X', data: { steps: ['a'] } }),
    });
    const { store, calls } = makeStore();
    await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.is(calls.length, 1);
    const res2 = await migrateJsonArtifactsToNotes({ adapter, store, now: NOW });
    t.true(res2.skipped);
    t.is(calls.length, 1); // bez drugiego importu
});
