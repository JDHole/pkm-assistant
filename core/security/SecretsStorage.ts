/**
 * SecretsStorage - local encrypted API key storage.
 *
 * v2.0 intentionally keeps one supported backend: a user-provided master
 * password deriving an AES-GCM key. Native Obsidian secret storage can return in
 * v2.1 after its public API and at-rest guarantees are verified.
 */

import { MASTER_PASSWORD_MIN_LENGTH } from './masterPasswordPolicy.js';
import { hostWindow } from '../utils/hostWindow.js';

// Prefiks id NOWYCH sekretów. Stare id `obsek-*` żyją dalej w mapie
// `settings.pkmAssistant.secureStorage.refs` u userów i są w pełni poprawne —
// odszyfrowanie idzie po refs, nie po tym prefiksie (S35).
const DEFAULT_NAMESPACE = 'pkm-assistant';

/** Zaszyfrowany sekret zapisany w ustawieniach (wszystko base64). */
export interface EncryptedSecret {
    salt: string;
    iv: string;
    data: string;
}

/** Slice `settings.pkmAssistant.secureStorage`. */
export interface SecureStorageSlice {
    enabled?: boolean;
    backend?: string;
    masterSalt?: string;
    /** fieldPath → id sekretu (stare id `obsek-*` żyją tu dalej, patrz nagłówek pliku). */
    refs?: Record<string, string>;
    /** id sekretu → zaszyfrowana wartość. */
    encrypted?: Record<string, EncryptedSecret>;
}

/**
 * Ustawienia pluginu widziane przez sejf. Index signature jest tu ISTOTNA: ścieżki
 * z `SECRET_FIELD_PATHS` są kropkowane i rozwiązywane dynamicznie (`getPath`).
 */
export interface SecretsSettings {
    pkmAssistant?: { secureStorage?: SecureStorageSlice; [key: string]: unknown };
    [key: string]: unknown;
}

/** Klucz wyprowadzony z hasła głównego + sól, w której go wyprowadzono (base64). */
export interface PasswordKey {
    key: CryptoKey;
    salt: string;
}

/** Raport z `hydrateSettings` — ile kluczy wróciło do pamięci i czego zabrakło. */
export interface HydrateStatus {
    hydrated: number;
    missing: string[];
    locked: boolean;
    errors: Array<{ fieldPath: string; message: string }>;
}

/** Opcje konstruktora. */
export interface SecretsStorageOptions {
    namespace?: string;
}

/** Minimalny kształt błędu w `catch` (err jest `unknown`). */
type ErrLike = { message?: string };

/** Skrót na „dowolny obiekt" — potrzebny przy chodzeniu po ścieżkach kropkowanych. */
type AnyRecord = Record<string, unknown>;

// AUD-dead-code-116/177 (2026-09-02): zdjęty `export` — zero konsumentów poza tym plikiem
// (był reeksportowany z core/index.ts, ale nikt spoza core/ po niego nie sięgał).
const SECRET_FIELD_PATHS: string[] = [
    'pkmAssistant.chat.apiKeys.anthropic',
    'pkmAssistant.chat.apiKeys.openai',
    'pkmAssistant.chat.apiKeys.deepseek',
    'pkmAssistant.chat.apiKeys.gemini',
    'pkmAssistant.chat.apiKeys.groq',
    'pkmAssistant.chat.apiKeys.xai',
    'pkmAssistant.chat.apiKeys.open_router',
    'pkmAssistant.embedding.apiKeys.openai',
    'pkmAssistant.embedding.apiKeys.ollama',
    'pkmAssistant.embedding.apiKeys.lm_studio',
    'pkmAssistant.embedding.apiKeys.gemini',
    // Web Search: klucz per dostawca (E3.3). Stare wspólne `apiKey` ZOSTAJE na liście —
    // user, który go nie przeklikał, dalej ma go schowanego w sejfie.
    'pkmAssistant.webSearch.apiKey',
    'pkmAssistant.webSearch.apiKeys.jina',
    'pkmAssistant.webSearch.apiKeys.tavily',
    'pkmAssistant.webSearch.apiKeys.brave',
    'pkmAssistant.webSearch.apiKeys.serper',
    'pkmAssistant.imageGen.stability_api_key',
    'pkmAssistant.imageGen.replicate_api_key',
    'pkmAssistant.stt.deepgram_api_key',
    'pkmAssistant.stt.assemblyai_api_key',
];

