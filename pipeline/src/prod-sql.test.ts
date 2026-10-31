// Offline unit tests for the guarded production SQL runner (pipeline/src/prod-sql.ts, prod-sql-split.ts, prod-sql-runner.ts).
// No network and no database: the executor runs against an in-memory fake client that records exactly what it was sent.
// Connection strings below are synthetic planner inputs only.
// Run: npx tsx src/prod-sql.test.ts   (npm run test:prod-sql)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  L1_AUTH_TABLES, L1_USERS_TOKEN_COLUMNS, PROD_SQL_ACTIONS, PROD_SQL_ACTION_IDS, PROD_SQL_COMMANDS, PROD_SQL_COUNT_NAMES, PROD_SQL_IRREVERSIBLE_ACTIONS, PROD_SQL_MISSING, PROD_SQL_RESULTS, PROD_SQL_SHAPE_CHECKS, PROD_SQL_WARNINGS, PROD_SQL_WRAPS, PRODUCTION_PROMPT_PROOF_VARIABLE,
  evaluateL1Shape, executeProdSqlPlan, planProdSql, promptProof, selectProdSqlDbUrl, stageDigest, stagesTile, type ProdSqlAction, type ProdSqlFiles,
} from './prod-sql.js';
import { main as runnerMain, parseProdSqlArgs } from './prod-sql-runner.js';
import { splitSqlStatements, sqlControl, transactionShape, unsupportedReason } from './prod-sql-split.js';
import { REFUSAL_IDS, RunnerRefusal } from './refusals.js';
import { REPOSITORY_ROOT, type RebuiltSqlClient } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const url = (ref: string, port = 5432) => `postgresql://postgres.${ref}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
const PROD = url(RECORDED_PROJECT_REFS.production);
const action = (id: string) => PROD_SQL_ACTIONS.find((a) => a.id === id)!;
const plan = (id: string, over: Partial<Parameters<typeof planProdSql>[0]> = {}) => planProdSql({ target: 'production', action: id, dbUrl: PROD, confirm: action(id)?.phrase, ...over });

let passed = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); passed += 1; };
const refusalOf = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return e instanceof RunnerRefusal ? e.id : `other:${String(e)}`; } };
const real = (rel: string) => readFileSync(resolve(REPOSITORY_ROOT, rel));
/** Files with one path replaced by other bytes. */
const withFile = (rel: string, bytes: Buffer | ((orig: Buffer) => Buffer)): ProdSqlFiles => ({
  readFile: (p) => (p === rel ? (typeof bytes === 'function' ? bytes(real(rel)) : bytes) : real(p)),
});

// ---------------------------------------------------------------------------------------------------------------
// The action table
// ---------------------------------------------------------------------------------------------------------------
check('the table has unique ids and unique exact phrases, each phrase names its action', new Set(PROD_SQL_ACTION_IDS).size === PROD_SQL_ACTIONS.length && new Set(PROD_SQL_ACTIONS.map((a) => a.phrase)).size === PROD_SQL_ACTIONS.length && PROD_SQL_ACTIONS.every((a) => a.phrase === `RUN TNBS PRODUCTION SQL ${a.id.toUpperCase()}`));
check('every pinned file exists and matches its SHA-256 (the whole-file hash)', PROD_SQL_ACTIONS.every((a) => existsSync(resolve(REPOSITORY_ROOT, a.file)) && createHash('sha256').update(real(a.file)).digest('hex') === a.sha256));
check('every pin is a 64-digit lower-case hex string and every stage has its own pin', PROD_SQL_ACTIONS.every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && (a.statements === undefined) === (a.stageSha256 === undefined) && (a.stageSha256 === undefined || /^[0-9a-f]{64}$/.test(a.stageSha256))));
{
  const manifest = new Map(readFileSync(resolve(REPOSITORY_ROOT, 'docs/build-plan/migration-checksums.sha256'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split('\t') as [string, string]));
  const migrations = PROD_SQL_ACTIONS.filter((a) => a.file.startsWith('supabase/migrations/'));
  check('the four July migrations (A2) are in the table and agree with the reviewed checksum manifest', migrations.length === 4 && migrations.every((a) => a.manifestName !== undefined && manifest.get(a.manifestName) === a.sha256));
}
check('every doc 17 file that exists on this branch has an action (M1, M1b, M1c, snapshot, L1, retire-app-credentials, three backouts)',
  ['supabase/pending/M1_same_origin_signin.sql', 'supabase/pending/M1b_add_person.sql', 'supabase/pending/M1c_batch_delete_audit.sql', 'supabase/backout/pre-cutover-snapshot.sql', 'supabase/rollout/L1-close-legacy-auth.sql',
    'supabase/backout/retire-app-credentials.sql', 'supabase/backout/M1-backout.sql', 'supabase/backout/M1b-backout.sql', 'supabase/backout/M1c-backout.sql'].every((f) => PROD_SQL_ACTIONS.some((a) => a.file === f)));
check('the missing list is disjoint from the table and every listed file is really absent', PROD_SQL_MISSING.every((m) => !PROD_SQL_ACTION_IDS.includes(m.id) && (m.file === undefined || m.file.endsWith('09-production-baseline-reconciliation.sql') || !existsSync(resolve(REPOSITORY_ROOT, m.file)))));

const EXPECTED_SHAPE: Record<string, string> = { snapshot: 'read_only', m1: 'wrapped', m1b: 'own', m1c: 'own', 'backout-m1': 'own', 'backout-m1b': 'own', 'backout-m1c': 'own', 'l1-shape': 'read_only', 'l1-counts': 'read_only', 'l1-sweep': 'own',
  'retire-nologin': 'wrapped', 'retire-terminate': 'wrapped', 'retire-backends': 'read_only', 'retire-revoke': 'own', 'retire-checks': 'read_only', 'retire-email': 'read_only' };
check('every action plans offline with its own phrase and the detected transaction shape is the expected one', PROD_SQL_ACTIONS.every((a) => plan(a.id).shape === (EXPECTED_SHAPE[a.id] ?? 'wrapped')));
check('stage ranges tile the L1 and retire-app-credentials files from statement 1 through the parsed final statement, with no gap and no overlap',
  ['supabase/rollout/L1-close-legacy-auth.sql', 'supabase/backout/retire-app-credentials.sql'].every((file) => {
    const total = splitSqlStatements(real(file).toString('utf8')).length;
    const stages = PROD_SQL_ACTIONS.filter((a) => a.file === file).map((a) => a.statements!);
    return stages.length > 1 && stages.every((s, i) => s[0] === (i === 0 ? 1 : stages[i - 1]![1] + 1)) && stages[stages.length - 1]![1] === total && stagesTile(file, total);
  }));
{
  const fake = (ranges: Array<[number, number]>): ProdSqlAction[] => ranges.map((r, i) => ({ ...action('l1-counts'), id: `x${i}`, file: 'f.sql', statements: r }));
  check('stagesTile: exact tiling passes; a gap, an overlap, an unexecuted tail, a missing head, a reversed range and no stage at all fail',
    stagesTile('f.sql', 5, fake([[1, 2], [3, 5]])) && !stagesTile('f.sql', 5, fake([[1, 2], [4, 5]])) && !stagesTile('f.sql', 5, fake([[1, 3], [3, 5]])) && !stagesTile('f.sql', 6, fake([[1, 2], [3, 5]]))
    && !stagesTile('f.sql', 5, fake([[2, 5]])) && !stagesTile('f.sql', 5, fake([[1, 3], [5, 4]])) && !stagesTile('f.sql', 5, []) && stagesTile('f.sql', 5, fake([[3, 5], [1, 2]])));
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals (each one on its own)
// ---------------------------------------------------------------------------------------------------------------
check('refuses a file whose bytes changed (hash mismatch), for every action', PROD_SQL_ACTIONS.every((a) => refusalOf(() => plan(a.id, { files: withFile(a.file, (b) => Buffer.concat([b, Buffer.from('\n-- x\n')])) })) === 'prod_sql_hash_mismatch'));
check('refuses a one-byte change inside the file', refusalOf(() => plan('m1', { files: withFile(action('m1').file, (b) => { const c = Buffer.from(b); c[100] = c[100] === 0x41 ? 0x42 : 0x41; return c; }) })) === 'prod_sql_hash_mismatch');
check('refuses an empty replacement file', refusalOf(() => plan('m1b', { files: withFile(action('m1b').file, Buffer.alloc(0)) })) === 'prod_sql_hash_mismatch');
check('refuses a file that cannot be read', refusalOf(() => plan('m1', { files: { readFile: () => { throw new Error('ENOENT'); } } })) === 'prod_sql_file_unreadable');
check('a migration is refused when the checksum manifest disagrees with the pin', refusalOf(() => plan('migration-dnc-activity-enum-cast', { files: withFile('docs/build-plan/migration-checksums.sha256', (b) => Buffer.from(b.toString('utf8').replace('9c6677418675cc6f', '0c6677418675cc6f'))) })) === 'prod_sql_hash_mismatch');
check('a migration is refused when the manifest cannot be read', refusalOf(() => plan('migration-dnc-activity-enum-cast', { files: { readFile: (p) => { if (p.endsWith('.sha256')) throw new Error('x'); return real(p); } } })) === 'prod_sql_file_unreadable');
{
  // A stage pin refuses even when the whole-file hash is updated to match changed text (a stage edited together with its file hash).
  const a = action('l1-sweep');
  const edited = real(a.file).toString('utf8').replace('delete from auth.sessions;', 'delete from auth.sessions where false;');
  const hash = createHash('sha256').update(edited).digest('hex');
  const bad = { ...a, sha256: hash };
  const stages = splitSqlStatements(edited).slice(a.statements![0] - 1, a.statements![1]);
  check('a stage is pinned separately from the file hash (an edited stage does not match its stage pin)', stageDigest(stages) !== a.stageSha256 && bad.sha256 !== a.sha256);
}
/** Runs fn with some pins of the live action table changed, then puts them back (the table is plain data; nothing else is touched). */
const withPinsChanged = <T>(changes: Array<[ProdSqlAction, Partial<ProdSqlAction>]>, fn: () => T): T => {
  const saved = changes.map(([a]) => ({ ...a }));
  try { for (const [a, patch] of changes) Object.assign(a, patch); return fn(); } finally { changes.forEach(([a], i) => Object.assign(a, saved[i])); }
};
{
  // R2. A statement appended to a staged file, with the whole-file pins updated to match: no stage would ever run it, so every stage of that file is refused.
  for (const file of ['supabase/rollout/L1-close-legacy-auth.sql', 'supabase/backout/retire-app-credentials.sql']) {
    const appended = Buffer.concat([real(file), Buffer.from('\nselect 1;\n')]);
    const hash = createHash('sha256').update(appended).digest('hex');
    const staged = PROD_SQL_ACTIONS.filter((a) => a.file === file);
    check(`an appended statement with the whole-file pin updated and every stage pin kept is refused (shape) for every stage of ${file.split('/').pop()}`,
      staged.every((a) => withPinsChanged(staged.map((x) => [x, { sha256: hash }] as [ProdSqlAction, Partial<ProdSqlAction>]), () => refusalOf(() => plan(a.id, { files: withFile(file, appended) }))) === 'prod_sql_shape_refused'));
  }
  const sweep = action('l1-sweep'); const counts = action('l1-counts'); const shape = action('l1-shape');
  check('a gap is refused as a shape refusal by a stage whose own pin still matches (l1-counts)', withPinsChanged([[sweep, { statements: [5, 10] }]], () => refusalOf(() => plan('l1-counts'))) === 'prod_sql_shape_refused');
  check('an overlap between two stages is refused as a shape refusal (l1-shape, whose own pin still matches)', withPinsChanged([[counts, { statements: [2, 3] }]], () => refusalOf(() => plan('l1-shape'))) === 'prod_sql_shape_refused');
  check('a stage that stops short of the final statement is refused (l1-counts)', withPinsChanged([[sweep, { statements: [4, 9] }]], () => refusalOf(() => plan('l1-counts'))) === 'prod_sql_shape_refused');
  // The stage pin itself, behaviourally: with a wrong stage pin the plan is refused although the whole-file pin is right.
  check('a wrong stage pin is refused as a hash mismatch for every staged action (whole-file pin unchanged)', PROD_SQL_ACTIONS.filter((a) => a.statements !== undefined).every((a) => withPinsChanged([[a, { stageSha256: '0'.repeat(64) }]], () => refusalOf(() => plan(a.id))) === 'prod_sql_hash_mismatch'));
  check('a wrong pin on the shape stage refuses the gated sweep as well (the gate is verified against its own pin)', withPinsChanged([[shape, { stageSha256: '0'.repeat(64) }]], () => refusalOf(() => plan('l1-sweep'))) === 'prod_sql_hash_mismatch');
  check('a gate that names a stage of another file, a non-shape stage or nothing is refused', ['retire-checks', 'l1-counts', 'no-such-action'].every((g) => withPinsChanged([[sweep, { gate: g }]], () => refusalOf(() => plan('l1-sweep'))) === 'prod_sql_shape_refused'));
}
check('refuses --target=staging, local, empty and anything else', ['staging', 'local', 'prod', 'Production', '', 'localhost'].every((t) => refusalOf(() => plan('m1', { target: t })) === 'prod_sql_target_refused'));
check('refuses a missing --target (no default)', refusalOf(() => plan('m1', { target: undefined })) === 'bootstrap_target_required');
check('refuses the staging project and the rebuilt staging project even when --target=production', [RECORDED_PROJECT_REFS.staging, RECORDED_PROJECT_REFS.stagingRebuilt!, 'abcdefghijklmnopqrst'].every((ref) => refusalOf(() => plan('m1', { dbUrl: url(ref) })) === 'target_not_recorded_production'));
check('refuses a local address, a non-Supabase host and a query-parameter override (all plan_refused by the shared parser, never a connection)',
  ['postgresql://postgres:pw@127.0.0.1:5432/postgres', 'postgresql://postgres:pw@localhost:5433/tr_x', `postgresql://postgres.${RECORDED_PROJECT_REFS.production}:pw@db.example.com:5432/postgres`, `${PROD}?host=127.0.0.1`]
    .every((u) => { try { plan('m1', { dbUrl: u }); return false; } catch (e) { return !(e instanceof RunnerRefusal) && e instanceof Error; } }));
