import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { MigrationV3 } from './MigrationV3.js';
import type { MigrationAgentMemoryLike } from './MigrationV3.js';

/**
 * `AgentMemory` jest jeszcze w JavaScripcie, a jego JSDoc deklaruje `@param {Object} vault`,
 * więc TS widzi `memory.vault` jako `Object` i nie uznaje instancji za `MigrationAgentMemoryLike`.
 * Rzutowanie znika, gdy paczka M2b skonwertuje właściciela.
 */
type MemoryUnderTest = AgentMemory & MigrationAgentMemoryLike;
const asMemory = (m: AgentMemory): MemoryUnderTest => m as unknown as MemoryUnderTest;

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>(initialFolders);

    const parentFoldersFor = (path: string): string[] => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join('/'));
        return result;
    };

    for (const path of Object.keys(files)) {
        for (const folder of parentFoldersFor(path)) folders.add(folder);
    }

    return {
        files,
        folders,
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) {
                    folders.add(path);
                },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) {
                    delete files[path];
                },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(path => path.startsWith(prefix)),
                        folders: [...folders].filter(path => path.startsWith(prefix) && path !== folder),
                    };
                },
            },
        },
    };
}

test('MigrationV3 skips fresh installs and creates Memory v3 structure', async t => {
    const { vault, folders } = makeVault();
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const migration = new MigrationV3(memory);

    const result = await migration.run();

    t.deepEqual(result, { skipped: true, reason: 'fresh_install' });
    t.true(folders.has('.pkm-assistant/agents/jaskier/memory/brain'));
    t.true(folders.has('.pkm-assistant/agents/jaskier/memory/sessions/active'));
});

test('MigrationV3 migrates clean brain.md into brain notes and keeps backup', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const brain = `# Jaskier brain

## User
- Kuba lubi krotkie raporty.

## Preferencje
- Odpowiadaj po polsku prostymi slowami.

## Ustalenia
- Projekt PKM Assistant ma release blocker Memory v3.

## Bieżące
- Dzisiaj domykamy sprint M3.
`;
    const { vault, files } = makeVault({
        [`${base}/brain.md`]: brain,
        [`${base}/sessions/old.md`]: 'old session',
    });
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const migration = new MigrationV3(memory, { now: () => '2026-05-15T00:00:00.000Z' });

    const result = await migration.run({ interactive: false });

    t.true(result.migrated === true);
    t.true(Object.prototype.hasOwnProperty.call(files, `${base.replace('/memory', '/memory.v2.backup')}/brain.md`));
    t.true(Object.keys(files).some(path => path.endsWith('/brain/user_kuba_lubi_krotkie_raporty.md')));
    t.true(Object.keys(files).some(path => path.endsWith('/brain/agent_rule_odpowiadaj_po_polsku_prostymi_slowami.md')));
    t.true(Object.keys(files).some(path => path.endsWith('/brain/project_context_projekt_pkm_assistant_ma_release_blocker.md')));
    t.true(Object.keys(files).some(path => path.endsWith('/brain/project_context_dzisiaj_domykamy_sprint_m3.md')));
    t.true(files[`${base}/brain.md`].includes('[[brain/project_context_dzisiaj_domykamy_sprint_m3.md]]'));
    t.true(files[`${base}/brain.md`].includes('## Workflow'));
    t.true(files[`${base}/brain.md`].includes('## Projekty i referencje'));
    t.false(files[`${base}/brain.md`].includes('## Index brain/'));
});

