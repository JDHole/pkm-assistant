/**
 * modules/cli - public API (barrel).
 *
 * CLI Obsidiana (`Plugin#registerCliHandler`, API od 1.12.2): agenci zewnętrzni (Claude Code)
 * wołają `Obsidian.com pkm-assistant:<akcja> klucz=wartosc` i dostają JSON na stdout. Fala 1 =
 * WYŁĄCZNIE odczyt - żadna komenda nie zapisuje na dysk, nie woła modelu, nie zmienia
 * aktywnego agenta. Szczegóły kontraktu, tabela komend i gotchas: `CLAUDE.md` w tym folderze.
 *
 * `buildCliCommands` (z `commands.ts`) świadomie NIE jest w barrelu - jedyny konsument spoza
 * `register.ts` to testy tego samego modułu, które importują go wprost jako sibling.
 */
export { registerCliCommands } from './register.js';
export type { CliHost, RegisterCliCommandsResult } from './register.js';

export type {
    CliDeps,
    CliAgentManager,
    CliIndexStatus,
    CliCommandSpec,
    StatusData,
    AgentPromptData,
    MemoryStatusData,
} from './commands.js';

export type { CliEffect, CliErrorCode, CliResponse } from './response.js';
