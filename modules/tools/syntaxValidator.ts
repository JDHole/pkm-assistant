import { parse } from 'acorn';
import { LineCounter, parseAllDocuments } from 'yaml';

export type SyntaxKind = 'js' | 'json' | 'yaml' | 'markdown';
export type SyntaxProblem = { line: number; column: number; message: string; type: 'syntax' | 'duplicate_key' | 'limit'; path?: string; path_truncated?: boolean; message_truncated?: boolean; firstLine?: number };
export type SyntaxResult = { ok: boolean; kind: SyntaxKind; problems: SyntaxProblem[]; truncated: boolean; mode?: string; checked_blocks?: number; skipped_blocks?: number; note?: string };

export const MAX_SYNTAX_BYTES = 2 * 1024 * 1024;

export type MarkdownFence = { language: string; line: number; column: number; body: string; columns: number[]; unclosed: boolean; skipped?: boolean };

/** Shared Markdown fence scan, preserving source positions for syntax diagnostics. */
export function scanMarkdownFences(text: string): MarkdownFence[] {
    const lines = text.split(/\r?\n/);
    let start = 0;
    if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
        if (end >= 0) start = end + 1;
    }
    const blocks: MarkdownFence[] = [];
    let listIndent = 0, inComment = false;
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (inComment) { if (line.includes('-->')) inComment = false; continue; }
        const comment = line.indexOf('<!--');
        if (comment >= 0) { if (!line.slice(comment + 4).includes('-->')) inComment = true; continue; }
        const list = /^( *)(?:(?:> ?)+)?(?:[-+*]|\d+[.)]) +/.exec(line);
        if (list) listIndent = list[0].length;
        else if (/^\S/.test(line) && !line.startsWith('>')) listIndent = 0;
        const fenceMatch = /^( *)(?:(> ?)+)?((?:[-+*]|\d+[.)]) +)?( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
        if (!fenceMatch) {
            // A container shape outside the confidently supported grammar is still
            // a source block, but must never be reported as checked.
            const uncertain = /^([ \t>]+)(`{3,}|~{3,})(.*)$/.exec(line);
            if (uncertain && (uncertain[1].includes('>') || (listIndent > 0 && uncertain[1].length >= listIndent))) {
                const marker = uncertain[2];
                let end = i + 1;
                const close = new RegExp(`^[ \t>]*${marker[0]}{${marker.length},}\\s*$`);
                while (end < lines.length && !close.test(lines[end])) end++;
                blocks.push({ language: uncertain[3].trim().toLowerCase(), line: i + 1, column: uncertain[1].length + 1, body: '', columns: [], unclosed: end === lines.length, skipped: true });
                i = end;
            }
            continue;
        }
        const leading = fenceMatch[1].length;
        if (leading >= 4 && (!listIndent || leading < listIndent)) continue;
        const fence = fenceMatch[5];
        const prefix = line.slice(0, line.indexOf(fence));
        const quoteCount = (prefix.match(/>/g) ?? []).length;
        const indent = leading;
        const markerWidth = fenceMatch[3]?.length ?? 0;
        let end = i + 1, skipped = /\t/.test(prefix);
        const body: string[] = [], columns: number[] = [];
        while (end < lines.length) {
            const current = lines[end];
            let cut = 0;
            if (current.trim()) {
                while (cut < indent && current[cut] === ' ') cut++;
                if (cut < indent || current.includes('\t')) skipped = true;
                for (let q = 0; q < quoteCount; q++) {
                    const part = /^ {0,3}> ?/.exec(current.slice(cut));
                    if (!part) { skipped = true; break; }
                    cut += part[0].length;
                }
            }
            if (markerWidth && current.trim()) {
                let n = 0; while (n < markerWidth && current[cut] === ' ') { cut++; n++; }
                if (n < markerWidth) skipped = true;
            }
            const rest = current.slice(cut);
            if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(rest)) break;
            body.push(rest); columns.push(cut); end++;
        }
        blocks.push({ language: fenceMatch[6].trim().toLowerCase(), line: i + 1, column: prefix.length + 1, body: body.join('\n'), columns, unclosed: end === lines.length, skipped });
        i = end;
    }
    return blocks;
}

export function checkSyntax(text: string, kind: SyntaxKind): SyntaxResult {
    const problems: SyntaxProblem[] = [];
    if (new TextEncoder().encode(text).length > MAX_SYNTAX_BYTES) return { ok: false, kind, problems: [{ line: 1, column: 1, message: 'Input exceeds 2 MB limit', type: 'limit' }], truncated: false, ...(kind === 'markdown' ? { checked_blocks: 0, skipped_blocks: 0 } : {}) };
    let count = 0, checkedBlocks = 0, skippedBlocks = 0;
    let mode: string | undefined;
    const add = (problem: SyntaxProblem) => {
        count++;
        if (problem.path && problem.path.length > 120) { problem.path = problem.path.slice(0, 120); problem.path_truncated = true; }
        if (problem.message.length > 120) { problem.message = problem.message.slice(0, 120); problem.message_truncated = true; }
        if (problems.length < 20) problems.push(problem);
    };
    const js = (source: string, offset: number, functionOnly: boolean, columns: number[] = []) => {
        const modes = functionOnly ? ['async_function'] : ['script', 'module', 'async_function'];
        let best: { pos?: number; loc?: { line: number; column: number }; message?: string } = {};
        const failures: typeof best[] = [];
        // Acorn only accepts a hashbang at offset zero; replace a leading BOM without shifting offsets.
        const normalized = source.replace(/^(\ufeff?)#![^\r\n]*/, match => ' '.repeat(match.length));
        for (const candidate of modes) {
            const prefix = candidate === 'async_function' ? 'async function __syntax_check__() {\n' : '';
            const wrapped = prefix + normalized + (prefix ? '\n}' : '');
            try {
                const program = parse(wrapped, { ecmaVersion: 'latest', sourceType: candidate === 'module' ? 'module' : 'script', allowHashBang: true });
                if (prefix && (program.body.length !== 1 || program.body[0].type !== 'FunctionDeclaration' || program.body[0].end !== wrapped.length)) {
                    throw Object.assign(new Error('Unexpected end of function body'), { pos: prefix.length + normalized.length, loc: { line: source.split('\n').length + 1, column: 0 } });
                }
                if (!functionOnly) mode = candidate;
                return;
            } catch (error) {
                const failure = error as typeof best;
                const adjusted = prefix ? { ...failure, pos: Math.max(0, (failure.pos ?? 0) - prefix.length), loc: { line: Math.max(1, (failure.loc?.line ?? 1) - 1), column: failure.loc?.column ?? 0 }, message: failure.message } : failure;
                failures.push(adjusted);
                if ((adjusted.pos ?? 0) > (best.pos ?? -1)) best = adjusted;
            }
        }
        if (!functionOnly && failures.length === 3 && failures.slice(0, 2).every(failure => /(?:'return' outside of function|(?:keyword )?'await' outside (?:of |an async )?function)/.test(failure.message ?? ''))) best = failures[2];
        add({ line: offset + (best.loc?.line ?? 1), column: (best.loc?.column ?? 0) + 1 + (columns[(best.loc?.line ?? 1) - 1] ?? 0), message: (best.message ?? 'Syntax error').replace(/ \(\d+:\d+\)$/, ''), type: 'syntax' });
    };
    const yaml = (source: string, offset: number) => {
        const counter = new LineCounter();
        const docs = parseAllDocuments(source, { lineCounter: counter, strict: true, merge: true, logLevel: 'silent' });
        for (const [index, doc] of docs.entries()) {
            for (const error of doc.errors) {
                const pos = error.linePos?.[0] ?? counter.linePos(error.pos[0]);
                add({ line: offset + pos.line, column: pos.col, message: error.message.split('\n')[0].replace(/ at line \d+, column \d+:$/, ''), type: error.code === 'DUPLICATE_KEY' ? 'duplicate_key' : 'syntax' });
            }
            try { doc.toJS({ maxAliasCount: 100, mapAsMap: true }); } catch (error) {
                const message = error instanceof Error ? error.message : 'YAML conversion failed';
                // Merge-aware duplicate detection accepts repeated << keys. If a
                // scalar << is ordinary YAML, retry conversion with the default schema.
                if (/Merge sources must be maps/.test(message)) {
                    try { parseAllDocuments(source, { logLevel: 'silent' })[index].toJS({ maxAliasCount: 100, mapAsMap: true }); continue; } catch { /* Report the original conversion failure. */ }
                }
                const limit = /alias count|resource exhaustion/i.test(message);
                const pos = counter.linePos(doc.range?.[0] ?? 0);
                add({ line: offset + pos.line, column: pos.col, message: limit ? 'YAML alias expansion limit exceeded' : 'YAML alias resolution failed', type: limit ? 'limit' : 'syntax' });
            }
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
            if (block.language !== 'dataviewjs') continue;
            if (block.skipped) { skippedBlocks++; continue; }
            checkedBlocks++;
            js(block.body, block.line, true, block.columns);
            if (block.unclosed) add({ line: block.line, column: block.column, message: 'Unclosed code block', type: 'syntax' });
        }
    }
    const result: SyntaxResult = { ok: count === 0 && skippedBlocks === 0, kind, problems, truncated: count > problems.length, ...(mode ? { mode } : {}), ...(kind === 'markdown' ? { checked_blocks: checkedBlocks, skipped_blocks: skippedBlocks } : {}), ...(skippedBlocks ? { note: `${skippedBlocks} blocks not checked due to ambiguous nesting` } : {}) };
    // Reserve space for the tool's success envelope as well as JSON escaping.
    while (JSON.stringify(result).length > 15980 && problems.length) { problems.pop(); result.truncated = true; }
    return result;
}
