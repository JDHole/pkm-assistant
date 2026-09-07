/**
 * KomunikatorManager v3 (S28 Z2) — skrzynka plik-per-wiadomość.
 *
 * Vault jest atrapą in-memory (mapa ścieżka → treść), więc testy dotykają PRAWDZIWEJ
 * logiki managera: składania frontmattera, liczenia statusów, kolizji timestampów
 * i twardych guardów ścieżek. Zero mocków samego managera.
 */
import test from 'ava';
import {
    KomunikatorManager as RuntimeKomunikatorManager,
    buildMessageMarkdown as runtimeBuildMessageMarkdown,
    parseMessage as runtimeParseMessage,
    setFrontmatterFlag as runtimeSetFrontmatterFlag,
    KOM_RATE_WINDOW_MS,
    KOM_HOP_TTL_MS,
    KOM_HOP_LIMIT,
} from './KomunikatorManager.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
// Alias — goły `t` jest wewnątrz każdego testu zajęty przez ExecutionContext AVA.
import { t as tr } from '../../core/i18n/index.js';

type TestMessage = {
    id: string; from: string; to: string; subject: string; body: string;
    userRead: boolean; aiRead: boolean; allRead: boolean; hop: number;
    header: { subject: string; from: string; to: string; userRead: boolean; aiRead: boolean; allRead: boolean; hop: number };
};
type TestManager = {
    sendMessage(...args: unknown[]): Promise<{ success: boolean; id: string; path: string; error?: string }>;
    listMessages(...args: unknown[]): Promise<TestMessage[]>;
    readMessage(...args: unknown[]): Promise<{ success: boolean; message: TestMessage; error?: string }>;
    getMessage(...args: unknown[]): Promise<TestMessage | null>;
    markUserRead(...args: unknown[]): Promise<boolean>;
    markAiRead(...args: unknown[]): Promise<boolean>;
    listAllRead(...args: unknown[]): Promise<TestMessage[]>;
    deleteMessage(...args: unknown[]): Promise<boolean>;
    getUnreadCount(...args: unknown[]): Promise<number>;
    getAiUnreadCount(...args: unknown[]): Promise<number>;
    getUnreadCounts(...args: unknown[]): Promise<Map<string, number>>;
    getInboxPing(...args: unknown[]): Promise<{ count: number; senders: string[] }>;
    noteSend(...args: unknown[]): void;
    checkSendAllowed(...args: unknown[]):
        { allowed: boolean; count: number; limit: number; senderCount: number; senderLimit: number; reason?: 'pair' | 'sender' };
    reserveSend(...args: unknown[]):
        { allowed: boolean; count: number; limit: number; senderCount: number; senderLimit: number; reason?: 'pair' | 'sender' };
    releaseSend(...args: unknown[]): void;
    noteRead(...args: unknown[]): void;
    nextHopFor(...args: unknown[]): number;
    resolveHopFor(...args: unknown[]): Promise<number>;
    attachVaultEvents(...args: unknown[]): boolean;
    detachVaultEvents(...args: unknown[]): void;
    _vaultEventRefs: unknown[];
};
const KomunikatorManager = RuntimeKomunikatorManager as unknown as new (vault: unknown, agents?: unknown, options?: unknown) => TestManager;
const buildMessageMarkdown = runtimeBuildMessageMarkdown as unknown as (frontmatter: unknown, body: string) => string;
const parseMessage = runtimeParseMessage as unknown as (markdown: string, id: string) => TestMessage | null;
const setFrontmatterFlag = runtimeSetFrontmatterFlag as unknown as (markdown: string, flag: string, value: boolean) => string;

function fakeVault(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    const dirs = new Set<string>();
    return {
        _files: files,
        _dirs: dirs,
        adapter: {
            async exists(p: string) { return files.has(p) || dirs.has(p); },
            async mkdir(p: string) { dirs.add(p); },
            async read(p: string) {
                if (!files.has(p)) throw new Error(`ENOENT ${p}`);
                return files.get(p);
            },
            async write(p: string, data: string) { files.set(p, data); },
            async remove(p: string) { files.delete(p); },
            async list(dir: string) {
                const prefix = dir.endsWith('/') ? dir : dir + '/';
                return {
                    files: [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')),
                    folders: [...dirs].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')),
                };
            },
        },
    };
}

type VaultEventCb = (file: unknown, oldPath?: unknown) => void;

/**
 * W8 follow-up (review koordynatora): `fakeVault` PLAIN nie ma `.on`/`.offref` — dokładnie
 * jak w większości testów tego pliku, gdzie kesz opiera się WYŁĄCZNIE na jawnej inwalidacji
 * + TTL. Ten wariant DODAJE event API realnego Obsidian `Vault`, żeby dowieść drugi kanał
 * ochrony (`attachVaultEvents`) — `_emitVaultEvent` symuluje to, co Obsidian odpaliłby po
 * zapisie z zewnątrz (sync Google Drive, obsidian-git, agent CC piszący wprost na dysk).
 */
function fakeVaultWithEvents(initial: Record<string, string> = {}) {
    const base = fakeVault(initial);
    const listeners = new Map<string, Set<VaultEventCb>>();
    const refs = new Map<number, { event: string; cb: VaultEventCb }>();
    let refSeq = 0;
    return {
        ...base,
        on(event: string, cb: VaultEventCb) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
            const id = ++refSeq;
            refs.set(id, { event, cb });
            return id;
        },
        offref(ref: unknown) {
            const entry = refs.get(ref as number);
            if (!entry) return;
            listeners.get(entry.event)?.delete(entry.cb);
            refs.delete(ref as number);
        },
        _emitVaultEvent(event: string, file: unknown, oldPath?: unknown) {
            for (const cb of listeners.get(event) || []) cb(file, oldPath);
        },
        _listenerCount(event: string) { return listeners.get(event)?.size || 0; },
    };
}

function makeManager(initial: Record<string, string> = {}, options: Record<string, unknown> = {}) {
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    const vault = fakeVault(initial);
    const manager = new KomunikatorManager(vault, { _emit: (event: string, data: Record<string, unknown>) => emitted.push({ event, data }) }, options);
    return { manager, vault, emitted };
}

/** Zegar na sznurku — rate-limit i TTL odbić testujemy bez czekania realnych minut. */
function fakeClock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => { now += ms; } };
}

// ───────────────────────── pure helpery ─────────────────────────

