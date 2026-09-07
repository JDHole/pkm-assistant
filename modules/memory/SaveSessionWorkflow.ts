import { streamToComplete, STREAM_ERROR_CODES } from './streamHelper.js';
import { resolveWorkPrompt } from '../../core/index.js';
import { DEFAULT_SAVE_SESSION_PROMPT } from './workPrompts.js';
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';

import type { StreamChatModelLike, StreamMessage, StreamToCompleteOptions } from './streamHelper.js';

/** Błąd w catch — czytamy z niego tylko `message` (kontrakt kampanii TS §4). */
type ErrLike = { message?: string; code?: string };

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Kontrakty otoczenia, typowane STRUKTURALNIE (`AgentMemory.js` jest jeszcze w `.js`).
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Adapter FS vaulta w zakresie potrzebnym zapisowi notatek. */
export interface SaveVaultAdapterLike {
    exists(path: string): Promise<boolean>;
    write(path: string, data: string): Promise<void>;
}

/** `.state.json` w zakresie, który czyta próg konsolidacji. */
export interface SaveStateLike {
    archived_since_last_consolidation?: number;
    brain_notes_limit?: number;
    [key: string]: unknown;
}

/** Fragment `AgentMemory`, na którym stoi `/save session`. */
export interface SaveAgentMemoryLike {
    agentName?: string;
    activeSessionPath?: string | null;
    vault: { adapter: SaveVaultAdapterLike };
    paths: { brainNotes: string };
    stateManager: { read(): Promise<SaveStateLike> };
    ensureMemoryStructure(): Promise<unknown>;
    getBrain(): Promise<string>;
    listBrainNotes(): Promise<Array<{ filename: string }>>;
    archiveActiveSession(path?: string): Promise<string | null>;
    /**
     * AUD-code-review-067/068: KANONICZNA ścieżka składania + zapisu notatki `brain/*.md`
     * (create-with-suffix + kolejka K1 + stopka Why/How z i18n + escapowanie frontmattera
     * przez `JSON.stringify`) — ta sama, której używają `memory_save` i accept z poczekalni
     * rescue. `_createBrainNote` (niżej) idzie przez nią zamiast utrzymywać drugą kopię
     * kontraktu notatki.
     */
    writeBrainNote(
        note: { name?: string; description?: string; type?: string; content?: string; why?: string; how_to_apply?: string },
        options?: { source?: string },
    ): Promise<CreatedBrainNote>;
    /** opcjonalne — atrapy w testach nie muszą ich mieć */
    loadActiveSession?(path: string): Promise<{ messages?: SessionMessageLike[] } | null>;
    rebuildBrainIndex?(): Promise<{ changed?: boolean } | undefined>;
    writeNaTeraz?(ops: NaTerazOpLike[]): Promise<unknown>;
    appendBrainLog?(op: string, target: string, detail?: string): Promise<unknown>;
    _enqueuePathWrite?<T>(path: string, fn: () => Promise<T>): Promise<T>;
    /**
     * D8 (2026-08-27, werdykt 27.08): poczekalnia `brain/pending_rescue/` — opcjonalne, jak
     * reszta pola tego interfejsu, żeby stare atrapy testów (bez tej ścieżki) nie musiały się
     * zmieniać. Brak metody = `prepareProposals` po prostu nie dokłada kandydatów rescue.
     */
    listPendingRescue?(): Promise<PendingRescueNoteLike[]>;
    acceptPendingRescue?(
        filename: string,
        note?: { name?: string; description?: string; type?: string; content?: string; why?: string; how_to_apply?: string },
        options?: { source?: string },
    ): Promise<{ path: string; filename: string; name: string }>;
    rejectPendingRescue?(filename: string): Promise<{ removed: boolean }>;
}

/** Kandydat z poczekalni `brain/pending_rescue/` (kształt zwracany przez `AgentMemory.listPendingRescue`). */
export interface PendingRescueNoteLike {
    filename: string;
    name?: string;
    description?: string;
    type?: string;
    content?: string;
    why?: string;
    how_to_apply?: string;
    created?: string;
}

/** Jedna wiadomość transkryptu. Treść bywa multimodalna (tablica bloków). */
export interface SessionMessageLike {
    role?: string;
    content?: string | Array<{ text?: string; content?: string }> | null;
}

/** Artefakt z sesji — regexowa ścieżka robi z niego notatkę `reference`. */
export interface SessionArtifactLike {
    title?: string;
    content?: string;
}

/** Aktywna sesja podana z zewnątrz (slash handler / test). */
export interface ActiveSessionLike {
    path?: string | null;
    messages?: SessionMessageLike[];
    artifacts?: SessionArtifactLike[];
}

