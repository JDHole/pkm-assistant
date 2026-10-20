import type { AgentLoopPartialSnapshot, AgentLoopStopReason } from '../agent-loop/index.js';
import type { EffectTarget, ToolEffect } from '../tools/index.js';

export type StopBy = 'user' | 'lead' | 'system';
export type RunEnd =
    | { kind: 'finished' }
    | { kind: 'limit'; reason: 'iteration-limit' | 'synthesis-budget' }
    | { kind: 'uncertain' }
    | { kind: 'stopped'; by: StopBy }
    | { kind: 'timeout' }
    | { kind: 'failed'; stage: 'work' | 'synthesis' };
export interface RunEffect extends Pick<ToolEffect, 'tool' | 'action' | 'targets'> {
    outcome: 'pending' | 'returned' | 'error' | 'unknown';
    cause?: AgentLoopStopReason['kind'];
    check: 'matches' | 'mismatch' | 'not-checked';
}
export interface RunOutcome {
    end: RunEnd;
    completeness: 'unconfirmed' | 'partial' | 'empty';
    hasAnswer: boolean;
    hasMaterial: boolean;
    effects: RunEffect[];
}
export interface ClassifyRunEndInput {
    stoppedBy?: 'natural' | 'backstop' | 'abort' | 'error';
    failed?: boolean;
    stopReason?: AgentLoopStopReason;
    finalText?: string;
    partial?: Pick<AgentLoopPartialSnapshot, 'synthesis'> | null;
    effects?: RunEffect[];
    successfulToolResults?: number;
    stoppedByActor?: StopBy;
}

export function classifyRunEnd(input: ClassifyRunEndInput): RunOutcome {
    let end: RunEnd;
    if (!input.stopReason) {
        if (input.failed || input.stoppedBy === 'error') end = { kind: 'failed', stage: 'work' };
        else if (input.stoppedBy === 'backstop') end = { kind: 'limit', reason: 'iteration-limit' };
        else if (input.stoppedBy === 'abort') end = { kind: 'stopped', by: input.stoppedByActor ?? 'user' };
        else end = { kind: 'finished' };
    } else {
        const reason = input.stopReason;
        switch (reason.kind) {
            case 'natural': end = { kind: 'finished' }; break;
            case 'iteration-limit': end = { kind: 'limit', reason: 'iteration-limit' }; break;
            case 'synthesis-budget': end = { kind: 'limit', reason: 'synthesis-budget' }; break;
            case 'tool-uncertain': end = { kind: 'uncertain' }; break;
            case 'manual-stop': end = { kind: 'stopped', by: input.stoppedByActor ?? 'user' }; break;
            case 'superseded': end = { kind: 'stopped', by: 'system' }; break;
            case 'task-timeout': end = { kind: 'timeout' }; break;
            case 'silence': case 'model-timeout': case 'transport-error': case 'model-error': case 'hook-error':
                end = { kind: 'failed', stage: reason.stage }; break;
            default: {
                const exhaustive: never = reason;
                void exhaustive;
                end = { kind: 'failed', stage: 'work' };
            }
        }
    }
    const effects = (input.effects ?? []).map((effect) => ({ ...effect, targets: effect.targets.map((target: EffectTarget) => ({ ...target })) }));
    const text = input.finalText?.trim() ?? '';
    const hasAnswer = !input.failed && text.length > 0 && (end.kind === 'finished' || input.partial?.synthesis === 'completed');
    const hasMaterial = hasAnswer || effects.some((effect) => effect.outcome === 'returned') || (input.successfulToolResults ?? 0) > 0;
    const completeness = end.kind === 'finished' && hasAnswer ? 'unconfirmed' : hasMaterial ? 'partial' : 'empty';
    return { end, completeness, hasAnswer, hasMaterial, effects };
}