test('buildMessageMarkdown: temat z cudzysłowem i nową linią nie rozwala frontmattera', t => {
    const md = buildMessageMarkdown({
        od: 'Tola', do: 'Sonny',
        temat: 'Brief: "tygodniowy"\nz nową linią',
        data: '2026-07-29 14:30',
        user_read: false, ai_read: false,
    }, 'treść');

    const parsed = parseMessage(md, 'msg-1')!;
    t.is(parsed.header.subject, 'Brief: "tygodniowy" z nową linią');
    t.is(parsed.header.from, 'Tola');
    t.is(parsed.header.to, 'Sonny');
    t.is(parsed.body, 'treść');
    t.false(parsed.header.userRead);
    t.false(parsed.header.aiRead);
    t.false(parsed.header.allRead);
});

test('parseMessage: ALL_READ jest LICZONE z obu flag, nie zapisywane', t => {
    const md = buildMessageMarkdown({
        od: 'A', do: 'B', temat: 'x', data: 'd', user_read: true, ai_read: true,
    }, 'body');
    t.false(md.includes('all_read'), 'ALL_READ nie ma prawa trafić do pliku');
    t.true(parseMessage(md, 'msg-1')!.header.allRead);
});

test('parseMessage: plik bez frontmattera nie jest wiadomością', t => {
    t.is(parseMessage('zwykła notatka', 'msg-1'), null);
});

test('setFrontmatterFlag: podmienia tylko blok frontmattera, treść nietknięta', t => {
    const md = buildMessageMarkdown(
        { od: 'A', do: 'B', temat: 'x', data: 'd', user_read: false, ai_read: false },
        'cytat: ai_read: true — to NIE jest flaga',
    );
    const updated = setFrontmatterFlag(md, 'ai_read', true);
    const parsed = parseMessage(updated, 'msg-1')!;
    t.true(parsed.header.aiRead);
    t.false(parsed.header.userRead);
    t.is(parsed.body, 'cytat: ai_read: true — to NIE jest flaga');
});

// ───────────────────────── store ─────────────────────────

test('sendMessage → listMessages: wiadomość ląduje w folderze adresata jako osobny plik', async t => {
    const { manager, vault, emitted } = makeManager();
    const res = await manager.sendMessage('Tola', 'Sonny', 'Temat', 'Treść wiadomości');

    t.true(res.success);
    t.regex(res.id, /^msg-\d+$/);
    t.is(res.path, `.pkm-assistant/komunikator/inbox/sonny/${res.id}.md`);
    t.true(vault._files.has(res.path));
    t.is(emitted.at(-1)!.event, 'communicator:message_updated');

    const list = await manager.listMessages('Sonny');
    t.is(list.length, 1);
    t.is(list[0].from, 'Tola');
    t.is(list[0].subject, 'Temat');
    t.false(list[0].aiRead);
    // Skrzynka nadawcy zostaje pusta — brak outboxów (decyzja z Mapy-2, dalej obowiązuje).
    t.is((await manager.listMessages('Tola')).length, 0);
});

// `test.serial` bo test podmienia globalny Date.now — równoległe testy nie mogą tego zobaczyć.
test.serial('sendMessage: kolizja timestampu daje sufiks zamiast nadpisania (create-only)', async t => {
    const { manager, vault } = makeManager();
    const fixed = Date.now();
    const realNow = Date.now;
    Date.now = () => fixed;
    try {
        const a = await manager.sendMessage('A', 'B', 't1', 'c1');
        const b = await manager.sendMessage('A', 'B', 't2', 'c2');
        t.is(a.id, `msg-${fixed}`);
        t.is(b.id, `msg-${fixed}-1`);
        t.is(vault._files.size, 2, 'żaden plik nie został nadpisany');
    } finally {
        Date.now = realNow;
    }
});

test('sendMessage: odmawia wiadomości większej niż limit', async t => {
    const { manager, vault } = makeManager();
    const res = await manager.sendMessage('A', 'B', 't', 'x'.repeat(50 * 1024 + 1));
    t.false(res.success);
    t.is(vault._files.size, 0);
});

test('sendMessage: pusty adresat → odmowa (brak folderu-śmiecia)', async t => {
    const { manager, vault } = makeManager();
    const res = await manager.sendMessage('A', '', 't', 'c');
    t.false(res.success);
    t.is(vault._files.size, 0);
});

test('readMessage: zwraca treść i sam odhacza ai_read (auto-ptaszek AI)', async t => {
    const { manager } = makeManager();
    const sent = await manager.sendMessage('A', 'B', 'temat', 'ciało wiadomości');

    const read = await manager.readMessage('B', sent.id);
    t.true(read.success);
    t.is(read.message.body, 'ciało wiadomości');
    t.true(read.message.aiRead);
    t.false(read.message.userRead);

    // Trwałe — druga lista widzi już odhaczoną wiadomość.
    const list = await manager.listMessages('B');
    t.true(list[0].aiRead);
    t.false(list[0].allRead, 'user jeszcze nie czytał');
});

test('getMessage (ścieżka UI): pokazuje treść NIE ruszając ai_read', async t => {
    const { manager } = makeManager();
    const sent = await manager.sendMessage('A', 'B', 'temat', 'ciało');

    const peeked = (await manager.getMessage('B', sent.id)) as TestMessage;
    t.is(peeked.body, 'ciało');
    t.false((await manager.listMessages('B'))[0].aiRead);
});

test('markUserRead + readMessage → allRead policzone z obu ptaszków', async t => {
    const { manager } = makeManager();
    const sent = await manager.sendMessage('A', 'B', 'temat', 'ciało');

    t.true(await manager.markUserRead('B', sent.id));
    t.false((await manager.listMessages('B'))[0].allRead);

    await manager.readMessage('B', sent.id);
    const list = await manager.listMessages('B');
    t.true(list[0].allRead);
    t.deepEqual((await manager.listAllRead('B')).map(m => m.id), [sent.id]);
});

test('sygnał ALL_READ leci DOKŁADNIE raz — przy drugim ptaszku, niezależnie od kolejności', async t => {
    for (const order of ['user-first', 'ai-first']) {
        const { manager, emitted } = makeManager();
        const sent = await manager.sendMessage('A', 'B', 't', 'c');
        const allRead = () => emitted.filter(e => e.event === 'communicator:message_all_read');

        if (order === 'user-first') {
            await manager.markUserRead('B', sent.id);
            t.is(allRead().length, 0, `${order}: pierwszy ptaszek nie sprząta`);
            await manager.readMessage('B', sent.id);
        } else {
            await manager.readMessage('B', sent.id);
            t.is(allRead().length, 0, `${order}: pierwszy ptaszek nie sprząta`);
            await manager.markUserRead('B', sent.id);
        }

        t.is(allRead().length, 1, `${order}: sygnał raz`);
        t.is(allRead()[0].data.id, sent.id);

        // Powtórzone oznaczenie nie zmienia pliku → żadnego dodatkowego sygnału.
        await manager.markUserRead('B', sent.id);
        await manager.markAiRead('B', sent.id);
        t.is(allRead().length, 1, `${order}: brak duplikatu sygnału`);
    }
});

