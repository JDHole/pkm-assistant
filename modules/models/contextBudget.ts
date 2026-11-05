import { hostWindow } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import type { ModelInfo } from './contracts.js';

export type ContextWindow = Readonly<{ tokens: number; estimated: boolean; source: 'override' | 'catalog' | 'fallback' }>;
export type ContextBudgetModel = { providerId: string; modelId: string; listModels?: () => Promise<ModelInfo[]> };
export type ContextBudgetClock = {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
};
export type ContextBudgetSettings = {
    overrides?: Readonly<Record<string, Readonly<Record<string, number>>>>;
    fallbackTokens?: number;
};
const clock: ContextBudgetClock = {
    setTimeout: (fn, ms) => hostWindow.setTimeout(fn, ms),
    clearTimeout: handle => hostWindow.clearTimeout(handle as number),
};
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1;

/** Instance-scoped cache: never reuse a catalog from another endpoint/account. */
export class ContextBudgetResolver {
    private readonly cache = new WeakMap<ContextBudgetModel, Promise<ModelInfo[]>>();
    constructor(private readonly timer: ContextBudgetClock = clock) {}

    async resolve(model: ContextBudgetModel, settings: ContextBudgetSettings = {}): Promise<ContextWindow> {
        const explicit = settings.overrides?.[model.providerId]?.[model.modelId];
        if (positive(explicit)) return { tokens: Math.floor(explicit), estimated: false, source: 'override' };
        let catalog = this.cache.get(model);
        if (!catalog) {
            catalog = this.readCatalog(model);
            this.cache.set(model, catalog);
        }
        const tokens = (await catalog).find(entry => entry.id === model.modelId)?.max_input_tokens;
        if (positive(tokens)) return { tokens: Math.floor(tokens), estimated: false, source: 'catalog' };
        return { tokens: positive(settings.fallbackTokens) ? Math.floor(settings.fallbackTokens) : 32768, estimated: true, source: 'fallback' };
    }

    private async readCatalog(model: ContextBudgetModel): Promise<ModelInfo[]> {
        if (!model.listModels) return [];
        let handle: unknown;
        try {
            const timeout = new Promise<ModelInfo[]>(resolve => { handle = this.timer.setTimeout(() => resolve([]), 1500); });
            const result = await Promise.race([Promise.resolve().then(() => model.listModels!()), timeout]);
            return Array.isArray(result) ? result : [];
        } catch {
            log.debug('ContextBudget', 'Model catalog unavailable');
            return [];
        } finally { this.timer.clearTimeout(handle); }
    }
}

export const contextBudgetResolver = new ContextBudgetResolver();

/** Fixed estimate (no live calibration): JSON framing + non-ASCII weight + explicit caller margin. */
export function estimateContextTokens(value: unknown): number {
    const text = JSON.stringify(value) ?? '';
    let weight = text.length;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) weight++;
    return Math.ceil(weight / 3);
}
