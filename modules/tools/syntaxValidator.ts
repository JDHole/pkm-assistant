import { parse } from 'acorn';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from 'yaml';

export type SyntaxKind = 'js' | 'json' | 'yaml' | 'markdown';
export type SyntaxProblem = { line: number; column: number; message: string; type: 'syntax' | 'duplicate_key' | 'limit'; path?: string; firstLine?: number };
export type SyntaxResult = { ok: boolean; kind: SyntaxKind; problems: SyntaxProblem[]; truncated: boolean; mode?: string };

export const MAX_SYNTAX_BYTES = 2 * 1024 * 1024;

export type MarkdownFence = { language: string; line: number; column: number; body: string; columns: number[]; unclosed: boolean };

/** Shared Markdown fence scan, preserving source positions for syntax diagnostics. */
export function scanMarkdownFences(text: string): MarkdownFence[] {
    const lines = text.split(/\r?\n/);
    let start = 0;
    if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
        if (end >= 0) start = end + 1;
    }
    const blocks: MarkdownFence[] = [];
    for (let i = start; i < lines.length; i++) {
        // Strip quote containers and list indentation while retaining each original column.
        const opening = /^( {0,3}(?:> ?)*(?: {0,3}(?:[-+*]|\d+[.)]) +| *)(?:> ?)* *)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
        if (!opening) continue;
        const prefix = opening[1], fence = opening[2];
        const quoteCount = (prefix.match(/>/g) ?? []).length;
        const indent = prefix.length;
        const strip = (line: string): number => {
            let n = 0;
            for (let q = 0; q < quoteCount; q++) {
                const part = /^ {0,3}> ?/.exec(line.slice(n));
                if (!part) return n;
                n += part[0].length;
            }
            while (n < line.length && line[n] === ' ' && n < indent) n++;
            return n;
        };
        let end = i + 1;
        const body: string[] = [], columns: number[] = [];
        while (end < lines.length) {
            const cut = strip(lines[end]);
            const rest = lines[end].slice(cut);
            if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(rest)) break;
            body.push(rest); columns.push(cut); end++;
        }
        blocks.push({ language: opening[3].trim().toLowerCase(), line: i + 1, column: indent + 1, body: body.join('\n'), columns, unclosed: end === lines.length });
        i = end;
    }
    return blocks;
}