/** Propozycja notatki `brain/*.md` — kształt wspólny dla ścieżki LLM i regexowej. */
export interface NoteProposal {
    name?: string;
    description?: string;
    type?: string;
    section?: string;
    content?: string;
    why?: string;
    how_to_apply?: string;
    accepted?: boolean;
    /**
     * D8 (2026-08-27): obecne WYŁĄCZNIE dla propozycji dołożonych z poczekalni rescue —
     * nazwa pliku w `brain/pending_rescue/`. `applyDecision` rozpoznaje po tym polu, czy
     * accept/reject ma iść przez `acceptPendingRescue`/`rejectPendingRescue`, czy zwykłą
     * ścieżkę tworzenia notatki. Zwykłe propozycje sesji tego pola NIE mają.
     */
    pendingFilename?: string;
    /** Opis BEZ prefiksu pochodzenia — do przywrócenia przy accept, jeśli user go nie tknął. */
    pendingOriginalDescription?: string;
    /** Dokładnie ten string wstawiony jako początkowa wartość pola opisu w modalu (por. wyżej). */
    pendingPrefixedDescription?: string;
}

/** Propozycja zmiany w sekcjach „Na teraz" (E2.8 D3) — modal renderuje to jako diff. */
export interface NaTerazUpdate {
    action?: string;
    section?: string;
    content?: string;
    oldContent?: string;
    accepted?: boolean;
}

/** Operacja przekazywana do `AgentMemory.writeNaTeraz`. */
export interface NaTerazOpLike {
    section?: string;
    add?: string;
    remove?: string;
}

/** Opcje strzału propozycji (S29 Z6) — idą prosto do `streamToComplete`. */
export interface PrepareProposalsOptions extends StreamToCompleteOptions {
    /** `false` = zwis/abort ma cicho spaść na regexy (domyślnie leci w górę) */
    rethrowStreamErrors?: boolean;
}

/** Wynik `prepareProposals` — kształt stabilny dla obu ścieżek (LLM i regex). */
export interface SaveSessionPrep {
    sessionPath: string | null | undefined;
    messages: SessionMessageLike[];
    notes: NoteProposal[];
    brainUpdates: NaTerazUpdate[];
    llmDriven: boolean;
    messageCount: number;
    /** surowe `usage` strzału propozycji (null na ścieżce regexowej, Z4.3) */
    usage: unknown;
}

/** Decyzja usera z modalu review. */
export interface SaveSessionDecision {
    action?: string;
    notes?: NoteProposal[];
    brainUpdates?: NaTerazUpdate[];
}

/** Utworzona notatka `brain/*.md`. */
export interface CreatedBrainNote {
    path: string;
    filename: string;
    name: string;
}

/**
 * Notatka, której zapis w `applyDecision` się nie udał (AUD-code-review-051) — pad JEDNEJ
 * pozycji (np. `write()` rzucający na dysku sieciowym) nie przerywa już pętli, więc reszta
 * przyjętych notatek, przebudowa indeksu i archiwizacja sesji dochodzą do skutku.
 */
export interface NoteFailure {
    name: string;
    error: string;
}

/** Wynik `applyDecision` (gałąź „anulowano" niesie tylko część pól). */
export interface SaveSessionOutcome {
    cancelled: boolean;
    action?: string;
    notesCreated: CreatedBrainNote[];
    brainChanged: boolean;
    archivedPath: string | null;
    shouldTriggerArchive?: boolean;
    counters?: { archived_since_last_consolidation?: number; brain_notes: number };
    /** AUD-code-review-051: pole POWSTAJE tylko przy niepustej liście (wzór gotchy 10 modułu) —
     *  czysty przebieg zwrotki nie zasmieca się pustą tablicą. */
    noteFailures?: NoteFailure[];
}

/** Settings widziane przez workflow (progi konsolidacji + resolver promptów). */
export interface SaveSettingsLike {
    memoryV3SessionThreshold?: number;
    archiveSessionThreshold?: number;
    memoryV3BrainNotesThreshold?: number;
    archiveBrainNotesThreshold?: number;
    promptDefaults?: Record<string, unknown>;
    pkmAssistant?: { promptDefaults?: Record<string, unknown> };
    [key: string]: unknown;
}

/** Agent (profil YAML) w zakresie, którego dotyka `/save session`. */
export interface SaveAgentLike {
    name?: string;
    [key: string]: unknown;
}

export interface SaveSessionWorkflowOptions {
    app?: unknown;
    settings?: SaveSettingsLike | null;
    modalFactory?: ((payload: SaveSessionModalPayload) => SaveSessionModalLike | null) | null;
    model?: StreamChatModelLike | null;
    agent?: SaveAgentLike | null;
}

export interface SaveSessionModalPayload {
    agentName?: string;
    sessionPath: string | null | undefined;
    notes: NoteProposal[];
    brainUpdates: NaTerazUpdate[];
    messageCount: number;
    llmDriven: boolean;
}

export interface SaveSessionModalLike {
    prompt?: () => Promise<SaveSessionDecision | null | undefined>;
}

