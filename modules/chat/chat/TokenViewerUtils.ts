export function formatTokenCount(n: unknown): string {
    const value = Number(n) || 0;
    if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 1000000 ? 0 : 1)}k`;
    return String(Math.round(value));
}

export function getContextLevel(percent: number): 'critical' | 'hot' | 'warm' | 'calm' {
    if (percent >= 90) return 'critical';
    if (percent >= 70) return 'hot';
    if (percent >= 50) return 'warm';
    return 'calm';
}

export function estimateContextWindow({ role = 'main', platform = '', model = '', fallback = 200000 } = {}) {
    const key = `${platform}/${model}`.toLowerCase();
    if (key.includes('grok-4-fast')) return 2000000;
    if (key.includes('grok-4')) return 256000;
    if (key.includes('gemini-2.5')) return 1048576;
    if (key.includes('gpt-5')) return 400000;
    if (key.includes('claude')) return 200000;
    if (key.includes('llama-3.3')) return 131072;
    if (key.includes('deepseek-v4')) return 64000;
    if (role === 'minion' || role === 'master') return 200000;
    return fallback;
}
