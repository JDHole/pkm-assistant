export type SubAgentCallView = 'block' | 'chip';

/** Wspólna klasyfikacja wywołania w placeholderze, wyniku i odtworzonej historii. */
export function subAgentCallView(
    toolName: string,
    args: { action?: unknown } | null | undefined,
    result: Record<string, unknown> | null | undefined,
    phase: 'pending' | 'result',
): SubAgentCallView {
    if (toolName === 'delegate') return 'block';
    if (toolName !== 'sub_agent' || args?.action !== 'task') return 'chip';
    if (phase === 'pending') return 'block';
    const hasBlockingOutcome = (result?.success === true || result?.success === false)
        && result !== null
        && result !== undefined
        && 'outcome' in result;
    return result?.started === true || hasBlockingOutcome ? 'block' : 'chip';
}
