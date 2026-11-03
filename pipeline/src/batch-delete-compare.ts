// Read-only comparison of the LIVE definition of public.batch_delete(uuid) with the reviewed definition in
// supabase/pending/M1c_batch_delete_audit.sql (doc 16 section 3.3: the body of the function is not certified by
// reapply-m1c, so this comparison is a required step of the separately approved M1c run).
//
// What it does: one read-only transaction fetches pg_get_functiondef(public.batch_delete(uuid)); both that text and the
// function text extracted from the pinned M1c file are put through the SAME documented normalisation below, and the two
// results are compared. It prints only a fixed event: match true/false and two 12-character SHA-256 prefixes of the
// normalised texts (the reviewed file is public repository content; the live text is never printed). It never changes
// anything. A difference, or an absent function, is refused with the fixed id batch_delete_definition_mismatch.
//
// NORMALISATION (the whole of it; nothing else is ignored):
//   1. CRLF and CR line ends in the PINNED FILE text become LF (the file is stored with LF; this only guards a checkout that
//      rewrote line ends). The LIVE text is NOT normalised: its body is compared exactly as PostgreSQL holds it, so a live
//      body that contains a CR byte is a difference. Nothing else about either body changes: the text between the dollar
//      quotes is compared byte for byte (comments, spacing, every character), so a body change of any kind is a difference.
//   2. The header (everything before `AS <dollar tag>`) is reduced to a fixed list of facts, because PostgreSQL deparses
//      it in its own layout (`CREATE OR REPLACE FUNCTION`, upper-case keywords, `SET search_path TO 'a', 'b'`, no
//      `VOLATILE` for the default) while the file is written `create function ... volatile ... set search_path = a, b`.
//      The facts are: schema-qualified name and argument list (single spaces), return type, language, volatility,
//      SECURITY DEFINER or INVOKER, and the search_path list. The search_path is compared EXACTLY, with no case folding and
//      no splitting of free text: the live header must show `SET search_path TO 'a', 'b'` with every element a quoted
//      lower-case plain identifier (`[a-z_][a-z0-9_]*`), the file must show unquoted lower-case plain identifiers, and in
//      addition the stored setting (pg_proc.proconfig, read in the same statement) must equal, byte for byte, the single
//      string `search_path=<elements joined by ", ">` derived from the pinned file. So `"Public"`, `"INTERNAL"`, one
//      schema whose name contains commas, and any different order (pg_temp first) are all differences. The header must consist ONLY of those clauses; any other
//      clause (STRICT, COST, ROWS, LEAKPROOF, PARALLEL, another SET, WINDOW, SUPPORT, TRANSFORM) makes the header
//      unrecognised, which is a difference, never a pass.
//   3. The dollar-quote tag (`$$` in the file, `$function$` from PostgreSQL) is not part of the comparison.
//   4. Text after the closing dollar quote (the file's `;`, PostgreSQL's trailing newline) is ignored; the file's extraction
//      stops at the first closing quote that is followed by `;` at a line start, and refuses if more than one statement
//      creating public.batch_delete exists.
// The read runs in a read-only transaction with a transaction-local 30 second statement_timeout (never raising a stricter one).
// Not compared (not part of pg_get_functiondef): the owner, the privileges (reapply-m1c and the role matrix check those)
// and comments on the function.
//
// pg_get_functiondef is not a cross-version serialization contract (doc 16 section 3.3). A different PostgreSQL version that
// deparses the header differently makes the live header unrecognised, which is refused: safe, and a human inspects.

import { createHash } from 'node:crypto';
import type { RebuiltSqlClient } from './staging-rebuilt.js';

// Same bound as the STOP sweep (prod-sql.ts STATEMENT_TIMEOUT_SQL): transaction-local, never raises a stricter value. Repeated here, not imported, to keep staging-rebuilt <-> prod-sql free of an import cycle.
export const BATCH_DELETE_STATEMENT_TIMEOUT_SQL = "select set_config('statement_timeout', '30s', true) from pg_catalog.pg_settings where name = 'statement_timeout' and (setting::bigint = 0 or setting::bigint > 30000)";

