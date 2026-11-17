import { parse } from 'acorn';

export type SyntaxKind = 'js' | 'json';
export type SyntaxProblem = { line: number; column: number; message: string; type: 'syntax' | 'duplicate_key' | 'limit'; path?: string; path_truncated?: boolean; message_truncated?: boolean; firstLine?: number };
export type SyntaxResult = { ok: boolean; kind: SyntaxKind; problems: SyntaxProblem[]; truncated: boolean; mode?: string; checked_blocks?: number; skipped_blocks?: number; note?: string };

export const syntaxByteLimit = (kind: SyntaxKind): number => (kind === 'js' ? 512 * 1024 : 2 * 1024 * 1024);
export const syntaxLimitMessage = (kind: SyntaxKind): string => `Input exceeds ${kind === 'js' ? '512 KiB JS' : '2 MiB JSON'} limit`;

export { scanMarkdownFences } from './markdownFences.js';

function utf8Size(text: string): number {
    let bytes = 0;
    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}

export function checkSyntax(text: string, kind: SyntaxKind, options: { shouldAbort?: () => boolean; parse?: typeof parse } = {}): SyntaxResult {
    const problems: SyntaxProblem[] = [];
    if (utf8Size(text) > syntaxByteLimit(kind)) return { ok: false, kind, problems: [{ line: 1, column: 1, message: syntaxLimitMessage(kind), type: 'limit' }], truncated: false };
    let count = 0;
    let mode: string | undefined;
    const add = (problem: SyntaxProblem) => {
        count++;
        if (problem.path && problem.path.length > 120) { problem.path = problem.path.slice(0, 120); problem.path_truncated = true; }
        if (problem.message.length > 120) { problem.message = problem.message.slice(0, 120); problem.message_truncated = true; }
        if (problems.length < 20) problems.push(problem);
    };
    const js = (source: string, offset: number, functionOnly: boolean, columns: number[] = []) => {
        const modes = functionOnly ? ['async_function'] : ['async_function', 'script', 'module'];
        let best: { pos?: number; loc?: { line: number; column: number }; message?: string } = {};
        const failures: Record<string, typeof best> = {};
        let bestRank = Infinity;
        const ranks: Record<string, number> = { script: 0, module: 1, async_function: 2 };
        // Acorn only accepts a hashbang at offset zero; replace a leading BOM without shifting offsets.
        const normalized = source.replace(/^(\ufeff?)#![^\r\n]*/, match => ' '.repeat(match.length));
        for (const candidate of modes) {
            if (options.shouldAbort?.()) throw new Error('Operation cancelled');
            const prefix = candidate === 'async_function' ? 'async function __syntax_check__() {\n' : '';
            const wrapped = prefix + normalized + (prefix ? '\n}' : '');
            try {
                const program = (options.parse ?? parse)(wrapped, { ecmaVersion: 'latest', sourceType: candidate === 'module' ? 'module' : 'script', allowHashBang: true });
                if (prefix && (program.body.length !== 1 || program.body[0].type !== 'FunctionDeclaration' || program.body[0].end !== wrapped.length)) {
                    throw Object.assign(new Error('Unexpected end of function body'), { pos: prefix.length + normalized.length, loc: { line: source.split('\n').length + 1, column: 0 } });
                }
                if (!functionOnly) mode = candidate;
                return;
            } catch (error) {
                if (error instanceof RangeError || (error instanceof Error && /stack (?:space|size)|too much recursion/i.test(error.message))) {
                    add({ line: 1, column: 1, message: 'JavaScript parser nesting limit exceeded', type: 'limit' });
                    return;
                }
                const failure = error as typeof best;
                const adjusted = prefix ? { ...failure, pos: Math.max(0, (failure.pos ?? 0) - prefix.length), loc: { line: Math.max(1, (failure.loc?.line ?? 1) - 1), column: failure.loc?.column ?? 0 }, message: failure.message } : failure;
                failures[candidate] = adjusted;
                const rank = ranks[candidate];
                if ((adjusted.pos ?? 0) > (best.pos ?? -1) || ((adjusted.pos ?? 0) === (best.pos ?? -1) && rank < bestRank)) { best = adjusted; bestRank = rank; }
            }
        }
        if (!functionOnly && failures.script && failures.module && failures.async_function && [failures.script, failures.module].every(failure => /(?:'return' outside of function|(?:keyword )?'await' outside (?:of |an async )?function)/.test(failure.message ?? ''))) best = failures.async_function;
        add({ line: offset + (best.loc?.line ?? 1), column: (best.loc?.column ?? 0) + 1 + (columns[(best.loc?.line ?? 1) - 1] ?? 0), message: (best.message ?? 'Syntax error').replace(/ \(\d+:\d+\)$/, ''), type: 'syntax' });
    };
    if (kind === 'js') js(text, 0, false);
    else if (kind === 'json') {
        let cursor = 0, line = 1, column = 1;
        type Frame = { kind: 'object' | 'array'; state: string; path: string; seen: Map<string, number>; index: number; key: string };
        const stack: Frame[] = [];
        let state = 'value';
        const advance = () => { const c = text[cursor++]; if (c === '\n') { line++; column = 1; } else column++; };
        const fail = (message: string): never => { throw Object.assign(new Error(message), { line, column }); };
        const space = () => { while (cursor < text.length && ' \t\r\n'.includes(text[cursor])) advance(); };
        const string = (): string => {
            const start = cursor; advance();
            while (cursor < text.length) {
                const c = text[cursor];
                if (c === '"') { advance(); return JSON.parse(text.slice(start, cursor)) as string; }
                if (c.charCodeAt(0) < 32) fail('Control character in string');
                if (c === '\\') {
                    advance();
                    if (cursor >= text.length) fail('Unterminated string');
                    if (!'"\\/bfnrtu'.includes(text[cursor])) fail('Invalid escape');
                    if (text[cursor] === 'u') { advance(); for (let i = 0; i < 4; i++) { if (!/[0-9a-fA-F]/.test(text[cursor] ?? '')) fail('Invalid escape'); advance(); } }
                    else advance();
                } else advance();
            }
            return fail('Unterminated string');
        };
        const complete = () => { if (!stack.length) state = 'done'; else stack[stack.length - 1].state = 'comma'; };
        try {
            while (true) {
                space();
                const frame = stack[stack.length - 1];
                if (!frame && state === 'done') { if (cursor < text.length) fail('Unexpected character'); break; }
                if (frame && frame.state === 'comma') {
                    if (text[cursor] === (frame.kind === 'object' ? '}' : ']')) { advance(); stack.pop(); complete(); continue; }
                    if (cursor >= text.length) fail('Unexpected end');
                    if (text[cursor] !== ',') fail('Unexpected character');
                    advance(); frame.state = frame.kind === 'object' ? 'keyAfterComma' : 'valueAfterComma'; continue;
                }
                if (frame && (frame.state === 'key' || frame.state === 'keyAfterComma')) {
                    if (text[cursor] === '}') { if (frame.state === 'keyAfterComma') fail('Trailing comma'); advance(); stack.pop(); complete(); continue; }
                    if (cursor >= text.length) fail('Unexpected end');
                    if (text[cursor] !== '"') fail('Unexpected character');
                    const loc = { line, column }; const key = string(); const firstLine = frame.seen.get(key);
                    frame.key = frame.path ? `${frame.path}.${key}` : key;
                    if (firstLine !== undefined) add({ ...loc, firstLine, path: frame.key, type: 'duplicate_key', message: 'Duplicate key' }); else frame.seen.set(key, loc.line);
                    space(); if (text[cursor] !== ':') fail(cursor >= text.length ? 'Unexpected end' : 'Unexpected character'); advance(); frame.state = 'value'; continue;
                }
                if (frame?.kind === 'array' && text[cursor] === ']') { if (frame.state === 'valueAfterComma') fail('Trailing comma'); advance(); stack.pop(); complete(); continue; }
                if (cursor >= text.length) fail('Unexpected end');
                const path = frame ? (frame.kind === 'object' ? frame.key : `${frame.path}[${frame.index++}]`) : '';
                const c = text[cursor];
                if (c === '{' || c === '[') {
                    if (stack.length >= 256) fail('JSON nesting depth limit exceeded');
                    advance(); stack.push({ kind: c === '{' ? 'object' : 'array', state: c === '{' ? 'key' : 'value', path, seen: new Map(), index: 0, key: '' }); continue;
                }
                if (c === '"') { string(); complete(); continue; }
                const numberOrLiteral = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
                numberOrLiteral.lastIndex = cursor;
                const match = numberOrLiteral.exec(text);
                if (!match) fail(c === '}' || c === ']' || c === ',' ? 'Missing value' : 'Unexpected character');
                for (let i = 0; i < match![0].length; i++) advance();
                complete();
            }
        } catch (error) {
            const problem = error as { line: number; column: number; message: string };
            add({ line: problem.line, column: problem.column, message: problem.message, type: problem.message === 'JSON nesting depth limit exceeded' ? 'limit' : 'syntax' });
        }
    }
    const result: SyntaxResult = { ok: count === 0, kind, problems, truncated: count > problems.length, ...(mode ? { mode } : {}) };
    // Reserve space for the tool's success envelope as well as JSON escaping.
    while (JSON.stringify(result).length > 15980 && problems.length) { problems.pop(); result.truncated = true; }
    return result;
}