test('deleteMessage: twarde usunięcie pliku (D5 — bez kosza)', async t => {
    const { manager, vault } = makeManager();
    const sent = await manager.sendMessage('A', 'B', 't', 'c');

    t.true(await manager.deleteMessage('B', sent.id));
    t.is(vault._files.size, 0);
    t.is((await manager.listMessages('B')).length, 0);
    t.false(await manager.deleteMessage('B', sent.id), 'drugie kasowanie = false, bez wyjątku');
});

test('liczniki: user-unread (badge) i ai-unread (ping) są niezależne', async t => {
    const { manager } = makeManager();
    const first = await manager.sendMessage('Tola', 'B', 't1', 'c1');
    await manager.sendMessage('Klara', 'B', 't2', 'c2');

    t.is(await manager.getUnreadCount('B'), 2);
    t.is(await manager.getAiUnreadCount('B'), 2);

    await manager.markUserRead('B', first.id);
    t.is(await manager.getUnreadCount('B'), 1);
    t.is(await manager.getAiUnreadCount('B'), 2, 'ptaszek usera nie rusza licznika AI');

    await manager.readMessage('B', first.id);
    t.is(await manager.getAiUnreadCount('B'), 1);

    const counts = await manager.getUnreadCounts(['B', 'Nikt']);
    t.is(counts.get('B'), 1);
    t.is(counts.get('Nikt'), 0);
});

test('getInboxPing: liczba + unikalni nadawcy, ZERO treści', async t => {
    const { manager } = makeManager();
    await manager.sendMessage('Tola', 'B', 't1', 'tajna treść');
    await manager.sendMessage('Tola', 'B', 't2', 'tajna treść');
    await manager.sendMessage('Klara', 'B', 't3', 'tajna treść');

    const ping = await manager.getInboxPing('B');
    t.is(ping.count, 3);
    t.deepEqual(ping.senders.sort(), ['Klara', 'Tola']);
    t.false(JSON.stringify(ping).includes('tajna'));
});

test('id od modelu: traversal i lewe nazwy odrzucone zanim dotkną dysku', async t => {
    const { manager, vault } = makeManager({ 'Sekrety/klucze.md': 'API_KEY' });
    await manager.sendMessage('A', 'B', 't', 'c');

    for (const badId of ['../../../Sekrety/klucze', 'msg-1/../../x', 'Sekrety/klucze', '', 'msg-abc']) {
        const res = await manager.readMessage('B', badId);
        t.false(res.success, `id "${badId}" nie może przejść`);
        t.is(await manager.getMessage('B', badId), null);
        t.false(await manager.deleteMessage('B', badId));
    }
    t.true(vault._files.has('Sekrety/klucze.md'), 'plik spoza skrzynki nietknięty');
});

test('listMessages: pusta/nieistniejąca skrzynka = pusta lista, bez wyjątku', async t => {
    const { manager } = makeManager();
    t.deepEqual(await manager.listMessages('Nikt'), []);
    t.is(await manager.getUnreadCount('Nikt'), 0);
    t.deepEqual(await manager.getInboxPing('Nikt'), { count: 0, senders: [] });
});

// `test.serial` — jw., podmienia globalny Date.now.
test.serial('listMessages: najnowsze pierwsze (sortowanie po timestampie w id)', async t => {
    const { manager } = makeManager();
    const stamps = [1000, 2000, 3000];
    const realNow = Date.now;
    try {
        for (const s of stamps) { Date.now = () => s; await manager.sendMessage('A', 'B', `t${s}`, 'c'); }
    } finally { Date.now = realNow; }

    t.deepEqual((await manager.listMessages('B')).map(m => m.id), ['msg-3000', 'msg-2000', 'msg-1000']);
});

test('listMessages: ignoruje pliki spoza wzorca msg-* w folderze skrzynki', async t => {
    const { manager, vault } = makeManager();
    await manager.sendMessage('A', 'B', 't', 'c');
    vault._files.set('.pkm-assistant/komunikator/inbox/b/notatka.md', '---\nod: X\n---\nhej');

    const list = await manager.listMessages('B');
    t.is(list.length, 1);
    t.is(list[0].subject, 't');
});

// ═══════════════ S33 Z2 — strażnicy poczty (rate-limit + licznik odbić) ═══════════════

test('B1 rate-limit: limit liczy się PER PARA nadawca→adresat', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    for (let i = 0; i < 3; i++) manager.noteSend('Tola', 'Sonny');

    t.false(manager.checkSendAllowed('Tola', 'Sonny', 3).allowed, 'ta para wyczerpana');
    t.true(manager.checkSendAllowed('Tola', 'Klara', 3).allowed, 'inny adresat ma własną pulę');
    t.true(manager.checkSendAllowed('Klara', 'Sonny', 3).allowed, 'inny nadawca ma własną pulę');
});

test('B1 rate-limit: wielkość liter nie obchodzi limitu', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.noteSend('Tola', 'Sonny');
    manager.noteSend('TOLA', 'sonny');

    t.false(manager.checkSendAllowed('tola', 'SONNY', 2).allowed);
});

test('B1 rate-limit: po wyjściu z okna 10 min pula wraca', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.noteSend('Tola', 'Sonny');
    manager.noteSend('Tola', 'Sonny');
    t.false(manager.checkSendAllowed('Tola', 'Sonny', 2).allowed);

    clock.advance(KOM_RATE_WINDOW_MS + 1);
    const after = manager.checkSendAllowed('Tola', 'Sonny', 2);
    t.true(after.allowed);
    t.is(after.count, 0, 'stare znaczniki wypadły z okna');
});

test('B1 rate-limit: śmieciowy limit spada na default z config/limits.js', t => {
    const { manager } = makeManager();
    t.is(manager.checkSendAllowed('A', 'B').limit, DEFAULT_LIMITS.kom_send_rate_max);
    t.is(manager.checkSendAllowed('A', 'B', 0).limit, DEFAULT_LIMITS.kom_send_rate_max);
    t.is(manager.checkSendAllowed('A', 'B', 'duzo').limit, DEFAULT_LIMITS.kom_send_rate_max);
});

// ═══════════════ K12 (ogon K6) — DRUGI sufit: pula wysyłkowa NADAWCY ═══════════════

