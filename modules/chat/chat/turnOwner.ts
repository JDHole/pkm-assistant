/**
 * turnOwner — kto jest WŁAŚCICIELEM tury/okna rozmowy (K4, AUD-security-064/065/066).
 *
 * Zasada: wszystko, czego potrzebuje bieg, jest ZAMROŻONE w chwili zlecenia i odczytywane
 * STAMTĄD — nigdy z globalnych luster pluginu (`agentManager.activeAgent`, `getActiveMemory()`,
 * `plugin.currentAutonomy`). Okno rozmowy (`RollingWindow`) powstaje raz per zakładka, a jego
 * providery (indeks pamięci, model kompresji, ratunek pamięci) bywają wołane DŁUGO PO tym, jak
 * user przełączył zakładkę — do K4 rozstrzygały się wtedy po agencie, który akurat był na
 * wierzchu, i transkrypt agenta X jechał modelem agenta Y, a jego trwałe notatki `brain/`
 * lądowały w pamięci Y.
 *
 * Ten plik jest CELOWO wolny od `obsidian` i od DOM-u — dzięki temu ma testy jednostkowe
 * (`turnOwner.test.ts`), a `chat_session.ts` (który importuje `Notice`) tylko go wywołuje.
 */
import { resolveWorkPrompt } from '../../../core/index.js';
import { log } from '../../../core/utils/Logger.js';
import { DEFAULT_COMPRESSION_PROMPT } from './compressionPrompt.js';

// TS-any: granica runtime'u — AgentManager/AgentMemory/ChatView są składane dynamicznie.
type Runtime = any;

// AUD-dead-code-231 (2026-09-02): `export` zdjęty z trzech typów niżej (i z `FrozenTurnOwner` dalej
// w pliku) — zero referencji spoza tego pliku; funkcje, których sygnatury je noszą
// (`resolveOwnerAgentName`, `resolveOwnerAgent`, `buildOwnerWindowOptions`, …), zostają publiczne.
type OwnerAgentLike = { name?: string; memory_rescue?: boolean } | null;
type OwnerMemoryLike = Runtime;

type OwnerManagerLike = {
    getAgent?(name: string): OwnerAgentLike | undefined;
    getActiveAgent?(): OwnerAgentLike | undefined;
    getAgentMemory?(name: string): OwnerMemoryLike;
    getActiveMemory?(): OwnerMemoryLike;
} | null | undefined;

/**
 * Nazwa agenta-właściciela. Jawna nazwa (z zakładki / ze zdarzenia) WYGRYWA; brak nazwy =
 * spadamy na aktywnego, ale tylko w chwili ZAKŁADANIA okna, nigdy w trakcie biegu.
 */
export function resolveOwnerAgentName(
    agentManager: OwnerManagerLike,
    explicitName?: string | null,
): string | null {
    const explicit = typeof explicitName === 'string' ? explicitName.trim() : '';
    if (explicit) return explicit;
    return agentManager?.getActiveAgent?.()?.name || null;
}

/**
 * Profil agenta-właściciela. Gdy nazwa jest znana, NIE ma zjazdu na aktywnego — inaczej model
 * i uprawnienia kompresji brałyby się od agenta, który akurat jest na wierzchu (AUD-security-066).
 */
export function resolveOwnerAgent(
    agentManager: OwnerManagerLike,
    ownerName: string | null | undefined,
): OwnerAgentLike {
    if (!ownerName) return agentManager?.getActiveAgent?.() || null;
    return agentManager?.getAgent?.(ownerName) || null;
}

/**
 * Pamięć agenta-właściciela. Fail-closed: znana nazwa bez wpisu w `agentMemories` = `null`
 * (odmowa), a nie cudzy katalog `brain/` (AUD-security-064/065, wzór 036 w narzędziach pamięci).
 */