check('refuses a missing connection string', refusalOf(() => plan('m1', { dbUrl: undefined })) === 'db_url_required');
check('refuses the 6543 transaction pooler', refusalOf(() => plan('m1', { dbUrl: url(RECORDED_PROJECT_REFS.production, 6543) })) === 'port_must_be_5432');
check('refuses a missing phrase', refusalOf(() => plan('m1', { confirm: undefined })) === 'confirmation_required');
check('refuses a wrong, lower-case, padded and another action\'s phrase', ['run tnbs production sql m1', ' RUN TNBS PRODUCTION SQL M1', 'RUN TNBS PRODUCTION SQL M1 ', 'RUN TNBS PRODUCTION SQL M1B', 'yes', '']
  .every((p) => refusalOf(() => plan('m1', { confirm: p })) === 'confirmation_required'));
check('no action accepts any other action\'s phrase', PROD_SQL_ACTIONS.every((a) => PROD_SQL_ACTIONS.filter((b) => b.id !== a.id).every((b) => refusalOf(() => plan(a.id, { confirm: b.phrase })) === 'confirmation_required')));
check('refuses an unknown action', refusalOf(() => plan('m2', { confirm: 'x' })) === 'unknown_action');
check('refuses every action doc 17 names that is not a runnable file ("not built"), without inventing it', PROD_SQL_MISSING.every((m) => refusalOf(() => plan(m.id, { confirm: 'x' })) === 'prod_sql_action_not_built'));

