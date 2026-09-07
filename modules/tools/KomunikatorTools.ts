/**
 * KomunikatorTools — trzy prymitywy poczty agenta (S28 D3).
 *
 *   kom_send(to, subject, content)  YELLOW  — wyślij JEDNĄ wiadomość do JEDNEGO adresata
 *   kom_list()                      GREEN   — nagłówki własnej skrzynki
 *   kom_read(id)                    GREEN   — treść jednej wiadomości + auto-ptaszek `ai_read`
 *
 * CREATE-ONLY: agent NIE MA narzędzia kasowania poczty. Sprzątanie robi user (modal
 * z podglądem po drugim ptaszku + guzik hurtowy w sidebarze) — decyzja D5.
 *
 * Tożsamość nadawcy/właściciela skrzynki bierzemy z `args._invocationAgentName`, które
 * wstrzykuje `MCPClient` — model NIE może jej podrobić parametrem (wzór A1-A4).
 *
 * Widoczność (D6) czytamy przez `agentManager` (`listKomunikatorAgents` /
 * `findKomunikatorAgent` / `isKomunikatorVisible`), a nie importem — tak jak dawny
 * `AgentMessageTool`. Dzięki temu narzędzia nie wciągają obsidian-owego barrela
 * komunikatora i zostają node-testowalne, a filtr ducha ma JEDNO źródło prawdy
 * (`modules/komunikator/visibility.js`, do którego deleguje AgentManager).
 */
import { t } from '../../core/i18n/index.js';
import { getLimits } from '../../config/limits.js';

const SERVER_NAME = 'komunikator';

/**
 * S33 B2 — na którym odbiciu przerywamy łańcuch agent→agent. Trzymamy stałą lokalnie
 * (a nie importem z `modules/komunikator/`), żeby `modules/tools/` nie wciągało
 * obsidian-owego barrela komunikatora — dokładnie z tego samego powodu, dla którego
 * widoczność czytamy przez `agentManager`. Manager eksportuje tę samą wartość jako
 * `KOM_HOP_LIMIT`; test pilnuje zgodności.
 */
const HOP_LIMIT = 3;

/**
 * AUD-wydajnosc-020/053 — twardy sufit wyników `kom_list` (skrzynka nie ma ewikcji, rośnie
 * bez ograniczenia — D5/D9 w `modules/komunikator/CLAUDE.md`). Wzór: `MAX_RESULTS` w
 * `ListTool.ts`. Newest-first z `listMessages` sprawia, że obcięcie zawsze zostawia
 * najświeższe wiadomości.
 */
const KOM_LIST_MAX = 50;