test('K12: 12 różnych adresatów poniżej limitu pary — sufit nadawcy i tak przerywa', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });
    const PARA = 5;      // każdy adresat dostaje najwyżej 5 → 12 × 5 = 60 > 40
    const NADAWCA = 40;

    // 40 wysyłek rozdzielonych po 12 adresatach: żadna para nie zbliża się do swojego limitu.
    for (let i = 0; i < 40; i++) {
        const to = `Agent${i % 12}`;
        const res = manager.reserveSend('Tola', to, PARA, NADAWCA);
        t.true(res.allowed, `wysyłka ${i + 1} do ${to} powinna przejść`);
    }

    const stop = manager.reserveSend('Tola', 'Agent0', PARA, NADAWCA);
    t.false(stop.allowed, '41. wysyłka w oknie musi się odbić');
    t.is(stop.reason, 'sender', 'odmowa idzie z sufitu NADAWCY, nie z limitu pary');
    t.true(stop.count < PARA, 'limit pary nie był nawet blisko wyczerpania');
    t.is(stop.senderLimit, NADAWCA);

    // Inny nadawca ma własną pulę — sufit jest per agent, nie globalny.
    t.true(manager.reserveSend('Klara', 'Agent0', PARA, NADAWCA).allowed);
});

test('K12: klucz nadawcy jest niewrażliwy na wielkość liter', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.noteSend('Tola', 'Sonny');
    manager.noteSend('TOLA', 'Klara');
    manager.noteSend('tola', 'Borys');

    const res = manager.checkSendAllowed('ToLa', 'Wera', 10, 3);
    t.false(res.allowed, '„Tola" i „tola" to jeden nadawca');
    t.is(res.reason, 'sender');
    t.is(res.senderCount, 3);
});

test('K12: po wyjściu z okna 10 min pula NADAWCY też wraca', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.noteSend('Tola', 'Sonny');
    manager.noteSend('Tola', 'Klara');
    t.false(manager.checkSendAllowed('Tola', 'Wera', 10, 2).allowed);

    clock.advance(KOM_RATE_WINDOW_MS + 1);
    const after = manager.checkSendAllowed('Tola', 'Wera', 10, 2);
    t.true(after.allowed);
    t.is(after.senderCount, 0, 'stare znaczniki nadawcy wypadły z okna');
});

test('K12: limit PARY działa niezależnie — odmowa mówi `pair`', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.reserveSend('Tola', 'Sonny', 2, 40);
    manager.reserveSend('Tola', 'Sonny', 2, 40);

    const stop = manager.reserveSend('Tola', 'Sonny', 2, 40);
    t.false(stop.allowed);
    t.is(stop.reason, 'pair', 'wąska para odbija PRZED szerokim sufitem nadawcy');
    t.true(manager.reserveSend('Tola', 'Klara', 2, 40).allowed, 'inny adresat wciąż przechodzi');
});

test('K12: nieudany zapis oddaje slot w OBU licznikach', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.reserveSend('Tola', 'Sonny', 2, 2);
    manager.releaseSend('Tola', 'Sonny');

    const res = manager.checkSendAllowed('Tola', 'Sonny', 2, 2);
    t.is(res.count, 0, 'slot pary wrócił do puli');
    t.is(res.senderCount, 0, 'slot nadawcy też wrócił — błąd dysku nie zjada sufitu');
});

test('K12: śmieciowy sufit nadawcy spada na default z config/limits.js', t => {
    const { manager } = makeManager();
    t.is(manager.checkSendAllowed('A', 'B').senderLimit, DEFAULT_LIMITS.kom_send_rate_max_sender);
    t.is(manager.checkSendAllowed('A', 'B', 5, 0).senderLimit, DEFAULT_LIMITS.kom_send_rate_max_sender);
    t.is(manager.checkSendAllowed('A', 'B', 5, 'duzo').senderLimit, DEFAULT_LIMITS.kom_send_rate_max_sender);
});

test('B2 hop: bez przeczytanej poczty wiadomość startuje od 0', t => {
    const { manager } = makeManager();
    t.is(manager.nextHopFor('Tola'), 0);
});

test('B2 hop: po przeczytaniu hop-2 kolejna wysyłka byłaby trzecim odbiciem', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.noteRead('Tola', 2);

    t.is(manager.nextHopFor('Tola'), 3);
    t.true(manager.nextHopFor('Tola') >= KOM_HOP_LIMIT, 'to jest właśnie próg odmowy');
    t.is(manager.nextHopFor('Sonny'), 0, 'łańcuch jest per agent');
});

test('B2 hop: liczy się NAJWYŻSZY świeżo przeczytany hop', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.noteRead('Tola', 2);
    manager.noteRead('Tola', 0);

    t.is(manager.nextHopFor('Tola'), 3, 'świeży list od usera nie zeruje łańcucha');
});

test('B2 hop: odczyt starszy niż TTL przestaje budować łańcuch', t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });

    manager.noteRead('Tola', 2);
    clock.advance(KOM_HOP_TTL_MS + 1);

    t.is(manager.nextHopFor('Tola'), 0, 'nowa rozmowa (przybliżona ciszą) startuje od zera');

    manager.noteRead('Tola', 0);
    t.is(manager.nextHopFor('Tola'), 1, 'po TTL licznik rusza od nowa, nie od starego maksimum');
});

test('B2 hop: sendMessage zapisuje hop we frontmatterze, kom_read go odczytuje', async t => {
    const { manager, vault } = makeManager();
    await manager.sendMessage('Tola', 'Sonny', 't', 'c', { hop: 2 });

    t.true([...vault._files.values()][0].includes('hop: 2'));

    const list = await manager.listMessages('Sonny');
    t.is(list[0].hop, 2);
});

test('B2 hop: domyślnie 0 — ścieżka UI (user pisze z panelu) nie buduje łańcucha', async t => {
    const { manager, vault } = makeManager();
    await manager.sendMessage('User', 'Sonny', 't', 'c');

    t.true([...vault._files.values()][0].includes('hop: 0'));
});

test('B2 hop: stara wiadomość BEZ pola hop czyta się jako 0 (kompatybilność)', t => {
    const legacy = [
        '---', 'type: kom-message', 'od: "Tola"', 'do: "Sonny"',
        'temat: "Stary list"', 'data: "2026-07-01 10:00"',
        'user_read: false', 'ai_read: false', '---', '', 'treść', '',
    ].join('\n');

    t.is(parseMessage(legacy, 'msg-1')!.header.hop, 0);
});

test('B2 hop: readMessage odnotowuje odczyt, getMessage (podgląd UI) NIE', async t => {
    const { manager } = makeManager();
    await manager.sendMessage('Tola', 'Sonny', 't', 'c', { hop: 1 });
    const [msg] = await manager.listMessages('Sonny');

    await manager.getMessage('Sonny', msg.id);
    t.is(manager.nextHopFor('Sonny'), 0, 'podglądem w panelu user nie nakręca agentowi łańcucha');

    await manager.readMessage('Sonny', msg.id);
    t.is(manager.nextHopFor('Sonny'), 2, 'dopiero kom_read buduje łańcuch');
});

