import { parseDelegatePlan } from '../../tools/index.js';
import { classifyRunEnd, parsePlanId } from '../index.js';
import type { ReservePlanInput, SubTaskRegistry, SubThreadOwner } from '../index.js';

export const planOwner = { agentName: 'Mira', sessionPath: 'plan.md', sessionEpoch: 'a'.repeat(32) };
export function planInput(owner: SubThreadOwner = planOwner, parentId?: string,
    nodes: Array<[string, string[]]> = [['C', ['A', 'B']], ['A', []], ['B', []]]): ReservePlanInput {
    const parsed = parseDelegatePlan({ tasks: nodes.map(([id, depends_on]) => ({ id, depends_on })) }, 20);
    const planId = parsePlanId('plan-p4');
    if (parsed.kind !== 'plan' || !planId) throw new Error('Invalid fixture');
    return { planId, graph: parsed.graph, owner, origin: owner, parentId, level: parentId ? 2 : 1, background: true,
        tasks: parsed.graph.map(node => ({ nodeId: node.nodeId, runId: node.nodeId, name: 'explorer', taskPreview: `Task ${node.nodeId}`,
            preparation: { kind: 'ready', threadId: node.nodeId, config: {} } })) };
}
export function activatePlanTask(registry: SubTaskRegistry, id: string, owner: SubThreadOwner = planOwner) {
    if (!registry.beginQueuedRun(id, owner, {})) throw new Error('Activation refused');
    return registry.create({ id, threadId: id });
}
export const planResult = (text = 'Full answer') => ({ text, toolsUsed: [], durationMs: 7, usage: null,
    stoppedBy: 'natural' as const, outcome: classifyRunEnd({ finalText: text }) });
