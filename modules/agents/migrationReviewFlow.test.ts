import test from 'ava';
import { runMigrationReview } from './migrationReviewFlow.js';
import type { MigrationReviewEngine } from './migrationReviewFlow.js';

/**
 * Atrapa silnika migracji: NIE dotyka dysku, tylko zlicza wywołania `run()` - dokładnie to,
 * czego brakowało w produkcji, gdy Cancel wołał `run()` drugi raz z `{interactive:false}`,
 * czyli plan migracji i tak lądował na dysku mimo odmowy usera.
 */
function makeMigration(
    runResult: { cancelled?: boolean } | null | undefined,
    needsMigration = true,
) {
    const runCalls: Array<{ interactive?: boolean } | undefined> = [];
    const engine: MigrationReviewEngine = {
        async needsMigration() {
            return needsMigration;
        },
        async run(options) {
            runCalls.push(options);
            return runResult;
        },
    };
    return { engine, runCalls };
}

test('Cancel: migration.run() wolane DOKLADNIE RAZ - zero automatycznego fallbacku', async t => {
    const { engine, runCalls } = makeMigration({ cancelled: true });
    const notified: string[] = [];

    await runMigrationReview(engine, 'Jaskier', true, name => notified.push(name));

    t.is(runCalls.length, 1, 'run() ma byc wolane raz - drugi (fallback) call to wlasnie ten bug');
    t.deepEqual(runCalls[0], { interactive: true });
    t.deepEqual(notified, ['Jaskier'], 'onCancelled musi dostac nazwe agenta DOKLADNIE raz');
});

test('X/Esc bez wyboru = ten sam kontrakt co Cancel (MigrationModal.onClose oddaje {action:\'cancel\'})', async t => {
    // MigrationModal._resolveWith('cancel') i onClose() prowadza do TEGO SAMEGO wyniku
    // MigrationV3._reviewPlan: { cancelled: true }. Z punktu widzenia tej funkcji zamkniecie
    // okna bez wyboru NIE jest odrebna sciezka - jest nierozroznialne od klikniecia Cancel.
    const { engine, runCalls } = makeMigration({ cancelled: true });
    const notified: string[] = [];

    await runMigrationReview(engine, 'Tola', true, name => notified.push(name));

    t.is(runCalls.length, 1);
    t.deepEqual(notified, ['Tola']);
});

test('Confirm: run() wolane raz, zero notyfikacji - zachowanie bez zmian', async t => {
    const { engine, runCalls } = makeMigration({ cancelled: false });
    const notified: string[] = [];

    await runMigrationReview(engine, 'Jaskier', true, name => notified.push(name));

    t.is(runCalls.length, 1);
    t.deepEqual(runCalls[0], { interactive: true });
    t.deepEqual(notified, [], 'sciezka potwierdzenia nie ma prawa wolac onCancelled');
});

test('needsMigration=false (swiezy install / juz v3): run() nigdy nie jest wolane', async t => {
    // `migrated` nie jest tu potrzebne - funkcja w ogole nie ma dojsc do run().
    const { engine, runCalls } = makeMigration({ cancelled: false }, false);
    const notified: string[] = [];

    await runMigrationReview(engine, 'Jaskier', true, name => notified.push(name));

    t.is(runCalls.length, 0);
    t.deepEqual(notified, []);
});

test('interactive=false (headless) leci do run() 1:1 - review sam nie decyduje o trybie', async t => {
    const { engine, runCalls } = makeMigration({ cancelled: false });

    await runMigrationReview(engine, 'Jaskier', false, () => t.fail('brak modala = brak cancel'));

    t.deepEqual(runCalls, [{ interactive: false }]);
});

test('wynik run() bez pola cancelled (null/undefined) nie wywala funkcji ani nie notyfikuje', async t => {
    const { engine: engineNull, runCalls: callsNull } = makeMigration(null);
    const { engine: engineUndef, runCalls: callsUndef } = makeMigration(undefined);

    await t.notThrowsAsync(() => runMigrationReview(engineNull, 'Jaskier', true, () => t.fail()));
    await t.notThrowsAsync(() => runMigrationReview(engineUndef, 'Jaskier', true, () => t.fail()));

    t.is(callsNull.length, 1);
    t.is(callsUndef.length, 1);
});
