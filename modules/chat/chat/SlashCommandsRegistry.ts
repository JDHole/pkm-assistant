import { Notice } from 'obsidian';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import { createSaveSessionCommand } from '../slash-commands/save_session.js';
import { runManualCompression } from './chat_ui.js';

import type { SlashCommandContext } from './chatViewShape.js';

/** Jedna komenda `/` — eksportowana, bo pasek inputu renderuje z niej listę podpowiedzi. */
export type SlashCommand = {
    name: string;
    description?: string;
    handler: (ctx: SlashCommandContext, raw: string) => unknown;
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

    get(name: string): SlashCommand | null {
        return this.commands.get(name.toLowerCase()) || null;
    }

    list(): SlashCommand[] {
        return [...this.commands.values()];
    }

    async execute(input: string, ctx: SlashCommandContext): Promise<boolean> {
        const raw = input.trim();
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

function guardedInputReset(view: SlashCommandContext['view'], raw: string): () => void {
    const tab = view.chatTabs.find(item => item.isActive);
    const value = view.input_area.value;
    return () => {
        if (tab && view.chatTabs.find(item => item.isActive) === tab
            && value.trim() === raw && view.input_area.value === value) view.resetInputArea();
    };
}

export function createDefaultSlashCommands(): SlashCommandsRegistry {
    const registry = new SlashCommandsRegistry();

    registry.register({
        name: '/clear',
        description: 'Start a new chat session.',
        handler: async ({ view }) => {
            void view.handleNewSession();
            view.resetInputArea();
        }
    });

    registry.register({
        name: '/save',
        description: 'Save current session.',
        handler: async ({ view }, raw) => {
            const reset = guardedInputReset(view, raw);
            await view.handleSaveSession();
            reset();
        }
    });
    registry.register(createSaveSessionCommand());

    registry.register({
        name: '/memory',
        description: 'Consolidate current session into memory.',
        handler: async ({ view }, raw) => {
            const reset = guardedInputReset(view, raw);
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
            reset();
        }
    });

    registry.register({
        name: '/compress',
        description: 'Compress current chat context.',
        handler: async ({ view }, raw) => {
            const reset = guardedInputReset(view, raw);
            // Rdzeń dzielony z guzikiem 🗜️ w chat_ui.ts (_renderSlimBar) - patrz komentarz przy
            // `runManualCompression` tam.
            await runManualCompression(view);
            reset();
        }
    });

    return registry;
}