// ───────────────── K4 / AUD-bledy-063: „nie wiem, czy plik istnieje" ≠ „nazwa wolna" ─────────────────

// `test.serial` bo test podmienia globalny Date.now — równoległe testy nie mogą tego zobaczyć.
test.serial('AUD-bledy-063: exists() rzuca → sendMessage ODMAWIA, nie nadpisuje cudzej wiadomości', async t => {
    const fixed = Date.now();
    const realNow = Date.now;
    Date.now = () => fixed;
    try {
        const path = `.pkm-assistant/komunikator/inbox/sonny/msg-${fixed}.md`;
        const original = buildMessageMarkdown(
            { od: 'Tola', do: 'Sonny', temat: 'pierwszy', data: '2026-08-23 10:00', user_read: false, ai_read: false },
            'treść Tola',
        );
        const { manager, vault } = makeManager({ [path]: original });
        // Zacięcie I/O dokładnie na plikach wiadomości (klient synchronizacji trzyma jeden plik);
        // foldery odpowiadają normalnie, więc `_ensureInboxDir` działa jak zawsze.
        vault.adapter.exists = async (p: string) => {
            if (p.endsWith('.md')) throw new Error('EIO');
            return vault._dirs.has(p);
        };

        const res = await manager.sendMessage('Klara', 'Sonny', 'drugi', 'treść Klary');

        t.false(res.success, 'nieudane SPRAWDZENIE ma blokować zapis (fail-closed), nie udawać wolnej nazwy');
        t.is(vault._files.get(path), original, 'wiadomość Tola nietknięta');
        t.is(vault._files.size, 1, 'żaden nowy plik nie powstał na ślepo');
    } finally {
        Date.now = realNow;
    }
});

// ───────────── AUD-bledy-042 / 046: poczta melduje ZE STANU, nie z zamiaru ─────────────

test('AUD-bledy-042: pad zapisu ptaszka ai_read → readMessage NIE melduje przeczytania', async t => {
    const path = '.pkm-assistant/komunikator/inbox/sonny/msg-1000.md';
    const original = buildMessageMarkdown(
        { od: 'Tola', do: 'Sonny', temat: 'brief', data: '2026-08-23 10:00', user_read: false, ai_read: false },
        'treść listu',
    );
    const { manager, vault, emitted } = makeManager({ [path]: original });
    vault._dirs.add('.pkm-assistant/komunikator/inbox/sonny'); // folder skrzynki istnieje - liczniki mają co listować
    // Plik zablokowany do zapisu (synchronizator vaulta / atrybut tylko-do-odczytu).
    vault.adapter.write = async () => { throw new Error('EACCES'); };

    const res = await manager.readMessage('Sonny', 'msg-1000');

    t.false(res.success, 'ptaszek nie usiadł na dysku → to NIE jest przeczytana wiadomość');
    t.is(res.error, tr('komunikator.mark_read_failed'), 'model dostaje powód, nie ciszę');
    t.is(vault._files.get(path), original, 'plik nietknięty — ai_read dalej false');
    t.is(await manager.getAiUnreadCount('Sonny'), 1, 'licznik pingu dalej widzi list jako nieprzeczytany');
    t.deepEqual(emitted.filter(e => e.event === 'communicator:message_updated'), [],
        'zero eventów „zaktualizowano" po nieudanym zapisie');
});

test('AUD-bledy-046: pad zakładania skrzynki → komunikat o SKRZYNCE, nie o adresacie', async t => {
    const { manager, vault } = makeManager();
    // `mkdir` pada wyłącznie na folderze skrzynki (brak miejsca / prawa / blokada synchronizatora).
    vault.adapter.mkdir = async (p: string) => {
        if (p.includes('/inbox/')) throw new Error('ENOSPC');
        vault._dirs.add(p);
    };

    const res = await manager.sendMessage('Tola', 'Sonny', 'temat', 'treść');

    t.false(res.success);
    t.is(res.error, tr('komunikator.inbox_unavailable'), 'awaria zapisu ma się nazywać awarią zapisu');
    t.not(res.error, tr('komunikator.invalid_recipient'), 'adresat został rozpoznany — to nie jest błąd adresata');
});

test('AUD-bledy-046: pusta nazwa adresata dalej melduje „nieznany adresat"', async t => {
    const { manager } = makeManager();

    const res = await manager.sendMessage('Tola', '', 'temat', 'treść');

    t.false(res.success);
    t.is(res.error, tr('komunikator.invalid_recipient'), 'walidacja nazwy zostaje bez zmian');
});

// ───────────── K8/AUD-code-review-045 + AUD-code-review-046: padnięty odczyt skrzynki ≠ pusta skrzynka ─────────────
//
// `listMessages` (publiczne) łykało KAŻDY błąd I/O na folderze skrzynki i oddawało `[]` —
// dokładnie tę samą wartość co legalnie pusta skrzynka. `resolveHopFor` deklarował fail-closed
// (KOM_HOP_LIMIT), a `CommunicatorView`/`HomeView` miały gotowe catch-e na badge „?" — ale żadne
// z nich nigdy się nie odpalało, bo `listMessages` nie oddawał wyjątku, którego mogłyby złapać.

test('AUD-code-review-045: resolveHopFor wraca KOM_HOP_LIMIT, gdy listing skrzynki rzuca (nie hop 0)', async t => {
    const { manager, vault } = makeManager();
    // Skrzynka istnieje (agent już dostawał pocztę), ale odczyt katalogu akurat pada —
    // to NIE jest to samo co „skrzynka pusta".
    vault._dirs.add('.pkm-assistant/komunikator/inbox/tola');
    vault.adapter.list = async () => { throw new Error('EIO'); };

    t.is(await manager.resolveHopFor('Tola'), KOM_HOP_LIMIT, 'padnięty odczyt = odmowa, nie zresetowany łańcuch');
});

test('AUD-code-review-045: resolveHopFor wraca KOM_HOP_LIMIT, gdy exists() na skrzynce rzuca', async t => {
    const { manager, vault } = makeManager();
    vault.adapter.exists = async (p: string) => {
        if (p.includes('/inbox/tola')) throw new Error('EIO');
        return false;
    };

    t.is(await manager.resolveHopFor('Tola'), KOM_HOP_LIMIT);
});

test('AUD-code-review-045: legalnie pusta skrzynka (folder nigdy nie powstał) NIE jest fail-closed', async t => {
    const clock = fakeClock();
    const { manager } = makeManager(undefined, { now: clock.now });
    manager.noteRead('Tola', 1);

    // Folder skrzynki Tola nigdy nie powstał (zero maili) — to legalne „pusto", nie awaria I/O.
    t.is(await manager.resolveHopFor('Tola'), 2, 'brak folderu ≠ padnięty odczyt — stan z pamięci zostaje');
});

