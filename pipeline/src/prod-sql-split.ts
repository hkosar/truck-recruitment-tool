/**
 * Offline SQL statement splitter and transaction-shape detector for the production SQL runner (prod-sql.ts).
 *
 * It reads a file's text and returns its TOP-LEVEL statements: a semicolon inside a comment, a quoted string, a quoted identifier or a
 * dollar-quoted body ($$ ... $$, $tag$ ... $tag$) does not end a statement, so a `begin` inside a DO block or a function body is never
 * mistaken for a transaction statement. Each statement is returned twice: `raw` (exactly what is sent to the server) and `clean`
 * (comments replaced by spaces, used only to read the first words). It never connects, never reads a file and never prints.
 *
 * Limits (each is refused, never guessed): psql meta-commands (a line that starts with a backslash), SQL-standard function bodies
 * (`begin atomic`), and statements that cannot run inside a transaction block.
 */

export interface SqlStatement {
  raw: string;
  clean: string;
}

export type SqlControl = 'begin' | 'commit' | 'rollback' | null;

const IDENT_CHAR = /[A-Za-z0-9_\u0080-￿$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export class SqlSplitError extends Error {
  constructor(readonly reason: 'unterminated' | 'meta_command') {
    super(`SQL text could not be split (${reason})`);
    this.name = 'SqlSplitError';
  }
}

export function splitSqlStatements(text: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let raw = '';
  let clean = '';
  const push = () => {
    if (clean.trim() !== '') out.push({ raw: raw.trim(), clean: clean.replace(/\s+/g, ' ').trim() });
    raw = '';
    clean = '';
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '\\' && (i === 0 || text[i - 1] === '\n') && clean.trim() === '') throw new SqlSplitError('meta_command');
    if (c === '-' && next === '-') {
      let j = i;
      while (j < n && text[j] !== '\n') j += 1;
      raw += text.slice(i, j);
      clean += ' ';
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth += 1; j += 2; } else if (text[j] === '*' && text[j + 1] === '/') { depth -= 1; j += 2; } else j += 1;
      }
      if (depth > 0) throw new SqlSplitError('unterminated');
      raw += text.slice(i, j);
      clean += ' ';
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      // E'...' strings treat a backslash as an escape; everything else only doubles the quote.
      const escapes = c === "'" && /[eE]/.test(text[i - 1] ?? '') && !IDENT_CHAR.test(text[i - 2] ?? ' ');
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new SqlSplitError('unterminated');
        if (escapes && text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) {
          if (text[j + 1] === c) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      raw += text.slice(i, j);
      clean += `${c}${c}`;
      i = j;
      continue;
    }
    if (c === '$' && !IDENT_CHAR.test(text[i - 1] ?? ' ')) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 130))?.[0];
      if (tag !== undefined) {
        const end = text.indexOf(tag, i + tag.length);
        if (end < 0) throw new SqlSplitError('unterminated');
        raw += text.slice(i, end + tag.length);
        clean += '$$';
        i = end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      push();
      i += 1;
      continue;
    }
    raw += c;
    clean += c;
    i += 1;
  }
  push();
  return out;
}

const words = (s: SqlStatement): string[] => s.clean.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);

/** begin / start transaction, commit / end, rollback / abort (also `rollback to savepoint`: any rollback is control). */
export function sqlControl(s: SqlStatement): SqlControl {
  const w = words(s);
  const first = w[0];
  if (first === 'begin') return 'begin';
  if (first === 'start' && w[1] === 'transaction') return 'begin';
  if (first === 'commit' || first === 'end') return w[1] === 'prepared' ? 'rollback' : 'commit';
  if (first === 'rollback' || first === 'abort') return 'rollback';
  if (first === 'prepare' && w[1] === 'transaction') return 'rollback';
  return null;
}

/** Statements the server refuses (or that would break) inside a transaction block, and SQL-standard bodies this splitter cannot read. */
export function unsupportedReason(s: SqlStatement): string | null {
  const w = words(s);
  const text = w.join(' ');
  if (/\bbegin atomic\b/.test(text)) return 'sql_standard_function_body';
  if (/^create (unique )?index concurrently\b/.test(text) || /^drop index concurrently\b/.test(text) || /^reindex .*concurrently\b/.test(text)) return 'concurrently';
  if (w[0] === 'vacuum' || w[0] === 'cluster' || text.startsWith('alter system') || text.startsWith('create database') || text.startsWith('drop database') || text.startsWith('create tablespace') || text.startsWith('drop tablespace')) return 'not_transactional';
  if (text.startsWith('alter type') && /\badd value\b/.test(text)) return 'enum_add_value';
  return null;
}

export type TransactionShape = 'wrapped' | 'own' | 'invalid';

/**
 * 'wrapped' = no top-level begin/commit/rollback at all (the runner supplies one transaction);
 * 'own'     = exactly the first statement is a begin and exactly the last is a commit, nothing else is transaction control
 *             (the runner does not wrap again);
 * 'invalid' = anything else (a begin without its commit, a commit without a begin, statements outside begin..commit, a rollback,
 *             control in the middle). Never guessed; refused.
 */
export function transactionShape(statements: readonly SqlStatement[]): TransactionShape {
  const controls = statements.map(sqlControl);
  const used = controls.filter((c) => c !== null);
  if (used.length === 0) return 'wrapped';
  if (statements.length >= 3 && used.length === 2 && controls[0] === 'begin' && controls[controls.length - 1] === 'commit') return 'own';
  return 'invalid';
}
