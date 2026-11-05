import type { ReasoningEffort } from './contracts.js';

export function effortBudget(effort: ReasoningEffort): number {
    return { low: 1024, medium: 4096, high: 8192 }[effort];
}

export function supportsEffort(provider: string, model: string): boolean {
    if (['open_router', 'lm_studio'].includes(provider)) return true;
    if (provider === 'ollama') return /^(?:[^/]+\/)?(?:gpt-oss|qwen3(?:\.5)?|deepseek-r1)(?::|$)/i.test(model);
    if (provider === 'anthropic') return /^claude-(?:3-7-|(?:opus|sonnet|haiku|fable|mythos)-[4-9](?:[-.\x2f]|$))/i.test(model);
    if (provider === 'openai') return /^(?:o[1-9](?:[0-9]*)(?:[-.]|$)|gpt-(?:[5-9]|[1-9][0-9]+)(?:[.-]|$)|gpt-oss(?:[-:]|$))/i.test(model);
    if (provider === 'gemini') return /^(models\/)?gemini-(2\.5|[3-9])/i.test(model);
    if (provider === 'deepseek') return /^(deepseek-flash|deepseek-v4-pro)$/.test(model);
    if (provider === 'xai') return /^grok-4[.-][567](?:$|[-.])/.test(model);
    if (provider === 'groq') return /^(openai\/gpt-oss-(20b|120b)|qwen\/qwen3\.8-27b)$/.test(model);
    return false;
}