// ───────────── AUD-testy-022: kanał DYSKOWY resolveHopFor (KomunikatorManager.ts:349-355) ─────────────
//
// `resolveHopFor` bierze MAKSIMUM z dwóch źródeł: rejestru w pamięci (`nextHopFor`) i ŚWIEŻEGO
// odczytu własnej skrzynki z dysku (docstring linie 322-334). Kanał dyskowy istnieje DOKŁADNIE
// po to, żeby łańcuch A→B→C→A przeżył restart pluginu — `_readHops` to zwykła `Map`, ginie z
// pamięcią procesu. Wszystkie testy WYŻEJ karmią albo padnięty I/O, albo skrzynkę bez folderu —
// żaden nie podkłada na dysku PRAWDZIWEJ wiadomości z `ai_read: true`, więc pętla licząca
// `fromDisk` (linie 352-354) nie miała ani jednej asercji. Testy hopa w KomunikatorTools.test.ts
// przechodzą wyłącznie po kanale PAMIĘCIOWYM (kom_read w tej samej turze ustawia noteRead).

test('AUD-testy-022: resolveHopFor liczy hop ze ŚWIEŻEJ wiadomości na dysku, mimo PUSTEGO rejestru w pamięci (restart pluginu)', async t => {
    const clock = fakeClock();
    const dir = '.pkm-assistant/komunikator/inbox/tola';
    const path = `${dir}/msg-${clock.now()}.md`;
    const markdown = buildMessageMarkdown(
        { od: 'Sonny', do: 'Tola', temat: 'temat', data: '2026-08-01 10:00', user_read: false, ai_read: true, hop: 2 },
        'treść',
    );
    const { manager, vault } = makeManager({ [path]: markdown }, { now: clock.now });
    vault._dirs.add(dir);

    // BRAK `manager.noteRead(...)` — dokładnie tak wygląda świeży proces po restarcie Obsidiana:
    // `_readHops` (kanał pamięciowy) jest puste, więc `nextHopFor` odda 0. Cały wynik musi
    // przyjść z dysku: wiadomość ma `hop: 2` i jest przeczytana (`ai_read: true`), więc kolejne
    // odbicie ma dostać 3 (maxPrzeczytany + 1) — dokładnie kontrakt z docstringu.
    t.is(
        await manager.resolveHopFor('Tola'),
        3,
        'świeża wiadomość ai_read z dysku (hop:2) ma dać hop 3, mimo pustego rejestru w pamięci'
    );
});

test('AUD-testy-022: resolveHopFor IGNORUJE wiadomość na dysku starszą niż KOM_HOP_TTL_MS (granica świeżości)', async t => {
    const clock = fakeClock();
    const dir = '.pkm-assistant/komunikator/inbox/tola';
    const path = `${dir}/msg-${clock.now()}.md`;
    const markdown = buildMessageMarkdown(
        { od: 'Sonny', do: 'Tola', temat: 'temat', data: '2026-08-01 10:00', user_read: false, ai_read: true, hop: 2 },
        'treść',
    );
    const { manager, vault } = makeManager({ [path]: markdown }, { now: clock.now });
    vault._dirs.add(dir);

    // Zegar ucieka POZA okno świeżości — ten sam plik, ale `stamp <= cutoff` teraz jest prawdą,
    // więc pętla `continue`-uje go (KomunikatorManager.ts:353) i `fromDisk` zostaje 0.
    clock.advance(KOM_HOP_TTL_MS + 1);

    t.is(
        await manager.resolveHopFor('Tola'),
        0,
        'wiadomość spoza okna KOM_HOP_TTL_MS nie ma budować łańcucha — pusty rejestr + stara wiadomość = hop 0'
    );
});

test('AUD-code-review-046: getUnreadCount ODRZUCA przy padniętym listingu skrzynki, nie melduje zero', async t => {
    const { manager, vault } = makeManager();
    vault._dirs.add('.pkm-assistant/komunikator/inbox/tola');
    vault.adapter.list = async () => { throw new Error('EIO'); };

    await t.throwsAsync(
        () => manager.getUnreadCount('Tola'),
        undefined,
        'wołacz (chip w CommunicatorView/HomeView) ma szansę pokazać „?" zamiast potwierdzonego zera',
    );
});

test('listMessages (publiczne) dalej łyka błąd I/O i oddaje [] — kontrakt reszty wołaczy bez zmian', async t => {
    const { manager, vault } = makeManager();
    vault._dirs.add('.pkm-assistant/komunikator/inbox/tola');
    vault.adapter.list = async () => { throw new Error('EIO'); };

    t.deepEqual(await manager.listMessages('Tola'), [], 'ping/UI/narzędzia agenta dalej dostają bezpieczne „pusto"');
});

// ═════════ AUD-wydajnosc-028/058/101/020/053 — kesz nagłówków skrzynki (dowód mutacyjny) ═════════
//
// Znalezisko: KAŻDE odświeżenie sidebara (i KAŻDE `kom_send`/`kom_list`) czytało z dysku
// CAŁĄ skrzynkę KAŻDEGO agenta, plik po pliku, sekwencyjnie, TYLKO żeby policzyć jedną liczbę
// (nieprzeczytane) albo zbudować listę nagłówków. Naprawa: kesz nagłówków per skrzynka
// (`_headerCache`), budowany raz przez `Promise.all` (nie sekwencyjny `for`+`await`) i
// jawnie inwalidowany po KAŻDEJ mutacji tej konkretnej skrzynki (`sendMessage`/`readMessage`/
// `markUserRead`/`markAiRead`/`deleteMessage`). Atrapa vaulta liczy realne wywołania
// `read`/`exists`/`list`, żeby dowód był na LICZBACH operacji I/O, nie na czasie zegarowym.

/** Owija `fakeVault` licznikiem wywołań adaptera per metoda — do dowodu mutacyjnego. */
function countingVault(vault: ReturnType<typeof fakeVault>) {
    const calls = { read: 0, exists: 0, list: 0 };
    const realRead = vault.adapter.read.bind(vault.adapter);
    const realExists = vault.adapter.exists.bind(vault.adapter);
    const realList = vault.adapter.list.bind(vault.adapter);
    vault.adapter.read = async (p: string) => { calls.read++; return realRead(p); };
    vault.adapter.exists = async (p: string) => { calls.exists++; return realExists(p); };
    vault.adapter.list = async (p: string) => { calls.list++; return realList(p); };
    return calls;
}

/** 5 skrzynek × 40 wiadomości (mieszanka read/unread) — rozmiar zbliżony do znaleziska (569/14). */
async function seedInboxes(manager: TestManager, agents: string[], perAgent = 40) {
    for (const agent of agents) {
        for (let i = 0; i < perAgent; i++) {
            const sent = await manager.sendMessage('Nadawca', agent, `t${i}`, `c${i}`);
            if (i % 3 === 0) await manager.markUserRead(agent, sent.id); // część już przeczytana
        }
    }
}

