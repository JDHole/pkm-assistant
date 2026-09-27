/** Bounded literal text search for explicitly scoped vault files. */
import { validateVaultFolder, validateVaultPath } from './vault_path_validator.js';
import { isHiddenVaultPath } from './vault_adapter_io.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

type Where = { path?: unknown; folder?: unknown; glob?: unknown };
type Adapter = {
  list?: (path: string) => Promise<{ files?: string[]; folders?: string[] } | null>;
  read?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ size?: number } | null>;
  exists?: (path: string) => Promise<boolean>;
};
type Vault = { adapter?: Adapter; getAbstractFileByPath?: (path: string) => unknown };
type SearchResult = { path: string; offset: number; line: number; column: number; excerpt: string };
type Scan = { candidates: number; inspected: number; read: number; skipped_access: number; skipped_too_large: number; read_errors: number; truncated: boolean; reasons: string[] };
const MAX_ENTRIES = 2000, MAX_DEPTH = 8, MAX_READS = 200, MAX_FILE = 256 * 1024, MAX_TOTAL = 2_000_000, MAX_RESULTS = 20;
const CODE_EXT = /\.(?:js|json|md)$/i;
const err = (code: string) => ({ success: false, code, isError: true });
const pathError = (raw: unknown) => typeof raw !== 'string' || /[\0]/.test(raw) || /^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.split(/[\\/]/).some(s => s === '..' || s.startsWith('.'));
function validGlob(glob: string): boolean {
  if (!glob || glob.length > 120 || glob.startsWith('/') || /^[A-Za-z]:/.test(glob) || glob.split('/').some(s => !s || s === '..' || s.startsWith('.'))) return false;
  return !/[\\\0]/.test(glob) && glob.split('/').every(segment => !segment.includes('**') || segment === '**');
}
function segmentMatches(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase(), s = text.toLowerCase();
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < s.length) {
    if (i < p.length && p[i] !== '*' && p[i] === s[j]) { i++; j++; }
    else if (i < p.length && p[i] === '*') { star = i++; retry = j; }
    else if (star >= 0) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (p[i] === '*') i++;
  return i === p.length;
}
function globMatches(glob: string, relative: string): boolean {
  const patterns = glob.split('/'), segments = relative.split('/');
  const dp = Array.from({ length: patterns.length + 1 }, () => new Uint8Array(segments.length + 1));
  const firstRow = dp[0];
  if (!firstRow) return false;
  firstRow[0] = 1;
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i], row = dp[i], nextRow = dp[i + 1];
    if (pattern === undefined || !row || !nextRow) return false;
    for (let j = 0; j <= segments.length; j++) {
      if (!row[j]) continue;
      if (pattern === '**') {
        nextRow[j] = 1;
        if (j < segments.length) row[j + 1] = 1;
      } else if (j < segments.length && segments[j] !== undefined && segmentMatches(pattern, segments[j])) nextRow[j + 1] = 1;
    }
  }
  return dp[patterns.length]?.[segments.length] === 1;
}
function addReason(scan: Scan, reason: string) { if (!scan.reasons.includes(reason)) scan.reasons.push(reason); scan.truncated = true; }
function ioCode(error: unknown): 'file_missing' | 'access_denied' | 'read_error' {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'file_missing';
  if (code === 'EACCES' || code === 'EPERM') return 'access_denied';
  return 'read_error';
}
function hitAt(content: string, index: number) {
  let line = 1, column = 0;
  for (let i = 0; i < index; i++) { if (content.charCodeAt(i) === 10) { line++; column = 0; } else column++; }
  const start = Math.max(0, index - 60), end = Math.min(content.length, start + 160);
  return { line, column, excerpt: content.slice(start, end) };
}
function safeResult(result: unknown, context?: BuiltinToolExecutionContext) {
  const cap = Math.min(context?.effectiveResultBudgetChars ?? 12000, 12000);
  const serial = (value: unknown) => context?.serializeFinalResult(value) ?? JSON.stringify(value);
  if (cap < 58) return 'B';
  if (serial(result).length <= cap) return result;
  return err('budget_too_small');
}