/** Argumenty trzech prymitywów poczty (unia — każdy czyta swoje pola). */
export interface KomunikatorArgs {
    /** kom_send: adresat (`to_agent`/`agent`/`target` to tolerowane synonimy). */
    to?: string;
    to_agent?: string;
    agent?: string;
    target?: string;
    subject?: string;
    content?: string;
    /** kom_read: id wiadomości. */
    id?: string;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Agent w zakresie, jaki czytają narzędzia poczty. */
interface KomAgent {
    name: string;
}

/** Wiadomość w skrzynce — nagłówek + treść. */
interface KomMessage {
    id: string;
    from: string;
    subject: string;
    date: string;
    aiRead: boolean;
    body: string;
}

/** Manager poczty (`modules/komunikator`) w zakresie, jakiego używają te narzędzia. */
interface KomunikatorManagerLike {
    /** K6: hop liczony ze stanu ODCZYTANEGO w chwili wysyłki (fail-closed przy braku danych). */
    resolveHopFor(agentName: string): Promise<number>;
    /** K6: łańcuch poczty jednego agenta — `kom_send` i `kom_read` tej samej tury po kolei. */
    withAgentLock<T>(agentName: string, fn: () => Promise<T>): Promise<T>;
    /**
     * K6: ATOMOWA rezerwacja slotu rate-limitu (sprawdzenie + inkrement bez `await` w środku).
     * K12: DWA sufity na to samo okno — `max` per para nadawca→adresat, `senderMax` per nadawca
     * niezależnie od adresata. `reason` mówi, który odmówił.
     */
    reserveSend(from: string, to: string, max: number, senderMax: number):
        { allowed: boolean; limit: number; senderLimit: number; reason?: 'pair' | 'sender' };
    /** K6: zwrot slotu, gdy zapis pliku padł. */
    releaseSend(from: string, to: string): void;
    sendMessage(from: string, to: string, subject: string, content: string, opts?: { hop?: number }):
        Promise<{ success?: boolean; error?: string; id?: string } | undefined>;
    listMessages(agentName: string): Promise<KomMessage[]>;
    readMessage(agentName: string, id: string | undefined):
        Promise<{ success?: boolean; error?: string; message: KomMessage } | undefined>;
}

/** Minimalny widok AgentManagera — widoczność czytamy przez niego, nie importem (D6). */
interface KomAgentManager {
    komunikatorManager?: KomunikatorManagerLike | null;
    getActiveAgent?(): { name?: string } | null | undefined;
    getAgent?(name: string): KomAgent | null | undefined;
    findKomunikatorAgent(name: string): KomAgent | null | undefined;
    listKomunikatorAgents(): KomAgent[];
    isKomunikatorVisible?(agent: KomAgent): boolean;
    _emit?(event: string, payload: Record<string, unknown>): void;
}

/**
 * Rejestr narzędzi w zakresie, którego potrzebuje bramka poczty (K17). Duck-typowany, nie
 * importowany: `modules/tools/KomunikatorTools` ma zostać node-testowalny i nie wciągać
 * rejestru tylko po to, żeby zapytać go o jedną regułę.
 */
interface KomToolRegistryLike {
    checkToolAxis?(agent: unknown, toolName: string): { allowed: boolean; reason?: string };
}

/** Minimalny widok pluginu: `agentManager` + rejestr (oś poczty) + ustawienia (limit wysyłek). */
export interface KomPlugin {
    agentManager?: KomAgentManager | null;
    /** K17: `ToolRegistry` — bramka poczty pyta go o oś `kom_send` WOŁAJĄCEGO. */
    toolRegistry?: KomToolRegistryLike | null;
    env?: { settings?: { pkmAssistant?: { limits?: Record<string, unknown> } } } | null;
}

/**
 * Wynik prologu. JEDEN kształt, nie unia: gałąź błędu niesie wyłącznie `error`, a wołacz
 * sprawdza je PIERWSZĄ linijką i wychodzi — dokładnie jak w JS. (Unia by tu nie pomogła:
 * `error: string` nie jest dyskryminantem literałowym, więc `if (ctx.error)` nic nie zawęża.)
 */
interface CallerContext {
    error?: string;
    agentManager: KomAgentManager;
    komunikator: KomunikatorManagerLike;
    meName: string;
    me: KomAgent | null;
}

/**
 * Wspólny prolog: kim jestem + czy komunikator w ogóle żyje.
 */
function resolveCaller(args: KomunikatorArgs | undefined, plugin: KomPlugin | null | undefined): CallerContext {
    const agentManager = plugin?.agentManager;
    if (!agentManager) return { error: t('mcp.kom.no_agent_manager') } as CallerContext;

    const komunikator = agentManager.komunikatorManager;
    if (!komunikator) return { error: t('mcp.kom.disabled') } as CallerContext;

    const meName = (args?._invocationAgentName as string) || agentManager.getActiveAgent?.()?.name || null;
    if (!meName) return { error: t('mcp.kom.no_identity') } as CallerContext;

    const me = agentManager.getAgent?.(meName) || null;
    // Duch w OBIE strony (D6): niewidzialny agent nie wysyła i nie odbiera. Ten komunikat
    // widzi wyłącznie ON SAM — o cudzej niewidzialności nikt się stąd nie dowie.
    if (me && agentManager.isKomunikatorVisible?.(me) === false) return { error: t('mcp.kom.self_disabled') } as CallerContext;

    return { agentManager, komunikator, meName, me };
}

/**
 * M (AUD-security-111): JEDNO miejsce, które sprowadza adresata do KANONU.
 *
 * `kom_send` toleruje cztery nazwy tego samego pola (`to`/`to_agent`/`agent`/`target`), bo model
 * bywa kreatywny. Bramka w `MCPClient` czytała tylko dwie i wpadała na literał `'agent'`, więc
 * okno zgody mówiło „wyślij do agenta »agent«", a klik „Zawsze zezwalaj" zapisywał regułę
 * `agent.message::agent` — auto-zgodę na pocztę do DOWOLNEGO adresata wysłaną tym samym
 * synonimem. Teraz kanon liczy ta funkcja i wołają ją OBIE strony: `contextExtractor` (cel dla
 * bramki, opis w modalu, klucz reguły) oraz `execute` (to, co realnie leci do skrzynki).
 *
 * Kanonem jest NAZWA Z REJESTRU, gdy adresat jest rozpoznawalny (`sonny` → `Sonny`) — inaczej
 * modal i reguła rozjeżdżałyby się z rzeczywistością na samej wielkości liter. Nierozpoznany
 * adresat zostaje DOSŁOWNY (wysyłka i tak odbije się o `unknown_recipient`), bo cel od wołacza
 * nigdy nie ma prawa zamienić się w wieloznacznik (K22).
 *
 * Wzór to K1: bramka i zlew oglądają jeden ciąg. Powtórne rozwiązanie w `sendAgentMail` jest
 * idempotentne — nazwa z rejestru rozwiązuje się do samej siebie.
 *
 * AUD-dead-code-021/166: `export` zdjęty — zero konsumentów poza tym plikiem (wołają go
 * WYŁĄCZNIE `contextExtractor` i `execute` narzędzia `kom_send` niżej, u siebie).
 */
function resolveKomSendTarget(
    args: KomunikatorArgs | null | undefined,
    agentManager?: { findKomunikatorAgent?(name: string): { name: string } | null | undefined } | null,
): string {
    const wanted = [args?.to, args?.to_agent, args?.agent, args?.target]
        .map(v => (typeof v === 'string' ? v.trim() : ''))
        .find(v => v !== '') || '';
    if (!wanted) return '';
    return agentManager?.findKomunikatorAgent?.(wanted)?.name || wanted;
}

/** Zlecenie wysyłki poczty agenta — jedno wejście dla `kom_send` i dla `agent_delegate`. */
interface AgentMailRequest {
    /** Nadawca — tożsamość z `_invocationAgentName`, NIGDY z pola podanego przez model. */
    from: string;
    /** Adresat tak, jak nazwał go model. */
    to: string;
    subject: string;
    content: string;
}

/** Wynik wysyłki: `error` niesie gotowy komunikat i18n. */
interface AgentMailResult {
    success: boolean;
    id?: string;
    error?: string;
    /** Nazwa adresata po rozwiązaniu (do eventu / logu wołacza). */
    recipient?: string;
}

/**
 * JEDYNA droga, którą poczta agenta trafia do cudzej skrzynki (K6, AUD-security-006/013).
 *
 * `agent_delegate` pisał do skrzynki WPROST przez `KomunikatorManager.sendMessage`, omijając
 * komplet bramek, które mieszkały w `kom_send`: filtr ducha po stronie nadawcy, rate-limit i
 * licznik odbić. Teraz obie drogi wchodzą tutaj, więc bramka jest jedna.
 *
 * Kolejność kontroli (celowa, S28 D6 + S33 Z2 + K17):
 *   tożsamość → widoczność NADAWCY → OŚ POCZTY NADAWCY → widoczność ADRESATA → self →
 *   hop → rate-limit → zapis.
 * Widoczność adresata idzie PRZED limitami, żeby odmowa nigdy nie zdradziła, że jakiś duch
 * istnieje: nieznana nazwa i agent-duch dają dokładnie ten sam komunikat. Oś poczty stoi
 * jeszcze wyżej — kto nie ma poczty, nie dowie się z odmowy nawet tego, kto istnieje.
 *
 * Hop i rezerwacja slotu siedzą pod {@link KomunikatorManagerLike.withAgentLock}, więc
 * równoległy wsad `tool_calls` z jednej odpowiedzi modelu nie przechodzi bramek hurtem.
 */
export async function sendAgentMail(
    plugin: KomPlugin | null | undefined,
    req: AgentMailRequest,
): Promise<AgentMailResult> {
    const ctx = resolveCaller({ _invocationAgentName: req.from }, plugin);
    if (ctx.error) return { success: false, error: ctx.error };

    // ── K17 (AUD-security-110): OŚ POCZTY WOŁAJĄCEGO, nie nazwa narzędzia ──
    // Oś narzędziowa (K3) zapada w `MCPClient` na nazwie WYWOŁANEGO narzędzia. `agent_delegate`
    // nazywa się `agent_delegate` (grupa `delegation`), a robi to samo, co `kom_send` (grupa
    // `komunikator`): zostawia tekst modelu w cudzej skrzynce. Agent z włączoną delegacją i
    // wyłączoną pocztą — czyli domyślny stan świeżego profilu po włączeniu jednej grupy —
    // pisał więc do skrzynki mimo że user mu poczty nie dał.
    //
    // Pytamy TUTAJ, w chokepoincie, bo to jedyna droga do skrzynki (K6): reguła obowiązuje
    // każdego wołacza, także tego dopisanego jutro. Tożsamość bierzemy z runtime'u
    // (`ctx.meName`/`ctx.me`, czyli `_invocationAgentName`), nigdy z pola podanego przez model.
    //
    // Brak rejestru albo nieznany managerowi agent = nie ma czego liczyć, więc przechodzimy —
    // dokładnie ten sam kontrakt, co bramka K3 w `MCPClient` (tam też `if (agent && ...)`).
    // W produkcji rejestr jest zawsze (`main.ts` stawia go przed rejestracją narzędzi).
    const axis = plugin?.toolRegistry?.checkToolAxis?.(ctx.me, 'kom_send');
    if (axis && !axis.allowed) {
        return { success: false, error: t('mcp.kom.tool_disabled') };
    }

    // Jeden adresat na wywołanie — wielu = model woła narzędzie w pętli.
    const wanted = String(req.to || '');
    const recipient = ctx.agentManager.findKomunikatorAgent(wanted);
    if (!recipient) {
        // Nieznana nazwa i agent-duch dają DOKŁADNIE ten sam błąd (D6).
        const available = ctx.agentManager.listKomunikatorAgents().map(a => a.name).join(', ');
        return { success: false, error: t('mcp.kom_send.unknown_recipient', { name: wanted, available }) };
    }
    if (recipient.name === ctx.meName) {
        return { success: false, error: t('mcp.kom_send.self') };
    }

    return ctx.komunikator.withAgentLock(ctx.meName, async (): Promise<AgentMailResult> => {
        // ── S33 B2 + K6: licznik odbić ──
        // Wiadomość wychodząca dziedziczy „piętro" po najświeższej przeczytanej
        // (`maxHopPrzeczytanych + 1`); rozmowa z userem startuje od 0. Przy trzecim
        // odbiciu przerywamy — dwa boty odpisujące sobie w kółko to nie współpraca.
        const hop = await ctx.komunikator.resolveHopFor(ctx.meName);
        if (hop >= HOP_LIMIT) {
            return { success: false, error: t('mcp.kom_send.hop_limit', { limit: HOP_LIMIT }) };
        }

        // ── S33 B1 + K6: rate-limit ──
        // Rezerwacja jest ATOMOWA (sprawdzenie + inkrement bez `await`), więc dziesięć
        // równoległych wywołań przy limicie 5 dostaje 5 przepustek, nie dziesięć.
        // K12: drugi sufit — per NADAWCA, bez względu na adresata. Sam limit pary nie domykał
        // sprawy: zepsuty agent rozsyłał `kom_send_rate_max` × liczba adresatów, mieszcząc się
        // w każdej parze z osobna. Komunikat odmowy mówi PRAWDĘ o tym, który sufit puścił —
        // „napisz do kogoś innego" byłoby złą radą, gdy wyczerpany jest sufit nadawcy.
        const limits = getLimits(plugin?.env?.settings);
        const rate = ctx.komunikator.reserveSend(
            ctx.meName, recipient.name, limits.kom_send_rate_max, limits.kom_send_rate_max_sender,
        );
        if (!rate.allowed) {
            return {
                success: false,
                error: rate.reason === 'sender'
                    ? t('mcp.kom_send.rate_limit_sender', { limit: rate.senderLimit })
                    : t('mcp.kom_send.rate_limit', { name: recipient.name, limit: rate.limit }),
            };
        }

        const res = await ctx.komunikator.sendMessage(
            ctx.meName, recipient.name, req.subject || '', req.content || '', { hop },
        );
        if (!res?.success) {
            // Zapis padł — slot wraca do puli, żeby błąd dysku nie zjadał limitu.
            ctx.komunikator.releaseSend(ctx.meName, recipient.name);
            return { success: false, error: res?.error || t('mcp.kom.send_failed') };
        }

        ctx.agentManager._emit?.('communicator:message_sent', {
            from: ctx.meName, to: recipient.name, messageId: res.id,
        });
        return { success: true, id: res.id, recipient: recipient.name };
    });
}

/**
 * @param app - Obsidian App (nieużywane, spójność sygnatury z resztą narzędzi)
 * @returns kom_send / kom_list / kom_read
 */
export function createKomunikatorTools() {
    return [
        {
            name: 'kom_send',
            serverName: SERVER_NAME,
            description: t('mcp.kom_send.desc'),
            inputSchema: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: t('mcp.kom_send.param.to') },
                    subject: { type: 'string', description: t('mcp.kom_send.param.subject') },
                    content: { type: 'string', description: t('mcp.kom_send.param.content') },
                },
                required: ['to', 'subject', 'content'],
            },
            /**
             * M (AUD-security-111): cel dla bramki liczymy U SIEBIE, tą samą funkcją co wykonanie.
             * `MCPClient` woli `contextExtractor` od swojego switcha, więc adresat, którego user
             * widzi w oknie zgody (i który wchodzi do reguły „Zawsze zezwalaj"), jest dokładnie
             * tym, do kogo pójdzie list. Tożsamość NADAWCY zostaje po stronie `execute` —
             * `contextExtractor` jej nie dotyka (K21: nazwy z worka się nie czyta).
             */
            contextExtractor: (args: KomunikatorArgs, ctx: { plugin?: KomPlugin | null }) => ({
                targetPath: resolveKomSendTarget(args, ctx?.plugin?.agentManager),
                approvalContext: {
                    messageSubject: args?.subject || '',
                    messageContent: args?.content || '',
                },
            }),
            execute: async (args: KomunikatorArgs, _app: unknown, plugin: KomPlugin | null | undefined) => {
                // Cała treść bramek siedzi w `sendAgentMail` — TA SAMA droga, którą chodzi
                // teraz `agent_delegate` (K6, AUD-security-006).
                const res = await sendAgentMail(plugin, {
                    from: (args?._invocationAgentName as string) || '',
                    to: resolveKomSendTarget(args, plugin?.agentManager),
                    subject: args.subject || '',
                    content: args.content || '',
                });
                if (!res.success) return { success: false, error: res.error };
                return {
                    success: true,
                    id: res.id,
                    message: t('mcp.kom_send.sent', { name: res.recipient }),
                };
            },
        },

        {
            name: 'kom_list',
            serverName: SERVER_NAME,
            description: t('mcp.kom_list.desc'),
            inputSchema: { type: 'object', properties: {}, required: [] },
            execute: async (args: KomunikatorArgs, _app: unknown, plugin: KomPlugin | null | undefined) => {
                const ctx = resolveCaller(args, plugin);
                if (ctx.error) return { success: false, error: ctx.error };

                const messages = await ctx.komunikator.listMessages(ctx.meName);
                // AUD-wydajnosc-020/053: bez sufitu `kom_list` zwracał KOMPLET nagłówków
                // skrzynki modelowi — koszt tokenów tury rósł liniowo ze skrzynką, która
                // nie ma automatycznej ewikcji (sprzątanie jest pół-automatem, D5). Newest-first
                // już zapewnia `listMessages` (sortowanie po id), więc `slice` bierze zawsze
                // najświeższe. `unread` liczy się z CAŁEJ skrzynki (info niezależna od obcięcia
                // widoku), `count`/`messages` tylko z widoku — tak jak przed cięciem dla skrzynek
                // ≤ sufit (identyczny kształt wyniku).
                const limited = messages.length > KOM_LIST_MAX ? messages.slice(0, KOM_LIST_MAX) : messages;
                return {
                    success: true,
                    count: limited.length,
                    unread: messages.filter(m => !m.aiRead).length,
                    ...(messages.length > KOM_LIST_MAX ? { total: messages.length, truncated: true } : {}),
                    // Same nagłówki — treść wyłącznie przez kom_read (budżet tokenów).
                    messages: limited.map(m => ({
                        id: m.id,
                        od: m.from,
                        temat: m.subject,
                        data: m.date,
                        przeczytana: m.aiRead,
                    })),
                };
            },
        },

        {
            name: 'kom_read',
            serverName: SERVER_NAME,
            description: t('mcp.kom_read.desc'),
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: t('mcp.kom_read.param.id') },
                },
                required: ['id'],
            },
            execute: async (args: KomunikatorArgs, _app: unknown, plugin: KomPlugin | null | undefined) => {
                const ctx = resolveCaller(args, plugin);
                if (ctx.error) return { success: false, error: ctx.error };

                // K6 (AUD-security-046): odczyt idzie po TYM SAMYM łańcuchu co wysyłka, więc
                // `kom_send` z tej samej tury widzi już odnotowany licznik odbić.
                const res = await ctx.komunikator.withAgentLock(
                    ctx.meName, () => ctx.komunikator.readMessage(ctx.meName, args.id),
                );
                if (!res?.success) return { success: false, error: res?.error || t('komunikator.message_not_found') };

                const m = res.message;
                return {
                    success: true,
                    id: m.id,
                    od: m.from,
                    temat: m.subject,
                    data: m.date,
                    tresc: m.body,
                };
            },
        },
    ];
}