// ---- Ambient URL: only the hidden prompt's proof is accepted.
{
  const proof = { [PRODUCTION_PROMPT_PROOF_VARIABLE]: promptProof(PROD) };
  check('an ambient PRODUCTION_DB_URL (no prompt proof) is refused', refusalOf(() => selectProdSqlDbUrl({ PRODUCTION_DB_URL: PROD })) === 'plan_refused');
  check('a PRODUCTION_DB_URL with a proof for a different value is refused', refusalOf(() => selectProdSqlDbUrl({ PRODUCTION_DB_URL: PROD, [PRODUCTION_PROMPT_PROOF_VARIABLE]: promptProof('other') })) === 'plan_refused');
  check('a PRODUCTION_DB_URL with its prompt proof is accepted', selectProdSqlDbUrl({ PRODUCTION_DB_URL: PROD, ...proof }) === PROD);
  check('a mixed environment (STAGING_DB_URL also set) is refused', refusalOf(() => selectProdSqlDbUrl({ PRODUCTION_DB_URL: PROD, ...proof, STAGING_DB_URL: url(RECORDED_PROJECT_REFS.stagingRebuilt!) })) === 'plan_refused');
  check('other ambient variables are never read (SUPABASE_DB_URL, DATABASE_URL)', selectProdSqlDbUrl({ SUPABASE_DB_URL: PROD, DATABASE_URL: PROD }) === undefined);
}

// ---- Plan-only is the default: nothing connects without --execute.
class Recorder extends EventEmitter {
  sent: string[] = [];
  connected = 0; ended = 0;
  constructor(private readonly onQuery: (sql: string) => unknown = () => ({ rows: [], rowCount: 0 })) { super(); }
  async connect() { assert.equal(this.listenerCount('error'), 1, 'the error listener is attached before connect'); this.connected += 1; }
  async end() { this.ended += 1; }
  // `sent` keeps the text exactly as sent; the handler sees the statement without comments and with collapsed whitespace.
  async query(sql: string) { this.sent.push(sql.trim()); return this.onQuery(splitSqlStatements(sql)[0]?.clean ?? sql.trim()); }
}
const captureLog = async (fn: () => Promise<void>): Promise<{ events: Array<Record<string, unknown>>; error?: unknown }> => {
  const events: Array<Record<string, unknown>> = [];
  const log = console.log; const err = console.error;
  console.log = (...a: unknown[]) => { try { events.push(JSON.parse(String(a[0]))); } catch { /* not an event */ } };
  console.error = () => undefined;
  try { await fn(); return { events }; } catch (e) { return { events, error: e }; } finally { console.log = log; console.error = err; }
};
const ENV = { PRODUCTION_DB_URL: PROD, [PRODUCTION_PROMPT_PROOF_VARIABLE]: promptProof(PROD) };
const argvFor = (id: string, extra: string[] = []) => ['--target=production', `--action=${id}`, `--confirm=${action(id).phrase}`, ...extra];
{
  let made = 0;
  const factory = (): RebuiltSqlClient => { made += 1; return new Recorder(); };
  const out = await captureLog(() => runnerMain(argvFor('m1'), ENV, factory));
  check('plan-only is the default: no client is even created, and the plan events are fixed', made === 0 && out.error === undefined && out.events.map((e) => e.msg).join() === 'prod-sql.verified,prod-sql.plan_only' && out.events[0]!.action === 'm1' && out.events[0]!.wrap === 'wrapped' && out.events[0]!.statements === 142);
  check('--confirm without --execute never connects, for every action', await (async () => { for (const a of PROD_SQL_ACTIONS) { await captureLog(() => runnerMain(argvFor(a.id), ENV, factory)); } return made === 0; })());
  const refused = await captureLog(() => runnerMain(argvFor('m1', ['--execute']), { PRODUCTION_DB_URL: PROD }, factory));
  check('--execute with an ambient URL is refused before any client exists', made === 0 && refused.error instanceof RunnerRefusal && refused.error.id === 'plan_refused');
  const noPhrase = await captureLog(() => runnerMain(['--target=production', '--action=m1', '--execute'], ENV, factory));
  check('--execute with no phrase is refused before any client exists', made === 0 && noPhrase.error instanceof RunnerRefusal && noPhrase.error.id === 'confirmation_required');
  const bad = await captureLog(() => runnerMain(['--target=production', '--action=m1', '--force'], ENV, factory));
  check('an unknown argument is refused', bad.error instanceof RunnerRefusal && bad.error.id === 'unknown_argument' && parseProdSqlArgs(['--execute']).execute === true && parseProdSqlArgs([]).execute === false);
  const wrongFile = await captureLog(() => runnerMain(argvFor('m1', ['--execute']), ENV, factory, withFile(action('m1').file, Buffer.from('select 1;'))));
  check('--execute with a changed file is refused before any client exists', made === 0 && wrongFile.error instanceof RunnerRefusal && wrongFile.error.id === 'prod_sql_hash_mismatch');
}