export class SecretsStorage {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare app: unknown;
    declare namespace: string;
    declare passwordKey: PasswordKey | null;

    constructor(app: unknown, options: SecretsStorageOptions = {}) {
        this.app = app;
        this.namespace = options.namespace || DEFAULT_NAMESPACE;
        this.passwordKey = null;
    }

    get backend(): 'master-password' | 'unavailable' {
        if (this._crypto()) return 'master-password';
        return 'unavailable';
    }

    // WebCrypto przez `hostWindow` (Obsidian: window, Node: globalThis) — ten plik jest node-safe (testowany wprost
    // przez AVA, `security_hardening.test.ts`) w gołym Node, gdzie `window` nie istnieje, ale
    // `hostWindow.crypto` tak (Node ma natywne WebCrypto pod `globalThis`, tak samo jak
    // przeglądarka/Electron renderer).
    _crypto(): SubtleCrypto | null {
        return hostWindow.crypto?.subtle || null;
    }

    makeSecretId(fieldPath: string): string {
        return `${this.namespace}-${fieldPath}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    /**
     * @param id - `unknown`, bo metoda sama waliduje kształt i rzuca własnym błędem
     * @param value - jw.
     * @param settings
     */
    async setSecret(
        id: unknown,
        value: unknown,
        settings: SecretsSettings | null = null,
    ): Promise<{ backend: string; id: string }> {
        if (!id || typeof id !== 'string') throw new Error('Secret id is required');
        if (typeof value !== 'string') throw new Error('Secret value must be a string');

        if (!settings) throw new Error('Settings object required for master-password fallback');
        if (!this._crypto()) throw new Error('Secure storage unavailable: Web Crypto API missing');
        if (!this.passwordKey) throw new Error('SecretsStorage is locked');
        const encrypted = await this.encryptWithPassword(value);
        const secure = ensureSecureStorage(settings);
        secure.encrypted = secure.encrypted || {};
        secure.encrypted[id] = encrypted;
        return { backend: 'master-password', id };
    }

    async getSecret(id: unknown, settings: SecretsSettings | null = null): Promise<string | null> {
        if (!id || typeof id !== 'string') return null;

        if (!settings || !this.passwordKey) return null;
        const encrypted = settings?.pkmAssistant?.secureStorage?.encrypted?.[id];
        if (!encrypted) return null;
        return this.decryptWithPassword(encrypted);
    }

    /**
     * @param password
     * @param saltBase64 - brak / `null` / `undefined` = losujemy nową sól (kod pyta o samą
     *   „prawdziwość", więc typ obejmuje oba kształty pustki)
     */
    async unlock(password: string, saltBase64: string | null | undefined = null): Promise<{ salt: string }> {
        if (!this._crypto()) throw new Error('Secure storage unavailable: Web Crypto API missing');
        if (!password || password.length < MASTER_PASSWORD_MIN_LENGTH) {
            throw new Error(`Master password must have at least ${MASTER_PASSWORD_MIN_LENGTH} characters`);
        }
        const salt = saltBase64 ? base64ToBytes(saltBase64) : crypto.getRandomValues(new Uint8Array(16));
        this.passwordKey = await derivePasswordKey(password, salt);
        return { salt: bytesToBase64(salt) };
    }

    lock(): void {
        this.passwordKey = null;
    }

    // Fix znaleziska TS-1 #5: bramka zamkniętego sejfu żyła TYLKO u wołaczy (`setSecret`,
    // `getSecret`) — wywołanie wprost dawało gołe TypeError na `null.key`. Teraz obie metody
    // bronią się same (ten sam komunikat co u wołacza), a zawężenie zastępuje rzutowania.
    async encryptWithPassword(value: string): Promise<EncryptedSecret> {
        const key = this.passwordKey;
        if (!key) throw new Error('SecretsStorage is locked');
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(value);
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key.key, encoded);
        return {
            salt: key.salt,
            iv: bytesToBase64(iv),
            data: bytesToBase64(new Uint8Array(data)),
        };
    }

    async decryptWithPassword(encrypted: EncryptedSecret | null | undefined): Promise<string | null> {
        if (!encrypted?.iv || !encrypted?.data) return null;
        const key = this.passwordKey;
        if (!key) throw new Error('SecretsStorage is locked');
        const iv = base64ToBytes(encrypted.iv);
        const data = base64ToBytes(encrypted.data);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key.key, data);
        return new TextDecoder().decode(decrypted);
    }

    async migratePlainSettings(settings: SecretsSettings): Promise<SecureStorageSlice> {
        const secure = ensureSecureStorage(settings);
        secure.enabled = true;
        secure.backend = this.backend;
        secure.refs = secure.refs || {};

        for (const fieldPath of SECRET_FIELD_PATHS) {
            const value = getPath(settings, fieldPath);
            if (!value || typeof value !== 'string') continue;
            const id = secure.refs[fieldPath] || this.makeSecretId(fieldPath);
            await this.setSecret(id, value, settings);
            secure.refs[fieldPath] = id;
            deletePath(settings, fieldPath);
            defineRuntimeSecret(settings, fieldPath, value);
        }

        return secure;
    }

    async hydrateSettings(settings: SecretsSettings): Promise<HydrateStatus> {
        const refs = settings?.pkmAssistant?.secureStorage?.refs || {};
        const status: HydrateStatus = { hydrated: 0, missing: [], locked: false, errors: [] };
        if (Object.keys(refs).length > 0 && !this.passwordKey) status.locked = true;

        for (const [fieldPath, id] of Object.entries(refs)) {
            let value = null;
            try {
                value = await this.getSecret(id, settings);
            } catch (error) {
                // `err` w catch jest `unknown` — dochodzi sama asercja, wyrażenie bez zmian.
                status.errors.push({ fieldPath, message: (error as ErrLike)?.message || String(error) });
            }
            if (value) {
                defineRuntimeSecret(settings, fieldPath, value);
                status.hydrated += 1;
            } else {
                status.missing.push(fieldPath);
            }
        }
        return status;
    }
}

function ensureSecureStorage(settings: SecretsSettings): SecureStorageSlice {
    if (!settings.pkmAssistant) settings.pkmAssistant = {};
    if (!settings.pkmAssistant.secureStorage) settings.pkmAssistant.secureStorage = {};
    return settings.pkmAssistant.secureStorage;
}

// Trzy helpery chodzą po ścieżkach kropkowanych (`chatModel.openai_api_key`) —
// stąd asercje na `AnyRecord`: struktura jest znana dopiero w runtime.
function getPath(root: unknown, dotted: string): unknown {
    return dotted.split('.').reduce((obj: unknown, key) => (obj as AnyRecord | null | undefined)?.[key], root);
}

function deletePath(root: unknown, dotted: string): void {
    const parts = dotted.split('.');
    const key = parts.pop() as string;
    const parent = parts.reduce((obj: unknown, part) => (obj as AnyRecord | null | undefined)?.[part], root) as AnyRecord | undefined;
    if (parent && Object.prototype.hasOwnProperty.call(parent, key)) delete parent[key];
}

function defineRuntimeSecret(root: unknown, dotted: string, value: string): void {
    const parts = dotted.split('.');
    const key = parts.pop() as string;
    let parent = root as AnyRecord;
    for (const part of parts) {
        if (!parent[part]) parent[part] = {};
        parent = parent[part] as AnyRecord;
    }
    Object.defineProperty(parent, key, {
        value,
        enumerable: false,
        configurable: true,
        writable: true,
    });
}

async function derivePasswordKey(password: string, salt: Uint8Array): Promise<PasswordKey> {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
    return { key, salt: bytesToBase64(salt) };
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
