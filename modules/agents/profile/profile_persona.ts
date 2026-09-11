/**
 * Persona tab - Osobowość (personality) + panel aktywnych sesji.
 *
 * Wyprowadzki (zgodnie z makietą):
 *  - nazwa / opis / kryształ / kolor → Przegląd (edycja inline ✎),
 *  - temperatura → Zaawansowane,
 *  - archetyp / rola / drift → skasowane.
 *
 * „Aktywne sesje" (rozmowy, które jeszcze nie poszły do archiwum) domknięte tutaj - zakładka
 * Pamięć pokazuje TYLKO archiwum, więc żywe sesje nie miały gdzie się pokazać. Klik = ten sam
 * edytor ukrytego pliku co w Pamięci (`openHiddenFile`, zero duplikatu kodu).
 */
import { renderShard, openHiddenFile } from './profile_helpers.js';
import { UiIcons, setSvg } from '../../crystal-soul/index.js';
import { t } from '../../../core/i18n/index.js';
import type { Agent } from '../Agent.js';
import type { AgentManager } from '../AgentManager.js';
import type { AgentsPlugin } from './profile_types.js';
import type { ActiveSessionInfo } from '../../memory/index.js';

interface PersonaContext {
    formData: { personality: string };
    agent: Agent;
    agentManager: AgentManager;
    plugin: AgentsPlugin;
}

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export async function renderProfileTab(ctx: PersonaContext, el: HTMLElement) {
    const { formData } = ctx;
    const grid = el.createDiv({ cls: 'cs-shards' });

    // Osobowość - jedyny prawdziwy głos duszy w prompcie (sekcja „KIM JESTEM").
    renderShard(grid, t('profile.persona.personality'), t('profile.persona.personality_hint'),
        formData.personality, 'textarea',
        (v) => formData.personality = v as string,
        { big: true, placeholder: t('profile.persona.personality_placeholder'), rows: 10 });

    await _renderActiveSessions(ctx, el);
}

/**
 * Panel aktywnych sesji. Dane przez publiczne API pamięci agenta
 * (`agentManager.getAgentMemory(name).listActiveSessions()`) - tak samo jak zakładka Pamięć
 * dostaje `memory`. Brak pamięci (agent bez zainicjowanego folderu) = sekcji po prostu nie ma:
 * pusty panel jest uczciwszy niż kłamliwe „Brak aktywnych sesji".
 */
async function _renderActiveSessions(ctx: PersonaContext, el: HTMLElement) {
    const { agent, agentManager, plugin } = ctx;
    const memory = agent ? agentManager?.getAgentMemory?.(agent.name) : null;
    if (!memory?.listActiveSessions) return;

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.history(14));
    head.createSpan({ text: t('profile.persona.sessions_header') });
    el.createDiv({ text: t('profile.persona.sessions_hint'), cls: 'setting-item-description' });

    let sessions: ActiveSessionInfo[] = [];
    try {
        sessions = await memory.listActiveSessions() || [];
    } catch (e: unknown) {
        el.createEl('p', { text: t('profile.memory.sessions_read_error') + (e as Error).message, cls: 'cs-focus-hint' });
        return;
    }

    if (sessions.length === 0) {
        el.createEl('p', { text: t('profile.persona.sessions_empty'), cls: 'cs-focus-hint' });
        return;
    }

    const list = el.createDiv({ cls: 'cs-mem-list' });
    for (const session of sessions) {
        const label = _sessionLabel(session);
        const item = list.createDiv({ cls: 'cs-mem-item' });
        setSvg(item.createSpan({ cls: 'cs-mem-item__icon' }), UiIcons.file(12));
        item.createSpan({ cls: 'cs-mem-item__date', text: label });
        item.addEventListener('click', () => {
            void openHiddenFile(plugin.app, session.path, label, {
                agentName: agent.name, agentColor: agent.color || '', readOnly: true
            });
        });
    }
}

/**
 * Czytelna data z nazwy pliku `<agent>_YYYY-MM-DD_HH-mm.md` („2026-07-30 14:05").
 * Bez trafienia w wzorzec - sama nazwa pliku (lepiej surowa niż zmyślona).
 */
function _sessionLabel(session: ActiveSessionInfo) {
    const name = String(session?.name || session?.path || '').split('/').pop()!.replace(/\.md$/, '');
    const match = name.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/);
    return match ? `${match[1]}  ${match[2]}:${match[3]}` : name;
}
