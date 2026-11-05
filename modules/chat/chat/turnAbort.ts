/**
 * turnAbort — PRZERWANIE JEST STANEM TURY, nie stanem widoku.
 *
 * Jedno pole widoku (`ChatView._abortedStream` — nazwa agenta ostatnio zatrzymanej tury) nie
 * wystarcza: każde kolejne `send_message` czyściłoby je na wejściu („nowa wiadomość = świeży
 * start"), więc pętla zaparkowana w długim narzędziu w chwili Stopu nigdy nie widziałaby flagi —
 * zanim doszłaby do punktu przerwania, gasiłaby ją albo następna wiadomość usera, albo AUTO-tura
 * z wynikiem suba, albo przełączenie zakładki (drain). Zatrzymana pętla wznawiałaby iteracje
 * i egzekucję narzędzi.
 *
 * Każda tura dostaje WŁASNY uchwyt (`createTurnAbort()`): Stop zatrzaskuje flagę na TEJ
 * turze, a nowa tura startuje z nowym uchwytem i nie ma jak „odkręcić" przerwania starej.
 * Pętla (`runAgentLoop`) pyta `shouldAbort: () => turn.abort.isAborted()`, czyli stan SWOJEJ
 * tury — nigdy pole widoku.
 *
 * Ten plik jest CELOWO wolny od `obsidian` i od DOM-u (wzór `turnOwner.ts`) — dzięki temu ma
 * testy jednostkowe, a mixiny `chat_streaming.ts` / `chat_view.ts` tylko go wywołują.
 */

/** Uchwyt przerwania JEDNEJ tury. Zatrzask: raz podniesiona flaga już nie gaśnie. */
// `export` zdjęty na trzech typach w tym pliku — zero referencji
// spoza pliku; funkcje, które je noszą w sygnaturze (`createTurnAbort`, …),
// zostają publiczne.
import type { SubTaskRegistry, SubThreadOwner, StopBy } from '../../sub-agents/index.js';
import { log } from '../../../core/utils/Logger.js';

export interface TurnAbortHandle {
    /** Czy ta tura została przerwana (Stop / watchdog / zamknięcie widoku). */
    readonly signal: AbortSignal;
    isAborted(): boolean;
    /** Powód pierwszego przerwania (`'stop'`, `'stall'`, `'close'`, …) albo `null`. */
    reason(): string | null;
    /** Zatrzaśnij przerwanie. Zwraca `true` TYLKO przy pierwszym wywołaniu (idempotencja). */
    abort(reason?: string): boolean;
}

export function createTurnAbort(): TurnAbortHandle {
    const controller = new AbortController();
    let aborted = false;
    let why: string | null = null;
    return {
        signal: controller.signal,
        isAborted: () => aborted,
        reason: () => why,
        abort(reason = 'stop') {
            if (aborted) return false;
            aborted = true;
            why = reason || 'stop';
            controller.abort(why);
            return true;
        },
    };
}

/** Minimalny widok biegu suba (`SubTask`) — tyle, ile trzeba, żeby zdecydować „to nasz bieg". */
interface StoppableSubTask {
    id?: string;
    status?: string;
    stopRequested?: boolean;
    origin?: { agentName?: string; tabKey?: string } | null;
}

/**
 * Id biegów subów zleconych Z TEGO WIDOKU — po adresie zwrotnym (`origin`), a nie po
 * agencie, który akurat je wykonuje. Zamknięcie panelu ubija tury, więc ich suby zostają
 * bez adresata: wynik i tak nie miałby dokąd wrócić, a bieg dalej paliłby tokeny i pisał
 * do vaulta.
 *
 * Dopasowanie: `origin.tabKey` w zbiorze zakładek widoku ALBO (gdy bieg nie ma klucza
 * zakładki) `origin.agentName` wśród właścicieli zatrzymywanych tur. Bieg BEZ `origin`
 * (zlecenie spoza czatu) nie jest nasz i zostaje nietknięty.
 */
export function collectSubTaskIdsForOwners(
    tasks: Iterable<StoppableSubTask> | null | undefined,
    owners: { tabKeys?: Iterable<string> | null; agentNames?: Iterable<string> | null } = {},
): string[] {
    const tabKeys = new Set(owners.tabKeys || []);
    const agentNames = new Set(owners.agentNames || []);
    const out: string[] = [];
    for (const task of tasks || []) {
        if (!task?.id || task.status !== 'running' || task.stopRequested) continue;
        const origin = task.origin;
        if (!origin) continue;
        const byTab = typeof origin.tabKey === 'string' && origin.tabKey && tabKeys.has(origin.tabKey);
        const byAgent = !origin.tabKey
            && typeof origin.agentName === 'string'
            && agentNames.has(origin.agentName);
        if (byTab || byAgent) out.push(task.id);
    }
    return out;
}

/** Shared Stop for a chat button and view teardown. Full session identity wins over UI keys. */
export function stopSubTasksForOwners(
    registry: Partial<Pick<SubTaskRegistry, 'list' | 'requestStop' | 'requestStopForOwner' | 'closeQueuedForOwners'>> | undefined,
    selection: { tabKeys: string[]; agentNames: string[]; owners?: SubThreadOwner[] }, by: StopBy,
): void {
    if (!registry) return;
    try {
        const complete = (owner: SubThreadOwner) => !!(owner.agentName && owner.sessionPath && owner.sessionEpoch);
        const owners = (selection.owners ?? []).filter(complete);
        const tasks = registry.list?.() ?? [];
        const ids = new Set(collectSubTaskIdsForOwners(tasks, selection));
        const stopped = new Set<string>();
        for (const owner of [...owners, ...tasks.filter(task => ids.has(task.id) && task.origin).map(task => task.origin!)]) {
            if (!complete(owner) || !registry.requestStopForOwner) continue;
            const known = owners.filter(candidate => candidate.agentName === owner.agentName);
            if (known.length && !known.some(candidate => candidate.sessionPath === owner.sessionPath && candidate.sessionEpoch === owner.sessionEpoch)) continue;
            const key = JSON.stringify([owner.agentName, owner.sessionPath, owner.sessionEpoch]);
            if (!stopped.has(key)) { stopped.add(key); registry.requestStopForOwner(owner, by); }
        }
        for (const task of tasks) if (ids.has(task.id) && (!registry.requestStopForOwner || !task.origin || !complete(task.origin))) {
            registry.requestStop?.(task.id, by);
        }
        registry.closeQueuedForOwners?.({ ...selection, owners }, by);
    } catch (error) { log.warn('Chat', 'Stopping sub-agent conversation failed:', error); }
}
