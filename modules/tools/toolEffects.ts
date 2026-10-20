import { isToolAlias, resolveToolAlias } from './toolAliases.js';

export type EffectCheck = 'exists' | 'absent' | 'none';
export type EffectTargetKind = 'vault-file' | 'vault-folder' | 'memory-file' | 'message' | 'todo-list';

export interface EffectTarget {
    kind: EffectTargetKind;
    path?: string;
    id?: string;
}

export interface ToolEffect {
    tool: string;
    action: string;
    targets: EffectTarget[];
    check: EffectCheck;
}

export interface EffectTargetIo {
    exists(path: string, kind: EffectTargetKind): Promise<boolean>;
}

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : {};
}

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function effect(tool: string, action: string, targets: EffectTarget[], check: EffectCheck): ToolEffect {
    return { tool, action, targets, check };
}

// Narzędzia bez bezpośredniego skutku. `delegate` sam niczego nie zapisuje: ewentualne zapisy
// suba to jego własne, osobne wywołania narzędzi.
const READ_ONLY_TOOLS = new Set([
    'read', 'list', 'search', 'web_search', 'web_read', 'ask_user',
    'kom_list', 'kom_read', 'artifact_read', 'artifact_list', 'delegate',
]);

/** Opisuje oczekiwany stan po wywołaniu narzędzia bez wykonywania I/O. */
export function describeToolEffect(toolName: string, args: unknown, result?: unknown): ToolEffect | null {
    const input = asRecord(args);
    const output = asRecord(result);
    const alias = isToolAlias(toolName) ? resolveToolAlias(toolName, input) : null;
    const tool = alias?.name ?? toolName;
    const canonicalArgs = alias?.arguments ?? input;
    const path = stringField(canonicalArgs.path);

    if (READ_ONLY_TOOLS.has(tool)) return null;

    switch (tool) {
        case 'write': {
            const mode = stringField(canonicalArgs.mode) ?? 'replace';
            return effect(tool, mode, path ? [{ kind: 'vault-file', path }] : [], 'exists');
        }
        case 'delete':
            return effect(tool, 'delete', path ? [{ kind: 'vault-file', path }] : [], 'absent');
        case 'create_folder':
            return effect(tool, 'create_folder', path ? [{ kind: 'vault-folder', path }] : [], 'exists');
        case 'memory_save':
            if (canonicalArgs.ephemeral === true) {
                return effect(tool, 'save', [{ kind: 'memory-file', path: 'brain.md' }], 'none');
            }
            return effect(tool, 'save', stringField(output.path)
                ? [{ kind: 'memory-file', path: stringField(output.path) }]
                : [], 'exists');
        case 'memory_delete': {
            const targetPath = stringField(output.path);
            return effect(tool, 'delete', targetPath ? [{ kind: 'memory-file', path: targetPath }] : [],
                targetPath ? 'absent' : 'none');
        }
        case 'artifact_create':
            return stringField(output.path)
                ? effect(tool, 'create', [{ kind: 'vault-file', path: stringField(output.path) }], 'exists')
                : effect(tool, 'create', [], 'none');
        case 'artifact_update': {
            const target: EffectTarget = { kind: 'vault-file' };
            const id = stringField(canonicalArgs.id) ?? stringField(output.id);
            const outputPath = stringField(asRecord(output.artifact).path);
            if (id) target.id = id;
            if (outputPath) target.path = outputPath;
            return effect(tool, 'update', id || outputPath ? [target] : [], outputPath ? 'exists' : 'none');
        }
        case 'todo': {
            const action = stringField(canonicalArgs.action) ?? 'unknown';
            if (action === 'list') return null;
            if (['create', 'check', 'uncheck', 'add', 'finish'].includes(action)) {
                return effect(tool, action, [{ kind: 'todo-list' }], 'none');
            }
            return null;
        }
        case 'generate_image': {
            const targets: EffectTarget[] = [];
            const imagePath = stringField(output.path);
            const notePath = stringField(output.note_path);
            if (imagePath) targets.push({ kind: 'vault-file', path: imagePath });
            if (notePath) targets.push({ kind: 'vault-file', path: notePath });
            return effect(tool, 'generate', targets, targets.length === 2 ? 'exists' : 'none');
        }
        case 'add_text_to_image':
            return effect(tool, 'add_text', stringField(canonicalArgs.output_path)
                ? [{ kind: 'vault-file', path: stringField(canonicalArgs.output_path) }]
                : [], 'exists');
        case 'kom_send':
            return effect(tool, 'send', stringField(output.id)
                ? [{ kind: 'message', id: stringField(output.id) }]
                : [], 'none');
        case 'agent_delegate':
            return effect(tool, 'delegate', stringField(output.id)
                ? [{ kind: 'message', id: stringField(output.id) }]
                : [], 'none');
        default: {
            // Każda nazwa spoza listy bez skutku i spoza tabeli powyżej (narzędzia zewnętrznych
            // serwerów MCP z prefiksem `<serverId>__`, nowe narzędzie bez wpisu tutaj) dostaje
            // ostrożny opis: skutek nieznany, niesprawdzany. `null` znaczyłoby "brak skutku",
            // a tego dla nieznanego narzędzia nie wiemy.
            return effect(toolName, 'unknown', [], 'none');
        }
    }
}

/** Porównuje bieżący stan wszystkich sprawdzalnych celów z oczekiwanym stanem efektu. */
export async function checkEffectTargets(
    describedEffect: ToolEffect,
    io: EffectTargetIo,
): Promise<'matches' | 'mismatch' | 'not-checked'> {
    if (describedEffect.check === 'none' || describedEffect.targets.length === 0
        || describedEffect.targets.some(target => typeof target.path !== 'string' || target.path.length === 0)) return 'not-checked';

    try {
        for (const target of describedEffect.targets) {
            const path = target.path;
            if (!path) return 'not-checked';
            const exists = await io.exists(path, target.kind);
            if (describedEffect.check === 'exists' ? !exists : exists) return 'mismatch';
        }
        return 'matches';
    } catch {
        return 'not-checked';
    }
}