export function resolveOwnerMemory(
    agentManager: OwnerManagerLike,
    ownerName: string | null | undefined,
): OwnerMemoryLike {
    if (!ownerName) return agentManager?.getActiveMemory?.() || null;
    return agentManager?.getAgentMemory?.(ownerName) || null;
}

/**
 * Ratunek pamięci przed kompresją (E2.7 W2 / K3) — zapis kandydatów jako notatek W POCZEKALNI
 * `brain/pending_rescue/` (D8, 2026-08-27, werdykt 27.08), NIE wprost do `brain/`. User zatwierdza
 * je istniejącą drogą `/save session` (`SaveSessionWorkflow`/`SaveSessionModal`) — patrz
 * `AgentMemory.acceptPendingRescue`/`rejectPendingRescue`. K4: i wyłącznik `memory_rescue`, i
 * katalog docelowy biorą się od WŁAŚCICIELA okna.
 *
 * Fail-soft (werdykt 27.08): gdy `mem` nie ma jeszcze `writePendingRescue` (stara atrapa) albo
 * zapis do poczekalni PADNIE, wracamy do dawnej ścieżki — `writeBrainNote` wprost. Lepszy
 * niezreview'owany zapis niż utrata kandydata, którego okno kompresji zaraz odrzuci.
 *
 * @returns ile kandydatów realnie wylądowało na dysku (w poczekalni ALBO, na fail-soft, w brain/)
 */
export async function saveMemoryCandidatesFor(
    agentManager: OwnerManagerLike,
    ownerName: string | null | undefined,
    candidates: Runtime[] = [],
): Promise<number> {
    const ownerAgent = resolveOwnerAgent(agentManager, ownerName);
    // E2.8 C9 (S23): per-agent wyłącznik ratunku pamięci przed kompresją (default ON).
    if (ownerAgent && ownerAgent.memory_rescue === false) return 0;
    const mem = resolveOwnerMemory(agentManager, ownerName);
    if (!mem?.writeBrainNote || !Array.isArray(candidates) || candidates.length === 0) return 0;
    let saved = 0;
    for (const candidate of candidates) {
        if (mem.writePendingRescue) {
            // Ścieżka poczekalni: fallback do writeBrainNote odpala się TYLKO stąd (werdykt
            // weryfikacji opusa, nit 1) — nigdy z gałęzi „atrapa bez poczekalni" niżej, żeby
            // padnięty writeBrainNote nie był ponawiany drugi raz z tymi samymi argumentami
            // (nit C1(a)). AgentMemory.writePendingRescue sam już broni się przed torn-write
            // (probeFile po catchu), więc ten catch łapie WYŁĄCZNIE zapisy, które NA PEWNO
            // nie doszły.
            try {
                const result = await mem.writePendingRescue(candidate, { source: 'auto_compaction' });
                if (result?.path) saved++;
            } catch (e: Runtime) {
                // Fail-soft: zapis DO POCZEKALNI padł. Lepszy niezreview'owany zapis wprost do
                // brain/ niż utrata kandydata — okno kompresji, z którego przyszedł, zaraz
                // odrzuci surową rozmowę, więc to jedyna kopia tego faktu.
                try {
                    const fallback = await mem.writeBrainNote(candidate, { source: 'auto_compaction' });
                    if (fallback?.path) saved++;
                    log.warn('Chat', `Memory candidate: poczekalnia padła, zapis wprost do brain/ (fail-soft): ${e?.message || e}`);
                } catch (e2: Runtime) {
                    log.warn('Chat', `Memory candidate save failed (poczekalnia i fallback): ${e2?.message || e2}`);
                }
            }
            continue;
        }
        // Atrapa bez poczekalni (testy / mem starego kształtu) — stare zachowanie wprost,
        // BEZ retry na pad: to już jest bezpośrednia droga, nie „fallback" po niczym.
        try {
            const result = await mem.writeBrainNote(candidate, { source: 'auto_compaction' });
            if (result?.path) saved++;
        } catch (e: Runtime) {
            log.warn('Chat', `Memory candidate save failed: ${e?.message || e}`);
        }
    }
    if (saved > 0) {
        try { await mem.rebuildBrainIndex?.(); } catch { /* index refresh best-effort */ }
    }
    return saved;
}