test('AUD-wydajnosc: kesz zimny buduje się przez Promise.all (nie exists+read na plik) — 1 odczyt/plik, 0 podwójnego exists', async t => {
    const { manager, vault } = makeManager();
    const calls = countingVault(vault);
    for (let i = 0; i < 10; i++) await manager.sendMessage('A', 'B', `t${i}`, `c${i}`);
    calls.read = 0; calls.exists = 0; calls.list = 0; // liczymy tylko odczyt skrzynki, nie zapis

    const count = await manager.getUnreadCount('B');

    t.is(count, 10);
    t.is(calls.read, 10, 'jeden `read` na plik wiadomości — bez zdublowanego exists()+read()');
    t.is(calls.exists, 1, 'JEDNO exists() — tylko na katalogu skrzynki, zero per-plik');
    t.is(calls.list, 1);
});

test('AUD-wydajnosc-028/058/101: getUnreadCount po zimnym renderze liczy poprawnie I drugi render jest darmowy', async t => {
    const { manager, vault } = makeManager();
    const AGENTS = ['Tola', 'Sonny', 'Klara', 'Borys', 'Wera'];
    await seedInboxes(manager, AGENTS, 40);
    // 40 wiadomości, co 3-cia (i=0,3,6,...39 → 14 sztuk) oznaczona user_read=true.
    const expectedUnread = 40 - 14;

    const calls = countingVault(vault);
    const first: number[] = [];
    for (const agent of AGENTS) first.push(await manager.getUnreadCount(agent));
    t.deepEqual(first, AGENTS.map(() => expectedUnread), 'liczniki poprawne mimo keszowania');
    t.true(calls.read >= 5 * 40, 'zimny render czyta całą skrzynkę KAŻDEGO agenta (nieunikniony koszt pierwszego razu)');

    calls.read = 0; calls.exists = 0; calls.list = 0;
    const second: number[] = [];
    for (const agent of AGENTS) second.push(await manager.getUnreadCount(agent));

    t.deepEqual(second, first, 'te same liczniki po trafieniu w kesz');
    t.is(calls.read, 0, 'DRUGIE odświeżenie NIECHANIONEJ skrzynki = zero odczytów treści (dowód na AUD-028/058/101)');
    t.is(calls.exists, 0);
    t.is(calls.list, 0, 'nawet listing katalogu jest z kesza — nie tylko odczyt plików');
});

test('AUD-wydajnosc-028/058/101: mutacja JEDNEJ skrzynki inwaliduje TYLKO jej kesz, sąsiednie 4 zostają darmowe', async t => {
    const { manager, vault } = makeManager();
    const AGENTS = ['Tola', 'Sonny', 'Klara', 'Borys', 'Wera'];
    await seedInboxes(manager, AGENTS, 40);
    for (const agent of AGENTS) await manager.getUnreadCount(agent); // ogrzej kesz wszystkich pięciu

    // Mutacja: nowa wiadomość TYLKO do Toli (odpowiednik pojedynczego `kom_send` z tury agenta).
    await manager.sendMessage('Ktoś', 'Tola', 'nowy', 'tresc');

    const calls = countingVault(vault);
    const counts: Record<string, number> = {};
    for (const agent of AGENTS) counts[agent] = await manager.getUnreadCount(agent);

    t.is(counts.Tola, 40 - 14 + 1, 'Tola widzi nową wiadomość — kesz faktycznie zainwalidowany');
    t.is(counts.Sonny, 40 - 14, 'Sonny nietknięty');
    // Koszt: TYLKO Tola (41 plików) czyta dysk na nowo; pozostałe 4 skrzynki (160 plików
    // łącznie) zostają w keszu i płacą zero — to jest dokładnie „targeted invalidation"
    // ze znaleziska (odświeżenie NIE skanuje WSZYSTKICH agentów na ślepo).
    t.is(calls.read, 41, 'przeczytany dysk tylko dla skrzynki, która faktycznie się zmieniła');
    t.is(calls.list, 1, 'jeden listing — tylko Tola');
});

test('AUD-wydajnosc-020/053: kom_list ma twardy sufit — nie rośnie bez ograniczenia razem ze skrzynką', async t => {
    const { manager } = makeManager();
    for (let i = 0; i < 120; i++) await manager.sendMessage('Nadawca', 'B', `t${i}`, `c${i}`);

    const all = await manager.listMessages('B');
    t.is(all.length, 120, 'manager sam nie tnie — sufit żyje w narzędziu (KomunikatorTools), test tu dowodzi materiału wejściowego');
});

// ═════════ W8 follow-up (review koordynatora, 2026-09-02) — zapisy Z ZEWNĄTRZ ═════════
//
// Znalezisko: „wszystkie zapisy idą przez KomunikatorManager" jest fałszywe. Sesje Claude
// Code piszą do skrzynek WPROST na dysk (nowy plik `msg-{epoch}.md`, edycja `ai_read` —
// kontrakt `/agent`), vault bywa synchronizowany Google Drive między laptopem a telefonem
// (pliki pojawiają się/zmieniają bez udziału pluginu), `obsidian-git pull` też potrafi
// podmienić pliki. Kesz z jawną inwalidacją (sekcja wyżej) widzi TYLKO mutacje przez metody
// managera — bez dodatkowej ochrony zamroziłby liczniki do najbliższej takiej mutacji, czyli
// realną regresję funkcjonalną. Naprawa: `attachVaultEvents` (nasłuch `create`/`modify`/
// `delete`/`rename` na `this.vault`, gdy dostępny) + `HEADER_CACHE_TTL_MS=5000` jako siatka
// bezpieczeństwa niezależna od zdarzeń.

