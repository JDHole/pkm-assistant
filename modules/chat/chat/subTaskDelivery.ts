/**
 * @module subTaskDelivery
 * KOMPLET BRAMEK DOSTARCZENIA wyniku suba z tła — jako czysta decyzja (AUD-testy-024).
 *
 * Co było zepsute: pięć pytań, od których zależy, czy czat sam wystartuje AUTO-TURĘ
 * z raportem sub-agenta, siedziało wyłącznie w `_deliverSubTaskResult` (`chat_streaming.ts`),
 * a `chat_streaming.ts` wisi na `obsidian` — AVA go nie zaimportuje. Jedynym strażnikiem był
 * więc regex po TEKŚCIE źródła (`stopSemantics.test.ts`), a taki strażnik nie odróżnia
 * `if (this._drainSuppressed) return false;` od `if (this._drainSuppressed) { }`: mutacja
 * kasująca SKUTEK przy zachowaniu NAPISU zostawiała pakiet zielony (dowód w znalezisku:
 * 259/259 pass po zneutralizowaniu trzech bramek).
 *
 * Dziś decyzja jest tutaj — pure, bez `obsidian`, bez DOM-u, bez I/O (wzór `autoTurnChain.ts`,
 * `queuedMessage.ts`, `turnAbort.ts`) — a `chat_streaming.ts` jest cienkim wołaczem, którego
 * OKABLOWANIE (kształt `if (!delivery.allowed)`) pilnuje osobny strażnik po źródle.
 *
 * ⚠️ Bramka „zadanie bez `id`" ZOSTAJE w monolicie, przed wyliczeniem adresu zwrotnego:
 * ona chroni samo wyliczenie `origin`/`matchTabForOrigin` przed wywrotką na pustym zadaniu,
 * więc nie da się jej przesunąć tutaj bez zmiany kolejności efektów (log w `catch`).
 *
 * Kontrakt zwrotki dostawcy (`SubTaskNotifier`): `true` = skonsumowane (wypada z kolejki),
 * `false` = zostaw na później. KAŻDA odmowa z tego pliku znaczy `false` — wynik NIE ginie,
 * czeka na najbliższy `drain()`.
 */

/** Dlaczego wynik nie jedzie teraz. `ok` = wolno startować auto-turę. */
// AUD-dead-code-231 (2026-09-02): `export` zdjęty na czterech typach niżej — zero referencji
// spoza tego pliku (funkcja `evaluateSubTaskDelivery` jest jedynym publicznym wejściem).
type SubTaskDeliveryReason =
    /** brak zakładki adresata (agent nieotwarty) */
    | 'no_tab'
    /** zakładka jest w tle — auto-tura byłaby robotą za plecami usera */
    | 'tab_inactive'
    /** trwa tura (własna albo już wstrzyknięta) */
    | 'turn_in_flight'
    /** po Stopie / watchdogu czat nie startuje tury sam (AUD-security-115) */
    | 'stopped'
    /** sufit łańcucha auto-tur po subach (werdykt Kuby 16.08) */
    | 'chain_limit'
    | 'ok';

/** Zakładka adresata — dostawcę interesuje wyłącznie to, czy jest na wierzchu. */
interface SubTaskDeliveryTab {
    isActive?: boolean;
}

interface SubTaskDeliveryInput {
    /** wynik `matchTabForOrigin` — `null`/`undefined` gdy adresata nie ma wśród zakładek */
    tab?: SubTaskDeliveryTab | null;
    /** `this.is_generating` — na tej zakładce trwa tura */
    isGenerating?: boolean;
    /** `this._subTaskTurnPending` — auto-tura już wstrzyknięta, czeka na `set_generating(true)` */
    subTaskTurnPending?: boolean;
    /** `this._drainSuppressed` — user kliknął Stop (albo strzelił watchdog) */
    drainSuppressed?: boolean;
    /** `evaluateAutoTurnChain(...).allowed` — sufit łańcucha auto-tur */
    chainAllowed?: boolean;
}

interface SubTaskDeliveryDecision {
    /** `true` = wolno wystartować auto-turę z powiadomieniem o wyniku */
    allowed: boolean;
    reason: SubTaskDeliveryReason;
}

/**
 * Czy wynik suba wolno dostarczyć TERAZ, czyli odpalić auto-turę na zakładce adresata.
 *
 * Kolejność bramek jest częścią kontraktu (powód odmowy trafia do logu i decyduje,
 * czy user zobaczy Notice), więc pytamy dokładnie w tej kolejności co dawny monolit:
 * zakładka → aktywność → trwająca tura → Stop → sufit łańcucha.
 *
 * Fail-closed na całej linii: brak informacji (`undefined`) jest traktowany jak „nie wiem",
 * a nie jak zgoda — jedyne pole, którego brak przepuszcza, to `chainAllowed`, bo tam
 * „nie wiem" znaczy „nikt nie liczył łańcucha", a pierwsza auto-tura ma prawo wystartować
 * (ta sama zasada, co `evaluateAutoTurnChain` z niedodatnim limitem).
 */
export function evaluateSubTaskDelivery(input: SubTaskDeliveryInput): SubTaskDeliveryDecision {
    const tab = input?.tab;
    if (!tab) return { allowed: false, reason: 'no_tab' };
    if (!tab.isActive) return { allowed: false, reason: 'tab_inactive' };
    if (input.isGenerating || input.subTaskTurnPending) return { allowed: false, reason: 'turn_in_flight' };
    if (input.drainSuppressed) return { allowed: false, reason: 'stopped' };
    if (input.chainAllowed === false) return { allowed: false, reason: 'chain_limit' };
    return { allowed: true, reason: 'ok' };
}