/**
 * AUD-code-review-013: czy zakładka WŁAŚCICIELA okna jest AKURAT na wierzchu.
 *
 * Callbacki okna (`onSummarized`/`onToolsTrimmed`/`onMemoryCandidates`) malują do JEDYNEGO
 * `messages_container` widoku (jeden kontener na cały `ChatView`, nie per zakładka). K4 mówi że
 * kompresja końca tury LECI bezwarunkowo także dla zakładki w tle — to jest zasada o DANYCH
 * (transkrypt, plik sesji), nie o DOM-ie. Bez tej bramki blok „skompresowano #N" agenta A malował
 * się fizycznie w rozmowie agenta B, którą user akurat czyta (z licznikami policzonymi z okna A),
 * i znikał dopiero przy najbliższym `render_messages()` — czysty artefakt cudzej tury.
 */
export function isOwnerTabActive(view: Runtime, ownerName: string | null): boolean {
    const tabs = view?.chatTabs;
    // Brak modelu zakładek (atrapy widoku bez `chatTabs`, kontekst bez multi-tab) = nie ma czego
    // gasić — stare zachowanie, maluj.
    if (!Array.isArray(tabs) || tabs.length === 0) return true;
    return (tabs.find((tab: Runtime) => tab?.isActive)?.agentName ?? null) === ownerName;
}

/**
 * Część opcji `RollingWindow`, która zależy od TOŻSAMOŚCI właściciela okna. Wszystkie providery
 * rozwiązują agenta/pamięć LENIWIE po `ownerName` (profil może zostać podmieniony przez reload),
 * ale NIGDY po globalnym lustrze.
 *
 * @param view - odbiorca mixinów ChatView (`_getMinionModel`, `_buildEmergencyTaskContext`, …)
 * @param ownerName - nazwa agenta zakładki, do której należy to okno
 */
export function buildOwnerWindowOptions(view: Runtime, ownerName: string | null) {
    const am = (): OwnerManagerLike => view?.plugin?.agentManager;
    // E2.8 B3: szkielet kompresji rozstrzygany raz, przy zakładaniu okna (agent>global>factory).
    const compressionPrompt = resolveWorkPrompt(
        resolveOwnerAgent(am(), ownerName),
        'compression_prompt',
        view?.env?.settings,
        DEFAULT_COMPRESSION_PROMPT,
    );
    return {
        compressionPrompt,
        // K18: zjazd awaryjny (`minionEnabled === false`) też celuje w WŁAŚCICIELA — `get_chat_model`
        // przyjmuje od K18 agenta, więc znika ostatnie miejsce, w którym kompresja okna A mogła
        // pojechać modelem agenta B (znana granica K4, domknięta).
        modelProvider: () => {
            const ownerAgent = resolveOwnerAgent(am(), ownerName);
            return view._getMinionModel(ownerAgent) || view.get_chat_model?.({ agent: ownerAgent });
        },
        memoryIndexProvider: async () => {
            const mem = resolveOwnerMemory(am(), ownerName);
            try { return mem ? await mem.getBrain() : ''; } catch { return ''; }
        },
        emergencyContextProvider: () => view._buildEmergencyTaskContext(ownerName),
        onMemoryCandidates: async (candidates: Runtime[]) => {
            const saved = await saveMemoryCandidatesFor(am(), ownerName, candidates);
            // AUD-code-review-013: nota „N kandydatów czeka" jest DOM-em jednego widoku — malujemy
            // ją tylko, gdy zakładka właściciela jest akurat na wierzchu (patrz `isOwnerTabActive`).
            if (saved > 0 && isOwnerTabActive(view, ownerName)) view._renderMemorySavedNote(saved);
            if (isOwnerTabActive(view, ownerName)) view._updateTokenPanel?.();
        },
    };
}