const TYPE_TO_SECTION: Record<string, string> = {
    user: '## User',
    agent_rule: '## Preferencje',
    skill_hint: '## Workflow',
    project_context: '## Bieżące',
    reference: '## Projekty i referencje'
};

const VALID_NOTE_TYPES = new Set(['user', 'agent_rule', 'skill_hint', 'project_context', 'reference']);

const AGENT_RULE_PATTERN = /\b(zawsze|nigdy|preferuj|preferenc|wol[eę] gdy|lubi[eę] gdy|nie u[zż]ywaj|m[oó]w po|pisz w |r[oó]b w |u[zż]ywaj)\b/i;
// S35: `obsek` ZOSTAJE świadomie — to heurystyka nad TEKSTEM USERA (jego własne zdania
// z rozmowy), nie nad niczym, co generuje plugin. Stare rozmowy i notatki nadal mówią
// „obsek", więc wycięcie słowa pogorszyłoby klasyfikację. Nic tu nie wymaga migracji.
const PROJECT_CONTEXT_PATTERN = /\b(projekt|vault|robimy|pkm|obsek|plugin|ten plugin|tworzymy|budujemy|repo)\b/i;

function detectNoteType(content: unknown): string {
    const text = String(content || '');
    if (AGENT_RULE_PATTERN.test(text)) return 'agent_rule';
    if (PROJECT_CONTEXT_PATTERN.test(text)) return 'project_context';
    return 'user';
}

export class SaveSessionWorkflow {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare agentMemory: SaveAgentMemoryLike;
    declare app: unknown;
    declare settings: SaveSettingsLike;
    declare modalFactory: SaveSessionWorkflowOptions['modalFactory'];
    declare model: StreamChatModelLike | null;
    declare agent: SaveAgentLike | null;

    constructor(agentMemory: SaveAgentMemoryLike, options: SaveSessionWorkflowOptions = {}) {
        this.agentMemory = agentMemory;
        this.app = options.app || null;
        this.settings = options.settings || {};
        this.modalFactory = options.modalFactory || null;
        // Memory v3 LLM-driven proposal — passing both unlocks proposeBrainUpdatesViaAgent.
        // If either is missing the workflow falls back to regex proposeNotes() (backwards-compat).
        this.model = options.model || null;
        this.agent = options.agent || null;
    }

    static async run(
        agentMemory: SaveAgentMemoryLike,
        activeSession: ActiveSessionLike = {},
        options: SaveSessionWorkflowOptions = {},
    ): Promise<SaveSessionOutcome> {
        const workflow = new SaveSessionWorkflow(agentMemory, options);
        return workflow.run(activeSession);
    }

    /**
     * Prepare proposals (LLM or regex) — does NOT prompt user, does NOT mutate disk.
     * Caller (slash handler) can display its own progress UI while this resolves, then hand the
     * result to `applyDecision` after the user reviews via SaveSessionModal.
     *
     * Returned shape stays stable for both LLM and regex paths so the modal renders uniformly.
     *
     * S29 Z6: `options` (wszystkie pola opcjonalne) idą prosto do `streamToComplete` —
     * `onChunk` (znak życia dla licznika w modalu), `signal` (działający „Anuluj": AbortController
     * z `save_session.js`), `watchdog` (zwis streamu przestaje wisieć do twardego XHR 600 s).
     * Bez `options` zachowanie jest identyczne jak przed S29.
     *
     */
    async prepareProposals(
        activeSession: ActiveSessionLike = {},
        options: PrepareProposalsOptions = {},
    ): Promise<SaveSessionPrep> {
        if (!this.agentMemory) {
            throw new Error('SaveSessionWorkflow requires AgentMemory');
        }

        const sessionPath = activeSession.path || this.agentMemory.activeSessionPath;
        const messages = await this._resolveMessages(activeSession, sessionPath);

        const llmProposal = await this._tryProposeViaAgent(messages, options);
        const notes = llmProposal
            ? llmProposal.new_notes
            : this.proposeNotes(messages, activeSession.artifacts || []);
        // Memory v3 index contract: durable facts go into brain/*.md. brain.md is regenerated from
        // the note catalogue after accepted notes are created. E2.8 D3: `brainUpdates` now carries
        // proposed „Na teraz" short-term updates (add/remove) — the modal renders them as a diff.
        const brainUpdates = llmProposal ? (llmProposal.na_teraz_updates || []) : [];

        // D8 (2026-08-27, werdykt 27.08): kandydaci memory_rescue czekający w poczekalni
        // dołączają do TEJ SAMEJ listy — user je widzi i decyduje w JEDNYM, już istniejącym
        // modalu, zamiast osobnego mechanizmu review.
        const pendingNotes = await this._proposePendingRescue();

        return {
            sessionPath,
            messages,
            notes: [...notes, ...pendingNotes],
            brainUpdates,
            llmDriven: Boolean(llmProposal),
            messageCount: messages.length,
            // Z4.3: `usage` strzału propozycji (null na ścieżce regexowej) — caller księguje koszt.
            usage: llmProposal?.usage || null
        };
    }