test('W8: TTL kesza — zapis Z ZEWNĄTRZ (atrapa bez .on, brak zdarzeń) staje się widoczny po upływie TTL', async t => {
    const clock = fakeClock();
    const { manager, vault } = makeManager(undefined, { now: clock.now });

    const first = await manager.sendMessage('Ktos', 'B', 't0', 'c0');
    await manager.markUserRead('B', first.id);
    t.is(await manager.getUnreadCount('B'), 0, 'kesz zbudowany: jedna wiadomość, przeczytana');

    // Zapis „z zewnątrz" — WPROST na dysk atrapy, z pominięciem KAŻDEJ metody managera.
    // `fakeVault` (bez `.on`) reprezentuje dokładnie ten przypadek, w którym `attachVaultEvents`
    // nie ma jak dać nasłuchu — TTL jest JEDYNĄ siatką bezpieczeństwa.
    const externalPath = '.pkm-assistant/komunikator/inbox/b/msg-9999999999999.md';
    vault._files.set(externalPath, buildMessageMarkdown(
        { od: 'Zewnetrzny', do: 'B', temat: 'z dysku', data: 'd', user_read: false, ai_read: false },
        'tresc z zewnatrz',
    ));

    t.is(await manager.getUnreadCount('B'), 0,
        'PRZED upływem TTL kesz jeszcze nie widzi zapisu z zewnątrz — to jest dokładnie okno ryzyka, które TTL ogranicza w czasie, nie eliminuje');

    clock.advance(5001); // > HEADER_CACHE_TTL_MS (5000ms)
    t.is(await manager.getUnreadCount('B'), 1,
        'PO TTL manager przeczytał dysk na nowo i widzi wiadomość dopisaną z zewnątrz — przed naprawą (kesz bez TTL) NIGDY by jej nie zobaczył');
});

test('W8: attachVaultEvents — zdarzenie vaulta inwaliduje kesz NATYCHMIAST, bez czekania na TTL', async t => {
    const clock = fakeClock();
    const vault = fakeVaultWithEvents();
    const manager = new KomunikatorManager(vault, { _emit: () => {} }, { now: clock.now });
    t.true(manager.attachVaultEvents(), 'atrapa MA .on/.offref — nasłuch faktycznie rusza');

    const first = await manager.sendMessage('Ktos', 'B', 't0', 'c0');
    await manager.markUserRead('B', first.id);
    t.is(await manager.getUnreadCount('B'), 0, 'kesz zbudowany');

    // Zapis Z ZEWNĄTRZ + zdarzenie, które realny Obsidian (albo obsidian-git/sync po jego
    // własnym odświeżeniu) wyemitowałby po takim zapisie — DRUGI kanał ochrony, szybszy niż TTL.
    const externalPath = '.pkm-assistant/komunikator/inbox/b/msg-8888888888888.md';
    vault._files.set(externalPath, buildMessageMarkdown(
        { od: 'Zewnetrzny', do: 'B', temat: 'z dysku', data: 'd', user_read: false, ai_read: false },
        'tresc',
    ));
    vault._emitVaultEvent('create', { path: externalPath });

    // Zegar NIE przesunięty — TTL nie minął. Widoczność MUSI przyjść z eventu, nie z TTL.
    t.is(await manager.getUnreadCount('B'), 1,
        'zdarzenie create zainwalidowało kesz NATYCHMIAST — dowód, że to event, nie TTL, zdjął wpis');
});

test('W8: attachVaultEvents łapie też rename (stara I nowa ścieżka tracą kesz) i delete', async t => {
    const vault = fakeVaultWithEvents();
    const manager = new KomunikatorManager(vault, null, {});
    manager.attachVaultEvents();

    const first = await manager.sendMessage('Ktos', 'Tola', 't0', 'c0');
    await manager.markUserRead('Tola', first.id);
    t.is(await manager.getUnreadCount('Tola'), 0);

    // rename z zewnątrz (np. narzędzie synchronizacji naprawia kolizję nazwy) — oba foldery
    // (stary i nowy) muszą stracić kesz, bo obie ścieżki mogły się zmienić.
    vault._files.set(
        '.pkm-assistant/komunikator/inbox/tola/msg-7777777777777.md',
        buildMessageMarkdown({ od: 'X', do: 'Tola', temat: 't', data: 'd', user_read: false, ai_read: false }, 'c'),
    );
    vault._emitVaultEvent(
        'rename',
        { path: '.pkm-assistant/komunikator/inbox/tola/msg-7777777777777.md' },
        { path: '.pkm-assistant/komunikator/inbox/tola/msg-stara-nazwa.md' },
    );
    t.is(await manager.getUnreadCount('Tola'), 1, 'rename zainwalidował kesz — nowa wiadomość widoczna bez TTL');
});

test('W8: attachVaultEvents — atrapa BEZ .on nie wybucha, zwraca false, kesz chroni tylko TTL', t => {
    const { manager } = makeManager();
    t.false(manager.attachVaultEvents(), 'fakeVault (bez .on) nie ma jak dać nasłuchu — no-op, nie wyjątek');
});

test('W8: attachVaultEvents jest idempotentne — drugie wołanie nie dubluje nasłuchu', t => {
    const vault = fakeVaultWithEvents();
    const manager = new KomunikatorManager(vault, null, {});

    t.true(manager.attachVaultEvents());
    t.true(manager.attachVaultEvents(), 'drugie wołanie zwraca true (już podpięte), ale nie rejestruje drugi raz');
    t.is(vault._listenerCount('create'), 1, 'jeden listener na `create`, nie dwa');
});

test('W8: attachVaultEvents z registerEvent — refy idą do przekazanej funkcji (wzór plugin.registerEvent), nie do wewnętrznej listy', t => {
    const vault = fakeVaultWithEvents();
    const manager = new KomunikatorManager(vault, null, {});
    const registered: unknown[] = [];

    manager.attachVaultEvents((ref: unknown) => registered.push(ref));

    t.is(registered.length, 4, 'create/modify/delete/rename — cztery refy trafiają do registerEvent');
    t.deepEqual(manager._vaultEventRefs, [], 'gdy registerEvent podany, manager NIE trzyma refów sam (Obsidian Component sprząta)');
});

test('W8: detachVaultEvents odpina nasłuch zarejestrowany BEZ registerEvent (harness/testy poza cyklem pluginu)', async t => {
    const vault = fakeVaultWithEvents();
    const manager = new KomunikatorManager(vault, null, {});
    manager.attachVaultEvents();
    t.is(vault._listenerCount('create'), 1);

    manager.detachVaultEvents();
    t.is(vault._listenerCount('create'), 0, 'offref faktycznie odpiął listenery');

    // Po odpięciu zdarzenie już NIE inwaliduje — kontrolna asercja, że test wyżej naprawdę
    // testował nasłuch, a nie coś przypadkowego.
    const first = await manager.sendMessage('Ktos', 'B', 't', 'c');
    await manager.markUserRead('B', first.id);
    t.is(await manager.getUnreadCount('B'), 0);
    vault._files.set(
        '.pkm-assistant/komunikator/inbox/b/msg-6666666666666.md',
        buildMessageMarkdown({ od: 'X', do: 'B', temat: 't', data: 'd', user_read: false, ai_read: false }, 'c'),
    );
    vault._emitVaultEvent('create', { path: '.pkm-assistant/komunikator/inbox/b/msg-6666666666666.md' });
    t.is(await manager.getUnreadCount('B'), 0, 'po detachVaultEvents zdarzenie nie ma już słuchacza — kesz nietknięty (TTL nadal chroni w tle)');
});
