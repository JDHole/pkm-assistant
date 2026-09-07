/**
 * Strażnik po źródle dla trzech znalezisk code-review 2026-08-30 — twarde teksty w modalach shell
 * omijające `core/i18n`, zamiast przez `t()` jak reszta tych samych plików:
 *
 * - AUD-code-review-060: `CostTrackingModal.ts` sekcja „Per model" — jedyny nagłówek modala
 *   pomijający i18n.
 * - AUD-code-review-097: `AgentPresentationModal.ts` w ogóle nie importował `core/i18n` —
 *   8+ napisów UI po polsku na twardo.
 * - AUD-code-review-098: `common.cancel` (osierocony duplikat `generic.cancel`) miał 3 wołania
 *   w tym module — `ClaudeImportModal.ts` (×2) i `MCPServerEditorModal.ts` (×1).
 *
 * Każdy z tych plików importuje `obsidian` (`Modal`), więc AVA nie może ich zaimportować wprost —
 * ten sam powód i wzór co `MCPServerEditorModal.rollback.test.ts` / `chat/stopSemantics.test.ts`:
 * czytamy ŹRÓDŁO regexami.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const costTracking = readSource('./CostTrackingModal.ts');
const agentPresentation = readSource('./AgentPresentationModal.ts');
const claudeImport = readSource('./ClaudeImportModal.ts');
const mcpServerEditor = readSource('./MCPServerEditorModal.ts');

// ── AUD-code-review-060 ──────────────────────────────────────────────────

test('CostTrackingModal.ts: sekcja "Per model" idzie przez t() (AUD-code-review-060)', t => {
    t.notRegex(costTracking, /createEl\('strong', \{ text: 'Per model' \}\)/,
        'ostatni nagłówek sekcji omijał i18n, w przeciwieństwie do per_agent/per_day/per_month obok');
    t.regex(costTracking, /t\('modal\.cost_tracking\.per_model'\)/);
});

// ── AUD-code-review-097 ──────────────────────────────────────────────────

test('AgentPresentationModal.ts importuje core/i18n (AUD-code-review-097)', t => {
    t.regex(agentPresentation, /import \{ t \} from '\.\.\/\.\.\/core\/i18n\/index\.js'/,
        'plik nie importował t() w ogóle — jedyny modal w shell z tą wadą');
});

test('AgentPresentationModal.ts: 8+ literałów PL zastąpione t() (AUD-code-review-097)', t => {
    t.notRegex(agentPresentation, /text: 'Agent nie znaleziony\.'/);
    t.notRegex(agentPresentation, /label: 'Sesje'/);
    t.notRegex(agentPresentation, /label: 'Skille'/);
    t.notRegex(agentPresentation, /label: 'Sub-agenci'/);
    t.notRegex(agentPresentation, /label: 'Model'/);
    t.notRegex(agentPresentation, /\|\| 'Globalny'/);
    t.notRegex(agentPresentation, /UiIcons\.chat\(14\), 'Czat'\)/);
    t.notRegex(agentPresentation, /UiIcons\.edit\(14\), 'Edytuj profil'\)/);

    t.regex(agentPresentation, /t\('modal\.agent_presentation\.not_found'\)/);
    t.regex(agentPresentation, /t\('profile\.overview\.sessions'\)/);
    t.regex(agentPresentation, /t\('profile\.overview\.skills'\)/);
    t.regex(agentPresentation, /t\('modal\.agent_presentation\.sub_agents'\)/);
    t.regex(agentPresentation, /t\('profile\.overview\.model'\)/);
    t.regex(agentPresentation, /t\('profile\.overview\.global'\)/);
    t.regex(agentPresentation, /t\('modal\.agent_presentation\.chat_btn'\)/);
    t.regex(agentPresentation, /t\('modal\.agent_presentation\.edit_profile_btn'\)/);
});

test('AgentPresentationModal.ts: filled-shard porównanie używa TEJ SAMEJ etykiety global co wyświetlana (regresja locale)', t => {
    // Zanim zamieniono display na t(), `filled` porównywał wartość z hardcoded 'Globalny' — gdyby
    // display przeszedł na t() bez zmiany tego warunku, w EN locale porównanie nigdy by nie
    // trafiało (zawsze "filled"). Test pilnuje, żeby obie strony dalej czytały JEDNĄ zmienną.
    t.regex(agentPresentation, /const globalLabel = t\('profile\.overview\.global'\);/);
    t.regex(agentPresentation, /info\.value !== '0' && info\.value !== globalLabel/);
});

// ── AUD-code-review-098 ──────────────────────────────────────────────────

test('common.cancel osierocony klucz nie ma już wołaczy w shell (AUD-code-review-098)', t => {
    t.notRegex(claudeImport, /t\('common\.cancel'\)/, 'ClaudeImportModal.ts miał 2 wołania common.cancel');
    t.notRegex(mcpServerEditor, /t\('common\.cancel'\)/, 'MCPServerEditorModal.ts miał 1 wołanie common.cancel');

    const genericCancelCalls = (claudeImport.match(/t\('generic\.cancel'\)/g) || []).length;
    t.is(genericCancelCalls, 2, 'oba guziki Anuluj w ClaudeImportModal.ts muszą przejść na kanoniczny klucz');
    t.regex(mcpServerEditor, /t\('generic\.cancel'\)/);
});
