/**
 * AgentDelegateTool
 * MCP tool: Propose delegation of conversation to another agent.
 * Does NOT switch automatically - returns delegation data for UI to render a button.
 */
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
// AUD-security-128: `maskSensitiveData` — ta sama granica maskowania, co w `SubAgentRunner` (K8).
import { maskSensitiveData } from '../../core/index.js';
import { sendAgentMail } from './KomunikatorTools.js';
import type { KomPlugin } from './KomunikatorTools.js';

/** Argumenty `agent_delegate` wg `inputSchema` (`context_summary` jest REQUIRED — D14). */
interface AgentDelegateArgs {
    to_agent?: string;
    reason?: string;
    context_summary?: string;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Agent w zakresie, jaki czyta to narzędzie. */
interface DelegateTargetAgent {
    name: string;
}

/** Minimalny widok AgentManagera. */
interface AgentDelegateManager {
    komunikatorManager?: unknown;
    getAgent(name: string | undefined): DelegateTargetAgent | null | undefined;
    getAllAgents(): DelegateTargetAgent[];
    /** D6: lista WIDOCZNYCH w komunikatorze — duchy nie mogą wyciec w błędzie „dostępni: …". */
    listKomunikatorAgents?(): DelegateTargetAgent[];
    getActiveAgent(): { name?: string } | null | undefined;
    isKomunikatorVisible?(agent: DelegateTargetAgent): boolean;
    _emit(event: string, payload: Record<string, unknown>): void;
}

/** Minimalny widok pluginu: tylko `agentManager`. */
interface AgentDelegatePlugin {
    agentManager?: AgentDelegateManager | null;
}

export function createAgentDelegateTool() {
    return {
        name: 'agent_delegate',
        description: t('mcp.agent_delegate.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                to_agent: {
                    type: 'string',
                    description: t('mcp.agent_delegate.param.to_agent')
                },
                reason: {
                    type: 'string',
                    description: t('mcp.agent_delegate.param.reason')
                },
                context_summary: {
                    type: 'string',
                    description: t('mcp.agent_delegate.param.context_summary')
                }
            },
            // D14 (E2.4): context_summary WYMAGANY w schemacie — twarda reguła zamiast miękkiej
            // instrukcji w prompcie. Bez niego nowy agent nie ma kontekstu rozmowy (opis + param
            // to podkreślają). execute() i tak ma fallback ''=brak, więc kontrakt bezpieczny.
            required: ['to_agent', 'context_summary']
        },

        execute: async (args: AgentDelegateArgs, _app: unknown, plugin: AgentDelegatePlugin | null | undefined) => {
            try {
                const agentManager = plugin?.agentManager;
                if (!agentManager) {
                    return { success: false, error: t('mcp.agent_delegate.error.no_manager') };
                }

                // Validate recipient exists
                const toAgent = agentManager.getAgent(args.to_agent);
                if (!toAgent) {
                    // K6 (AUD-security-013): lista „dostępni" WYŁĄCZNIE z widocznych w
                    // komunikatorze — `getAllAgents()` wypisywało też duchy, czyli błąd
                    // narzędzia był darmową enumeracją agentów ukrytych przed pocztą.
                    const available = (agentManager.listKomunikatorAgents?.() ?? agentManager.getAllAgents())
                        .map(a => a.name).join(', ');
                    return {
                        success: false,
                        error: t('mcp.agent_delegate.error.not_found', { name: args.to_agent, available })
                    };
                }

                const fromName = (args?._invocationAgentName as string) || agentManager.getActiveAgent()?.name || 'System';

                // ── Kontekst do skrzynki adresata (K6, AUD-security-006/013) ──
                // Delegacja BYŁA drugą drogą do cudzej skrzynki: wołała `sendMessage` wprost,
                // więc omijała komplet bramek poczty (filtr ducha po stronie nadawcy,
                // rate-limit, licznik odbić). Teraz idzie przez `sendAgentMail`, czyli
                // DOKŁADNIE ten sam kod co `kom_send`.
                //
                // Odmowa bramki (duch po którejkolwiek stronie, wyczerpany limit, łańcuch
                // odbić) NIE wywraca delegacji: kontekst niesie sam proposal
                // (`context_summary` w wyniku), więc nic nie ginie — to zachowanie z S28 D6.
                if (!agentManager.komunikatorManager && args.context_summary) {
                    log.warn('AgentDelegateTool', `${t('mcp.agent_delegate.error.no_communicator')}`);
                }
                if (args.context_summary) {
                    // S28 (D2): store v3 — bez osobnego pola kontekstu (powód doklejamy do treści).
                    const body = args.reason
                        ? `${args.context_summary}\n\n${t('communicator.field.context')}: ${args.reason}`
                        : args.context_summary;
                    const mail = await sendAgentMail(plugin as unknown as KomPlugin, {
                        from: fromName,
                        to: args.to_agent as string,
                        subject: t('mcp.agent_delegate.msg.subject', { from: fromName }),
                        content: body,
                    });
                    // Event `communicator:message_sent` emituje już `sendAgentMail` (odbiorcy
                    // czytają samą nazwę zdarzenia), więc drugi raz go tu nie wypychamy.
                    if (!mail.success) {
                        log.warn('AgentDelegateTool', 'Kontekst nie trafil do skrzynki:', mail.error);
                    }
                }

                // Return delegation proposal - chat_view.js will render a button
                return {
                    success: true,
                    delegation: true,
                    to_agent: args.to_agent,
                    to_name: toAgent.name,
                    from_agent: fromName,
                    reason: args.reason || t('mcp.agent_delegate.msg.default_reason', { from: fromName }),
                    context_summary: args.context_summary || '',
                    message: t('mcp.agent_delegate.msg.proposal', { name: toAgent.name })
                };
            } catch (e) {
                // AUD-security-128: ten sam catch i ta sama klasa co w `delegate` — komunikat
                // idzie MODELOWI i do transkryptu. Wyjątek z zapisu poczty (adapter vaulta,
                // błąd I/O z pełną ścieżką systemową) albo z rozwiązania agenta wracał tędy
                // surowy, choć K8 (AUD-security-055) postawił maskę dokładnie na tę drogę
                // wewnątrz runnera subów.
                log.error('AgentDelegateTool', 'Error:', e);
                return { success: false, error: maskSensitiveData(String((e as Error)?.message ?? e)) };
            }
        }
    };
}
