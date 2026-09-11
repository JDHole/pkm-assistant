/**
 * artifactBlocks.js — render bloku ```pkm-artefakt``` w notatce instancji.
 *
 * Precedens: `modules/komunikator/KomunikatorEmbed.js` (registerMarkdownCodeBlockProcessor).
 * Silnik store dokleja blok ` ```pkm-artefakt\nid: <art-id>\n``` ` do body instancji przy `create`
 * (JEDYNY kod, który plugin pisze do notatki — nasz własny). Tu go RENDERUJEMY: guziki wg statusu
 * instancji i `statusy` typu (`computeArtifactButtons`), a klik = `set_field status` (gdy dotyczy)
 * przez `ArtifactStore` + przywołanie agenta (`summonAgentForArtifact`, B2).
 */
import { t } from '../../core/i18n/index.js';
import { computeArtifactButtons } from './artifactButtons.js';
import { summonAgentForArtifact } from './artifactSummon.js';
import { log } from '../../core/utils/Logger.js';
import type { ArtifactType, ArtifactPatchOp, ArtifactPatchError, ThinArtifact } from './types.js';

/** Wyłuskaj `id` z ciała bloku (`id: art-...` albo sam token w pierwszej linii). */
export function parseArtifactBlockId(source: unknown = ''): string {
    const text = String(source || '').trim();
    if (!text) return '';
    const m = text.match(/^id\s*:\s*(.+)$/mi);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    return text.split(/\s+/)[0] || '';
}