export const BATCH_DELETE_COMPARE_EVENT = 'staging-sql.batch_delete_compare';

/** The live-definition query: read-only, a fixed schema-qualified signature, no parameters, returns zero or one row. */
export const BATCH_DELETE_LIVE_SQL = "select pg_get_functiondef(to_regprocedure('public.batch_delete(uuid)')) as def, (select proconfig from pg_proc where oid = to_regprocedure('public.batch_delete(uuid)')) as config where to_regprocedure('public.batch_delete(uuid)') is not null";

export interface NormalisedFunction {
  /** The fixed header facts, one per line, then the body; the exact text that is hashed. */
  text: string;
}

const lf = (s: string): string => s.replace(/\r\n?/g, '\n');
const spaces = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Splits `<header> AS <tag>body<tag>` where the tag is `$$` or `$name$`. Returns null when the shape is not exactly that. */
function splitHeaderBody(def: string, closingMustBeFollowedByStatementEnd: boolean): { header: string; body: string } | null {
  const open = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(def);
  if (!open) return null;
  const tag = open[1]!;
  const bodyStart = open.index + open[0].length;
  const closeAt = closingMustBeFollowedByStatementEnd ? def.indexOf(`\n${tag};`, bodyStart) : def.lastIndexOf(tag);
  if (closeAt < bodyStart) return null;
  const body = closingMustBeFollowedByStatementEnd ? def.slice(bodyStart, closeAt + 1) : def.slice(bodyStart, closeAt);
  const rest = def.slice(closeAt + (closingMustBeFollowedByStatementEnd ? 1 : 0) + tag.length);
  if (!/^\s*;?\s*$/.test(rest)) return null;
  return { header: def.slice(0, open.index), body };
}

const SEARCH_PATH_ID = '[a-z_][a-z0-9_]*';
const LIVE_SEARCH_PATH = new RegExp(`^[Ss][Ee][Tt] search_path [Tt][Oo] ('${SEARCH_PATH_ID}'(?:, '${SEARCH_PATH_ID}')*) `);
const FILE_SEARCH_PATH = new RegExp(`^set search_path (?:to|=) (${SEARCH_PATH_ID}(?:, ${SEARCH_PATH_ID})*) `);

