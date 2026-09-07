/**
 * Fabryczne ustawienia pluginu w NOWYM kształcie (spec §4).
 *
 * Prowizjonuje kontenery, na których stoi reguła „boot nie pisze":
 * `pkmAssistant.chat = { platform:'', apiKeys:{}, models:{}, hosts:{}, temperature, maxTokens }`
 * oraz `pkmAssistant.embedding = { provider:'', models:{}, apiKeys:{}, hosts:{} }`.
 * Dzięki temu hydratacja sekretów na czterosegmentowej ścieżce niczego nie dotwarza.
 * `batchSize` i `timeoutMs` ZOSTAJĄ nieprowizjonowane.
 *
 * Do tego JEDEN klucz płaski: `defaultAutonomy`. Wszyscy jego czytelnicy i tak spadają na tę
 * samą stałą `DEFAULT_AUTONOMY`, więc efektywne zachowanie jest identyczne — ale suwak
 * autonomii w Ustawieniach ma wtedy co pokazać, a worek fabryczny mówi wprost, na jak ciasnym
 * trybie plugin startuje po utracie ustawień. Klucz istniał w starej fabryce i wraca tu
 * świadomie (clean-room, integracja F7).
 *
 * ⚠️ KAŻDE wywołanie oddaje ŚWIEŻY obiekt (mapy też). Worek defaultów wchodzi do
 * `RuntimeConfig.defaults`, a stamtąd do pancerza ustawień, który go merguje z tym,
 * co przyjechało z dysku — współdzielona mapa oznaczałaby, że ustawienie usera
 * wycieka do „fabrycznych" wartości następnego bootu (i do drugiego pluginu w testach).
 */
import type { SettingsBag } from '../core/index.js';
import { DEFAULT_AUTONOMY } from '../core/index.js';
import { DEFAULT_EMBEDDING_SETTINGS } from '../modules/embedding/index.js';

/** Suwak 0–1 w Ustawieniach → Modele (B.14 SE-12). */
export const DEFAULT_CHAT_TEMPERATURE = 0.7;
/** Globalny limit odpowiedzi — legacy, per platforma nadpisuje `pkmAssistant.maxTokens` (B.14 SE-13). */
export const DEFAULT_CHAT_MAX_TOKENS = 4096;

export function defaultSettings(): SettingsBag {
    return {
        pkmAssistant: {
            defaultAutonomy: DEFAULT_AUTONOMY,
            chat: {
                platform: '',
                apiKeys: {},
                models: {},
                hosts: {},
                temperature: DEFAULT_CHAT_TEMPERATURE,
                maxTokens: DEFAULT_CHAT_MAX_TOKENS,
            },
            embedding: {
                ...DEFAULT_EMBEDDING_SETTINGS,
                models: { ...DEFAULT_EMBEDDING_SETTINGS.models },
                apiKeys: { ...DEFAULT_EMBEDDING_SETTINGS.apiKeys },
                hosts: { ...DEFAULT_EMBEDDING_SETTINGS.hosts },
            },
        },
    };
}
