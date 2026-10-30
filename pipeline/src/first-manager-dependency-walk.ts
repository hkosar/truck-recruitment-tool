// Dependency walk behind the first-manager readiness list (first-manager-required-functions.ts). TEST/TOOLING ONLY: the shipped tool never reads SQL files.
//
// What it does. Parses every applied SQL source in order (supabase/migrations/*.sql sorted, then supabase/pending/M1, M1b, M1c; the latest definition of a
// function, policy or trigger wins, DROPs are honoured) and starts from two kinds of roots:
//   (a) every internal.* and public.* function the server calls: any `internal.x(` / `public.x(` in the non-test .ts files under app/server, the keys of
//       RPC_SPECS (app/server/core/rpc-spec.ts, called as public.<key>) and the dbFunction names in app/server/recovery/matrix.ts;
//   (b) every table or view the server names (`public.x` / `internal.x` in those files) - its row-access policies, triggers, column defaults, check
//       constraints and index expressions.
// It then follows, to a fixed point, every function name called inside a reached function, policy, trigger, view or table statement, and every table or view
// such a statement reads or writes (which pulls in that table's policies and triggers). The result is the set of function signatures (full argument types).
//
// Limits (stated, not hidden):
//  - Calls are matched by NAME, not by resolved overload: every current overload of a called name is included, so the set can be larger than strictly needed.
//  - Only functions, tables, views, policies, triggers, defaults, checks and index expressions defined in the SQL sources are followed. Extension, built-in and
//    Supabase-supplied functions (st_*, auth.uid(), pg_catalog) are not required here.
//  - Dynamic SQL is not evaluated. The one place the sources create triggers dynamically (a DO block with `execute format('create trigger ...')`) is handled by
//    reading the `execute function` names and the quoted table names in that block; any other dynamic creation is invisible to the walk.
//  - Dropped columns and constraints are not modelled (a statement on a table stays in scope), which can only enlarge the set.
//  - Only the existence of the function is required. EXECUTE grants, search_path, ownership, body correctness and behaviour are NOT checked.
//  - Comments are stripped before parsing; a `--` inside a string literal would be misread.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Fn { sig: string; schema: string; name: string; text: string }
interface TableNode { id: string; isView: boolean; statements: string[] }

/** Removes comments (outside string literals) and splits on `;` outside string literals and dollar-quoted blocks. */
export function splitStatements(source: string): string[] {
  const out: string[] = [];
  let cur = '', i = 0, inQuote = false, dollar = '';
  while (i < source.length) {
    const ch = source[i]!, two = source.slice(i, i + 2);
    if (!inQuote && two === '--') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (!inQuote && two === '/*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; cur += ' '; continue; }
    if (inQuote) { cur += ch; if (ch === "'") inQuote = false; i++; continue; }
    if (ch === "'") { inQuote = true; cur += ch; i++; continue; }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(source.slice(i));
      if (m) { dollar = dollar === '' ? m[0] : dollar === m[0] ? '' : dollar; cur += m[0]; i += m[0].length; continue; }
    }
    if (ch === ';' && dollar === '') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '', quote = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; } else if ('([{'.includes(ch)) { depth++; cur += ch; } else if (')]}'.includes(ch)) { depth--; cur += ch; } else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

/** The text between the parenthesis at `open` and its match. */
function parenthesised(s: string, open: number): string {
  let depth = 0, quote = '';
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') quote = ch; else if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return '';
}

function normaliseType(raw: string, customTypes: Set<string>): string {
  let t = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\[\s*\]/g, '[]');
  const base = t.replace(/(\[\])+$/, '');
  if (!base.includes('.') && customTypes.has(base)) t = `public.${t}`;
  return t;
}

/** Input-argument types of a function's argument list (OUT arguments are not part of the identity). */
function argTypes(args: string, customTypes: Set<string>): string {
  const types: string[] = [];
  for (let a of splitTop(args)) {
    a = a.trim().replace(/\s+default\s[^]*$/i, '').replace(/\s*=\s[^]*$/, '');
    if (/^out\s/i.test(a)) continue;
    a = a.replace(/^(?:in|inout|variadic)\s+/i, '');
    const words = a.split(/\s+/);
    types.push(normaliseType(words.length === 1 ? a : words.slice(1).join(' '), customTypes));
  }
  return types.join(',');
}

