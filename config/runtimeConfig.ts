/**
 * `buildRuntimeConfig(deps)` — JEDYNE miejsce, w którym rejestrowani są dostawcy czatu
 * i embeddingu, klient HTTP, transport strumienia i komponent paska statusu.
 *
 * ⚠️ To TU powstaje klient HTTP oparty na `requestUrl` Obsidiana — NIE w `src/main.ts`
 * (pilnuje tego strażnik `src/main.test.ts`). Composition root buduje ten obiekt
 * w KONSTRUKTORZE pluginu i podaje TĘ SAMĄ referencję konstruktorowi runtime'u (C-02/C-03).
 *
 * PODZIAŁ TRANSPORTU (spec §0.4):
 *   • tor BEZ strumienia (`complete()`, katalogi modeli, embedding) → `ObsidianHttpClient`,
 *     bo `requestUrl` Obsidiana nie podlega CORS-om okna `app://obsidian.md`;
 *   • tor strumieniowy → `FetchStreamTransport` (`fetch` + `ReadableStream` + `AbortController`),
 *     bo `requestUrl` oddaje CAŁE ciało dopiero na końcu i strumienia z niego nie ma.
 *
 * ⚠️ Rejestry dostawców są ODDZIELNYMI kopiami map z modułów (`{ ...CHAT_PROVIDERS }`):
 * harness PODMIENIA w nich wpisy przed `onload()`, a mutacja mapy eksportowanej z modułu
 * przeciekłaby do każdego kolejnego bootu w tym samym procesie (scenariusze biegną seryjnie).
 */
import { requestUrl } from 'obsidian';

import { FetchStreamTransport, ObsidianHttpClient } from '../core/index.js';
import type { AppLike, LoggerLike, RuntimeConfig, StatusBarRenderer } from '../core/index.js';
import { CHAT_PROVIDERS } from '../modules/models/index.js';
import { EMBEDDING_PROVIDERS } from '../modules/embedding/index.js';
import { defaultSettings } from './defaultSettings.js';

export interface BuildRuntimeConfigDeps {
    app: AppLike;
    log?: LoggerLike;
    statusBar?: StatusBarRenderer;
}

export function buildRuntimeConfig(deps: BuildRuntimeConfigDeps): RuntimeConfig {
    // Referencja trzymana świadomie: `ObsidianHttpClient` dostaje `requestUrl` konstruktorem,
    // dzięki czemu `core/http/**` nie importuje `obsidian` i wstaje w gołym Node.
    const http = new ObsidianHttpClient(requestUrl);

    const config: RuntimeConfig = {
        chat: {
            providers: { ...CHAT_PROVIDERS },
            http,
            transport: new FetchStreamTransport(),
        },
        embedding: {
            providers: { ...EMBEDDING_PROVIDERS },
            // Ten sam klient co czat: embedding nie streamuje, a dwa klienty to dwa różne
            // zachowania na tym samym torze (limity, logi, maska sekretów).
            http,
        },
        defaults: defaultSettings(),
    };

    if (deps?.statusBar) config.statusBar = deps.statusBar;
    if (deps?.log) config.log = deps.log;
    return config;
}