export async function runTextSearch(args: { query?: unknown; where?: unknown; limit?: unknown }, vaultLike: unknown, context?: BuiltinToolExecutionContext) {
  if (typeof args.query !== 'string' || args.query.length < 1 || args.query.length > 256) return safeResult(err('invalid_args'), context);
  if (!args.where || typeof args.where !== 'object' || Array.isArray(args.where)) return safeResult(err('invalid_args'), context);
  const where = args.where as Where, exact = typeof where.path === 'string', folderMode = typeof where.folder === 'string' && typeof where.glob === 'string';
  const allowedWhereKeys = exact ? new Set(['path']) : new Set(['folder', 'glob']);
  if (Object.keys(where).some(key => !allowedWhereKeys.has(key)) || exact === folderMode || (exact && ('folder' in where || 'glob' in where)) || (folderMode && 'path' in where)) return safeResult(err('invalid_args'), context);
  const vault = vaultLike as Vault | null;
  const adapter = vault?.adapter;
  if (!adapter?.read) return safeResult(err('read_error'), context);
  const scan: Scan = { candidates: 0, inspected: 0, read: 0, skipped_access: 0, skipped_too_large: 0, read_errors: 0, truncated: false, reasons: [] };
  const results: SearchResult[] = [];
  const maxHits = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(args.limit))) : MAX_RESULTS;
  let totalChars = 0;
  const cap = Math.min(context?.effectiveResultBudgetChars ?? 12000, 12000);
  if (cap < 58) return 'B';
  const contextValid = !!context && typeof context.authorizeFileRead === 'function';
  const auth = (path: string) => contextValid ? context.authorizeFileRead(path) : { allowed: false };
  const base = { success: true, query: args.query, scope: 'vault', mode_used: 'text' } as const;
  const value = (status: 'complete' | 'partial' | 'aborted') => ({ ...base, status, results, total: results.length, scan });
  const finish = (status: 'complete' | 'partial' | 'aborted') => {
    let finalStatus = status;
    if (!fits(finalStatus)) {
      if (status !== 'aborted') finalStatus = 'partial';
      addReason(scan, 'result_budget');
      while (results.length && !fits(finalStatus)) results.pop();
    }
    return safeResult(value(finalStatus), context);
  };
  const fits = (status: 'complete' | 'partial' | 'aborted') => (context?.serializeFinalResult(value(status)) ?? JSON.stringify(value(status))).length <= cap;
  if (typeof args.limit === 'number' && args.limit <= 0) return safeResult(err('invalid_args'), context);
  if (!fits('partial')) return safeResult(err('budget_too_small'), context);

  let candidates: Array<{ path: string; depth: number; size?: number }> = [];
  if (exact) {
    if (pathError(where.path)) return safeResult(err('invalid_args'), context);
    const valid = validateVaultPath(where.path, { adminAccess: false, allowSkillsRead: false });
    if (!valid.ok || valid.safePath !== where.path) return safeResult(err('invalid_args'), context);
    const path = valid.safePath;
    if (!CODE_EXT.test(path)) return safeResult(err('unsupported_type'), context);
    const decision = auth(path);
    if (!decision.allowed) return safeResult(err('access_denied'), context);
    let stat: { size?: number } | null | undefined;
    try { stat = await adapter.stat?.(path); } catch { stat = null; }
    if (!stat && adapter.exists) {
      try { if (!await adapter.exists(path)) return safeResult(err('file_missing'), context); }
      catch (error) { return safeResult(err(ioCode(error)), context); }
    }
    candidates.push({ path, depth: 0, size: stat?.size });
    scan.candidates = 1;
  } else {
    if (typeof where.folder !== 'string' || !where.folder || pathError(where.folder) || typeof where.glob !== 'string') return safeResult(err('invalid_args'), context);
    const folderValid = validateVaultFolder(where.folder, { adminAccess: false, allowSkillsRead: false });
    const matcher = validGlob(where.glob);
    if (!folderValid.ok || folderValid.safePath !== where.folder || !matcher) return safeResult(err('invalid_args'), context);
    const folder = folderValid.safePath.replace(/\/$/, '');
    const queue: Array<{ folder: string; depth: number }> = [{ folder, depth: 0 }];
    let enumerationStopped = false;
    while (queue.length && !enumerationStopped) {
      if (context?.shouldAbort()) { scan.truncated = true; scan.reasons = ['aborted']; return finish('aborted'); }
      const current = queue.shift();
      if (!current) break;
      let listing: { files?: string[]; folders?: string[] } | null;
      try { listing = await adapter.list?.(current.folder) ?? null; } catch { listing = null; }
      if (!listing) { addReason(scan, 'read_error'); scan.read_errors++; continue; }
      // The adapter may return a full array. Touch and sort at most the remaining
      // candidate budget, checking Stop between accesses to external entries.
      const files = listing.files || [], folders = listing.folders || [];
      const remaining = MAX_ENTRIES - scan.candidates;
      const entries: Array<{ path: string; isFolder: boolean }> = [];
      for (let i = 0; i < files.length && entries.length < remaining; i++) {
        if (context?.shouldAbort()) { scan.truncated = true; scan.reasons = ['aborted']; return finish('aborted'); }
        entries.push({ path: files[i] ?? '', isFolder: false });
      }
      for (let i = 0; i < folders.length && entries.length < remaining; i++) {
        if (context?.shouldAbort()) { scan.truncated = true; scan.reasons = ['aborted']; return finish('aborted'); }
        entries.push({ path: folders[i] ?? '', isFolder: true });
      }
      if (files.length + folders.length > entries.length) { addReason(scan, 'candidate_limit'); enumerationStopped = true; }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      for (const entry of entries) {
        if (context?.shouldAbort()) { scan.truncated = true; scan.reasons = ['aborted']; return finish('aborted'); }
        scan.candidates++;
        if (entry.isFolder) {
          const validFolder = validateVaultFolder(entry.path, { adminAccess: false, allowSkillsRead: false });
          const rootPrefix = `${folder}/`;
          if (!validFolder.ok || validFolder.safePath !== entry.path || !entry.path.startsWith(rootPrefix) || isHiddenVaultPath(entry.path)) { addReason(scan, 'access_skipped'); scan.skipped_access++; continue; }
          if (current.depth >= MAX_DEPTH) { addReason(scan, 'depth_limit'); continue; }
          queue.push({ folder: entry.path, depth: current.depth + 1 });
        } else {
          const prefix = `${folder}/`;
          if (entry.path.startsWith(prefix) && !pathError(entry.path) && !isHiddenVaultPath(entry.path) && CODE_EXT.test(entry.path)) {
            const validPath = validateVaultPath(entry.path, { adminAccess: false, allowSkillsRead: false });
            const relative = entry.path.slice(prefix.length);
            if (validPath.ok && validPath.safePath === entry.path && globMatches(where.glob, relative)) candidates.push({ path: entry.path, depth: current.depth });
          }
        }
      }
      if (scan.candidates >= MAX_ENTRIES && queue.length) { addReason(scan, 'candidate_limit'); enumerationStopped = true; }
    }
    candidates.sort((a, b) => a.path.localeCompare(b.path));
  }
  for (const candidate of candidates) {
    if (context?.shouldAbort()) { scan.truncated = true; scan.reasons = ['aborted']; return finish('aborted'); }
    scan.inspected++;
    const valid = validateVaultPath(candidate.path, { adminAccess: false, allowSkillsRead: false });
    if (!valid.ok || valid.safePath !== candidate.path || isHiddenVaultPath(candidate.path)) { addReason(scan, 'access_skipped'); scan.skipped_access++; continue; }
    const decision = auth(candidate.path);
    if (!decision.allowed) {
      if (exact) return safeResult(err('access_denied'), context);
      addReason(scan, 'access_skipped'); scan.skipped_access++; continue;
    }
    if (scan.read >= MAX_READS) { addReason(scan, 'file_limit'); return finish('partial'); }
    const stat = candidate.size !== undefined ? { size: candidate.size } : await adapter.stat?.(candidate.path).catch(() => null);
    if (typeof stat?.size === 'number' && stat.size > MAX_FILE) { addReason(scan, 'oversized'); scan.skipped_too_large++; if (exact) return finish('partial'); continue; }
    const beforeRead = auth(candidate.path);
    if (!beforeRead.allowed) {
      if (exact) return safeResult(err('access_denied'), context);
      addReason(scan, 'access_skipped'); scan.skipped_access++; continue;
    }
    scan.read++;
    let content: string;
    try { content = await adapter.read(candidate.path); } catch (error) {
      if (exact) return safeResult(err(ioCode(error)), context);
      addReason(scan, 'read_error'); scan.read_errors++; continue;
    }
    if (context?.shouldAbort()) { scan.truncated = true; scan.reasons = ['aborted']; return finish('aborted'); }
    totalChars += content.length;
    if (totalChars > MAX_TOTAL) { addReason(scan, 'byte_limit'); return finish('partial'); }
    const contentBytes = new TextEncoder().encode(content).length;
    if (contentBytes > MAX_FILE) { addReason(scan, 'oversized'); scan.skipped_too_large++; if (exact) return finish('partial'); continue; }
    if (!fits('partial')) { addReason(scan, 'result_budget'); return finish('partial'); }
    const re = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    for (const match of content.matchAll(re)) {
      if (results.length >= maxHits) { addReason(scan, 'result_limit'); return finish('partial'); }
      const index = match.index ?? 0, loc = hitAt(content, index);
      results.push({ path: candidate.path, offset: index, line: loc.line, column: loc.column, excerpt: loc.excerpt });
      if (!fits('partial')) {
        results.pop(); addReason(scan, 'result_budget'); return finish('partial');
      }
    }
  }
  return finish(scan.truncated ? 'partial' : 'complete');
}