/**
 * WŁAŚCICIEL TURY — wszystko, co tura czatu bierze z widoku, ZAMROŻONE w jednej chwili
 * (K18, AUD-security-112).
 *
 * Do K18 `send_message` zapalał Stop, wchodził w `getActiveSystemPromptWithMemory` (brain.md,
 * sesja, mapa vaulta, ping skrzynki — okno „potrafi trwać sekundy") i DOPIERO POTEM czytał
 * `getActiveAgent()`, `view.rollingWindow`, `getActiveMemory().activeSessionPath`. Przełączenie
 * zakładki w tym oknie (`_switchTab` nie jest blokowane w trakcie generowania i przestawia
 * `agentManager.activeAgent`, `view.rollingWindow`, `view.tokenTracker`) sprawiało, że tura
 * zaczęta u agenta A — z promptem złożonym z JEGO pamięci — kończyła jako tura agenta B:
 * modelem B, z uprawnieniami narzędzi B i zapisami do sesji B.
 */
interface FrozenTurnOwner {
    /** Nazwa agenta, do którego należy tura (pusta = brak agenta). */
    agentName: string;
    /** Profil agenta z chwili zamrożenia. */
    agent: OwnerAgentLike;
    /** Okno rozmowy zakładki-właściciela (`RollingWindow`). */
    rollingWindow: Runtime;
    /** Licznik tokenów zakładki-właściciela. */
    tokenTracker: Runtime;
    /** Pamięć właściciela — rozstrzygnięta po nazwie, fail-closed (patrz `resolveOwnerMemory`). */
    memory: OwnerMemoryLike;
    /** Ścieżka aktywnej sesji właściciela w chwili startu tury (adres zwrotny + label trace). */
    sessionPath: string;
    /** Zakładka, z której wyszła tura (adres zwrotny delegacji w tle). */
    tab: Runtime;
    /** Autonomia tej zakładki (E2.3) — polityka „czy pytać" dla egzekutora narzędzi. */
    autonomy: Runtime;
    /** Aktywny artefakt tej zakładki (E2.9 B3) — wstrzykiwany do promptu. */
    artifactId: Runtime;
}

/**
 * Zamroź właściciela tury. Czyta widok RAZ i SYNCHRONICZNIE — bez `await` w środku, żeby między
 * odczytami nie dało się wcisnąć przełączenia zakładki.
 *
 * Wołane w `send_message` razem z zapaleniem guzika Stop i PRZED pierwszym awaitem przygotowania
 * promptu; od tego miejsca tura nie ma prawa pytać widoku „kto jest teraz aktywny".
 *
 * @param view - odbiorca mixinów ChatView (`rollingWindow`, `tokenTracker`, `chatTabs`, …)
 */
export function freezeTurnOwner(view: Runtime): FrozenTurnOwner {
    const agentManager: OwnerManagerLike = view?.plugin?.agentManager;
    const agent = agentManager?.getActiveAgent?.() || null;
    const agentName = agent?.name || '';
    // Pamięć bierzemy PO NAZWIE (fail-closed), nie przez `getActiveMemory()` — tamta
    // rozstrzygałaby się przy każdym odczycie na nowo i po przełączeniu wskazywałaby na B.
    const memory = agentName
        ? resolveOwnerMemory(agentManager, agentName)
        : (agentManager?.getActiveMemory?.() || null);
    const tabs = Array.isArray(view?.chatTabs) ? view.chatTabs : [];
    return {
        agentName,
        agent,
        rollingWindow: view?.rollingWindow ?? null,
        tokenTracker: view?.tokenTracker ?? null,
        memory,
        sessionPath: memory?.activeSessionPath || '',
        tab: tabs.find((tab: Runtime) => tab?.isActive) || null,
        autonomy: view?.currentAutonomy,
        artifactId: view?.currentArtifactId ?? null,
    };
}
