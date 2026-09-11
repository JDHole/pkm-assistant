/**
 * `modules/models/ModelRequestError.ts` - `NormalizedError` jako prawdziwy `Error`.
 *
 * Walidator katalogu Obsidiana (`@typescript-eslint/only-throw-error`) nie akceptuje `throw`
 * na gołym obiekcie - a `ChatModel._completeOnce()` od zawsze rzucał `NormalizedError` (kształt
 * `{ message, code, details, http_status }`, patrz `core/utils/errorUtils.ts`) bo TO jest
 * kontrakt, na którym stoi `modules/agent-loop` i konsumenci wyżej. `NormalizedError` sam
 * ZOSTAJE gołym interfejsem (kontrakt 12 adapterów - nie ruszać); ta klasa jest cienkim
 * opakowaniem `throw`-owalnym w `Error`, nie nowym kształtem danych.
 *
 * Zgodność z dotychczasowym gołym obiektem (żeby `{...err}`, `Object.keys(err)`,
 * `JSON.stringify(err)` dawały te same pola co wcześniej):
 *  - `message` jest WŁASNĄ, ENUMEROWALNĄ własnością - `Error`'owy konstruktor ustawia ją
 *    NIEenumerowalną (`super(message)`), więc nadpisujemy `defineProperty` zaraz potem;
 *  - `code` / `details` / `http_status` to zwykłe pola instancji (enumerowalne z definicji);
 *  - `toJSON()` oddaje DOKŁADNIE `{ message, code, details, http_status }` - nic więcej;
 *  - `name` CELOWO NIE jest własną własnością (zostaje odziedziczone z `Error.prototype`),
 *    żeby JSON/Object.keys nie dostały nowego pola, którego stary obiekt nie miał.
 */
import { normalizeError, maskSensitiveData } from '../../core/index.js';
import type { NormalizedError } from './contracts.js';

export class ModelRequestError extends Error implements NormalizedError {
    readonly code: string;
    readonly details?: unknown;
    readonly http_status: number | null;

    constructor(normalized: NormalizedError) {
        super(normalized.message);
        // `super(message)` zostawia `message` NIEenumerowalnym - stary goły obiekt miał je
        // zwykłym, enumerowalnym polem. Bez tego `{...err}`/`Object.keys(err)` zgubiłyby message.
        Object.defineProperty(this, 'message', {
            value: normalized.message,
            enumerable: true,
            writable: true,
            configurable: true,
        });
        this.code = normalized.code;
        this.details = normalized.details;
        this.http_status = normalized.http_status;
    }

    /** `JSON.stringify(err)` ma dać identyczny tekst jak dla dawnego gołego obiektu. */
    toJSON(): NormalizedError {
        return { message: this.message, code: this.code, details: this.details, http_status: this.http_status };
    }

    /**
     * Granica `throw`: cokolwiek wpadnie, wychodzi instancją tej klasy.
     * Już-instancja przechodzi PRZEZ TĘ SAMĄ referencję (nie podwaja opakowania, nie gubi pól).
     * `Error`/`string` idą przez maskę sekretów PRZED normalizacją - lokalny odpowiednik
     * `toConsumerError` z `ChatModel.ts` (ten jest prywatny temu plikowi, więc nie da się go
     * zaimportować bez cyklu) - komunikat `fetch` potrafi nieść cały adres, a w nim klucz.
     * Cokolwiek innego (już znormalizowany kształt, `null`, cokolwiek) idzie prosto przez
     * `normalizeError`, ten sam kanon, którym dziś stoi cała normalizacja błędów modeli.
     */
    static from(x: unknown): ModelRequestError {
        if (x instanceof ModelRequestError) return x;
        const text = x instanceof Error ? x.message : typeof x === 'string' ? x : '';
        const safe = maskSensitiveData(text).trim();
        return new ModelRequestError(normalizeError(safe || x));
    }
}
