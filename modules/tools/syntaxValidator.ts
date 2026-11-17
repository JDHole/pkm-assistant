import { parse } from 'acorn';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from 'yaml';

export type SyntaxKind = 'js' | 'json' | 'yaml' | 'markdown';
export type SyntaxProblem = { line: number; column: number; message: string; type: 'syntax' | 'duplicate_key'; path?: string; firstLine?: number };
export type SyntaxResult = { ok: boolean; kind: SyntaxKind; problems: SyntaxProblem[]; truncated: boolean; mode?: string };

export function checkSyntax(text: string, kind: SyntaxKind): SyntaxResult {
    const problems: SyntaxProblem[] = [];
    let count = 0;
    let mode: string | undefined;
    const add = (problem: SyntaxProblem) => { count++; if (problems.length < 20) problems.push(problem); };
    const js = (source: string, offset: number, functionOnly: boolean) => {
        const modes = functionOnly ? ['async_function'] : ['script', 'module', 'async_function'];
        let last: { loc?: { line: number; column: number }; message?: string } = {};
        for (const candidate of modes) {
            try {
                const prefix = candidate === 'async_function' ? 'async function __check__(){\n' : '';
                parse(prefix + source + (prefix ? '\n}' : ''), { ecmaVersion: 'latest', sourceType: candidate === 'module' ? 'module' : 'script' });
                if (!functionOnly) mode = candidate;
                return;
            } catch (error) { last = error as typeof last; }
        }
        const line = Math.max(1, (last.loc?.line ?? 1) - 1);
        add({ line: offset + line, column: (last.loc?.column ?? 0) + 1, message: (last.message ?? 'Syntax error').replace(/ \(\d+:\d+\)$/, '').slice(0, 120), type: 'syntax' });
    };
    const yaml = (source: string, offset: number) => {
        const counter = new LineCounter();
        const docs = parseAllDocuments(source, { lineCounter: counter, uniqueKeys: false, strict: true });
        for (const doc of docs) {
            for (const error of doc.errors) {
                const pos = counter.linePos(error.pos[0]);
                add({ line: offset + pos.line, column: pos.col, message: error.message.split('\n')[0].slice(0, 120), type: 'syntax' });
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
                if (isMap(node)) {
                    const seen = new Map<string, number>();
                    for (const pair of node.items) {
                        const key = pair.key;
                        if (!isScalar(key) && !isMap(key) && !isSeq(key) && !isAlias(key)) continue;
                        const name = isScalar(key) ? String(key.value) : '[complex key]';
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
        let cursor = 0;
        const position = (at: number) => { const lines = text.slice(0, at).split('\n'); return { line: lines.length, column: lines[lines.length - 1].length + 1 }; };
        const fail = (): never => { throw new Error('Invalid JSON syntax'); };
        const space = () => { while (/[ \t\r\n]/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
        const string = (): string => {
            const start = cursor;
            if (text[cursor++] !== '"') return fail();
            while (cursor < text.length) {
                const char = text[cursor++];
                if (char === '"') {
                    try { return JSON.parse(text.slice(start, cursor)) as string; } catch { return fail(); }
                }
                if (char === '\\') cursor++;
                else if (char.charCodeAt(0) < 32) return fail();
            }
            return fail();
        };
        const value = (path: string): void => {
            space();
            if (text[cursor] === '{') {
                cursor++; space(); const seen = new Map<string, number>();
                if (text[cursor] === '}') { cursor++; return; }
                while (true) {
                    space(); const start = cursor; const key = string(); const loc = position(start);
                    const keyPath = path ? `${path}.${key}` : key;
                    const firstLine = seen.get(key);
                    if (firstLine !== undefined) add({ ...loc, firstLine, path: keyPath, type: 'duplicate_key', message: 'Duplicate key' });
                    else seen.set(key, loc.line);
                    space(); if (text[cursor++] !== ':') fail(); value(keyPath); space();
                    if (text[cursor] === '}') { cursor++; return; }
                    if (text[cursor++] !== ',') fail();
                }
            }
            if (text[cursor] === '[') {
                cursor++; space(); let index = 0;
                if (text[cursor] === ']') { cursor++; return; }
                while (true) {
                    value(`${path}[${index++}]`); space();
                    if (text[cursor] === ']') { cursor++; return; }
                    if (text[cursor++] !== ',') fail();
                }
            }
            if (text[cursor] === '"') { string(); return; }
            const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(cursor));
            if (!match) fail();
            cursor += match![0].length;
        };
        try { value(''); space(); if (cursor !== text.length) fail(); }
        catch { add({ ...position(Math.min(cursor, text.length)), message: 'Invalid JSON syntax', type: 'syntax' }); }
    } else if (kind === 'yaml') yaml(text, 0);
    else {
        const lines = text.split(/\r?\n/);
        let start = 0;
        if (lines[0]?.trim() === '---') {
            const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
            if (end < 0) add({ line: 1, column: 1, message: 'Unclosed frontmatter', type: 'syntax' });
            else { yaml(lines.slice(1, end).join('\n'), 1); start = end + 1; }
        }
        for (let i = start; i < lines.length; i++) {
            const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
            if (!match) continue;
            let end = i + 1;
            const fence = match[1];
            while (end < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[end])) end++;
            if (/^\s*(dataviewjs|js)\s*$/i.test(match[2])) js(lines.slice(i + 1, end).join('\n'), i + 1, true);
            i = end;
        }
    }
    return { ok: count === 0, kind, problems, truncated: count > problems.length, ...(mode ? { mode } : {}) };
}