/** Ścieżka vaulta do porównania: jeden zapis (slashe w przód, bez `./` i wiodącego `/`). */
function canonicalVaultPath(path: unknown): string {
    return String(path ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .trim();
}

/**
 * Czy blok `pkm-artefakt` stoi w SWOJEJ notatce?
 *
 * Procesor jest zarejestrowany globalnie dla całego vaultu, a `id` bierze z TREŚCI bloku - czyli
 * z tekstu, który do notatki może wpisać model albo zatwierdzony `write`. Bez tego warunku blok
 * podłożony w dowolnej notatce rysowałby działające guziki CUDZEGO artefaktu: user widziałby
 * „✅ Zatwierdź" w kontekście swojej notatki, a klik przestawiałby status cudzego planu i przywoływał
 * jego agenta (nadużycie zaufania człowieka).
 *
 * Prawowitym pisarzem bloku jest wyłącznie `ArtifactStore.create`, który wkleja go do notatki tego
 * samego artefaktu — więc niezmiennik brzmi: ścieżka renderowanego pliku == ścieżka artefaktu.
 * Porównujemy po ścieżce KANONICZNEJ i po JEDNYM źródle prawdy (`store.pathById`, to samo, którego
 * używa bramka uprawnień) — żadnej drugiej mapy id→plik.
 *
 * Fail-closed: brak `sourcePath` (stary host), brak store'a albo nieznane id = `false`.
 *
 * @param {string} id - identyfikator z treści bloku
 * @param {string} sourcePath - ścieżka notatki, w której blok jest renderowany (`ctx.sourcePath`)
 * @param {Object} store - ArtifactStore (potrzebne tylko `pathById`)
 * @returns {boolean}
 */
export function isBlockBoundToNote(
    id: unknown,
    sourcePath: unknown,
    store: { pathById?: (id: string) => string | null } | null | undefined,
): boolean {
    const artifactId = String(id ?? '').trim();
    const here = canonicalVaultPath(sourcePath);
    if (!artifactId || !here || typeof store?.pathById !== 'function') return false;
    const owner = canonicalVaultPath(store.pathById(artifactId));
    return owner !== '' && owner === here;
}

/** Element DOM/Obsidiana, jakiego potrzebuje renderer bloku — duck-type (testy podstawiają
 *  własną atrapę bez importu obsidian: `registerMarkdownCodeBlockProcessor` biegnie w gołym
 *  Node w `artifactBlocks.test.ts`). W prawdziwym Obsidianie to realny `HTMLElement`, który ma
 *  te metody z globalnej rozszerzki Obsidiana (`createDiv`/`createSpan`/`createEl`). */
interface ArtifactBlockElement {
    createDiv(o?: { cls?: string; text?: string }): ArtifactBlockElement;
    createSpan(o?: { cls?: string; text?: string }): ArtifactBlockElement;
    createEl(tag: string, o?: { cls?: string; text?: string }): ArtifactBlockElement;
    addEventListener(ev: string, fn: () => unknown): void;
    disabled?: boolean;
}

/** Store artefaktów widziany przez renderer bloku — `pathById` (patrz `isBlockBoundToNote`)
 *  + `read`/`update` (te same sygnatury co realny `ArtifactStore`, `./ArtifactStore.ts`). */
interface ArtifactBlockStore {
    pathById?: (id: string) => string | null;
    read(id: string): Promise<ThinArtifact | null>;
    update(id: string, ops: ArtifactPatchOp[]): Promise<{ applied: number; errors: ArtifactPatchError[]; artifact: ThinArtifact | null }>;
}

/** Plugin widziany przez renderer bloku — TYLKO pola, które ten plik realnie czyta. */
interface ArtifactBlocksPlugin {
    artifactStore?: ArtifactBlockStore | null;
    agentManager?: { artifactTypeLoader?: { getType(name: string): Partial<ArtifactType> | null } | null } | null;
    registerMarkdownCodeBlockProcessor(
        type: string,
        handler: (source: string, el: ArtifactBlockElement, ctx: { sourcePath?: string }) => Promise<void>,
    ): void;
}

/**
 * Zarejestruj procesor bloku artefaktów.
 * @param {Object} plugin
 */
export function registerArtifactBlocks(plugin: ArtifactBlocksPlugin): void {
    plugin.registerMarkdownCodeBlockProcessor('pkm-artefakt', async (source: string, el: ArtifactBlockElement, ctx: { sourcePath?: string }) => {
        const store = plugin?.artifactStore;
        const id = parseArtifactBlockId(source);
        const root = el.createDiv({ cls: 'pkm-artefakt-block cs-root' });

        if (!store || !id) {
            root.createSpan({ cls: 'pkm-artefakt-block__note', text: t('artifact.block.unavailable') });
            return;
        }

        // Blok bez związku z tą notatką renderuje się MARTWY - i to PRZED odczytem artefaktu,
        // żeby cudza notatka nie wyciekła nawet statusem.
        if (!isBlockBoundToNote(id, ctx?.sourcePath, store)) {
            root.createSpan({ cls: 'pkm-artefakt-block__note', text: t('artifact.block.foreign') });
            return;
        }

        let thin: ThinArtifact | null = null;
        try { thin = await store.read(id); } catch { thin = null; }
        if (!thin) {
            root.createSpan({ cls: 'pkm-artefakt-block__note', text: t('artifact.block.not_found') });
            return;
        }

        // TS-boundary: ZASTANE - `thin.typ`/`thin.status` to `string | null` (ThinArtifact), ale
        // `getType`/`computeArtifactButtons` chcą `string`; artefakt z pustym `typ`/`status` w
        // frontmatterze dostałby tu `null` mimo asercji. Naprawa (walidacja przy tworzeniu /
        // guard tutaj) to zmiana runtime, poza zakresem tej fali.
        const type = plugin.agentManager?.artifactTypeLoader?.getType?.(thin.typ as string);
        const buttons = computeArtifactButtons(thin.status as string, type?.statusy);

        if (buttons.length === 0) {
            // Domknięty artefakt — pokazujemy sam status, bez akcji.
            root.createSpan({
                cls: 'pkm-artefakt-block__status',
                text: t('artifact.block.status', { status: thin.status || '' }),
            });
            return;
        }

        for (const btn of buttons) {
            const buttonEl = root.createEl('button', {
                cls: 'pkm-artefakt-block__btn',
                text: `${btn.icon} ${t(btn.labelKey)}`,
            });
            buttonEl.addEventListener('click', async () => {
                // Blokada podwójnego kliku w trakcie zapisu.
                if (buttonEl.disabled) return;
                buttonEl.disabled = true;
                try {
                    if (btn.statusTo) {
                        await store.update(id, [{ op: 'set_field', key: 'status', value: btn.statusTo }]);
                    }
                    await summonAgentForArtifact(plugin, { id, actionLabel: t(btn.summonKey) });
                } catch (e) {
                    log.error('artifactBlocks', 'Akcja artefaktu nie powiodła się:', e);
                    buttonEl.disabled = false;
                }
            });
        }
    });
}
