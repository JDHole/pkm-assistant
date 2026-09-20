/**
 * @module register
 * Wiąże `buildCliCommands(deps)` z hostem Obsidiana (`Plugin#registerCliHandler`, API od
 * 1.12.2). Zero logiki komend tutaj - tylko okablowanie + straż wersji + odporność na duplikat.
 */

import { log } from '../../core/utils/Logger.js';
import { buildCliCommands } from './commands.js';

import type { CliHandler, CliFlags } from 'obsidian';
import type { CliDeps } from './commands.js';

/**
 * Powierzchnia hosta, jakiej potrzebuje rejestracja - `registerCliHandler` jest OPCJONALNE,
 * bo `manifest.json` ma `minAppVersion: 1.11.0` i NIE jest podbijany: Obsidian starszy niż
 * 1.12.2 po prostu nie ma tej metody, a plugin ma wtedy wstać normalnie, bez komend CLI.
 */
export interface CliHost {
    registerCliHandler?: (command: string, description: string, flags: CliFlags | null, handler: CliHandler) => void;
}

/** Wynik jednego przebiegu rejestracji - co się udało, czy hosta w ogóle stać na CLI, co padło. */
export interface RegisterCliCommandsResult {
    registered: string[];
    skipped: 'unsupported' | null;
    failed: Array<{ id: string; message: string }>;
}

/**
 * Rejestruje cztery komendy fali 1 na hoście. Brak `registerCliHandler` (Obsidian < 1.12.2)
 * kończy się CICHO (`skipped:'unsupported'`), bez rzucania - `src/main.ts` woła to z `onload()`
 * i awaria rejestracji CLI nie ma prawa wywrócić startu pluginu. Każda komenda rejestruje się w
 * OSOBNYM try/catch: `registerCliHandler` rzuca na duplikacie id, więc jedna nieudana rejestracja
 * (np. drugi reload w tej samej sesji Obsidiana) nie blokuje pozostałych trzech.
 */
export function registerCliCommands(host: CliHost, deps: CliDeps): RegisterCliCommandsResult {
    const handler = host.registerCliHandler;
    if (typeof handler !== 'function') {
        return { registered: [], skipped: 'unsupported', failed: [] };
    }

    const registered: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];

    for (const spec of buildCliCommands(deps)) {
        try {
            // P1: WOŁANE NA HOŚCIE (`handler.call(host, ...)`), NIGDY jako gołą funkcję.
            // Prawdziwa implementacja Obsidiana jest metodą prototypu, która czyta `this`
            // (`this.app.cli...`, `this.manifest.name`, `this.register(...)`) - odpięta referencja
            // (`const f = host.registerCliHandler; f(...)`) gubi `this` i rzuca TypeError na
            // KAŻDEJ komendzie w prawdziwym Obsidianie (fejkowy host jako strzałka tego nie widzi,
            // bo strzałki i tak nie mają własnego `this`).
            handler.call(host, spec.id, spec.description, spec.flags, spec.run);
            registered.push(spec.id);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            log.warn('CLI', `Rejestracja komendy "${spec.id}" padła, idę dalej: ${message}`);
            failed.push({ id: spec.id, message });
        }
    }

    return { registered, skipped: null, failed };
}
