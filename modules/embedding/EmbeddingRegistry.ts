/**
 * modules/embedding/EmbeddingRegistry.ts — rozstrzyganie modelu domyślnego z ustawień (§8 kontraktu).
 *
 * Rejestr jest CZYTELNIKIEM ustawień i niczym więcej: nie ma stanu na dysku, nie dopisuje
 * kluczy, nie „leczy" niczego przy starcie. To nie jest ozdoba — obserwowany worek ustawień
 * planuje zapis na każdą mutację, więc jeden niewinny dopisek w getterze przepisywał userowi
 * przy KAŻDYM boocie plik z kluczami API.
 *
 * Druga zasada: fail-closed. Nie wybrano dostawcy albo wpisano nieznanego → `default === null`,
 * zero sieci, zero wyjątku. Żadnego zgadywania „a może coś chodzi na localhoście".
 */
import { EMBEDDING_PROVIDER_IDS } from './contracts.js';
import { EmbeddingModel } from './EmbeddingModel.js';
import { UnknownEmbeddingProviderError } from './embedErrors.js';
import type {
    EmbeddingProvider,
    EmbeddingProviderId,
    EmbeddingProviderInfo,
    EmbeddingRegistryDeps,
    EmbeddingSettingsSlice,
} from './contracts.js';

/** Rozstrzygnięcie ustawień: wszystko, czego potrzeba do zbudowania jednego modelu. */
interface ResolvedChoice {
    provider: EmbeddingProvider;
    providerId: EmbeddingProviderId;
    modelId: string;
    apiKey?: string;
    endpoint: string;
    batchSize?: number;
    timeoutMs?: number;
}

/** Niepusty tekst po obcięciu białych znaków, albo `undefined`. */
function text(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/** Liczba dodatnia i skończona, albo `undefined`. */
function positiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export class EmbeddingRegistry {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare private readonly _deps: EmbeddingRegistryDeps;
    /** Odcisk ustawień, z których powstał `_model` — zmiana odcisku unieważnia instancję. */
    declare private _fingerprint: string | null;
    declare private _model: EmbeddingModel | null;
    /** Nieznane id, o których już ostrzegaliśmy — log ma być śladem, nie strumieniem. */
    declare private readonly _warned: Set<string>;

    constructor(deps: EmbeddingRegistryDeps) {
        this._deps = deps;
        this._fingerprint = null;
        this._model = null;
        this._warned = new Set<string>();
    }

    /**
     * Model wynikający z ustawień usera albo `null`, gdy dostawca nie jest wybrany lub nieznany.
     *
     * Getter jest CZYSTY (nic nie zapisuje) i stabilny: przy niezmienionych ustawieniach oddaje
     * tę samą instancję, a zmiana dostawcy / modelu / klucza / adresu robi nową — bez restartu
     * pluginu, bo ustawienia czytamy leniwie, przy każdym odczycie.
     */
    get default(): EmbeddingModel | null {
        const choice = this._resolve();
        if (!choice) {
            this._fingerprint = null;
            this._model = null;
            return null;
        }

        const fingerprint = JSON.stringify([
            choice.providerId,
            choice.modelId,
            choice.apiKey ?? '',
            choice.endpoint,
            choice.batchSize ?? null,
            choice.timeoutMs ?? null,
        ]);

        if (this._model && this._fingerprint === fingerprint) return this._model;

        this._model = this._build(choice);
        this._fingerprint = fingerprint;
        return this._model;
    }

    /** `true`, gdy jest z czego liczyć wektory. */
    isConfigured(): boolean {
        return this.default !== null;
    }

    /**
     * Model wskazany wprost — z pominięciem wyboru usera, ale z jego kluczem i adresem.
     * Nieznany dostawca to błąd wołacza, więc leci rzutem, nie cichym `undefined`.
     */
    select(providerId: EmbeddingProviderId, modelId?: string): EmbeddingModel {
        const provider = this._providerFor(providerId);
        if (!provider) throw new UnknownEmbeddingProviderError(String(providerId));

        const slice = this._slice();
        return this._build({
            provider,
            providerId,
            modelId: text(modelId) ?? text(slice?.models?.[providerId]) ?? provider.info.defaultModel,
            apiKey: text(slice?.apiKeys?.[providerId]),
            endpoint: text(slice?.hosts?.[providerId]) ?? provider.info.defaultEndpoint,
            batchSize: positiveNumber(slice?.batchSize?.[providerId]),
            timeoutMs: positiveNumber(slice?.timeoutMs),
        });
    }

    /** Metryczki dostawców w kolejności, w jakiej user widzi je w Ustawieniach. */
    providers(): EmbeddingProviderInfo[] {
        const out: EmbeddingProviderInfo[] = [];
        for (const id of EMBEDDING_PROVIDER_IDS) {
            const provider = this._providerFor(id);
            // Kopia, żeby konsument (dropdown) nie miał uchwytu do metryczki rejestru.
            if (provider) out.push({ ...provider.info });
        }
        return out;
    }

    // ── Wnętrze ──────────────────────────────────────────────────────────────

    /** Wycinek ustawień embeddingu — czytany LENIWIE, nigdy nie zapamiętywany. */
    private _slice(): EmbeddingSettingsSlice | undefined {
        try {
            return this._deps.settings()?.pkmAssistant?.embedding ?? undefined;
        } catch {
            // Worek ustawień jeszcze nie wstał (albo proxy rzuciło) — to nie jest awaria
            // embeddingu, tylko „nie ma jeszcze czym liczyć".
            return undefined;
        }
    }

    private _providerFor(providerId: string): EmbeddingProvider | undefined {
        const providers = this._deps.providers as Partial<Record<string, EmbeddingProvider>> | undefined;
        return providers?.[providerId];
    }

    /** Wybór usera → komplet danych do budowy modelu, albo `null` (fail-closed). */
    private _resolve(): ResolvedChoice | null {
        const slice = this._slice();
        const providerId = text(slice?.provider);
        if (!providerId) return null;

        const provider = this._providerFor(providerId);
        if (!provider) {
            this._warnUnknown(providerId);
            return null;
        }

        const id = provider.info.id;
        return {
            provider,
            providerId: id,
            modelId: text(slice?.models?.[id]) ?? provider.info.defaultModel,
            apiKey: text(slice?.apiKeys?.[id]),
            endpoint: text(slice?.hosts?.[id]) ?? provider.info.defaultEndpoint,
            batchSize: positiveNumber(slice?.batchSize?.[id]),
            timeoutMs: positiveNumber(slice?.timeoutMs),
        };
    }

    private _build(choice: ResolvedChoice): EmbeddingModel {
        return new EmbeddingModel({
            provider: choice.provider,
            ctx: {
                modelId: choice.modelId,
                apiKey: choice.apiKey,
                endpoint: choice.endpoint,
                log: this._deps.log,
            },
            http: this._deps.http,
            batchSize: choice.batchSize,
            timeoutMs: choice.timeoutMs,
        });
    }

    private _warnUnknown(providerId: string): void {
        if (this._warned.has(providerId)) return;
        this._warned.add(providerId);
        try {
            this._deps.log.warn('embedding', `Nieznany dostawca embeddingu w ustawieniach: ${providerId} — semantyka wyłączona.`);
        } catch { /* log nie ma prawa wywalić odczytu ustawień */ }
    }
}
