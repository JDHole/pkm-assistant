/**
 * artifactSummon.js — przywołanie agenta po interakcji z artefaktem w notatce (E2.9 FAZA B / B2).
 *
 * Dwie warstwy w jednym pliku (BEZ importu `obsidian`, żeby `buildSummonMessage` był node-testowalny):
 *  - `buildSummonMessage(thin, actionLabel)` — PURE. Buduje wiadomość user-side: nagłówek
 *    „📄 Artefakt „<tytul>" (<id>) — user: <akcja>" + sparsowany chudy JSON (ten sam kształt co
 *    `artifact_read`). Testowalny.
 *  - `summonAgentForArtifact(plugin, {...})` — RUNTIME. Czyta świeży stan (`artifactStore.read`),
 *    otwiera/aktywuje ChatView z agentem instancji, ustawia artefakt jako AKTYWNY w tej rozmowie
 *    (B3) i wysyła wiadomość ISTNIEJĄCĄ ścieżką `send_message` (wzór `main.sendInlineComment`).
 *    NIE buduje równoległego mechanizmu wysyłki.
 *  - `activateArtifactInChat(plugin, {id})` — RUNTIME, wariant CICHY. To samo ustawienie aktywnego
 *    artefaktu, ale BEZ budowania i wysyłania wiadomości. Dla klików, które mają tylko przypiąć
 *    artefakt (picker w slim barze); wysyłkę robią guziki w notatce i 🔄 na chipie.
 */
import { t } from '../../core/i18n/index.js';
// AUD-dead-code-182: CHAT_VIEW_TYPE — kanoniczna stała żyje w core/ (node-safe barrel),
// nie w `modules/chat/index.js` (ten ciągnie `obsidian` przez ChatView/chat_streaming.js
// i złamałby "BEZ importu obsidian" tego pliku — patrz `core/utils/viewTypes.ts`).
import { MACHINE_MESSAGE_META, CHAT_VIEW_TYPE } from '../../core/index.js';
import type { ThinArtifact } from './types.js';

/**
 * Zbuduj wiadomość przywołania (user-side) dla agenta.
 * @param {Object} thin - sparsowany stan artefaktu (z `ArtifactStore.read`)
 * @param {string} actionLabel - zlokalizowana fraza akcji usera (np. „zatwierdził plan")
 * @returns {string}
 */
export function buildSummonMessage(thin: unknown, actionLabel: string = ''): string {
    const tytul = (thin as Partial<ThinArtifact> | null | undefined)?.tytul
        || (thin as Partial<ThinArtifact> | null | undefined)?.frontmatter?.typ
        || 'artefakt';
    const id = (thin as Partial<ThinArtifact> | null | undefined)?.id
        || (thin as Partial<ThinArtifact> | null | undefined)?.frontmatter?.['pkm-artefakt']
        || '';
    const header = t('artifact.summon.header', { tytul, id, akcja: actionLabel || t('artifact.summon.action.summon') });
    const state = formatThinState(thin);
    return state ? `${header}\n\n${state}` : header;
}

/** Sparsowany stan jako czytelny blok JSON (ten sam kształt co odpowiedź `artifact_read`). */
function formatThinState(thin: unknown): string {
    if (!thin || typeof thin !== 'object') return '';
    const slim = {
        id: (thin as Partial<ThinArtifact>).id || null,
        typ: (thin as Partial<ThinArtifact>).typ || null,
        status: (thin as Partial<ThinArtifact>).status || null,
        frontmatter: (thin as Partial<ThinArtifact>).frontmatter || {},
        sections: (Array.isArray((thin as Partial<ThinArtifact>).sections)
            ? (thin as Partial<ThinArtifact>).sections!
            : []).map(s => ({
            heading: s.heading,
            ...(s.text ? { text: s.text } : {}),
            items: (Array.isArray(s.items) ? s.items : []).map(i => ({
                blockId: i.blockId || null,
                text: i.text,
                checked: !!i.checked,
            })),
        })),
    };
    return '```json\n' + JSON.stringify(slim, null, 2) + '\n```';
}

// Ten plik wstaje w gołym Node bez mocka obsidiana (`artifactSummon.test.ts`), gdzie `window`
// nie istnieje — bramka `typeof window !== 'undefined'` odpada tam na gałąź Node. W prawdziwym
// Obsidianie (Electron) `window.setTimeout` jest identyczny z globalnym, więc zachowanie się nie
// zmienia — to tylko dodatkowa gałąź dla środowiska bez `window` (nazwa inna niż `setTimeout`,
// żeby `obsidianmd/prefer-window-timers` nie widziała tu bare-globala do zgłoszenia).
const scheduleTimeout: typeof setTimeout = typeof window !== 'undefined' ? window.setTimeout.bind(window) : setTimeout;