// ---------------------------------------------------------------------------------------------------------------
// Transaction detection
// ---------------------------------------------------------------------------------------------------------------
const stmts = (sql: string) => splitSqlStatements(sql);
check('M1 has no top-level begin/commit: the runner wraps it', transactionShape(stmts(real(action('m1').file).toString('utf8'))) === 'wrapped' && stmts(real(action('m1').file).toString('utf8')).every((s) => sqlControl(s) === null));
check('M1-backout has its own begin ... commit: the runner does not wrap it again', (() => { const s = stmts(real(action('backout-m1').file).toString('utf8')); return transactionShape(s) === 'own' && sqlControl(s[0]!) === 'begin' && sqlControl(s[s.length - 1]!) === 'commit'; })());
check('a plpgsql begin inside a DO block or a function body is not a transaction statement', transactionShape(stmts("do $$ begin perform 1; end $$; create function f() returns int language plpgsql as $f$ begin return 1; end $f$; select 'begin;';")) === 'wrapped');
check('semicolons and the word commit inside comments, strings and quoted identifiers do not split or count', (() => { const s = stmts("-- begin;\n/* commit; /* nested; */ */ select 'a;b''c; commit', \"x;y\", E'q\\';rollback' ; select 2"); return s.length === 2 && transactionShape(s) === 'wrapped'; })());
check('begin ... commit with statements between is "own"; "start transaction" and "end" count', transactionShape(stmts('begin; select 1; commit')) === 'own' && transactionShape(stmts('start transaction; select 1; end;')) === 'own');
check('a begin with no commit is invalid', transactionShape(stmts('begin; select 1;')) === 'invalid');
check('a commit with no begin is invalid', transactionShape(stmts('select 1; commit;')) === 'invalid');
check('statements before begin or after commit make it invalid (never guessed)', transactionShape(stmts('select 1; begin; select 2; commit;')) === 'invalid' && transactionShape(stmts('begin; select 2; commit; select 3;')) === 'invalid');
check('a rollback, a second begin or control in the middle is invalid', transactionShape(stmts('begin; select 1; rollback;')) === 'invalid' && transactionShape(stmts('begin; begin; select 1; commit;')) === 'invalid' && transactionShape(stmts('begin; select 1; commit; begin; select 2; commit;')) === 'invalid');
check('the whole retire-app-credentials and L1 files are invalid as one unit (they are run in stages)', ['supabase/backout/retire-app-credentials.sql', 'supabase/rollout/L1-close-legacy-auth.sql'].every((f) => transactionShape(stmts(real(f).toString('utf8'))) === 'invalid'));
check('psql meta-commands, unterminated strings and begin atomic are refused', (() => {
  const split = (t: string) => { try { splitSqlStatements(t); return 'ok'; } catch { return 'refused'; } };
  return split('\\i other.sql\nselect 1;') === 'refused' && split("select 'unterminated;") === 'refused' && split('select $$ open') === 'refused' && split('/* open') === 'refused'
    && unsupportedReason(stmts('create function f() returns int language sql begin atomic select 1; end')[0]!) === 'sql_standard_function_body'
    && unsupportedReason(stmts('create index concurrently i on t(a)')[0]!) === 'concurrently' && unsupportedReason(stmts('vacuum t')[0]!) === 'not_transactional'
    && unsupportedReason(stmts('alter type t add value \'x\'')[0]!) === 'enum_add_value' && unsupportedReason(stmts('select 1')[0]!) === null;
})());
check('a file with a statement that cannot run in a transaction is refused at plan time', refusalOf(() => plan('m1b', { files: withFile(action('m1b').file, Buffer.from('vacuum;')) })) === 'prod_sql_hash_mismatch');
check('the pinned files hold no unsupported statement', PROD_SQL_ACTIONS.every((a) => plan(a.id).statements.every((s) => unsupportedReason(s) === null)));

// Helpers for the L1 shape gate tests (below): the two shape selects answer from these rows.
const goodColumns = () => [
  ...['sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state'].map((t) => ({ table_name: t, column_name: 'id' })),
  ...L1_USERS_TOKEN_COLUMNS.map((c) => ({ table_name: 'users', column_name: c })), { table_name: 'users', column_name: 'id' },
];
const goodTables = () => [...L1_AUTH_TABLES, 'schema_migrations'].map((t) => ({ table_name: t }));
const SHAPE_COLUMNS_SQL = 'select table_name, column_name from information_schema.columns';
const SHAPE_TABLES_SQL = 'select table_name from information_schema.tables';
/** A fake database whose two shape selects answer with the given rows; every other statement answers with a row count of 3. */
const shapeClient = (columns: unknown, tables: unknown, extra: (sql: string) => unknown = () => undefined) => new Recorder((sql) => {
  if (sql.startsWith(SHAPE_COLUMNS_SQL)) return { rows: columns, rowCount: Array.isArray(columns) ? columns.length : 0 };
  if (sql.startsWith(SHAPE_TABLES_SQL)) return { rows: tables, rowCount: Array.isArray(tables) ? tables.length : 0 };
  return extra(sql) ?? { rows: [], rowCount: 3 };
});
const shapeEvent = (events: Array<Record<string, unknown>>) => events.find((e) => e.msg === 'prod-sql.shape') as { action: string; checks: Record<string, boolean>; auth_tables: number; auth_tables_unreviewed: number; passed: boolean } | undefined;