/** Reduces the header to the fixed facts, or null when anything else is present. */
function headerFacts(header: string, form: 'file' | 'live'): string[] | null {
  let h = spaces(header);
  const create = /^create (?:or replace )?function /i.exec(h);
  if (!create) return null;
  h = h.slice(create[0].length);
  const sig = /^(public\.batch_delete) ?\( ?(p_batch_id uuid) ?\) ?/i.exec(h);
  if (!sig) return null;
  h = h.slice(sig[0].length);
  const facts = [`name=public.batch_delete(p_batch_id uuid)`];
  const ret = /^returns (boolean) /i.exec(h + ' ');
  if (!ret) return null;
  h = (h + ' ').slice(ret[0].length);
  facts.push('returns=boolean');
  let language: string | null = null;
  let volatility = 'volatile'; // the default; PostgreSQL omits it, the file states it: both mean volatile
  let security = 'invoker';
  let searchPath: string | null = null;
  while (h.trim() !== '') {
    let m: RegExpExecArray | null;
    if ((m = /^language (plpgsql|sql) /i.exec(h))) {
      if (language !== null) return null;
      language = m[1]!.toLowerCase();
    } else if ((m = /^(volatile|stable|immutable) /i.exec(h))) {
      volatility = m[1]!.toLowerCase();
    } else if ((m = /^security (definer|invoker) /i.exec(h))) {
      security = m[1]!.toLowerCase();
    } else if ((m = (form === 'live' ? LIVE_SEARCH_PATH : FILE_SEARCH_PATH).exec(h))) {
      if (searchPath !== null) return null;
      // Case-sensitive and strict: every element is a lower-case plain identifier (quoted on the live side), so there is
      // nothing to fold and a comma can only be an element separator. The list is kept verbatim, in order.
      searchPath = m[1]!.replace(/'/g, '');
    } else {
      return null;
    }
    h = h.slice(m[0].length);
  }
  if (language === null || searchPath === null) return null;
  facts.push(`language=${language}`, `volatility=${volatility}`, `security=${security}`, `search_path=${searchPath}`);
  return facts;
}

/** Normalises a CREATE FUNCTION text (file form or pg_get_functiondef form). Returns null when it is not recognised exactly. */
export function normaliseFunctionDefinition(def: string, form: 'file' | 'live'): NormalisedFunction | null {
  const parts = splitHeaderBody(form === 'file' ? lf(def) : def, form === 'file');
  if (!parts) return null;
  const facts = headerFacts(parts.header, form);
  if (!facts) return null;
  return { text: `${facts.join('\n')}\nbody:\n${parts.body}` };
}

/** The exact pg_proc.proconfig value the pinned file's search_path produces: one string, elements joined by ", ". */
export function expectedProconfig(normalisedText: string): string[] | null {
  const m = /^search_path=(.+)$/m.exec(normalisedText);
  return m ? [`search_path=${m[1]!}`] : null;
}

/** The statement creating public.batch_delete in the pinned M1c file; null unless there is exactly one. */
export function extractBatchDeleteFromFile(fileSql: string): string | null {
  const sql = lf(fileSql);
  const starts = [...sql.matchAll(/^create (?:or replace )?function public\.batch_delete\b/gim)];
  if (starts.length !== 1) return null;
  const from = starts[0]!.index!;
  const open = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(sql.slice(from));
  if (!open) return null;
  const closeAt = sql.indexOf(`\n${open[1]};`, from + open.index + open[0].length);
  if (closeAt < 0) return null;
  return sql.slice(from, closeAt + 1 + open[1]!.length + 1);
}

export const shortHash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

export interface BatchDeleteComparison {
  match: boolean;
  expected_hash: string;
  /** `absent` when the function does not exist, `unrecognised` when the live header is not in the reviewed shape. */
  live_hash: string;
}

/** Pure comparison of the expected (file) text with the live pg_get_functiondef text (or null when absent). */
export function compareBatchDelete(expectedFileText: string, liveDef: string | null, liveConfig: unknown = null): BatchDeleteComparison {
  const expected = normaliseFunctionDefinition(expectedFileText, 'file');
  if (!expected) throw new Error('the pinned M1c function text is not in the recognised shape');
  const expected_hash = shortHash(expected.text);
  if (liveDef === null) return { match: false, expected_hash, live_hash: 'absent' };
  const live = normaliseFunctionDefinition(liveDef, 'live');
  if (!live) return { match: false, expected_hash, live_hash: 'unrecognised' };
  // The stored setting must be exactly the one string derived from the file; any other shape (null, extra entries, other case) differs.
  const want = expectedProconfig(expected.text);
  const configOk = want !== null && Array.isArray(liveConfig) && liveConfig.length === want.length && liveConfig.every((c, i) => c === want[i]);
  return { match: live.text === expected.text && configOk, expected_hash, live_hash: shortHash(live.text) };
}

/** Runs inside a read-only transaction opened by the caller. Prints the fixed event; returns the comparison. */
export async function runBatchDeleteCompare(client: RebuiltSqlClient, expectedFileText: string): Promise<BatchDeleteComparison> {
  await client.query(BATCH_DELETE_STATEMENT_TIMEOUT_SQL);
  const res = await client.query(BATCH_DELETE_LIVE_SQL);
  const row = res.rows[0] as { def?: unknown; config?: unknown } | undefined;
  const live = row === undefined ? null : typeof row.def === 'string' ? row.def : null;
  const cmp = compareBatchDelete(expectedFileText, live, row?.config ?? null);
  console.log(JSON.stringify({ msg: BATCH_DELETE_COMPARE_EVENT, match: cmp.match, expected_hash: cmp.expected_hash, live_hash: cmp.live_hash }));
  return cmp;
}