/** Świeży stan artefaktu ze store'a; null gdy brak store'a / id / nieznane id. */
// TS-any: plugin objects are Obsidian runtime integrations without a stable module-local API.
async function readFreshArtifact(plugin: any, id: string): Promise<any> {
    if (!plugin?.artifactStore || !id) return null;
    try { return await plugin.artifactStore.read(id); } catch { return null; }
}

/**
 * Otwórz/aktywuj czat (wzór main.openChatView) i wykonaj `fn(view)` po ticku (leaf render).
 * Wspólny przewód obu wejść — czatu szukamy tak samo, niezależnie czy wysyłamy wiadomość.
 */
// TS-any: view objects are Obsidian runtime integrations without a stable module-local API.
function withChatView(plugin: any, fn: (view: any) => void): void {
    try { plugin.openChatView?.(); } catch { /* brak metody / layout */ }
    scheduleTimeout(() => {
        const leaves = plugin.app?.workspace?.getLeavesOfType?.(CHAT_VIEW_TYPE) || [];
        const view = leaves[0]?.view;
        if (!view) return;
        fn(view);
    }, 300);
}

/** Ustaw artefakt jako AKTYWNY w tej rozmowie (B3) + odśwież chip nad inputem (B4). */
// TS-any: view objects are Obsidian runtime integrations without a stable module-local API.
function setActiveArtifact(view: any, id: string): void {
    view.currentArtifactId = id;
    try { view._renderArtifactChip?.(); } catch { /* UI jeszcze nie gotowe */ }
}

/**
 * Przywołaj agenta instancji: aktywuj czat, przełącz na agenta, ustaw artefakt aktywny, wyślij stan.
 * @param {Object} plugin
 * @param {Object} opts
 * @param {string} opts.id - id artefaktu (frontmatter `pkm-artefakt`)
 * @param {string} [opts.actionLabel] - zlokalizowana fraza akcji usera (do wiadomości)
 * @returns {Promise<boolean>} false gdy brak store'a / artefaktu
 */
// TS-any: plugin and view objects are Obsidian runtime integrations without a stable module-local API.
export async function summonAgentForArtifact(plugin: any, { id, actionLabel = '' }: { id: string; actionLabel?: string } = {} as { id: string; actionLabel?: string }): Promise<boolean> {
    const thin = await readFreshArtifact(plugin, id);
    if (!thin) return false;

    const message = buildSummonMessage(thin, actionLabel);

    withChatView(plugin, view => {
        const send = () => {
            setActiveArtifact(view, id);
            if (view.input_area) {
                view.input_area.value = message;
                // K7 (AUD-security-062): treść artefaktu pisze AGENT (a jej materiał bywa z sieci),
                // więc wysyłka jest maszynowa mimo kliknięcia usera — inaczej adres wpisany przez
                // model do sekcji „Źródła" odblokowywałby `web_read`, a marker `@@skill:` udawałby
                // polecenie człowieka.
                try { view.send_message?.({ meta: MACHINE_MESSAGE_META }); } catch { /* model niekonfigurowany itp. */ }
            }
        };

        // Przełącz na agenta instancji (jeśli inny niż aktywny), potem wyślij.
        if (thin.agent && typeof view.handleAgentChange === 'function') {
            Promise.resolve(view.handleAgentChange(thin.agent)).then(send).catch(send);
        } else {
            send();
        }
    });

    return true;
}

/**
 * Przypnij artefakt do rozmowy BEZ wysyłania czegokolwiek (klik w pickerze slim bara).
 *
 * Agenta świadomie NIE przełączamy — picker listuje wyłącznie artefakty aktywnego agenta,
 * więc nie ma czego przełączać (przełączanie robi `summonAgentForArtifact`, wołane z guzików
 * w notatce, gdzie artefakt może należeć do kogoś innego).
 *
 * @param {Object} plugin
 * @param {Object} opts
 * @param {string} opts.id - id artefaktu (frontmatter `pkm-artefakt`)
 * @returns {Promise<{ok:boolean, path?:string|null}>} `{ok:false}` gdy brak store'a / artefaktu
 */
// TS-any: plugin objects are Obsidian runtime integrations without a stable module-local API.
export async function activateArtifactInChat(plugin: any, { id }: { id: string } = {} as { id: string }): Promise<{ ok: boolean; path?: string | null }> {
    const thin = await readFreshArtifact(plugin, id);
    if (!thin) return { ok: false };

    withChatView(plugin, view => setActiveArtifact(view, id));

    return { ok: true, path: thin.path || null };
}
