import { Notice } from 'obsidian';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import { createSaveSessionCommand } from '../slash-commands/save_session.js';
import { runManualCompression } from './chat_ui.js';

// TS-any: widok czatu jest legacy composition root składanym dynamicznie z modułów mixinów.
type RuntimeView = any;
// AUD-dead-code-057/187 (2026-09-02): `SlashCommandContext` skasowany — zero referencji w całym
// repo, nawet lokalnie (`SlashCommand.handler` deklarował `(ctx: RuntimeView, raw: string)`, nie
// ten typ).
// AUD-dead-code-231 (2026-09-02): `export` zdjęty z `SlashCommand` — zero referencji spoza tego
// pliku (`SlashCommandsRegistry`/`createDefaultSlashCommands` są jedynym publicznym wejściem).
type SlashCommand = {
    name: string;
    description?: string;
    handler: (ctx: RuntimeView, raw: string) => unknown;
};

export class SlashCommandsRegistry {
    declare commands: Map<string, SlashCommand>;

    constructor() {
        this.commands = new Map();
    }

    register(command: SlashCommand | null | undefined): void {
        if (!command?.name || typeof command.handler !== 'function') return;
        this.commands.set(command.name.toLowerCase(), command);
    }

    get(name: unknown): SlashCommand | null {
        return this.commands.get(String(name || '').toLowerCase()) || null;
    }

    list(): SlashCommand[] {
        return [...this.commands.values()];
    }

    async execute(input: unknown, ctx: RuntimeView): Promise<boolean> {
        const raw = String(input || '').trim();
        const command = [...this.commands.values()]
            .sort((a, b) => b.name.length - a.name.length)
            .find(candidate => {
                const name = candidate.name.toLowerCase();
                const lower = raw.toLowerCase();
                return lower === name || lower.startsWith(`${name} `);
            });
        if (!command) return false;
        await command.handler(ctx, raw);
        return true;
    }
}

export function createDefaultSlashCommands(): SlashCommandsRegistry {
    const registry = new SlashCommandsRegistry();

    registry.register({
        name: '/clear',
        description: 'Start a new chat session.',
        handler: async ({ view }) => {
            view.handleNewSession();
            view.resetInputArea();
        }
    });

    registry.register({
        name: '/save',
        description: 'Save current session.',
        handler: async ({ view }) => {
            await view.handleSaveSession();
            view.resetInputArea();
        }
    });
    registry.register(createSaveSessionCommand());

    registry.register({
        name: '/memory',
        description: 'Consolidate current session into memory.',
        handler: async ({ view }) => {
            const agentMem = view.plugin?.agentManager?.getActiveMemory();
            const hasMsg = view.rollingWindow.messages.length >= 2;
            let hasDisk = false;
            if (agentMem) {
                try {
                    const unc = await agentMem.getUnconsolidatedSessions();
                    hasDisk = unc.length >= 1;
                } catch (e) {
                    // Odczyt z dysku (sesje nieskonsolidowane) może paść (brak pliku, race
                    // z zapisem). Fail-safe: zachowujemy się jak przy braku sesji na dysku
                    // (`hasDisk` zostaje `false`) zamiast wywalać komendę `/memory` — ale
                    // logujemy, bo cichy fallback bez śladu utrudniał diagnozę.
                    log.warn('Chat', `/memory: getUnconsolidatedSessions failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (hasMsg || hasDisk) {
                new Notice(t('chat.consolidating'));
                await view.consolidateSession();
                new Notice(t('chat.memory_saved'));
            } else {
                new Notice(t('chat.no_sessions'));
            }
            view.resetInputArea();
        }
    });

    registry.register({
        name: '/compress',
        description: 'Compress current chat context.',
        handler: async ({ view }) => {
            // AUD-code-review-053: rdzeń dzielony z guzikiem 🗜️ w chat_ui.ts (_renderSlimBar) —
            // patrz komentarz przy `runManualCompression` tam.
            await runManualCompression(view);
            view.resetInputArea();
        }
    });

    return registry;
}