export function checkSyntax(text: string, kind: SyntaxKind): SyntaxResult {
    const problems: SyntaxProblem[] = [];
    if (new TextEncoder().encode(text).length > MAX_SYNTAX_BYTES) return { ok: false, kind, problems: [{ line: 1, column: 1, message: 'Input exceeds 2 MB limit', type: 'limit' }], truncated: false };
    let count = 0;
    let mode: string | undefined;
    const add = (problem: SyntaxProblem) => { count++; if (problems.length < 20) problems.push(problem); };
    const js = (source: string, offset: number, functionOnly: boolean, columns: number[] = []) => {
        const modes = functionOnly ? ['async_function'] : ['script', 'module', 'async_function'];
        let best: { pos?: number; loc?: { line: number; column: number }; message?: string } = {};
        // Acorn only accepts a hashbang at offset zero; replace a leading BOM without shifting offsets.
        const normalized = source.replace(/^(\ufeff?)#![^\r\n]*/, match => ' '.repeat(match.length));
        for (const candidate of modes) {
            try {
                parse(normalized, { ecmaVersion: 'latest', sourceType: candidate === 'module' ? 'module' : 'script',
                    allowReturnOutsideFunction: candidate === 'async_function', allowAwaitOutsideFunction: candidate === 'async_function', allowHashBang: true });
                if (!functionOnly) mode = candidate;
                return;
            } catch (error) {
                const failure = error as typeof best;
                if ((failure.pos ?? 0) > (best.pos ?? -1)) best = failure;
            }
        }
        add({ line: offset + (best.loc?.line ?? 1), column: (best.loc?.column ?? 0) + 1 + (columns[(best.loc?.line ?? 1) - 1] ?? 0), message: (best.message ?? 'Syntax error').replace(/ \(\d+:\d+\)$/, '').slice(0, 120), type: 'syntax' });
    };
    const yaml = (source: string, offset: number) => {
        const counter = new LineCounter();
        const docs = parseAllDocuments(source, { lineCounter: counter, uniqueKeys: false, strict: true });
        for (const doc of docs) {
            for (const error of doc.errors) {
                const pos = counter.linePos(error.pos[0]);
                add({ line: offset + pos.line, column: pos.col, message: error.message.split('\n')[0].slice(0, 120), type: 'syntax' });
            }
            try { doc.toJS({ maxAliasCount: 100 }); } catch (error) {
                if (!/Unresolved alias/.test(String(error))) add({ line: offset + counter.linePos(doc.range?.[0] ?? 0).line, column: 1, message: 'YAML alias expansion limit exceeded', type: 'syntax' });
            }
            const fingerprint = (node: unknown, ancestors = new Set<object>()): string => {
                if (isAlias(node)) {
                    const resolved = node.resolve(doc);
                    return resolved ? fingerprint(resolved, ancestors) : 'unresolved-alias';
                }
                if (isScalar(node)) return JSON.stringify([typeof node.value, typeof node.value === 'number' ? String(node.value) : node.value]);
                if (!isMap(node) && !isSeq(node)) return 'null';
                if (ancestors.has(node)) return 'recursive';
                const next = new Set(ancestors); next.add(node);
                if (isSeq(node)) return JSON.stringify(['sequence', node.tag ?? '', node.items.map(item => fingerprint(item, next))]);
                return JSON.stringify(['map', node.tag ?? '', node.items.map(pair => [fingerprint(pair.key, next), fingerprint(pair.value, next)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
            };
            const walk = (node: unknown, path: string) => {
                if (isAlias(node)) {
                    if (!node.resolve(doc)) { const pos = counter.linePos(node.range?.[0] ?? 0); add({ line: offset + pos.line, column: pos.col, message: 'Unresolved alias', type: 'syntax' }); }
                } else if (isMap(node)) {
                    const seen = new Map<string, number>();
                    for (const pair of node.items) {
                        const key = pair.key;
                        if (!isScalar(key) && !isMap(key) && !isSeq(key) && !isAlias(key)) continue;
                        const name = isScalar(key) ? String(key.value) : '[complex key]';
                        if (isScalar(key) && key.value === '<<') { walk(pair.value, path); continue; }
                        if (isAlias(key)) walk(key, path);
                        const identity = fingerprint(key);
                        const keyPath = path ? `${path}.${name}` : name;
                        const pos = counter.linePos(key.range?.[0] ?? 0);
                        const firstLine = seen.get(identity);
                        if (firstLine !== undefined) add({ line: offset + pos.line, column: pos.col, message: 'Duplicate key', type: 'duplicate_key', path: keyPath, firstLine });
                        else seen.set(identity, offset + pos.line);
                        walk(pair.value, keyPath);
                    }
                } else if (isSeq(node)) node.items.forEach((item, index) => walk(item, `${path}[${index}]`));
            };
            walk(doc.contents, '');
        }
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
    } else if (kind === 'yaml') yaml(text, 0);
    else {
        const lines = text.split(/\r?\n/);
        if (lines[0]?.trim() === '---') {
            const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
            if (end < 0) add({ line: 1, column: 1, message: 'Unclosed frontmatter', type: 'syntax' });
            else { yaml(lines.slice(1, end).join('\n'), 1); }
        }
        for (const block of scanMarkdownFences(text)) {
            if (/^(dataviewjs|js|javascript)$/i.test(block.language)) js(block.body, block.line, true, block.columns);
            if (block.unclosed) add({ line: block.line, column: block.column, message: 'Unclosed code block', type: 'syntax' });
        }
    }
    return { ok: count === 0, kind, problems, truncated: count > problems.length, ...(mode ? { mode } : {}) };
}