const qualify = (schema: string | undefined, name: string): string => `${(schema ?? 'public').toLowerCase()}.${name.toLowerCase()}`;
const IDENT = '(?:"?[a-zA-Z_]\\w*"?)';

export interface WalkInput { repositoryRoot: string }
export interface WalkResult {
  signatures: string[];
  /** Roots the server names that no SQL source defines (functions) - must be empty. */
  unresolvedFunctionRoots: string[];
  stats: { sources: number; functions: number; tables: number; policies: number; triggers: number; rootFunctions: number; rootTables: number; reachedTables: number };
}

export function sqlSourcePaths(root: string): string[] {
  const dir = resolve(root, 'supabase/migrations');
  const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => resolve(dir, f));
  return [...migrations, ...['M1_same_origin_signin.sql', 'M1b_add_person.sql', 'M1c_batch_delete_audit.sql'].map((f) => resolve(root, 'supabase/pending', f))];
}

export function serverSourcePaths(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : serverSourcePaths(resolve(dir, e.name))) : /\.(ts|mts)$/.test(e.name) && !/\.test\./.test(e.name) ? [resolve(dir, e.name)] : []));
}

// Drops block and line comments so prose such as "public.name(...)" is not read as a call. A line-comment marker inside a string literal would also drop
// the rest of that line, which can only shrink the root set; the contract test pins the roots the server is known to use.
export function stripTsComments(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, ' ').replace(/(^|[^:\w'"`])\/\/[^\n]*/g, '$1');
}

export function walkReachableFunctions({ repositoryRoot }: WalkInput): WalkResult {
  const sources = sqlSourcePaths(repositoryRoot);
  const statements = sources.flatMap((p) => splitStatements(readFileSync(p, 'utf8')));

  // ---- pass 1: custom types, then definitions (latest wins)
  const customTypes = new Set<string>();
  for (const s of statements) { const m = new RegExp(`^create\\s+(?:type|domain)\\s+(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s); if (m) customTypes.add(m[2]!.toLowerCase().replace(/"/g, '')); }

  const fns = new Map<string, Fn>();
  const tables = new Map<string, TableNode>();
  const policies = new Map<string, { table: string; text: string }>();
  const triggers = new Map<string, { table: string; text: string }>();
  const extras: Array<{ table: string; text: string }> = [];
  const doBlocks: string[] = [];
  const tableId = (schema: string | undefined, name: string) => qualify(schema?.replace(/"/g, ''), name.replace(/"/g, ''));
  const node = (id: string, isView: boolean): TableNode => { let t = tables.get(id); if (!t) { t = { id, isView, statements: [] }; tables.set(id, t); } if (isView) t.isView = true; return t; };

  for (const s of statements) {
    let m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+(?:(${IDENT})\\.)?(${IDENT})\\s*\\(`, 'i').exec(s);
    if (m) {
      const schema = (m[1] ?? 'public').toLowerCase(), name = m[2]!.toLowerCase().replace(/"/g, '');
      const sig = `${schema}.${name}(${argTypes(parenthesised(s, m[0].length - 1), customTypes)})`;
      fns.set(sig, { sig, schema, name, text: s });
      continue;
    }
    m = new RegExp(`^drop\\s+function\\s+(?:if\\s+exists\\s+)?(?:(${IDENT})\\.)?(${IDENT})\\s*\\(`, 'i').exec(s);
    if (m) { fns.delete(`${(m[1] ?? 'public').toLowerCase()}.${m[2]!.toLowerCase().replace(/"/g, '')}(${argTypes(parenthesised(s, m[0].length - 1), customTypes)})`); continue; }
    m = new RegExp(`^create\\s+policy\\s+(${IDENT})\\s+on\\s+(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { const t = tableId(m[2], m[3]!); node(t, false); policies.set(`${t}|${m[1]!.toLowerCase()}`, { table: t, text: s }); continue; }
    m = new RegExp(`^drop\\s+policy\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s+on\\s+(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { policies.delete(`${tableId(m[2], m[3]!)}|${m[1]!.toLowerCase()}`); continue; }
    m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+(${IDENT})[^]*?\\son\\s+(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { const t = tableId(m[2], m[3]!); node(t, false); triggers.set(`${t}|${m[1]!.toLowerCase()}`, { table: t, text: s }); continue; }
    m = new RegExp(`^drop\\s+trigger\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s+on\\s+(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { triggers.delete(`${tableId(m[2], m[3]!)}|${m[1]!.toLowerCase()}`); continue; }
    m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:(?:materialized\\s+)?view)\\s+(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { const v = node(tableId(m[1], m[2]!), true); v.statements = [s]; continue; }
    m = new RegExp(`^create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { node(tableId(m[1], m[2]!), false).statements.push(s); continue; }
    m = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { node(tableId(m[1], m[2]!), false).statements.push(s); continue; }
    m = new RegExp(`^create\\s+(?:unique\\s+)?index\\s+[^]*?\\son\\s+(?:only\\s+)?(?:(${IDENT})\\.)?(${IDENT})`, 'i').exec(s);
    if (m) { extras.push({ table: tableId(m[1], m[2]!), text: s }); continue; }
    if (/^do\b/i.test(s)) doBlocks.push(s);
  }
  // Dynamic trigger creation inside DO blocks: each `execute function X(` is attached to every known table named as a quoted literal in the same block.
  for (const block of doBlocks) {
    if (!/create\s+trigger/i.test(block)) continue;
    const named = [...block.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((x) => x[1]!).filter((n) => tables.has(qualify('public', n)));
    for (const f of block.matchAll(/execute\s+(?:function|procedure)\s+((?:\w+\.)?\w+)\s*\(/gi)) for (const n of named) extras.push({ table: qualify('public', n), text: `execute function ${f[1]}()` });
  }
  for (const e of extras) node(e.table, false);
  const extrasByTable = new Map<string, string[]>();
  for (const e of extras) extrasByTable.set(e.table, [...(extrasByTable.get(e.table) ?? []), e.text]);

  const fnsByQual = new Map<string, Fn[]>(), fnsByName = new Map<string, Fn[]>();
  for (const f of fns.values()) {
    fnsByQual.set(`${f.schema}.${f.name}`, [...(fnsByQual.get(`${f.schema}.${f.name}`) ?? []), f]);
    fnsByName.set(f.name, [...(fnsByName.get(f.name) ?? []), f]);
  }
  const tablesByName = new Map<string, TableNode[]>();
  for (const t of tables.values()) { const bare = t.id.split('.')[1]!; tablesByName.set(bare, [...(tablesByName.get(bare) ?? []), t]); }

  // ---- roots from the server
  const serverRoot = resolve(repositoryRoot, 'app/server');
  const serverFiles = serverSourcePaths(serverRoot);
  const serverText = serverFiles.map((f) => stripTsComments(readFileSync(f, 'utf8'))).join('\n');
  const rootNames = new Set<string>();
  for (const m of serverText.matchAll(/\b(internal|public)\.([a-z_][a-z0-9_]*)\s*\(/g)) rootNames.add(`${m[1]}.${m[2]}`);
  const rpcSource = readFileSync(resolve(serverRoot, 'core/rpc-spec.ts'), 'utf8');
  const rpcBlock = rpcSource.slice(rpcSource.indexOf('export const RPC_SPECS'), rpcSource.indexOf('\n};', rpcSource.indexOf('export const RPC_SPECS')));
  for (const m of rpcBlock.matchAll(/^ {2}([a-z_][a-z0-9_]*): \{/gm)) rootNames.add(`public.${m[1]}`);
  const matrix = readFileSync(resolve(serverRoot, 'recovery/matrix.ts'), 'utf8');
  for (const m of matrix.matchAll(/dbFunction:\s*'(internal|public)\.(\w+)'/g)) rootNames.add(`${m[1]}.${m[2]}`);

  const reached = new Set<string>();
  const rootTableIds = new Set<string>();
  const reachedTables = new Set<string>();
  const unresolved: string[] = [];
  const fnQueue: Fn[] = [];
  const tableQueue: string[] = [];
  const addFn = (f: Fn) => { if (!reached.has(f.sig)) { reached.add(f.sig); fnQueue.push(f); } };
  const addTable = (t: TableNode) => { if (!reachedTables.has(t.id)) { reachedTables.add(t.id); tableQueue.push(t.id); } };

  for (const q of rootNames) { const hit = fnsByQual.get(q); if (hit) hit.forEach(addFn); else if (tables.has(q)) { rootTableIds.add(q); addTable(tables.get(q)!); } else unresolved.push(q); }
  for (const m of serverText.matchAll(/\b(internal|public)\.([a-z_][a-z0-9_]*)\b(?!\s*\()/g)) { const t = tables.get(`${m[1]}.${m[2]}`); if (t) { rootTableIds.add(t.id); addTable(t); } }
  const rootFunctionCount = reached.size;

  const visit = (text: string): void => {
    for (const m of text.matchAll(/\b(?:([a-z_]\w*)\s*\.\s*)?([a-z_]\w*)\s*\(/gi)) {
      const name = m[2]!.toLowerCase();
      const hits = m[1] ? fnsByQual.get(`${m[1].toLowerCase()}.${name}`) : fnsByName.get(name);
      hits?.forEach(addFn);
    }
    for (const m of text.matchAll(/\b(?:from|join|into|update|references|table|on)\s+(?:only\s+)?(?:([a-z_]\w*)\.)?([a-z_]\w*)\b/gi)) {
      const bare = m[2]!.toLowerCase();
      const t = m[1] ? tables.get(`${m[1].toLowerCase()}.${bare}`) : undefined;
      if (t) addTable(t); else if (!m[1]) tablesByName.get(bare)?.forEach(addTable);
    }
    for (const m of text.matchAll(/\b(internal|public)\.([a-z_][a-z0-9_]*)\b/gi)) { const t = tables.get(`${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}`); if (t) addTable(t); }
  };

  while (fnQueue.length || tableQueue.length) {
    while (fnQueue.length) visit(fnQueue.pop()!.text);
    while (tableQueue.length) {
      const id = tableQueue.pop()!;
      const t = tables.get(id)!;
      t.statements.forEach(visit);
      (extrasByTable.get(id) ?? []).forEach(visit);
      for (const p of policies.values()) if (p.table === id) visit(p.text);
      for (const g of triggers.values()) if (g.table === id) visit(g.text);
    }
  }

  return {
    signatures: [...reached].sort(),
    unresolvedFunctionRoots: unresolved.sort(),
    stats: { sources: sources.length, functions: fns.size, tables: tables.size, policies: policies.size, triggers: triggers.size, rootFunctions: rootFunctionCount, rootTables: rootTableIds.size, reachedTables: reachedTables.size },
  };
}

export const REQUIRED_FUNCTIONS_FILE = 'pipeline/src/first-manager-required-functions.ts';

/** The exact text of the checked-in module for a given walk result. */
export function renderRequiredFunctionsModule(signatures: readonly string[]): string {
  return `// GENERATED by first-manager-dependency-walk.ts - do not edit by hand. Regenerate: cd pipeline && npx tsx src/first-manager-dependency-walk.ts --write
// The test (first-manager-bootstrap.test.ts) re-runs the walk over the SQL sources and the app server code and fails on any difference.
// Every internal.* and public.* function the server can reach: called by the server code, RPC_SPECS or the session matrix, or reached through
// the policies, triggers, views and defaults of the tables the server touches, followed through function bodies. Full argument types.
// Existence only: this does not prove grants, search_path, ownership or behaviour, and it does not cover extension or built-in functions.
export const REQUIRED_FUNCTION_SIGNATURES: readonly string[] = [
${signatures.map((s) => `  '${s}',`).join('\n')}
];
`;
}

if (process.argv[1] && /first-manager-dependency-walk\.[mc]?[jt]s$/.test(process.argv[1]) && process.argv.includes('--write')) {
  const root = resolve(process.cwd(), '..');
  const result = walkReachableFunctions({ repositoryRoot: root });
  if (result.unresolvedFunctionRoots.length) throw new Error(`roots with no SQL definition: ${result.unresolvedFunctionRoots.join(', ')}`);
  writeFileSync(resolve(root, REQUIRED_FUNCTIONS_FILE), renderRequiredFunctionsModule(result.signatures));
  console.log(`wrote ${result.signatures.length} signatures`);
}
