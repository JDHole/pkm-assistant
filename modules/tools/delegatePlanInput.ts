import { Validator } from '@cfworker/json-schema';
import { parsePlanNodeId } from '../sub-agents/index.js';
import type { DelegationGraph, PlanNodeId } from '../sub-agents/index.js';

export type ParsePlanResult =
    | { kind: 'legacy' }
    | { kind: 'plan'; graph: DelegationGraph }
    | { kind: 'invalid'; error: string };

// This boundary owns graph fields only. Task/aspect/context and trusted runtime fields
// stay with DelegateTool's existing argument validator; nothing is stripped or rewritten.
const validator = new Validator({
    type: 'object', properties: {
        tasks: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' } },
        } } },
    },
});
const invalid = (error: string): ParsePlanResult => ({ kind: 'invalid', error });

/** Validate the entire graph before any preparation, consent, reservation or execution. */
export function parseDelegatePlan(input: unknown, maxTasks: number): ParsePlanResult {
    if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) return invalid('maxTasks: expected a positive integer.');
    const validation = validator.validate(input);
    if (!validation.valid) {
        const issue = validation.errors[validation.errors.length - 1];
        return invalid(`${issue.instanceLocation || '#'}: ${issue.error}`);
    }
    const { tasks } = input as { tasks?: Array<{ id?: string; depends_on?: string[] }> }; // schema above
    if (!tasks) return { kind: 'legacy' };
    if (tasks.length > maxTasks) return invalid(`tasks: ${tasks.length} tasks exceed the configured limit ${maxTasks}.`);
    const hasEdges = tasks.some(task => (task.depends_on?.length ?? 0) > 0);
    const ids = new Set<PlanNodeId>();
    const graph: Array<{ nodeId: PlanNodeId; dependsOn: PlanNodeId[] }> = [];
    for (const [index, task] of tasks.entries()) {
        if (task.id === undefined && !hasEdges) continue;
        if (task.id === undefined) return invalid(`tasks[${index}].id: required when the plan has dependencies.`);
        const id = parsePlanNodeId(task.id);
        if (!id) return invalid(`tasks[${index}].id: expected 1–64 characters matching [A-Za-z0-9_-]+.`);
        if (ids.has(id)) return invalid(`tasks[${index}].id: duplicate id "${id}".`);
        ids.add(id);
        const dependencies: PlanNodeId[] = [];
        for (const [dependencyIndex, value] of (task.depends_on ?? []).entries()) {
            const dependency = parsePlanNodeId(value);
            const path = `tasks[${index}].depends_on[${dependencyIndex}]`;
            if (!dependency) return invalid(`${path}: expected 1–64 characters matching [A-Za-z0-9_-]+.`);
            if (dependencies.includes(dependency)) return invalid(`${path}: duplicate dependency "${dependency}".`);
            if (dependency === id) return invalid(`${path}: task "${id}" cannot depend on itself.`);
            dependencies.push(dependency);
        }
        graph.push({ nodeId: id, dependsOn: dependencies });
    }
    if (!hasEdges) return { kind: 'legacy' };
    for (const [index, node] of graph.entries()) {
        for (const dependency of node.dependsOn) {
            if (!ids.has(dependency)) return invalid(`tasks[${index}].depends_on: unknown id "${dependency}".`);
        }
    }
    const byId = new Map(graph.map(node => [node.nodeId, node]));
    const visited = new Set<PlanNodeId>();
    const path: PlanNodeId[] = [];
    const visit = (id: PlanNodeId): readonly PlanNodeId[] | undefined => {
        const cycleStart = path.indexOf(id);
        if (cycleStart !== -1) return [...path.slice(cycleStart), id];
        if (visited.has(id)) return undefined;
        path.push(id);
        for (const dependency of byId.get(id)!.dependsOn) {
            const cycle = visit(dependency);
            if (cycle) return cycle;
        }
        path.pop();
        visited.add(id);
        return undefined;
    };
    for (const node of graph) {
        const cycle = visit(node.nodeId);
        if (cycle) return invalid(`Cycle: ${cycle.join(' → ')}.`);
    }
    return { kind: 'plan', graph: Object.freeze(graph.map(node => Object.freeze({
        nodeId: node.nodeId, dependsOn: Object.freeze(node.dependsOn),
    }))) };
}