// ---------------------------------------------------------------------------------------------------------------
// Execution against a fake client
// ---------------------------------------------------------------------------------------------------------------
const runPlan = async (id: string, client: Recorder) => captureLog(() => executeProdSqlPlan(plan(id), () => client));
const resultsOf = (events: Array<Record<string, unknown>>) => events.filter((e) => e.msg === 'prod-sql.result').map((e) => e.result);
// The file's own begin/commit are sent as written (with their leading comments), so they are recognised by their SQL control word, not by exact text.
const ctlOf = (s: string) => { const first = splitSqlStatements(s)[0]; return first === undefined ? null : sqlControl(first); };
const nonStatement = (sent: string[]) => sent.filter((s) => ctlOf(s) !== null || s.startsWith('set local')).map((s) => ctlOf(s) ?? s);
{
  const c = new Recorder();
  const out = await runPlan('m1', c);
  check('wrapped file: begin, lock timeout, every statement in order, then one commit; reported committed', out.error === undefined && c.sent[0] === 'begin' && c.sent[1] === "set local lock_timeout = '10s'" && c.sent.length === 142 + 3 && c.sent[c.sent.length - 1] === 'commit' && c.sent.filter((s) => s === 'commit').length === 1 && resultsOf(out.events).join() === 'committed' && out.events[0]!.statements === 142 && c.ended === 1);
}
{
  const c = new Recorder();
  const out = await runPlan('backout-m1', c);
  const all = c.sent.map((s) => ctlOf(s));
  check('own file: the runner does not double-wrap (exactly one begin and one commit are sent, both from the file)', out.error === undefined && nonStatement(c.sent).join('|') === `begin|set local lock_timeout = '10s'|commit` && all.filter((w) => w === 'begin').length === 1 && resultsOf(out.events).join() === 'committed');
  check('own file: the first statement sent is the file\'s own begin, the last is its own commit', ctlOf(c.sent[0]!) === 'begin' && ctlOf(c.sent[c.sent.length - 1]!) === 'commit' && c.sent[0] !== 'begin' && c.sent.length === 104 + 1);
}
{
  const c = new Recorder();
  const out = await runPlan('snapshot', c);
  check('read-only action: begin read only, statements, rollback; never a commit; reported read_only_done', out.error === undefined && c.sent[0] === 'begin read only' && c.sent[c.sent.length - 1] === 'rollback' && !c.sent.includes('commit') && !c.sent.some((s) => s.startsWith('set local')) && resultsOf(out.events).join() === 'read_only_done');
  check('read-only action with a digest reports a fixed statement event per statement (index, command word, row count, SHA-256 of the rows)', out.events.filter((e) => e.msg === 'prod-sql.statement').length === 8 && out.events.filter((e) => e.msg === 'prod-sql.statement').every((e) => e.command === 'select' && /^[0-9a-f]{64}$/.test(String(e.digest)) && e.rows === 0));
}
{
  const c = new Recorder((sql) => (sql.startsWith('select (select count(*) from auth.sessions)') ? { rows: [{ sessions: '0', refresh_tokens: '0', one_time_tokens: '3', flow_state: '0', users_with_tokens: '0', secret_column: 'leak@example.com' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  const out = await runPlan('l1-counts', c);
  const counts = out.events.find((e) => e.msg === 'prod-sql.counts');
  check('counts action prints only the pinned column names with numbers; an extra column is never printed', JSON.stringify(counts?.counts) === JSON.stringify({ sessions: 0, refresh_tokens: 0, one_time_tokens: 3, flow_state: 0, users_with_tokens: 0 }) && !JSON.stringify(out.events).includes('leak'));
  const c2 = new Recorder(() => ({ rows: [{ sessions: 'not a number', refresh_tokens: 5 }, { sessions: 1 }], rowCount: 2 }));
  const out2 = await runPlan('l1-counts', c2);
  check('a counts result that is not exactly one row, or a non-numeric value, is reported as -1, never as text', Object.values(out2.events.find((e) => e.msg === 'prod-sql.counts')!.counts as Record<string, number>).every((v) => v === -1));
}
{
  const c = shapeClient(goodColumns(), goodTables(), (sql) => (sql.startsWith('delete from auth.refresh_tokens') ? { rows: [], rowCount: 4 } : { rows: [], rowCount: 0 }));
  const out = await runPlan('l1-sweep', c);
  const rows = out.events.filter((e) => e.msg === 'prod-sql.statement');
  check('L1 sweep stage runs as written (own begin/commit, no extra wrap) and reports rows changed per statement as numbers', out.error === undefined && rows.length === 5 && rows[0]!.rows === 4 && rows[0]!.command === 'delete' && rows[4]!.command === 'update' && !rows.some((e) => 'digest' in e) && ctlOf(c.sent[0]!) === 'begin' && c.sent[0] !== 'begin' && ctlOf(c.sent[c.sent.length - 1]!) === 'commit');
}
{
  // A failure in the middle of a wrapped file: rolled back, acknowledged, never committed; the driver text is not in the events.
  const c = new Recorder((sql) => { if (sql.includes('create table')) throw Object.assign(new Error('relation "secret_name" already exists at host db.example.com'), { code: '42P07' }); return { rows: [], rowCount: 0 }; });
  const out = await runPlan('m1', c);
  check('a mid-file failure rolls back, never commits, reports rolled_back with the number of statements that ran', out.error !== undefined && c.sent[c.sent.length - 1] === 'rollback' && !c.sent.includes('commit') && resultsOf(out.events).join() === 'rolled_back' && Number(out.events[0]!.statements) < 142 && !JSON.stringify(out.events).includes('secret_name') && c.ended === 1);
}
{
  const c = new Recorder((sql) => { if (sql.includes('create table')) throw new Error('boom'); if (sql === 'rollback') throw new Error('connection lost'); return { rows: [], rowCount: 0 }; });
  const out = await runPlan('m1', c);
  check('a failed ROLLBACK is reported as rollback_not_confirmed (the operator still stops and reads the state)', out.error !== undefined && resultsOf(out.events).join() === 'rollback_not_confirmed');
}
for (const id of ['m1', 'backout-m1c']) {
  // CR17: a COMMIT that fails is UNKNOWN, never retried, never rolled back, never called refused.
  const commitSql = 'commit';
  const c = new Recorder((sql) => { if (sql === commitSql) throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATALER FEHLER' }); return { rows: [], rowCount: 0 }; });
  const out = await runPlan(id, c);
  check(`${id}: a failed COMMIT is unknown, sent exactly once, never rolled back, never retried`, out.error !== undefined && c.sent.filter((s) => ctlOf(s) === 'commit').length === 1 && !c.sent.includes('rollback') && resultsOf(out.events).join() === 'unknown' && (out.error as Error).name === 'ProdSqlResultUnknown');
}
{
  const c = new Recorder((sql) => (sql === 'commit' ? { command: 'ROLLBACK', rows: [], rowCount: null } : { rows: [], rowCount: 0 }));
  const out = await runPlan('m1', c);
  check('a COMMIT that returns the ROLLBACK tag is a definite failure: a fixed refusal, one rollback, reported rolled_back, never "unknown"', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_commit_rolled_back' && resultsOf(out.events).join() === 'rolled_back' && c.sent.filter((s) => s === 'commit').length === 1);
}
{
  // Severity text is never read: a localized severity does not change the classification.
  const c = new Recorder((sql) => { if (sql === 'commit') throw Object.assign(new Error('x'), { code: 'ZZ999', severity: 'FATALER FEHLER' }); return { rows: [], rowCount: 0 }; });
  const out = await runPlan('m1', c);
  check('a localized severity on a failed COMMIT still reports unknown', resultsOf(out.events).join() === 'unknown');
}
{
  const c = new Recorder();
  const out = await runPlan('retire-nologin', c);
  check('a single-statement write stage is wrapped in one transaction', out.error === undefined && nonStatement(c.sent).join('|') === "begin|set local lock_timeout = '10s'|commit" && c.sent.length === 4);
}

// ---------------------------------------------------------------------------------------------------------------
// R1. The L1 shape gate: required tables and columns, a reviewed table inventory, fixed names and booleans only, a stop on anything else
// ---------------------------------------------------------------------------------------------------------------
{
  const ok = evaluateL1Shape(goodColumns(), goodTables());
  check('evaluateL1Shape: the full reviewed shape passes; the check names are exactly the fixed list; every check is true', ok.passed && JSON.stringify(Object.keys(ok.checks)) === JSON.stringify([...PROD_SQL_SHAPE_CHECKS]) && Object.values(ok.checks).every((v) => v === true) && ok.authTables === 6 && ok.unreviewedAuthTables === 0 && PROD_SQL_SHAPE_CHECKS.length === 13);
  const noToken = evaluateL1Shape(goodColumns().filter((r) => r.column_name !== 'confirmation_token'), goodTables());
  check('evaluateL1Shape: a missing users token column fails exactly that check', !noToken.passed && noToken.checks.users_confirmation_token === false && Object.entries(noToken.checks).filter(([, v]) => !v).length === 1);
  for (const c of L1_USERS_TOKEN_COLUMNS) check(`evaluateL1Shape: a missing ${c} column fails`, !evaluateL1Shape(goodColumns().filter((r) => r.column_name !== c), goodTables()).passed);
  for (const t of L1_AUTH_TABLES) check(`evaluateL1Shape: a missing ${t} table fails`, !evaluateL1Shape(goodColumns().filter((r) => r.table_name !== t || t === 'users'), goodTables().filter((r) => r.table_name !== t)).passed);
  const extra = evaluateL1Shape(goodColumns(), [...goodTables(), { table_name: 'a_secret_extra_table' }, { table_name: 'another_one' }]);
  check('evaluateL1Shape: unlisted auth tables fail the inventory check and are only counted, never named', !extra.passed && extra.checks.no_unreviewed_auth_tables === false && extra.unreviewedAuthTables === 2 && extra.authTables === 8 && !JSON.stringify(extra).includes('secret'));
  check('evaluateL1Shape: a table list with a row that has no name fails the inventory; results that are not lists fail every check', !evaluateL1Shape(goodColumns(), [...goodTables(), { table_name: null }]).passed
    && Object.values(evaluateL1Shape(undefined, 'x').checks).every((v) => v === false) && !evaluateL1Shape(null, null).passed && !evaluateL1Shape([], []).passed);
  check('evaluateL1Shape: a column of the right name on the wrong table, and a table that is listed without any column rows, do not count', !evaluateL1Shape(goodColumns().map((r) => (r.column_name === 'recovery_token' ? { ...r, table_name: 'sessions' } : r)), goodTables()).passed
    && !evaluateL1Shape(goodColumns().filter((r) => r.table_name !== 'flow_state'), goodTables()).passed);
}
{
  const c = shapeClient(goodColumns(), goodTables());
  const out = await runPlan('l1-shape', c);
  const ev = shapeEvent(out.events);
  check('l1-shape with the reviewed shape: read_only_done, one shape event that passed, no digest of database rows anywhere, a read-only transaction that is rolled back', out.error === undefined && resultsOf(out.events).join() === 'read_only_done' && ev?.passed === true && ev.action === 'l1-shape' && ev.auth_tables === 6 && ev.auth_tables_unreviewed === 0
    && !out.events.some((e) => 'digest' in e) && c.sent[0] === 'begin read only' && c.sent[c.sent.length - 1] === 'rollback' && !c.sent.includes('commit'));
  const hidden = shapeClient(goodColumns().filter((r) => r.column_name !== 'confirmation_token'), goodTables());
  const bad = await runPlan('l1-shape', hidden);
  check('l1-shape with a hidden confirmation_token column: refused (prod_sql_l1_shape_not_ok), the failing check is named from the fixed list, rolled back, nothing written', bad.error instanceof RunnerRefusal && bad.error.id === 'prod_sql_l1_shape_not_ok' && shapeEvent(bad.events)?.passed === false && shapeEvent(bad.events)?.checks.users_confirmation_token === false && resultsOf(bad.events).join() === 'rolled_back' && !hidden.sent.includes('commit'));
  const unlisted = shapeClient(goodColumns(), [...goodTables(), { table_name: 'review_unlisted_credentials' }]);
  const stop = await runPlan('l1-shape', unlisted);
  check('l1-shape with an extra unlisted auth table: refused, the table is counted but its name appears nowhere in the output', stop.error instanceof RunnerRefusal && stop.error.id === 'prod_sql_l1_shape_not_ok' && shapeEvent(stop.events)?.auth_tables_unreviewed === 1 && shapeEvent(stop.events)?.checks.no_unreviewed_auth_tables === false && !JSON.stringify(stop.events).includes('review_unlisted'));
}
{
  const good = shapeClient(goodColumns(), goodTables(), (sql) => (sql.startsWith('delete from auth.refresh_tokens') ? { rows: [], rowCount: 4 } : undefined));
  const out = await runPlan('l1-sweep', good);
  const firstDelete = good.sent.findIndex((s) => s.startsWith('delete from'));
  const gateAt = [good.sent.findIndex((s) => s.includes('information_schema.columns')), good.sent.findIndex((s) => s.includes('information_schema.tables'))];
  check('l1-sweep with the reviewed shape: the two shape selects run inside the same transaction, after the lock timeout and before the first delete; then the sweep commits as before', out.error === undefined && resultsOf(out.events).join() === 'committed' && shapeEvent(out.events)?.passed === true && shapeEvent(out.events)?.action === 'l1-sweep'
    && gateAt[0] === 2 && gateAt[1] === 3 && gateAt[1]! < firstDelete && ctlOf(good.sent[0]!) === 'begin' && good.sent[1] === "set local lock_timeout = '10s'" && ctlOf(good.sent[good.sent.length - 1]!) === 'commit' && out.events.filter((e) => e.msg === 'prod-sql.statement').length === 5);
  for (const [name, columns, tables] of [
    ['an extra unlisted auth table', goodColumns(), [...goodTables(), { table_name: 'review_unlisted_credentials' }]],
    ['a hidden confirmation_token column', goodColumns().filter((r) => r.column_name !== 'confirmation_token'), goodTables()],
    ['a missing one_time_tokens table', goodColumns().filter((r) => r.table_name !== 'one_time_tokens'), goodTables().filter((r) => r.table_name !== 'one_time_tokens')],
  ] as const) {
    const c = shapeClient(columns, tables);
    const stopped = await runPlan('l1-sweep', c);
    check(`l1-sweep with ${name}: refused before any delete or update; rolled back; never committed; the stop is in the same run`, stopped.error instanceof RunnerRefusal && stopped.error.id === 'prod_sql_l1_shape_not_ok' && !c.sent.some((s) => /^(delete|update)\b/.test(s)) && !c.sent.some((s) => ctlOf(s) === 'commit') && c.sent[c.sent.length - 1] === 'rollback'
      && resultsOf(stopped.events).join() === 'rolled_back' && shapeEvent(stopped.events)?.passed === false && stopped.events.filter((e) => e.msg === 'prod-sql.statement').length === 0 && !JSON.stringify(stopped.events).includes('review_unlisted'));
  }
  const empty = await runPlan('l1-sweep', new Recorder(() => ({ rows: [], rowCount: 0 })));
  check('l1-sweep against a database that returns no shape rows at all: refused (an empty answer never passes the gate)', empty.error instanceof RunnerRefusal && empty.error.id === 'prod_sql_l1_shape_not_ok');
  const counts = await runPlan('l1-counts', new Recorder(() => ({ rows: [], rowCount: 0 })));
  check('l1-counts and the other actions are not gated and print no shape event; only l1-sweep has a gate and only l1-shape is a shape stage', counts.error === undefined && shapeEvent(counts.events) === undefined && PROD_SQL_ACTIONS.filter((a) => a.gate !== undefined).map((a) => a.id).join() === 'l1-sweep' && PROD_SQL_ACTIONS.filter((a) => a.report === 'shape').map((a) => a.id).join() === 'l1-shape');
}

// ---------------------------------------------------------------------------------------------------------------
// Output: every event the runner can print passes the wrapper's allow-list with nothing withheld, and nothing sensitive appears
// ---------------------------------------------------------------------------------------------------------------
const wrapper = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
{
  check('the wrapper allow-list names equal the runner lists', JSON.stringify([...wrapper.PROD_SQL_ACTIONS]) === JSON.stringify(PROD_SQL_ACTION_IDS) && JSON.stringify([...wrapper.PROD_SQL_COUNT_NAMES].sort()) === JSON.stringify([...PROD_SQL_COUNT_NAMES].sort())
    && JSON.stringify([...wrapper.PROD_SQL_COMMANDS]) === JSON.stringify([...PROD_SQL_COMMANDS]) && JSON.stringify([...wrapper.PROD_SQL_RESULTS]) === JSON.stringify([...PROD_SQL_RESULTS]) && JSON.stringify([...wrapper.PROD_SQL_WRAPS]) === JSON.stringify([...PROD_SQL_WRAPS]) && JSON.stringify([...wrapper.PROD_SQL_SHAPE_CHECKS]) === JSON.stringify([...PROD_SQL_SHAPE_CHECKS]));
  check('the new refusal identifiers are in both lists', ['prod_sql_target_refused', 'prod_sql_action_not_built', 'prod_sql_file_unreadable', 'prod_sql_hash_mismatch', 'prod_sql_shape_refused', 'prod_sql_commit_rolled_back', 'prod_sql_l1_shape_not_ok'].every((id) => (REFUSAL_IDS as readonly string[]).includes(id) && wrapper.REFUSAL_IDS.includes(id)));
  const all: Array<Record<string, unknown>> = [];
  for (const a of PROD_SQL_ACTIONS) {
    const c = new Recorder((sql) => ({ rows: [Object.fromEntries((a.countNames ?? ['x']).map((n) => [n, '7']))], rowCount: 1, command: sql === 'commit' ? 'COMMIT' : undefined }));
    all.push(...(await runPlan(a.id, c)).events);
    all.push(...(await captureLog(() => runnerMain(argvFor(a.id), ENV))).events);
  }
  const counter = { fields: 0 };
  const shown = all.map((e) => wrapper.allowListLine(JSON.stringify(e), counter));
  check('every event the runner prints for every action passes the wrapper allow-list: 0 withheld lines, 0 withheld fields', shown.every((s: string | null) => s !== null) && counter.fields === 0 && all.length > PROD_SQL_ACTIONS.length * 3);
  check('the event names are exactly the new prod-sql family', [...new Set(all.map((e) => e.msg))].sort().join() === 'prod-sql.counts,prod-sql.plan_only,prod-sql.result,prod-sql.shape,prod-sql.statement,prod-sql.verified,prod-sql.warning');
  {
    const good = await runPlan('l1-shape', shapeClient(goodColumns(), goodTables()));
    const bad = await runPlan('l1-sweep', shapeClient(goodColumns(), [...goodTables(), { table_name: 'x' }]));
    const counter2 = { fields: 0 };
    check('the shape events (passed and failed, from l1-shape and from l1-sweep) pass the wrapper allow-list with nothing withheld', [...good.events, ...bad.events].filter((e) => e.msg === 'prod-sql.shape').length === 2 && [...good.events, ...bad.events].every((e) => wrapper.allowListLine(JSON.stringify(e), counter2) !== null) && counter2.fields === 0);
    const counter3 = { fields: 0 };
    const shown = JSON.parse(wrapper.allowListLine(JSON.stringify({ msg: 'prod-sql.shape', action: 'm1', checks: { table_users: 'yes', secret_table: true }, auth_tables: 'many', auth_tables_unreviewed: 1, passed: true, table_names: ['x'] }), counter3));
    check('the allow-list withholds a shape event with another action, a non-boolean check, an unknown check name, a non-numeric count, and drops an unknown key', shown.action === '<withheld>' && shown.checks === '<withheld>' && shown.auth_tables === '<withheld>' && !('table_names' in shown) && counter3.fields === 4);
  }
  const text = JSON.stringify(all);
  check('no output contains the address, the password, the host or a driver word', !/redacted-pw|pooler\.supabase|postgres\.|aws-0|postgresql:|ECONN|select |insert into/i.test(text));
  const deliberately = [
    { msg: 'prod-sql.statement', action: 'm1', index: 1, command: 'select', rows: 1, digest: 'not-hex' }, { msg: 'prod-sql.counts', action: 'l1-counts', index: 1, counts: { email_address: 5 } }, { msg: 'prod-sql.counts', action: 'l1-counts', index: 1, counts: { sessions: 'abc' } },
    { msg: 'prod-sql.result', action: 'm1', result: 'ok; secret', statements: 1 }, { msg: 'prod-sql.verified', action: 'not-an-action', target: 'staging', statements: 1, wrap: 'x', sha256: 'zz' }, { msg: 'prod-sql.refused', refusal: 'free text', err_code: 'password=x' },
    { msg: 'prod-sql.result', action: 'm1', result: 'committed', statements: 1, message: 'relation x' },
  ];
  const c2 = { fields: 0 };
  deliberately.forEach((e) => wrapper.allowListLine(JSON.stringify(e), c2));
  check('the allow-list withholds non-hex digests, unpinned count names, non-numeric counts, free text, other targets and unknown keys (11 fields)', c2.fields === 11);
  check('an unknown prod-sql event name is withheld as a whole line', wrapper.allowListLine('{"msg":"prod-sql.sql_text","sql":"select 1"}') === null);
}

// ---------------------------------------------------------------------------------------------------------------
// B2 (re-review of eafc55b): ending connections cannot be undone by a rollback, so it is warned about with the plan, before any connection,
// and again after a failed run. The warning is a fixed, allow-listed event; it is printed for no other action.
// ---------------------------------------------------------------------------------------------------------------
{
  check('only retire-terminate carries the irreversible flag, and the wrapper names exactly that action', PROD_SQL_IRREVERSIBLE_ACTIONS.join() === 'retire-terminate' && JSON.stringify([...wrapper.PROD_SQL_IRREVERSIBLE_ACTIONS]) === JSON.stringify(PROD_SQL_IRREVERSIBLE_ACTIONS));
  check('every action whose pinned statements call pg_terminate_backend carries the flag, and no other action does (so L1 has none: it has no termination statement)', PROD_SQL_ACTIONS.every((a) => plan(a.id).statements.some((s) => /pg_terminate_backend/i.test(s.clean)) === (a.irreversible !== undefined)));
  check('the warning ids and sentences in the wrapper equal the runner', JSON.stringify(wrapper.PROD_SQL_WARNINGS) === JSON.stringify(PROD_SQL_WARNINGS));
  check('the sentences say: ends connections, cannot be undone, a rollback does not restore them, stop and read the real count; and they hold no placeholder or address',
    /ENDS every database connection/.test(PROD_SQL_WARNINGS.connections_end_cannot_be_undone) && /cannot be brought back/.test(PROD_SQL_WARNINGS.connections_end_cannot_be_undone) && /rollback does not restore/.test(PROD_SQL_WARNINGS.connections_end_cannot_be_undone)
    && /rolled_back or unknown/.test(PROD_SQL_WARNINGS.rollback_does_not_restore_connections) && /stay ended/.test(PROD_SQL_WARNINGS.rollback_does_not_restore_connections) && /STOP/.test(PROD_SQL_WARNINGS.rollback_does_not_restore_connections) && /retire-backends/.test(PROD_SQL_WARNINGS.rollback_does_not_restore_connections)
    && Object.values(PROD_SQL_WARNINGS).every((t) => !/[{}<>]|https?:|postgres/i.test(t)));
  let made = 0;
  const factory = (): RebuiltSqlClient => { made += 1; console.log(JSON.stringify({ msg: 'test.client_created' })); return new Recorder(); };
  const planOnly = await captureLog(() => runnerMain(argvFor('retire-terminate'), ENV, factory));
  const warned = planOnly.events.find((e) => e.msg === 'prod-sql.warning');
  check('plan-only for retire-terminate: verified, then the fixed warning, then plan_only; nothing connects', made === 0 && planOnly.error === undefined && planOnly.events.map((e) => e.msg).join() === 'prod-sql.verified,prod-sql.warning,prod-sql.plan_only'
    && warned?.action === 'retire-terminate' && warned.warning === 'connections_end_cannot_be_undone' && warned.notice === PROD_SQL_WARNINGS.connections_end_cannot_be_undone && Object.keys(warned).sort().join() === 'action,msg,notice,warning');
  const exec = await captureLog(() => runnerMain(argvFor('retire-terminate', ['--execute']), ENV, factory));
  check('--execute for retire-terminate: the warning is printed before the client is even created, and the run then reports its result', made === 1 && exec.error === undefined
    && exec.events.map((e) => e.msg).join() === 'prod-sql.verified,prod-sql.warning,test.client_created,prod-sql.statement,prod-sql.result,prod-sql.done');
  const others: Array<Record<string, unknown>> = [];
  for (const a of PROD_SQL_ACTIONS.filter((x) => x.id !== 'retire-terminate')) others.push(...(await captureLog(() => runnerMain(argvFor(a.id), ENV, factory))).events);
  check('no other action prints a warning in its plan', others.length > 0 && !others.some((e) => e.msg === 'prod-sql.warning'));
  // After a failed run: the warning follows the result, for each way a run can end without a confirmed commit.
  const terminate = (sql: string) => /pg_terminate_backend/.test(sql);
  const failed = async (onQuery: (sql: string) => unknown) => runPlan('retire-terminate', new Recorder(onQuery));
  const afterFailure = (o: { events: Array<Record<string, unknown>>; error?: unknown }, result: string) => {
    const i = o.events.findIndex((e) => e.msg === 'prod-sql.result');
    const w = o.events[i + 1];
    return o.error !== undefined && o.events[i]?.result === result && w?.msg === 'prod-sql.warning' && w.warning === 'rollback_does_not_restore_connections' && w.notice === PROD_SQL_WARNINGS.rollback_does_not_restore_connections && o.events.filter((e) => e.msg === 'prod-sql.warning').length === 1;
  };
  check('a failure after the termination statement: rolled_back is followed by the warning that connections stay ended', afterFailure(await failed((sql) => { if (terminate(sql)) throw new Error('result handling failed'); return { rows: [], rowCount: 0 }; }), 'rolled_back'));
  check('a failed rollback: rollback_not_confirmed is followed by the same warning', afterFailure(await failed((sql) => { if (terminate(sql)) throw new Error('boom'); if (sql === 'rollback') throw new Error('connection lost'); return { rows: [], rowCount: 0 }; }), 'rollback_not_confirmed'));
  check('a failed COMMIT: unknown is followed by the same warning', afterFailure(await failed((sql) => { if (sql === 'commit') throw new Error('connection lost'); return { rows: [], rowCount: 0 }; }), 'unknown'));
  const ok = await failed(() => ({ rows: [], rowCount: 2 }));
  check('a successful retire-terminate run prints no after-failure warning', ok.error === undefined && !ok.events.some((e) => e.msg === 'prod-sql.warning'));
  const m1failed = await runPlan('m1', new Recorder((sql) => { if (sql.includes('create table')) throw new Error('boom'); return { rows: [], rowCount: 0 }; }));
  check('a failed run of an action without the flag prints no warning', m1failed.error !== undefined && !m1failed.events.some((e) => e.msg === 'prod-sql.warning'));
  // The wrapper passes the fixed events and withholds anything altered.
  const counter = { fields: 0 };
  const passed = [...planOnly.events, ...exec.events, ...(await failed((sql) => { if (terminate(sql)) throw new Error('x'); return { rows: [], rowCount: 0 }; })).events].filter((e) => e.msg === 'prod-sql.warning');
  check('both warning events pass the wrapper allow-list with nothing withheld', passed.length === 3 && passed.every((e) => wrapper.allowListLine(JSON.stringify(e), counter) !== null) && counter.fields === 0);
  const tampered = { msg: 'prod-sql.warning', action: 'm1', warning: 'be careful', notice: 'free text from the database', extra: 'x' };
  const counter2 = { fields: 0 };
  const shown = JSON.parse(wrapper.allowListLine(JSON.stringify(tampered), counter2));
  check('the allow-list withholds a warning for another action, an unknown warning id, a free-text notice, and drops an unknown key', shown.action === '<withheld>' && shown.warning === '<withheld>' && shown.notice === '<withheld>' && !('extra' in shown) && counter2.fields === 4);
}

// ---------------------------------------------------------------------------------------------------------------
// The real executable, offline: plan-only and refusals as a subprocess (no socket can be opened: nothing connects)
// ---------------------------------------------------------------------------------------------------------------
{
  const tsx = resolve(REPOSITORY_ROOT, 'pipeline/node_modules/tsx/dist/cli.mjs');
  const runner = resolve(REPOSITORY_ROOT, 'pipeline/src/prod-sql-runner.ts');
  const base = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' };
  const exec = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, [tsx, runner, ...args], { cwd: REPOSITORY_ROOT, env: { ...base, ...env }, encoding: 'utf8', timeout: 60000 });
  const evs = (s: string) => s.split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
  const plain = exec(argvFor('m1b'), ENV);
  check('executable, plan-only: exit 0, verified then plan_only, and the output has no secret', plain.status === 0 && evs(plain.stdout).map((e) => e.msg).join() === 'prod-sql.verified,prod-sql.plan_only' && !plain.stdout.includes('redacted-pw') && plain.stderr === '');
  const terminating = exec(argvFor('retire-terminate'), ENV);
  check('executable, plan-only for retire-terminate: the fixed warning is printed between verified and plan_only, and passes the wrapper allow-list', terminating.status === 0 && evs(terminating.stdout).map((e) => e.msg).join() === 'prod-sql.verified,prod-sql.warning,prod-sql.plan_only'
    && evs(terminating.stdout)[1]!.notice === PROD_SQL_WARNINGS.connections_end_cannot_be_undone && terminating.stdout.split(/\r?\n/).filter(Boolean).every((l) => wrapper.allowListLine(l, { fields: 0 }) !== null) && terminating.stderr === '');
  const ambient = exec(argvFor('m1b', ['--execute']), { PRODUCTION_DB_URL: PROD });
  check('executable, ambient URL with --execute: refused (plan_refused), exit 1, nothing connected', ambient.status === 1 && evs(ambient.stderr).some((e) => e.msg === 'prod-sql.refused' && e.refusal === 'plan_refused') && !ambient.stderr.includes('redacted-pw'));
  const staging = exec(['--target=staging', '--action=m1b', `--confirm=${action('m1b').phrase}`, '--execute'], { ...ENV });
  check('executable, --target=staging: refused (prod_sql_target_refused), exit 1', staging.status === 1 && evs(staging.stderr).some((e) => e.refusal === 'prod_sql_target_refused'));
  for (const out of [plain, ambient, staging]) {
    const counter = { fields: 0 };
    const lines = (out.stdout + out.stderr).split(/\r?\n/).filter(Boolean);
    check('executable output passes the wrapper allow-list on both streams', lines.every((l) => wrapper.allowListLine(l, counter) !== null) && counter.fields === 0);
  }
}

console.log(`prod-sql: ${passed} checks passed`);
