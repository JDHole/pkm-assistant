import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { buildSummonMessage, activateArtifactInChat } from './artifactSummon.js';
import { parseArtifactBlockId } from './artifactBlocks.js';

setLocale('pl');

const thin = (over = {}) => ({
    id: 'art-20260723-a1b2',
    tytul: 'Plan porządków',
    typ: 'plan',
    agent: 'jaskier',
    status: 'do-akceptacji',
    frontmatter: { 'pkm-artefakt': 'art-20260723-a1b2', typ: 'plan', status: 'do-akceptacji', cel: 'Ogarnąć Projekty' },
    sections: [
        { heading: 'Kroki', text: '', items: [
            { blockId: 'k1', text: 'Przejrzeć notatki', checked: true },
            { blockId: 'k2', text: 'Zarchiwizować stare', checked: false },
        ] },
        { heading: 'Uwagi usera', text: 'zrób k2 najpierw', items: [] },
    ],
    buttons: true,
    ...over,
});

test('buildSummonMessage: nagłówek zawiera tytuł, id i frazę akcji', t => {
    const msg = buildSummonMessage(thin(), 'zatwierdził plan');
    t.true(msg.includes('Plan porządków'));
    t.true(msg.includes('art-20260723-a1b2'));
    t.true(msg.includes('zatwierdził plan'));
});

test('buildSummonMessage: dołącza sparsowany stan (checkboxy + block-idy + Uwagi usera)', t => {
    const msg = buildSummonMessage(thin(), 'przywołał Cię do artefaktu');
    t.true(msg.includes('k1'));
    t.true(msg.includes('k2'));
    t.true(msg.includes('Zarchiwizować stare'));
    t.true(msg.includes('Uwagi usera'));
    // Stan checkboxów zachowany.
    t.regex(msg, /"checked":\s*true/);
    t.regex(msg, /"checked":\s*false/);
});

test('buildSummonMessage: bez actionLabel → domyślna fraza przywołania (bez wybuchu)', t => {
    const msg = buildSummonMessage(thin(), '');
    t.true(msg.includes('art-20260723-a1b2'));
    t.true(msg.length > 0);
});

test('buildSummonMessage: null/pusty thin → nie wybucha', t => {
    t.notThrows(() => buildSummonMessage(null, 'x'));
    const msg = buildSummonMessage({ id: 'art-x' }, 'przywołał Cię');
    t.true(msg.includes('art-x'));
});

// ── activateArtifactInChat (N2): przypięcie BEZ wysyłki ──────────────────────

/** Atrapa pluginu z jednym widokiem czatu; `sent` liczy wywołania `send_message`. */
function makePlugin(thinState: unknown) {
    const view = {
        currentArtifactId: null as string | null,
        input_area: { value: '' },
        chipRenders: 0,
        sent: 0,
        agentChanges: 0,
        _renderArtifactChip() { this.chipRenders++; },
        send_message() { this.sent++; },
        handleAgentChange() { this.agentChanges++; },
    };
    const plugin = {
        artifactStore: { read: async () => thinState },
        openedChat: 0,
        openChatView() { this.openedChat++; },
        app: { workspace: { getLeavesOfType: () => [{ view }] } },
    };
    return { plugin, view };
}

/** Delivery do widoku leci po ticku (leaf render) — test musi go przeczekać. */
const settle = () => new Promise(resolve => setTimeout(resolve, 400));

test.serial('activateArtifactInChat: ustawia aktywny artefakt i zwraca ścieżkę', async t => {
    const { plugin, view } = makePlugin({ ...thin(), path: 'PKM Assistant/Artefakty/Jaskier/plan.md' });

    const res = await activateArtifactInChat(plugin, { id: 'art-20260723-a1b2' });
    t.true(res.ok);
    t.is(res.path, 'PKM Assistant/Artefakty/Jaskier/plan.md');

    await settle();
    t.is(view.currentArtifactId, 'art-20260723-a1b2');
    t.is(view.chipRenders, 1, 'chip nad inputem przerysowany');
});

test.serial('activateArtifactInChat: NIC nie wysyła (ani wiadomości, ani zmiany agenta)', async t => {
    const { plugin, view } = makePlugin(thin());

    await activateArtifactInChat(plugin, { id: 'art-20260723-a1b2' });
    await settle();

    t.is(view.sent, 0, 'send_message nietknięte');
    t.is(view.input_area.value, '', 'pole inputu nietknięte');
    t.is(view.agentChanges, 0, 'picker listuje artefakty aktywnego agenta — nie ma czego przełączać');
});

test.serial('activateArtifactInChat: brak store\'a / nieznane id → {ok:false}', async t => {
    const { plugin } = makePlugin(null);
    t.deepEqual(await activateArtifactInChat(plugin, { id: 'art-nieznane' }), { ok: false });
    t.deepEqual(await activateArtifactInChat({}, { id: 'art-x' }), { ok: false });
});

test('parseArtifactBlockId: „id: art-..." → id', t => {
    t.is(parseArtifactBlockId('id: art-20260723-a1b2'), 'art-20260723-a1b2');
    t.is(parseArtifactBlockId('  id:   art-9  \n'), 'art-9');
});

test('parseArtifactBlockId: sam token / puste', t => {
    t.is(parseArtifactBlockId('art-20260723-zzzz'), 'art-20260723-zzzz');
    t.is(parseArtifactBlockId(''), '');
    t.is(parseArtifactBlockId('   '), '');
});