    /**
     * D8 (2026-08-27): kandydaci memory_rescue czekający w `brain/pending_rescue/` → propozycje
     * kształtu `NoteProposal`, gotowe do dorzucenia do listy `notes`. Pochodzenie jest widoczne
     * jako prefiks opisu „[z kompresji okna, DATA]" (bez przebudowy renderu modalu — kolumna
     * notatek już renderuje `description` jako edytowalne pole). Prefiks jest doklejany TYLKO
     * do wyświetlenia: `brain.md` ma twardy budżet tokenów wstrzykiwany do KAŻDEGO promptu, więc
     * finalna notatka nie ma go dźwigać na zawsze — `applyDecision`/`_acceptPendingRescue`
     * zdejmuje go, jeśli user nie tknął pola opisu (patrz `pendingPrefixedDescription`).
     *
     * Padnięte listowanie ANI padnięte mapowanie NIE wywala `/save session` w całości —
     * kandydaci po prostu nie pojawią się w TEJ rundzie (zostają bezpiecznie na dysku,
     * `listPendingRescue` woła się ponownie przy następnej okazji). Werdykt weryfikacji opusa
     * (nit 3): `.map()` musi siedzieć w TYM SAMYM try co `listPendingRescue` — kandydat bez
     * `name`/`filename` z obcej implementacji `AgentMemory`-podobnej (typ deklaruje te pola,
     * ale runtime niczego nie egzekwuje) rzucałby przy `p.filename.replace(...)` i ubijał cały
     * zapis sesji dla WSZYSTKICH notatek, nie tylko dla kandydatów z poczekalni.
     */
    private async _proposePendingRescue(): Promise<NoteProposal[]> {
        if (!this.agentMemory.listPendingRescue) return [];
        try {
            const pending = await this.agentMemory.listPendingRescue();
            return pending.map((p): NoteProposal => {
                const type = VALID_NOTE_TYPES.has(p.type as string) ? (p.type as string) : 'reference';
                const date = (p.created || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
                const label = t('modal.save_session.pending_rescue_label', { date });
                const original = p.description || '';
                const prefixed = original ? `[${label}] ${original}` : `[${label}]`;
                return {
                    name: p.name || p.filename.replace(/\.md$/, ''),
                    description: prefixed,
                    type,
                    section: TYPE_TO_SECTION[type] || '## Bieżące',
                    content: p.content || '',
                    why: p.why || '',
                    how_to_apply: p.how_to_apply || '',
                    accepted: true,
                    pendingFilename: p.filename,
                    pendingOriginalDescription: original,
                    pendingPrefixedDescription: prefixed,
                };
            });
        } catch (e) {
            log.warn('SaveSessionWorkflow', `listPendingRescue (albo mapowanie kandydatów) padło, pomijam tę rundę: ${(e as ErrLike).message as string}`);
            return [];
        }
    }

    /**
     * Accept jednej propozycji-z-poczekalni: `AgentMemory.acceptPendingRescue` tworzy prawdziwą
     * notatkę w `brain/` (reużywa `writeBrainNote` — kolizje nazw i `brain.log` załatwione tam)
     * i kasuje plik z poczekalni. Brak metody na `agentMemory` (stara atrapa) → traktujemy jak
     * zwykłą propozycję, żeby kandydat nie przepadł w ciszy zamiast wylądować w brain/.
     */
    private async _acceptPendingRescue(note: NoteProposal): Promise<CreatedBrainNote> {
        if (!this.agentMemory.acceptPendingRescue || !note.pendingFilename) {
            return this._createBrainNote(note);
        }
        // Prefiks pochodzenia był doklejony TYLKO na potrzeby modalu (token economy — patrz
        // docstring `_proposePendingRescue`). User, który NIE tknął pola opisu, dostaje czysty
        // oryginał; kto go edytował — dostaje dokładnie to, co napisał.
        const description = note.description === note.pendingPrefixedDescription
            ? (note.pendingOriginalDescription || '')
            : (note.description || '');
        const result = await this.agentMemory.acceptPendingRescue(note.pendingFilename, {
            name: note.name,
            description,
            type: note.type,
            content: note.content,
            why: note.why,
            how_to_apply: note.how_to_apply,
        });
        return { path: result.path, filename: result.filename, name: result.name };
    }

    /** Reject jednej propozycji-z-poczekalni: kasuje plik, nic nie trafia do `brain/`. */
    private async _rejectPendingRescue(filename: string): Promise<void> {
        if (!this.agentMemory.rejectPendingRescue) return;
        try {
            await this.agentMemory.rejectPendingRescue(filename);
        } catch (e) {
            log.warn('SaveSessionWorkflow', `rejectPendingRescue padło dla ${filename}: ${(e as ErrLike).message as string}`);
        }
    }

    /**
     * Apply a user-approved decision: create accepted brain notes, rebuild brain.md as
     * an index, archive the session, increment counters, maybe trigger ArchiveWorkflow.
     */
    async applyDecision(
        activeSession: ActiveSessionLike | null | undefined,
        prep: Pick<SaveSessionPrep, 'sessionPath'> | null | undefined,
        decision: SaveSessionDecision | null | undefined,
    ): Promise<SaveSessionOutcome> {
        if (!decision || decision.action === 'cancel') {
            return { cancelled: true, notesCreated: [], brainChanged: false, archivedPath: null };
        }

        const notesCreated: CreatedBrainNote[] = [];
        // AUD-code-review-051: każda notatka ma WŁASNY try/catch — pad jednej pozycji (np.
        // write() rzucający na dysku sieciowym) nie ma prawa zablokować rebuildBrainIndex /
        // writeNaTeraz / archiveActiveSession niżej dla tego, co się udało. Bez tego jeden pad
        // przerywał całą metodę: utworzone notatki zostawały na dysku, ale POZA indeksem
        // (rebuild się nie odpalał), sesja zostawała NIEzarchiwizowana (plik trwał w
        // sessions/active/), a przy ponowieniu udane notatki dostawały duplikat z sufiksem
        // `_2` (create-with-suffix w `writeBrainNote`). Sąsiedni `_rejectPendingRescue` już ma
        // ten wzorzec (własny try/catch + log.warn) — reszta pętli dostaje go teraz też.
        const noteFailures: NoteFailure[] = [];
        for (const note of decision.notes || []) {
            try {
                // D8 (2026-08-27): propozycje z poczekalni `brain/pending_rescue/` mają zawsze
                // rozstrzygnięcie — accept TWORZY notatkę, reject KASUJE kandydata. Zwykła
                // propozycja sesji, gdy odznaczona, po prostu nigdy nie powstaje (bez zmian).
                if (note?.pendingFilename) {
                    if (note.accepted === false) {
                        await this._rejectPendingRescue(note.pendingFilename);
                        continue;
                    }
                    notesCreated.push(await this._acceptPendingRescue(note));
                    continue;
                }
                if (note?.accepted === false) continue;
                notesCreated.push(await this._createBrainNote(note));
            } catch (e) {
                const message = (e as ErrLike)?.message || String(e);
                log.warn('SaveSessionWorkflow', `applyDecision: notatka "${note?.name || '(bez nazwy)'}" nie zapisała się, pomijam i idę dalej: ${message}`);
                noteFailures.push({ name: note?.name || '', error: message });
            }
        }

        const indexResult = await this.agentMemory.rebuildBrainIndex?.();
        const brainChanged = Boolean(indexResult?.changed);

        // E2.8 D3: apply accepted „Na teraz" short-term updates (add/remove) through the writer.
        // These mutate brain.md's ephemeral sections in place (the sole create-only exception, S22).
        const naTerazOps = (decision.brainUpdates || [])
            .filter(u => u && u.accepted !== false)
            .map(u => this._toNaTerazOp(u))
            .filter(Boolean) as NaTerazOpLike[];
        if (naTerazOps.length > 0 && this.agentMemory.writeNaTeraz) {
            try {
                await this.agentMemory.writeNaTeraz(naTerazOps);
            } catch (e) {
                log.warn('SaveSessionWorkflow', `„Na teraz" update failed: ${(e as ErrLike).message as string}`);
            }
        }
        const sessionPath = prep?.sessionPath || activeSession?.path || this.agentMemory.activeSessionPath;
        // `sessionPath` zostaje `string | null | undefined` — bramka niżej jest jedyną walidacją.
        const archivedPath = sessionPath ? await this.agentMemory.archiveActiveSession(sessionPath) : null;
        const state = await this.agentMemory.stateManager.read();
        const brainNotes = await this.agentMemory.listBrainNotes();
        const shouldTriggerArchive = this._shouldTriggerArchive(state, brainNotes);

        // Fix znaleziska TS-2 #5: martwa bramka `this.archiveWorkflow?.run(...)` SKASOWANA —
        // `ArchiveWorkflow.run()` nie istnieje od D6 (2026-07-30), a próg konsolidacji odpala
        // wołacz przez `consolidationRunner` na podstawie zwracanego `shouldTriggerArchive`.

        return {
            cancelled: false,
            action: decision.action || 'archive',
            notesCreated,
            brainChanged,
            archivedPath,
            shouldTriggerArchive,
            ...(noteFailures.length > 0 ? { noteFailures } : {}),
            counters: {
                archived_since_last_consolidation: state.archived_since_last_consolidation,
                brain_notes: brainNotes.length
            }
        };
    }

    /**
     * Convenience wrapper: prepare → modal → apply. Kept so unit tests and any non-UI caller can
     * still drive the full flow in one call. The slash handler bypasses this and uses
     * prepareProposals/applyDecision directly so it can show a loading modal first.
     */
    async run(activeSession: ActiveSessionLike = {}): Promise<SaveSessionOutcome> {
        const prep = await this.prepareProposals(activeSession);
        const decision = await this._prompt({
            agentName: this.agentMemory.agentName,
            sessionPath: prep.sessionPath,
            notes: prep.notes,
            brainUpdates: prep.brainUpdates,
            messageCount: prep.messageCount,
            llmDriven: prep.llmDriven
        });
        return this.applyDecision(activeSession, prep, decision);
    }

    proposeNotes(messages: SessionMessageLike[] = [], artifacts: SessionArtifactLike[] = []): NoteProposal[] {
        const text = this._messagesToText(messages);
        const proposals: NoteProposal[] = [];
        const rememberRegex = /pami[eę]taj(?:\s+prosz[eę])?(?:,)?\s+(?:że|ze)\s+([^\n.!?]+[.!?]?)/gi;
        let match: RegExpExecArray | null;
        while ((match = rememberRegex.exec(text)) !== null) {
            const content = match[1].trim();
            if (!content) continue;
            const name = this._titleFromContent(content);
            const type = detectNoteType(content);
            proposals.push({
                name,
                description: `Zapamietane z sesji: ${content.slice(0, 120)}`,
                type,
                section: TYPE_TO_SECTION[type] || '## Bieżące',
                content,
                accepted: true
            });
        }

        for (const artifact of artifacts || []) {
            if (!artifact?.title && !artifact?.content) continue;
            proposals.push({
                name: artifact.title || 'Artefakt z sesji',
                description: 'Kontekst z artefaktu utworzonego w sesji',
                type: 'reference',
                section: TYPE_TO_SECTION.reference,
                content: artifact.content || artifact.title,
                accepted: true
            });
        }

        return this._dedupeNotes(proposals);
    }

    /**
     * Memory v3 LLM proposal path. Returns null when the workflow lacks a model/agent or when the
     * LLM call/parse fails — caller then falls back to regex `proposeNotes` (the "Na teraz" side
     * of the fallback has no regex counterpart: `brainUpdates` just becomes `[]`, see
     * `prepareProposals`).
     */
    private async _tryProposeViaAgent(
        messages: SessionMessageLike[],
        options: PrepareProposalsOptions = {},
    ): Promise<AgentProposal | null> {
        // E2.8 B3: agent no longer carries the factory prompt — resolver provides it, so a fresh
        // agent still gets the LLM path. Only "no model / no active agent" falls back to regex.
        if (!this.model || !this.agent) return null;
        if (!Array.isArray(messages) || messages.length === 0) return null;
        try {
            return await this.proposeBrainUpdatesViaAgent(messages, options);
        } catch (e) {
            // S29 Z6: zwis / anulowanie przez usera NIE MOŻE po cichu spaść na regexy — user ma
            // zobaczyć „padło, ponów?" zamiast wyników udających propozycje modelu.
            if (options.rethrowStreamErrors !== false && this._isStreamControlError(e)) throw e;
            log.warn('SaveSessionWorkflow', `LLM proposal failed, falling back to regex: ${(e as ErrLike).message as string}`);
            return null;
        }
    }

    /** Czy to nasze przerwanie streamu (zwis / abort), a nie zwykła awaria modelu. */
    private _isStreamControlError(error: unknown): boolean {
        return (error as ErrLike)?.code === STREAM_ERROR_CODES.STALLED || (error as ErrLike)?.code === STREAM_ERROR_CODES.ABORTED;
    }

    /**
     * Call the active agent's model with its `save_session_prompt`, feed the transcript + current
     * brain/*.md notes, parse a structured JSON proposal. Caller is `_tryProposeViaAgent`.
     */
    async proposeBrainUpdatesViaAgent(
        messages: SessionMessageLike[],
        options: PrepareProposalsOptions = {},
    ): Promise<AgentProposal> {
        const currentBrain = await this.agentMemory.getBrain();
        const userPayload = {
            agent: this.agent?.name || this.agentMemory.agentName,
            message_count: messages.length,
            current_brain: currentBrain,
            transcript: messages.map(m => ({
                role: m.role,
                content: Array.isArray(m.content)
                    ? m.content.map(part => part?.text || part?.content || '').join('\n')
                    : (m.content || '')
            }))
        };
        const savePrompt = resolveWorkPrompt(this.agent, 'save_session_prompt', this.settings, DEFAULT_SAVE_SESSION_PROMPT);
        const llmMessages: StreamMessage[] = [
            { role: 'system', content: savePrompt },
            { role: 'user', content: JSON.stringify(userPayload) }
        ];
        // S29 Z6: onChunk/signal/watchdog przekazywane 1:1 (bez nich zachowanie jak dotąd).
        const { text, usage } = await streamToComplete(this.model!, llmMessages, {
            onChunk: options.onChunk,
            signal: options.signal,
            watchdog: options.watchdog,
        });
        // Z4.3: surowe `usage` z tego strzału jedzie dalej (kontrakt propozycji bez zmian, doszło
        // jedno pole). Bez niego jedyne wywołanie LLM w `/save session` było niewidzialne w koszcie
        // — `CostLog` znał tylko konsolidację.
        return { ...this._parseAgentJsonResponse(text), usage: usage || null };
    }

    /**
     * Strip optional ```json fences, parse, validate against the Memory v3 note contract.
     * Throws when the structure is malformed — caller catches and falls back to regex.
     */
    _parseAgentJsonResponse(text: unknown): AgentProposal {
        const raw = String(text || '').trim();
        if (!raw) throw new Error('Empty LLM response');
        const stripped = raw
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        let parsed: { new_notes?: unknown; na_teraz?: unknown };
        try {
            parsed = JSON.parse(stripped) as { new_notes?: unknown; na_teraz?: unknown };
        } catch {
            // Last-resort: extract the first {...} block — handles models that wrap with prose.
            const match = stripped.match(/\{[\s\S]*\}/);
            if (!match) throw new Error('No JSON object in LLM response');
            parsed = JSON.parse(match[0]) as { new_notes?: unknown; na_teraz?: unknown };
        }

        const newNotes = Array.isArray(parsed?.new_notes) ? parsed.new_notes : [];

        const cleanNotes: NoteProposal[] = newNotes
            .map((n: Record<string, unknown>): NoteProposal | null => {
                const type = VALID_NOTE_TYPES.has(n?.type as string) ? (n.type as string) : 'reference';
                const name = String(n?.name || '').trim();
                const content = String(n?.content || '').trim();
                if (!name || !content) return null;
                return {
                    name,
                    description: String(n?.description || '').trim(),
                    type,
                    content,
                    why: String(n?.why || '').trim(),
                    how_to_apply: String(n?.how_to_apply || '').trim(),
                    section: TYPE_TO_SECTION[type] || '## Bieżące',
                    accepted: true
                };
            })
            .filter(Boolean) as NoteProposal[];

        // Legacy brain_updates are parsed for backwards compatibility, but the workflow no longer
        // applies them. Facts belong in brain/*.md; brain.md is a categorized index.
        // E2.8 D3: na_teraz → short-term „Na teraz" updates (add/remove), reviewed in the modal.
        return { brain_updates: [], new_notes: cleanNotes, na_teraz_updates: this._parseNaTerazUpdates(parsed?.na_teraz) };
    }

    /**
     * Turn the LLM's `na_teraz: { user: {add,remove}, environment: {add,remove} }` block into flat
     * review items `{action:'ADD'|'DELETE', section, content, oldContent, accepted}` for the modal.
     */
    private _parseNaTerazUpdates(naTeraz: unknown): NaTerazUpdate[] {
        if (!naTeraz || typeof naTeraz !== 'object') return [];
        const updates: NaTerazUpdate[] = [];
        for (const section of ['user', 'environment']) {
            const bucket = (naTeraz as Record<string, { add?: unknown; remove?: unknown } | undefined>)[section];
            if (!bucket || typeof bucket !== 'object') continue;
            for (const raw of Array.isArray(bucket.add) ? bucket.add : []) {
                const content = String(raw || '').replace(/\s+/g, ' ').trim();
                if (content) updates.push({ action: 'ADD', section, content, oldContent: '', accepted: true });
            }
            for (const raw of Array.isArray(bucket.remove) ? bucket.remove : []) {
                const oldContent = String(raw || '').replace(/\s+/g, ' ').trim();
                if (oldContent) updates.push({ action: 'DELETE', section, content: '', oldContent, accepted: true });
            }
        }
        return updates;
    }

    /** Map a modal review item to a writeNaTeraz op ({section, add?, remove?}), or null when unusable. */
    private _toNaTerazOp(update: NaTerazUpdate | null | undefined): NaTerazOpLike | null {
        const action = String(update?.action || 'ADD').toUpperCase();
        const section = update?.section;
        if (!section) return null;
        if (action === 'DELETE') {
            const remove = update.oldContent || update.content || '';
            return remove ? { section, remove } : null;
        }
        if (action === 'UPDATE') return { section, add: update.content || '', remove: update.oldContent || '' };
        return update.content ? { section, add: update.content } : null; // ADD
    }

    private async _resolveMessages(
        activeSession: ActiveSessionLike,
        sessionPath: string | null | undefined,
    ): Promise<SessionMessageLike[]> {
        if (Array.isArray(activeSession.messages)) return activeSession.messages;
        if (sessionPath && this.agentMemory.loadActiveSession) {
            const parsed = await this.agentMemory.loadActiveSession(sessionPath);
            return parsed?.messages || [];
        }
        return [];
    }

    private async _prompt(payload: SaveSessionModalPayload): Promise<SaveSessionDecision | null | undefined> {
        const modal = this.modalFactory
            ? this.modalFactory(payload)
            : null;
        if (modal?.prompt) return modal.prompt();
        return {
            action: 'archive',
            notes: payload.notes,
            brainUpdates: payload.brainUpdates
        };
    }

    /**
     * Zapisz notatkę zaakceptowaną w modalu `/save session` przez KANONICZNĄ ścieżkę
     * `AgentMemory.writeBrainNote` — create-with-suffix + kolejka K1 + stopka Why/How z i18n
     * + escapowanie frontmattera przez `JSON.stringify`, ta sama, której używają `memory_save`
     * i accept z poczekalni rescue (`writeBrainNote` sam woła `ensureMemoryStructure` i
     * `appendBrainLog('create', ..., 'save_session')` — wołacz nie dubluje żadnego z nich).
     *
     * AUD-code-review-067/068: do tej naprawy metoda REIMPLEMENTOWAŁA zapis notatki obok
     * `writeBrainNote` — własny szablon frontmattera bez stopki Why/How (LLM w `/save session`
     * generuje `why`/`how_to_apply`, patrz `workPrompts.ts`, ale nigdy nie trafiały na dysk tą
     * drogą) i własne escapowanie frontmattera przez `replace(':', ' -')` zamiast
     * `JSON.stringify` (dwukropek w treści usera, np. „spotkanie 14:30", wracał trwale
     * okaleczony na „spotkanie 14 -30" — pozostali trzej pisarze tego samego kontraktu wracają
     * 1:1). Trzeci, nieudokumentowany pisarz tej samej notatki miał dziś jednego właściciela.
     */
    async _createBrainNote(note: NoteProposal): Promise<CreatedBrainNote> {
        return this.agentMemory.writeBrainNote(
            {
                name: note.name,
                description: note.description,
                type: note.type,
                content: note.content,
                why: note.why,
                how_to_apply: note.how_to_apply,
            },
            { source: 'save_session' },
        );
    }

    // Fix znaleziska TS-2 #9: martwy parametr `updates` usunięty — ciało go nie czytało
    // (metoda tylko przebudowuje indeks i raportuje, czy plik się zmienił).
    async _applyBrainUpdates(): Promise<boolean> {
        const before = await this.agentMemory.getBrain();
        await this.agentMemory.rebuildBrainIndex?.();
        const after = await this.agentMemory.getBrain();
        return after !== before;
    }

    private _shouldTriggerArchive(state: SaveStateLike | null | undefined, brainNotes: Array<unknown> | null | undefined): boolean {
        // Memory v3 default thresholds:
        //  - sessions threshold 10 so the dedup modal doesn't barge in every other /save session
        //  - brain notes threshold 20 after the categorized brain.md index split
        // Per-agent `state.brain_notes_limit` (auto-bumped on user reject) still takes precedence.
        const sessionThreshold = this.settings.memoryV3SessionThreshold
            || this.settings.archiveSessionThreshold
            || 10;
        const brainNotesThreshold = state?.brain_notes_limit
            || this.settings.memoryV3BrainNotesThreshold
            || this.settings.archiveBrainNotesThreshold
            || 20;
        return Number(state?.archived_since_last_consolidation || 0) >= sessionThreshold
            || (brainNotes?.length || 0) > brainNotesThreshold;
    }

    private _messagesToText(messages: SessionMessageLike[] | null | undefined): string {
        return (messages || [])
            .map(message => Array.isArray(message?.content)
                ? message.content.map(part => part.text || part.content || '').join('\n')
                : (message?.content || ''))
            .join('\n');
    }

    private _titleFromContent(content: unknown): string {
        return String(content || '')
            .replace(/^[-*\s]+/, '')
            .split(/\s+/)
            .slice(0, 6)
            .join(' ')
            .replace(/[.:;!?]+$/, '')
            || 'Notatka z sesji';
    }

    private _dedupeNotes(notes: NoteProposal[]): NoteProposal[] {
        const seen = new Set<string>();
        return notes.filter(note => {
            const key = `${note.type}:${note.content}`.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}

/** Propozycja z modelu po sparsowaniu (`brain_updates` zostaje pusty — legacy). */
export interface AgentProposal {
    brain_updates: unknown[];
    new_notes: NoteProposal[];
    na_teraz_updates: NaTerazUpdate[];
    /** surowe `usage` strzału (Z4.3) — dokładane w `proposeBrainUpdatesViaAgent` */
    usage?: unknown;
}