test('MigrationV3 proposes deletion for zombie sections instead of writing zombie brain notes', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain.md`]: `# Jaskier brain

## User
- Kuba uzywa Obsidiana.

## System
- agora project hub
- vault-builder
- Default rob
`,
    });
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const migration = new MigrationV3(memory);

    const result = await migration.run({ interactive: false });
    const brainFiles = Object.keys(files).filter(path => path.includes('/memory/brain/') && path.endsWith('.md'));

    t.true((result.deletedSections || []).includes('System'));
    t.true(brainFiles.every(path => !path.includes('agora') && !path.includes('vault_builder') && !path.includes('default_rob')));
    t.true(brainFiles.some(path => path.endsWith('/user_kuba_uzywa_obsidiana.md')));
});

test('MigrationV3 falls back to legacy brain dump for malformed unsectioned brain.md', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault, files } = makeVault({
        [`${base}/brain.md`]: 'broken: [yaml\nwithout sections\nbut still user memory',
    });
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    const migration = new MigrationV3(memory);

    const result = await migration.run({ interactive: false });
    const dump = files[`${base}/brain/reference_legacy_brain_dump.md`];

    t.true(result.migrated === true);
    t.true(dump.includes('broken: [yaml'));
    t.true(Object.prototype.hasOwnProperty.call(files, `${base.replace('/memory', '/memory.v2.backup')}/brain.md`));
});

// ─── Werdykt 2026-08-27 (AUD-docs-051): Cancel na modalu review naprawdę anuluje ───
//
// Do tej naprawy `AgentManager._initializeMemoryForAgent` wołał `migration.run({interactive:
// false})` DRUGI RAZ, gdy ten `cancelled:true` wracał stąd — czyli plan i tak był stosowany.
// Testy niżej dowodzą, że SAM `MigrationV3` (silnik, niezależnie od tamtego bugu w orkiestracji)
// przy odrzuceniu w modalu nie stosuje planu i zostawia stan tak, że `needsMigration()` wraca
// `true` — modal ma się pojawić ponownie przy następnym starcie. Regresję samej orkiestracji
// (AgentManager) pilnuje osobno `modules/agents/migrationReviewFlow.test.ts` (tamten plik nie
// może importować `AgentMemory`/`MigrationV3` z prawdziwym vaultem — testuje tylko decyzję).

test('MigrationV3 interactive review: Cancel nie stosuje planu - brain.md nietkniety, brain/ nie powstaje, needsMigration zostaje true', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const brain = `# Jaskier brain

## User
- Kuba lubi krotkie raporty.

## System
- agora project hub
`;
    const { vault, files, folders } = makeVault({ [`${base}/brain.md`]: brain });
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    // Atrapa modala: user kliknal Cancel. `MigrationModal._resolveWith('cancel')` oddaje
    // dokladnie taki ksztalt.
    const migration = new MigrationV3(memory, {
        modalFactory: () => ({ prompt: async () => ({ action: 'cancel' }) }),
    });

    t.true(await migration.needsMigration(), 'przed review: legacy brain.md bez brain/ = potrzebna migracja');

    const result = await migration.run({ interactive: true });

    t.true(result.cancelled === true);
    t.false(folders.has(`${base}/brain`), 'brain/ nie ma prawa powstac po Cancel');
    t.is(files[`${base}/brain.md`], brain, 'brain.md ma zostac BAJT W BAJT taki jak przed review - zero zombie-sekcji usunietych bez zgody');
    t.true(await migration.needsMigration(), 'needsMigration MUSI zostac true - to ona sprawia, ze modal wroci przy nastepnym starcie');
});

test('MigrationV3 interactive review: zamkniecie okna bez wyboru (X/Esc) ma TEN SAM skutek co Cancel', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const brain = `# Jaskier brain

## User
- test
`;
    const { vault, files } = makeVault({ [`${base}/brain.md`]: brain });
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    // `MigrationModal.onClose()` woła dokladnie to samo `resolve({action:'cancel'})` co
    // guzik Cancel, gdy user zamknie modal przez X/Esc bez klikniecia zadnego przycisku -
    // z punktu widzenia MigrationV3 to NIEROZROZNIALNE od jawnego Cancel.
    const migration = new MigrationV3(memory, {
        modalFactory: () => ({ prompt: async () => ({ action: 'cancel' }) }),
    });

    const result = await migration.run({ interactive: true });

    t.true(result.cancelled === true);
    t.is(files[`${base}/brain.md`], brain);
    t.true(await migration.needsMigration());
});

test('MigrationV3 interactive review: Confirm (Save) stosuje plan jak dotad - zachowanie bez zmian', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const brain = `# Jaskier brain

## User
- Kuba lubi krotkie raporty.
`;
    const { vault, files } = makeVault({ [`${base}/brain.md`]: brain });
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    let seenPlan: unknown = null;
    const migration = new MigrationV3(memory, {
        modalFactory: (payload) => ({
            prompt: async () => {
                seenPlan = payload.plan;
                return { action: 'accept', plan: payload.plan };
            },
        }),
    });

    const result = await migration.run({ interactive: true });

    t.true(result.migrated === true);
    t.truthy(seenPlan, 'modal ma dostac plan do przegladu');
    t.true(Object.keys(files).some(path => path.endsWith('/brain/user_kuba_lubi_krotkie_raporty.md')));
    t.false(await migration.needsMigration(), 'po Confirm migracja jest zastosowana - brain/ istnieje');
});

// ─── Weryfikacja opus (2026-08-27): guzik "Awaryjny dump" gubil realna tresc brain ───
//
// `MigrationModal._resolveWith` nigdy nie oddawal pola `originalBrain` (guzik fallback
// resolwowal SAM `{action:'fallback'}"), a `_reviewPlan` czytal `result.originalBrain || ''`
// - notatka dumpu wychodzila PUSTA, po czym `applyPlan` i tak nadpisywal brain.md indeksem.
// Stara tresc przezywala WYLACZNIE w `memory.v2.backup/`. Test niezej dowodzi, ze dump niesie
// PELNA, bajt-w-bajt oryginalna tresc - migracja bierze ja teraz z lokalnej zmiennej `run()`
// mial od zawsze, zamiast liczyc na to, ze modal ja odeśle.

test('MigrationV3 interactive review: guzik "Awaryjny dump" niesie PELNA oryginalna tresc brain.md (nie pusty string)', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const brain = `# Jaskier brain

## User
- Kuba lubi krotkie raporty.

## Preferencje
- Odpowiadaj po polsku prostymi slowami.
`;
    const { vault, files } = makeVault({ [`${base}/brain.md`]: brain });
    const memory = asMemory(new AgentMemory(vault, 'Jaskier'));
    // User NIE ufa automatycznemu planowi (mimo ze buildPlan sparsowalby go bez problemu)
    // i klika "Awaryjny dump" - chce surowa kopie CALEGO starego brain.md, nie per-linie split.
    const migration = new MigrationV3(memory, {
        modalFactory: () => ({ prompt: async () => ({ action: 'fallback' }) }),
    });

    const result = await migration.run({ interactive: true });
    const dump = files[`${base}/brain/reference_legacy_brain_dump.md`];

    t.true(result.migrated === true);
    t.truthy(dump, 'notatka dump ma powstac');
    t.true(dump.includes('Kuba lubi krotkie raporty'), 'dump MUSI niesc PELNA oryginalna tresc - nie pusty string');
    t.true(dump.includes('Odpowiadaj po polsku prostymi slowami'), 'dump MUSI niesc CALY brain.md, nie fragment');
    t.false(
        Object.prototype.hasOwnProperty.call(files, `${base}/brain/user_kuba_lubi_krotkie_raporty.md`),
        'guzik fallback pomija automatyczny per-linie split - tylko jeden dump'
    );
    t.false(files[`${base}/brain.md`].includes('Kuba lubi krotkie raporty'), 'brain.md jest nadpisany nowym indeksem, jak dotad (Accept/fallback obie migruja)');
});
