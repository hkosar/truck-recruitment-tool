// Offline unit tests for the guarded production SQL runner (pipeline/src/prod-sql.ts, prod-sql-split.ts, prod-sql-runner.ts).
// No network and no database: the executor runs against an in-memory fake client that records exactly what it was sent.
// Connection strings below are synthetic planner inputs only.
// Run: npx tsx src/prod-sql.test.ts   (npm run test:prod-sql)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  STOP_CLASSIFICATION, stopTablesOf, readStopTables, AUTH_CLASSIFICATIONS, AUTH_CLASSIFICATION_FILE, AUTH_CLASSIFICATION_SHA256, L1_AUTH_TABLES, L1_USERS_TOKEN_COLUMNS, PROD_SQL_ACTIONS, PROD_SQL_ACTION_IDS, PROD_SQL_COMMANDS, PROD_SQL_COUNT_NAMES, PROD_SQL_DO_NOT_USE, PROD_SQL_FLAG_NAMES, PROD_SQL_IRREVERSIBLE_ACTIONS, PROD_SQL_MISSING, PROD_SQL_RESULTS, PROD_SQL_SHAPE_CHECKS, PROD_SQL_WARNINGS, PROD_SQL_WRAPS, PRODUCTION_PROMPT_PROOF_VARIABLE,
  evaluateL1Shape, executeProdSqlPlan, loadAuthClassification, planProdSql, promptProof, selectProdSqlDbUrl, stageDigest, stagesTile, validateAuthClassification, type AuthTableClassification, type ProdSqlAction, type ProdSqlFiles,
} from './prod-sql.js';
import { main as runnerMain, parseProdSqlArgs } from './prod-sql-runner.js';
import { splitSqlStatements, sqlControl, transactionShape, unsupportedReason } from './prod-sql-split.js';
import { REFUSAL_IDS, RunnerRefusal } from './refusals.js';
import { REBUILT_STAGING_SQL_ACTIONS, REPOSITORY_ROOT, planRebuiltSqlRun, type RebuiltSqlClient } from './staging-rebuilt.js';
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
  'retire-nologin': 'wrapped', 'retire-terminate': 'wrapped', 'retire-backends': 'read_only', 'retire-revoke': 'own', 'retire-checks': 'read_only', 'retire-email': 'read_only', 'security-hardening-backout': 'own', 'read-only-inventory': 'read_only', 'bootstrap-identity-check': 'read_only' };
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
check('profile-bootstrap-backout and dnc-enum-cast-backout are DO NOT USE: listed, never in the action table, never in the missing list', PROD_SQL_DO_NOT_USE.map((m) => m.id).join() === 'profile-bootstrap-backout,dnc-enum-cast-backout' && PROD_SQL_DO_NOT_USE.every((m) => !PROD_SQL_ACTION_IDS.includes(m.id) && !PROD_SQL_MISSING.some((x) => x.id === m.id) && !PROD_SQL_ACTIONS.some((a) => a.file === m.file)));
check('a DO NOT USE action is refused with the fixed prod_sql_action_do_not_use whatever the phrase, the connection string or the files say (it is checked before any of them)', PROD_SQL_DO_NOT_USE.every((m) => refusalOf(() => plan(m.id, { confirm: 'RUN TNBS PRODUCTION SQL ' + m.id.toUpperCase() })) === 'prod_sql_action_do_not_use' && refusalOf(() => plan(m.id, { confirm: undefined, dbUrl: undefined })) === 'prod_sql_action_do_not_use' && refusalOf(() => plan(m.id, { files: { readFile: () => { throw new Error('must not read'); } } })) === 'prod_sql_action_do_not_use' && refusalOf(() => plan(m.id, { target: 'production', dbUrl: url(RECORDED_PROJECT_REFS.production) })) === 'prod_sql_action_do_not_use'));

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
  check('l1-sweep with the reviewed shape: read committed, then the lock timeout, then the two shape selects, all inside the same transaction and before the first delete; then the sweep commits as before', out.error === undefined && resultsOf(out.events).join() === 'committed' && shapeEvent(out.events)?.passed === true && shapeEvent(out.events)?.action === 'l1-sweep'
    && gateAt[0] === 3 && gateAt[1] === 4 && gateAt[1]! < firstDelete && ctlOf(good.sent[0]!) === 'begin' && good.sent[1] === 'set transaction isolation level read committed' && good.sent[2] === "set local lock_timeout = '10s'" && ctlOf(good.sent[good.sent.length - 1]!) === 'commit' && out.events.filter((e) => e.msg === 'prod-sql.statement').length === 5);
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

const wrapper = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
// ---------------------------------------------------------------------------------------------------------------
// STOP tables: proceed only while all thirteen are empty; locked, counted, refused and rolled back otherwise
// ---------------------------------------------------------------------------------------------------------------
{
  const classification = loadAuthClassification();
  const STOP = stopTablesOf(classification);
  const stopEvent = (events: Array<Record<string, unknown>>) => events.find((e) => e.msg === 'prod-sql.stop_tables') as { action: string; classification: string; locked: boolean; tables: Record<string, number | string>; tables_present: number; tables_populated: number; passed: boolean } | undefined;
  /** The fake catalogue holds the listed STOP tables with the given counts (a string is the raw, possibly unreadable, answer); the lock and count statements answer from it. `lockError` makes the lock statement fail. */
  const stopFake = (state: Record<string, number | string>, lockError?: { code?: string }) => {
    const c = shapeClient(goodColumns(), goodTables());
    const base = c.query.bind(c);
    // The recorder hands handlers the statement with quoted names blanked, so the STOP statements are matched here on the raw text.
    c.query = async (sql: string) => {
      const raw = sql.trim();
      const m = /^select count\(\*\)::bigint as n from auth\."([a-z_]+)"$/.exec(raw);
      if (raw.startsWith('select c.relname') || raw.startsWith('lock table') || m !== null) {
        c.sent.push(raw);
        if (raw.startsWith('select c.relname')) return { rows: Object.keys(state).filter((t) => raw.includes(`'${t}'`)).map((relname) => ({ relname })), rowCount: Object.keys(state).length };
        if (raw.startsWith('lock table')) { if (lockError !== undefined) throw Object.assign(new Error('lock failed at host db.example.com'), lockError); return { rows: [], rowCount: 0 }; }
        return { rows: [{ n: String(state[m![1]!]) }], rowCount: 1 };
      }
      return base(sql);
    };
    return c;
  };
  const allZero = () => Object.fromEntries(STOP.map((t) => [t, 0]));
  const isChange = (s: string) => /^(delete|update)\b/.test(s);

  check('there are exactly 13 STOP tables and they come from the pinned classification file (the sweep code names none of them)', STOP.length === 13 && STOP.every((t) => classification.find((e) => e.table === t)?.classification === STOP_CLASSIFICATION) && !readFileSync(resolve(REPOSITORY_ROOT, 'pipeline/src/prod-sql.ts'), 'utf8').includes("'scim_users'"));
  check('only the sweep must find the STOP tables empty; the shape stage only reports them', PROD_SQL_ACTIONS.filter((a) => a.stopTables !== undefined).map((a) => `${a.id}:${a.stopTables}`).join() === 'l1-shape:report,l1-sweep:must_be_empty');
  {
    const c = stopFake(allZero());
    const out = await runPlan('l1-sweep', c);
    const ev = stopEvent(out.events);
    const at = (re: RegExp) => c.sent.findIndex((s) => re.test(s));
    const lockAt = at(/^lock table/); const firstCount = at(/^select count/); const firstDelete = c.sent.findIndex(isChange);
    check('all 13 STOP tables empty: the sweep proceeds and commits; one stop_tables event: locked, 13 present, 0 populated, passed, classification named', out.error === undefined && resultsOf(out.events).join() === 'committed' && ev?.locked === true && ev.tables_present === 13 && ev.tables_populated === 0 && ev.passed === true && ev.classification === STOP_CLASSIFICATION && ev.action === 'l1-sweep' && Object.values(ev.tables).every((v) => v === 0) && Object.keys(ev.tables).sort().join() === STOP.join());
    check('order: begin, read committed, lock timeout, the two shape selects, the catalogue lookup, ONE lock statement for all 13 tables in sorted order in share row exclusive mode, 13 counts, and only then the first delete (13 more counts follow, see the next check)',
      ctlOf(c.sent[0]!) === 'begin' && c.sent[1] === 'set transaction isolation level read committed' && c.sent[2] === "set local lock_timeout = '10s'" && at(/information_schema\.tables/) === 4 && at(/^select c\.relname/) === 5 && lockAt === 6
      && c.sent[lockAt] === `lock table ${STOP.map((t) => `auth."${t}"`).join(', ')} in share row exclusive mode` && firstCount === 7 && c.sent.filter((s) => /^select count/.test(s)).length === 26 && firstDelete === 7 + 13 && c.sent.filter((s) => /^lock table/.test(s)).length === 1);
    check('after the last L1 statement and before COMMIT the sweep looks up the STOP tables again and counts all 13 again', (() => { const lastChange = c.sent.map((s, i) => (isChange(s) ? i : -1)).filter((i) => i >= 0).pop()!; const commitAt = c.sent.lastIndexOf('commit'); const reCounts = c.sent.map((s, i) => (/^select count/.test(s) ? i : -1)).filter((i) => i > lastChange); return reCounts.length === 13 && reCounts.every((i) => i < commitAt) && c.sent.slice(lastChange + 1, reCounts[0]!).some((s) => /^select c\.relname/.test(s)) && c.sent.filter((s) => /^lock table/.test(s)).length === 1; })());
    check('only counts are read: every statement that names a STOP table is the lock or a count(*) select (never a column, never *)', c.sent.filter((s) => STOP.some((t) => s.includes(`auth."${t}"`))).every((s) => /^lock table /.test(s) || /^select count\(\*\)::bigint as n from auth\."[a-z_]+"$/.test(s)));
    check('the stop_tables event passes the wrapper allow-list with nothing withheld', (() => { const k = { fields: 0 }; return out.events.every((e) => wrapper.allowListLine(JSON.stringify(e), k) !== null) && k.fields === 0; })());
  }
  {
    const populated = { ...allZero(), mfa_factors: 2 };
    const c = stopFake(populated);
    const out = await runPlan('l1-sweep', c);
    const ev = stopEvent(out.events);
    check('one row in one STOP table: refused (prod_sql_l1_stop_table_populated), no delete or update, never committed, rolled back; the event holds only the category, the count per table and the populated count', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_populated' && !c.sent.some(isChange) && !c.sent.some((s) => ctlOf(s) === 'commit') && c.sent[c.sent.length - 1] === 'rollback' && resultsOf(out.events).join() === 'rolled_back'
      && ev?.passed === false && ev.tables_populated === 1 && ev.tables.mfa_factors === 2 && Object.entries(ev.tables).filter(([t]) => t !== 'mfa_factors').every(([, v]) => v === 0) && out.events.filter((e) => e.msg === 'prod-sql.statement').length === 0);
    const unreadable = await runPlan('l1-sweep', stopFake({ ...allZero(), scim_users: 'not a number' }));
    check('a count that cannot be read counts as populated (-1), never as empty', unreadable.error instanceof RunnerRefusal && unreadable.error.id === 'prod_sql_l1_stop_table_populated' && stopEvent(unreadable.events)?.tables.scim_users === -1);
    const some = await runPlan('l1-sweep', stopFake({ instances: 0, scim_tokens: 0 }));
    const sev = stopEvent(some.events);
    check('a STOP table the schema does not have is reported as absent and is not locked; the others still must be empty', some.error === undefined && sev?.tables_present === 2 && Object.values(sev.tables).filter((v) => v === 'absent').length === 11 && sev?.passed === true);
    const none = stopFake({});
    const noneOut = await runPlan('l1-sweep', none);
    check('no STOP table present at all: no lock statement is sent and the sweep proceeds', noneOut.error === undefined && !none.sent.some((s) => /^lock table/.test(s)) && stopEvent(noneOut.events)?.tables_present === 0);
  }
  {
    // A trigger or cascade inside the sweep's own transaction writes a STOP table after the first count (SHARE ROW EXCLUSIVE cannot stop the transaction's own writes).
    const state: Record<string, number | string> = allZero();
    const c = stopFake(state);
    const inner = c.query.bind(c);
    c.query = async (sql: string) => { const r = await inner(sql); if (/^delete from auth\.flow_state/.test(sql.trim())) state.scim_users = 1; return r; };
    const out = await runPlan('l1-sweep', c);
    check('a STOP table that holds a row after the L1 statements (written inside the transaction): fixed refusal prod_sql_l1_stop_table_populated, no commit, rolled back', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_populated' && !c.sent.includes('commit') && resultsOf(out.events).join() === 'rolled_back' && c.sent.some((s) => /^delete from auth\.flow_state/.test(s)));
    check('the re-count before COMMIT adds no second stop_tables event and no new refusal id', stopEvent(out.events)?.passed === true && out.events.filter((e) => e.msg === 'prod-sql.stop_tables').length === 1);
  }
  {
    // The flush: SET CONSTRAINTS ALL IMMEDIATE is sent after the last L1 statement and immediately before the final 13 counts; nothing is sent between the last count and COMMIT.
    const c = stopFake(allZero());
    const out = await runPlan('l1-sweep', c);
    const flush = c.sent.indexOf('set constraints all immediate');
    const counts = c.sent.map((s, i) => (/^select count/.test(s) ? i : -1)).filter((i) => i >= 0);
    const lastDelete = Math.max(...c.sent.map((s, i) => (/^delete from auth\.flow_state/.test(s) ? i : -1)));
    check('SET CONSTRAINTS ALL IMMEDIATE is sent once, after the last L1 statement and immediately before the final 13 counts (the second lookup sits just before them); the commit follows the last count with nothing between', out.error === undefined && c.sent.filter((s) => s === 'set constraints all immediate').length === 1 && flush > lastDelete && counts.length === 26 && counts[13]! > flush && c.sent.slice(flush + 1, counts[13]!).every((s) => /^select c\.relname/.test(s)) && c.sent[counts[25]! + 1] === 'commit');
  }
  {
    // A deferred check that fails at the flush: the error propagates (it is not a COMMIT failure), nothing is committed, and the run is rolled back.
    const c = stopFake(allZero());
    const inner = c.query.bind(c);
    c.query = async (sql: string) => { if (sql.trim() === 'set constraints all immediate') { c.sent.push(sql.trim()); throw Object.assign(new Error('deferred check failed at host db.example.com'), { code: '23503' }); } return inner(sql); };
    const out = await runPlan('l1-sweep', c);
    check('a failure of the flush (a deferred foreign key, 23503) is not relabelled: the original error propagates, no commit is sent, the run is rolled_back, and the driver text is not printed', (out.error as { code?: string } | undefined)?.code === '23503' && !c.sent.includes('commit') && resultsOf(out.events).join() === 'rolled_back' && !JSON.stringify(out.events).includes('db.example.com'));
  }
  for (const code of ['55P03', '40P01', '42809']) {
    const c = stopFake(allZero(), { code });
    const out = await runPlan('l1-sweep', c);
    check(`a lock that fails with SQLSTATE ${code}: fixed refusal prod_sql_l1_stop_table_lock_failed, no count, no delete or update, never committed, rolled back; the driver text is not printed`, out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_lock_failed' && !c.sent.some((s) => /^select count/.test(s)) && !c.sent.some(isChange) && !c.sent.some((s) => ctlOf(s) === 'commit') && c.sent[c.sent.length - 1] === 'rollback'
      && resultsOf(out.events).join() === 'rolled_back' && !JSON.stringify(out.events).includes('db.example.com'));
  }
  {
    const c = stopFake(allZero(), { code: '42501' });
    const out = await runPlan('l1-sweep', c);
    check('a lock that fails for another reason (a missing privilege, 42501) is not relabelled: the original error propagates (reported as server_or_driver_error with its SQLSTATE) and the run is rolled back', out.error !== undefined && !(out.error instanceof RunnerRefusal) && (out.error as { code?: string }).code === '42501' && resultsOf(out.events).join() === 'rolled_back' && !c.sent.some(isChange));
    check('the lock timeout is ten seconds and is set before the lock is taken (it bounds the wait for the lock)', c.sent.findIndex((s) => s === "set local lock_timeout = '10s'") >= 0 && c.sent.findIndex((s) => s === "set local lock_timeout = '10s'") < c.sent.findIndex((s) => /^lock table/.test(s)));
  }
  {
    const p = plan('l1-sweep'); const { classification: _drop, ...rest } = p;
    const c = stopFake(allZero());
    const out = await captureLog(() => executeProdSqlPlan(rest as typeof p, () => c));
    check('a sweep plan without the verified classification refuses and sends no delete', out.error instanceof RunnerRefusal && !c.sent.some(isChange));
    const noStop = { ...p, classification: classification.filter((e) => e.classification !== STOP_CLASSIFICATION) };
    const c2 = stopFake(allZero());
    const out2 = await captureLog(() => executeProdSqlPlan(noStop, () => c2));
    check('if the classification lists no STOP table nothing is locked or counted (and the event says 0 present)', out2.error === undefined && !c2.sent.some((s) => /^lock table|^select count|^select c\.relname/.test(s)) && stopEvent(out2.events)?.tables_present === 0);
  }
  {
    const c = stopFake({ ...allZero(), oauth_clients: 5, mfa_factors: 1 });
    const out = await runPlan('l1-shape', c);
    const ev = stopEvent(out.events);
    check('l1-shape reports the same per-table counts as information (locked: false), takes no lock, does not refuse on a populated STOP table, and ends read_only_done', out.error === undefined && resultsOf(out.events).join() === 'read_only_done' && ev?.locked === false && ev.action === 'l1-shape' && ev.tables_populated === 2 && ev.passed === false && ev.tables.oauth_clients === 5 && shapeEvent(out.events)?.passed === true
      && !c.sent.some((s) => /^lock table|^set /.test(s)) && c.sent[0] === 'begin read only' && c.sent[c.sent.length - 1] === 'rollback');
    const unclassified = await runPlan('l1-shape', shapeClient(goodColumns(), [...goodTables(), { table_name: 'review_unclassified' }]));
    check('l1-shape still refuses on an unclassified table (counted, not named)', unclassified.error instanceof RunnerRefusal && unclassified.error.id === 'prod_sql_l1_shape_not_ok' && shapeEvent(unclassified.events)?.auth_tables_unreviewed === 1 && !JSON.stringify(unclassified.events).includes('review_unclassified'));
    const su = shapeClient(goodColumns(), [...goodTables(), { table_name: 'review_unclassified' }]);
    const suOut = await runPlan('l1-sweep', su);
    check('l1-sweep with an unclassified table still stops at the gate, before any lock or count', suOut.error instanceof RunnerRefusal && suOut.error.id === 'prod_sql_l1_shape_not_ok' && !su.sent.some((s) => /^lock table|^select count/.test(s)));
  }
  {
    const k1 = { fields: 0 };
    const good = JSON.stringify({ msg: 'prod-sql.stop_tables', action: 'l1-sweep', classification: STOP_CLASSIFICATION, locked: true, tables: { scim_users: 0, instances: 'absent' }, tables_present: 1, tables_populated: 0, passed: true });
    check('the wrapper allow-list shows a well-formed stop event whole', wrapper.allowListLine(good, k1) === good && k1.fields === 0);
    const k2 = { fields: 0 };
    const bad = JSON.parse(wrapper.allowListLine(JSON.stringify({ msg: 'prod-sql.stop_tables', action: 'm1', classification: 'fine', locked: 'yes', tables: { 'bad name; drop': 1 }, tables_present: 'many', tables_populated: 1.5, passed: true, row: { secret: 'x' } }), k2));
    check('the allow-list withholds a stop event with another action, another classification word, a non-boolean, a table key that is not an identifier, a non-numeric count, and drops an unknown key', bad.action === '<withheld>' && bad.classification === '<withheld>' && bad.locked === '<withheld>' && bad.tables === '<withheld>' && bad.tables_present === '<withheld>' && bad.tables_populated === '<withheld>' && !('row' in bad) && k2.fields === 7);
    check('the wrapper PROD_SQL_STOP_TABLES equals the STOP entries of the pinned classification, in sorted order', JSON.stringify([...wrapper.PROD_SQL_STOP_TABLES]) === JSON.stringify(stopTablesOf(loadAuthClassification())) && wrapper.PROD_SQL_STOP_TABLES.length === 13);
    const k4 = { fields: 0 };
    const unpinned = JSON.parse(wrapper.allowListLine(JSON.stringify({ msg: 'prod-sql.stop_tables', action: 'l1-sweep', classification: STOP_CLASSIFICATION, locked: true, tables: { review_unpinned_name: 1 }, tables_present: 1, tables_populated: 1, passed: false }), k4));
    check('the allow-list withholds (and counts) a valid-looking table key that is not a pinned STOP table, and a pinned non-STOP table', unpinned.tables === '<withheld>' && k4.fields === 1 && (() => { const k = { fields: 0 }; return JSON.parse(wrapper.allowListLine(JSON.stringify({ msg: 'prod-sql.stop_tables', tables: { audit_log_entries: 0 } }), k)).tables === '<withheld>' && k.fields === 1; })());
    const k3 = { fields: 0 };
    check('the allow-list withholds a stop table whose value is a string other than absent, or a nested object', JSON.parse(wrapper.allowListLine(JSON.stringify({ msg: 'prod-sql.stop_tables', tables: { scim_users: 'secret value' } }), k3)).tables === '<withheld>' && JSON.parse(wrapper.allowListLine(JSON.stringify({ msg: 'prod-sql.stop_tables', tables: { scim_users: { a: 1 } } }), k3)).tables === '<withheld>');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Drift: the contract script fails when the emptiness check or the lock is removed (mutation test on a temporary copy of the repository files)
// ---------------------------------------------------------------------------------------------------------------
{
  const copy = mkdtempSync(resolve(tmpdir(), 'tnbs-stop-drift-'));
  try {
    const listed = spawnSync('git', ['ls-files', '-z', '--', 'scripts', 'supabase', 'docs', 'pipeline/src', 'pipeline/package.json', '.github'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
    for (const f of listed) { mkdirSync(dirname(resolve(copy, f)), { recursive: true }); copyFileSync(resolve(REPOSITORY_ROOT, f), resolve(copy, f)); }
    const target = resolve(copy, 'pipeline/src/prod-sql.ts');
    const original = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    const contract = () => spawnSync(process.execPath, [resolve(copy, 'scripts/verify-prod-sql-runner-contract.mjs')], { cwd: copy, encoding: 'utf8', timeout: 60000 });
    const base = contract();
    check('the contract script passes on an unchanged copy of the repository files (so each failure below is caused by its own mutation)', base.status === 0);
    const mutations: Array<[string, (t: string) => string]> = [
      ["remove stopTables: 'must_be_empty' from the sweep (no emptiness check, no lock)", (t) => t.replace(", stopTables: 'must_be_empty'", '')],
      ['remove the lock: a mode that does not block writers', (t) => t.replace("export const STOP_LOCK_MODE = 'share row exclusive';", "export const STOP_LOCK_MODE = 'access share';")],
      ['remove the lock: the sweep asks for no lock (lock = false)', (t) => t.replace('readStopTables(client, plan.classification, true)', 'readStopTables(client, plan.classification, false)')],
      ['remove the lock statement from readStopTables', (t) => t.replace('await client.query(stopTablesLockSql(existing));', 'void stopTablesLockSql(existing);')],
      ['drop the populated refusal', (t) => t.replace("if (stop.populated > 0) throw new RunnerRefusal('prod_sql_l1_stop_table_populated'", "if (stop.populated > 99) throw new RunnerRefusal('prod_sql_l1_stop_table_populated'")],
      ['count after the delete: move the check behind the first statement', (t) => t.replace("if (action.stopTables === 'must_be_empty') {\n      // Lock the STOP tables", "if (action.stopTables === 'never') {\n      // Lock the STOP tables")],
      ['no read committed before the lock', (t) => t.replace("if (action.stopTables === 'must_be_empty') await client.query(READ_COMMITTED_SQL);", '')],
      ['remove SET CONSTRAINTS ALL IMMEDIATE before the final re-count (a deferred constraint trigger could write a STOP table inside COMMIT)', (t) => t.replace('await client.query(SET_CONSTRAINTS_IMMEDIATE_SQL);', '')],
      ['change the flush to a statement that does not fire deferred triggers', (t) => t.replace("'set constraints all immediate'", "'set constraints all deferred'")],
      ['hard-code a STOP table in code', (t) => t.replace("export const STOP_LOCK_MODE", "const hardCoded = ['scim_users'];\nexport const STOP_LOCK_MODE")],
      ['a lock timeout is no longer a fixed refusal', (t) => t.replace("['55P03', '40P01', '42809']", "['40P01', '42809']")],
      ['select the rows, not a count', (t) => t.replace('select count(*)::bigint as n from', 'select * from')],
      ['the shape stage locks (a read-only report must not)', (t) => t.replace('await readStopTables(client, plan.classification, false)', 'await readStopTables(client, plan.classification, true)')],
    ];
    for (const [name, mutate] of mutations) {
      const mutated = mutate(original);
      assert.notEqual(mutated, original, `the mutation "${name}" did not change the file (the test is stale)`);
      writeFileSync(target, mutated);
      const out = contract();
      check(`the contract script fails when: ${name}`, out.status === 1 && /prod-sql\.ts/.test(out.stderr));
    }
    writeFileSync(target, original);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output: every event the runner can print passes the wrapper's allow-list with nothing withheld, and nothing sensitive appears
// ---------------------------------------------------------------------------------------------------------------
{
  check('the wrapper allow-list names equal the runner lists', JSON.stringify([...wrapper.PROD_SQL_ACTIONS]) === JSON.stringify(PROD_SQL_ACTION_IDS) && JSON.stringify([...wrapper.PROD_SQL_COUNT_NAMES].sort()) === JSON.stringify([...PROD_SQL_COUNT_NAMES].sort())
    && JSON.stringify([...wrapper.PROD_SQL_COMMANDS]) === JSON.stringify([...PROD_SQL_COMMANDS]) && JSON.stringify([...wrapper.PROD_SQL_RESULTS]) === JSON.stringify([...PROD_SQL_RESULTS]) && JSON.stringify([...wrapper.PROD_SQL_WRAPS]) === JSON.stringify([...PROD_SQL_WRAPS]) && JSON.stringify([...wrapper.PROD_SQL_SHAPE_CHECKS]) === JSON.stringify([...PROD_SQL_SHAPE_CHECKS]));
  check('the new refusal identifiers are in both lists', ['prod_sql_target_refused', 'prod_sql_action_not_built', 'prod_sql_action_do_not_use', 'prod_sql_file_unreadable', 'prod_sql_hash_mismatch', 'prod_sql_shape_refused', 'prod_sql_commit_rolled_back', 'prod_sql_l1_shape_not_ok', 'prod_sql_flag_not_expected', 'prod_sql_l1_stop_table_populated', 'prod_sql_l1_stop_table_lock_failed'].every((id) => (REFUSAL_IDS as readonly string[]).includes(id) && wrapper.REFUSAL_IDS.includes(id)));
  const all: Array<Record<string, unknown>> = [];
  for (const a of PROD_SQL_ACTIONS) {
    const c = new Recorder((sql) => ({ rows: [Object.fromEntries((a.countNames ?? ['x']).map((n) => [n, '7']))], rowCount: 1, command: sql === 'commit' ? 'COMMIT' : undefined }));
    all.push(...(await runPlan(a.id, c)).events);
    all.push(...(await captureLog(() => runnerMain(argvFor(a.id), ENV))).events);
  }
  const counter = { fields: 0 };
  const shown = all.map((e) => wrapper.allowListLine(JSON.stringify(e), counter));
  check('every event the runner prints for every action passes the wrapper allow-list: 0 withheld lines, 0 withheld fields', shown.every((s: string | null) => s !== null) && counter.fields === 0 && all.length > PROD_SQL_ACTIONS.length * 3);
  check('the event names are exactly the new prod-sql family', [...new Set(all.map((e) => e.msg))].sort().join() === 'prod-sql.counts,prod-sql.flag,prod-sql.plan_only,prod-sql.result,prod-sql.shape,prod-sql.statement,prod-sql.stop_tables,prod-sql.verified,prod-sql.warning');
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
// B1 (re-review of eafc55b): the reviewed auth table list lives in one pinned data file; only an explicitly classified, sourced table passes the gate;
// the staging-2 schema inventory is a pinned, read-only, names-and-types-only action. Nothing here invents the hosted inventory.
// ---------------------------------------------------------------------------------------------------------------
{
  const classification = loadAuthClassification();
  const handledBy = (c: readonly AuthTableClassification[]) => c.filter((e) => e.classification === 'credential-bearing: handled by L1').map((e) => e.table).sort().join();
  check('the classification file is pinned, every entry has an allowed classification and a cited source, and the handled-by-L1 tables are exactly the L1 tables', createHash('sha256').update(real(AUTH_CLASSIFICATION_FILE)).digest('hex') === AUTH_CLASSIFICATION_SHA256
    && classification.every((e) => (AUTH_CLASSIFICATIONS as readonly string[]).includes(e.classification) && e.source.trim() !== '') && handledBy(classification) === [...L1_AUTH_TABLES].sort().join() && new Set(classification.map((e) => e.table)).size === classification.length);
  // The staging-2 capture of 2026-11-01 (27 auth tables, names and types only): every table is classified; thirteen are STOP, so the real gate refuses on that schema.
  const mirror = JSON.parse(real('supabase/tests/a3/harness/auth-staging2-mirror.json').toString('utf8')) as { tables: Record<string, Array<{ column: string }>> };
  const mirrorTables = Object.keys(mirror.tables).sort();
  const stopTables = classification.filter((e) => e.classification === 'credential-bearing: STOP').map((e) => e.table).sort();
  check('the classification lists exactly the 27 tables of the staging-2 capture (the mirror fixture), each once, and the L1 tables are among them', mirrorTables.length === 27 && classification.length === 27 && classification.map((e) => e.table).sort().join() === mirrorTables.join() && L1_AUTH_TABLES.every((t) => mirrorTables.includes(t)));
  check('thirteen tables are STOP, nine are reviewed as not credential-bearing, five are handled by L1; the STOP tables are exactly the recorded list',
    stopTables.length === 13 && classification.filter((e) => e.classification === 'not credential-bearing: reviewed').length === 9 && classification.filter((e) => e.classification === 'credential-bearing: handled by L1').length === 5
    && stopTables.join() === ['custom_oauth_providers', 'instances', 'mfa_challenges', 'mfa_factors', 'mfa_recovery_codes', 'oauth_authorizations', 'oauth_client_states', 'oauth_clients', 'saml_relay_states', 'scim_tokens', 'scim_users', 'webauthn_challenges', 'webauthn_credentials'].join());
  check('every table that has a secret, token, hash, code or credential column in the capture is STOP or handled by L1 (none is waved through by name)', [
    ['custom_oauth_providers', 'client_secret'], ['mfa_challenges', 'otp_code'], ['mfa_factors', 'secret'], ['mfa_recovery_codes', 'code_hash'], ['oauth_authorizations', 'authorization_code'], ['oauth_client_states', 'code_verifier'], ['oauth_clients', 'client_secret_hash'],
    ['scim_tokens', 'token_hash'], ['webauthn_credentials', 'credential_id'], ['webauthn_challenges', 'session_data'], ['mfa_factors', 'web_authn_credential'], ['scim_users', 'resource'],
  ].every(([t, c]) => mirror.tables[t!]?.some((x) => x.column === c) && classification.find((e) => e.table === t)?.classification === 'credential-bearing: STOP'));
  check('the schema_migrations entry is confirmed by the capture (one column, version) and the two remaining free-form-json assumptions are recorded as notes', (() => { const e = classification.find((x) => x.table === 'schema_migrations'); const cols = mirror.tables.schema_migrations ?? []; return e?.classification === 'not credential-bearing: reviewed' && cols.length === 1 && cols[0]?.column === 'version' && /Confirmed by the staging-2 capture/.test(e.note ?? '') && ['audit_log_entries', 'identities'].every((t) => /Assumption/.test(classification.find((x) => x.table === t)?.note ?? '')); })());
  check('the whole captured schema (every table and column of the mirror) is judged by the real shape gate: every one of the 27 tables is classified, so the SHAPE passes; the STOP tables are judged by emptiness (readStopTables), not by their names', (() => {
    const cols = Object.entries(mirror.tables).flatMap(([t, cs]) => cs.map((c) => ({ table_name: t, column_name: c.column })));
    const r = evaluateL1Shape(cols, mirrorTables.map((t) => ({ table_name: t })), classification);
    return r.passed === true && r.authTables === 27 && r.unreviewedAuthTables === 0 && Object.values(r.checks).every((v) => v);
  })());
  check('the same captured schema plus one table that is not in the classification file stops the shape gate (counted, one unreviewed)', (() => {
    const cols = Object.entries(mirror.tables).flatMap(([t, cs]) => cs.map((c) => ({ table_name: t, column_name: c.column })));
    const r = evaluateL1Shape(cols, [...mirrorTables, 'review_unclassified'].map((t) => ({ table_name: t })), classification);
    return r.passed === false && r.unreviewedAuthTables === 1 && r.checks.no_unreviewed_auth_tables === false;
  })());
  const sourceOf = (e: unknown): AuthTableClassification => ({ table: 'x', classification: 'not credential-bearing: reviewed', source: 'a cited source', ...(e as object) }) as AuthTableClassification;
  const l1Rows = [...L1_AUTH_TABLES].map((t) => ({ table: t, classification: 'credential-bearing: handled by L1', source: 'L1 file' }));
  const validates = (tables: unknown[]) => refusalOf(() => validateAuthClassification({ tables }));
  check('validation accepts the L1 tables plus a classified, sourced table', validates([...l1Rows, sourceOf({})]) === undefined && validates([...l1Rows, sourceOf({ classification: 'credential-bearing: STOP' })]) === undefined);
  check('validation refuses an unknown classification, a missing or blank source, a repeated or badly named table, and no tables at all',
    validates([...l1Rows, sourceOf({ classification: 'probably fine' })]) === 'prod_sql_shape_refused' && validates([...l1Rows, sourceOf({ classification: undefined })]) === 'prod_sql_shape_refused' && validates([...l1Rows, sourceOf({ source: undefined })]) === 'prod_sql_shape_refused'
    && validates([...l1Rows, sourceOf({ source: '   ' })]) === 'prod_sql_shape_refused' && validates([...l1Rows, sourceOf({}), sourceOf({})]) === 'prod_sql_shape_refused' && validates([...l1Rows, sourceOf({ table: 'Bad Name' })]) === 'prod_sql_shape_refused'
    && validates([]) === 'prod_sql_shape_refused' && refusalOf(() => validateAuthClassification(null)) === 'prod_sql_shape_refused');
  check('validation refuses a table passed as handled by L1 that the L1 file does not clear, and an L1 table that is no longer marked handled',
    validates([...l1Rows, sourceOf({ table: 'identities', classification: 'credential-bearing: handled by L1' })]) === 'prod_sql_shape_refused' && validates([...l1Rows.slice(1), sourceOf({ table: 'users' })]) === 'prod_sql_shape_refused');
  check('a changed classification file is refused at plan time as a hash mismatch for l1-shape and l1-sweep; an unreadable one as unreadable; other actions do not need it',
    ['l1-shape', 'l1-sweep'].every((id) => refusalOf(() => plan(id, { files: withFile(AUTH_CLASSIFICATION_FILE, (b) => Buffer.from(b.toString('utf8').replace('not credential-bearing: reviewed', 'credential-bearing: STOP'))) })) === 'prod_sql_hash_mismatch'
      && refusalOf(() => plan(id, { files: { readFile: (p) => { if (p === AUTH_CLASSIFICATION_FILE) throw new Error('ENOENT'); return real(p); } } })) === 'prod_sql_file_unreadable')
    && refusalOf(() => plan('l1-counts', { files: { readFile: (p) => { if (p === AUTH_CLASSIFICATION_FILE) throw new Error('ENOENT'); return real(p); } } })) === undefined && plan('l1-shape').classification !== undefined && plan('l1-sweep').classification !== undefined && plan('l1-counts').classification === undefined);
  // The gate: only a classified table passes. Hosted-like extra tables (names only, no data) from the re-review's reproduction.
  const standard = ['identities', 'mfa_factors', 'mfa_challenges', 'mfa_amr_claims', 'sso_providers', 'sso_domains', 'saml_providers', 'saml_relay_states', 'audit_log_entries', 'instances'];
  const tablesWith = (extra: string[]) => [...goodTables(), ...extra.map((t) => ({ table_name: t }))];
  const judged = (extra: string[], c = classification) => evaluateL1Shape(goodColumns(), tablesWith(extra), c);
  check('an unclassified table stops the gate (counted, not named); the ten standard names are all classified, so the shape passes for them (the four STOP ones are judged by emptiness instead)', (() => {
    const one = judged(['review_unclassified']);
    const many = judged(standard);
    return one.passed === false && one.checks.no_unreviewed_auth_tables === false && one.unreviewedAuthTables === 1 && Object.entries(one.checks).filter(([k]) => k !== 'no_unreviewed_auth_tables').every(([, v]) => v) && many.passed === true && many.unreviewedAuthTables === 0 && judged([]).passed === true;
  })());
  check('a table the classification file lists (STOP or reviewed) is known to the shape gate; a table it does not list is not; the classification list is the only authority', (() => {
    const stop = [...classification, sourceOf({ table: 'review_extra_table', classification: 'credential-bearing: STOP' })];
    const reviewed = [...classification, sourceOf({ table: 'review_extra_table' })];
    return judged(['review_extra_table'], stop).passed === true && judged(['review_extra_table'], reviewed).passed === true && judged(['review_extra_table'], classification).passed === false && stopTablesOf(stop).includes('review_extra_table') && !stopTablesOf(reviewed).includes('review_extra_table');
  })());
  check('with an empty classification every auth table is unreviewed, so the gate fails closed', evaluateL1Shape(goodColumns(), goodTables(), []).passed === false);
  const gated = async (id: string, tables: unknown, mutate: (p: ReturnType<typeof plan>) => ReturnType<typeof plan> = (p) => p) => {
    const c = shapeClient(goodColumns(), tables);
    const out = await captureLog(() => executeProdSqlPlan(mutate(plan(id)), () => c));
    return { c, out };
  };
  {
    const { c, out } = await gated('l1-sweep', tablesWith(['review_unclassified']));
    check('l1-sweep with an unclassified table: refused before any delete or update, nothing committed', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_shape_not_ok' && !c.sent.some((s) => /^(delete|update)\b/.test(s)) && !c.sent.some((s) => ctlOf(s) === 'commit'));
    const stopPlan = (p: ReturnType<typeof plan>) => ({ ...p, classification: [...p.classification!, sourceOf({ table: 'review_extra_table', classification: 'credential-bearing: STOP' })] });
    const stopKnown = await gated('l1-sweep', tablesWith(['review_extra_table']), stopPlan);
    check('l1-sweep with an extra table classified credential-bearing: STOP: the SHAPE gate no longer refuses on the name; the table is judged by emptiness (it is absent from the fake catalogue here, so the sweep commits)', stopKnown.out.error === undefined && resultsOf(stopKnown.out.events).join() === 'committed' && shapeEvent(stopKnown.out.events)?.passed === true);
    const reviewedPlan = (p: ReturnType<typeof plan>) => ({ ...p, classification: [...p.classification!, sourceOf({ table: 'review_extra_table' })] });
    const passedSweep = await gated('l1-sweep', tablesWith(['review_extra_table']), reviewedPlan);
    check('the same sweep passes the gate once that table is classified not credential-bearing: reviewed (the list, not the code, decides)', passedSweep.out.error === undefined && resultsOf(passedSweep.out.events).join() === 'committed');
    const noClass = await gated('l1-shape', goodTables(), (p) => { const { classification: _drop, ...rest } = p; return rest as typeof p; });
    check('a plan with no verified classification fails closed even on the reviewed shape', noClass.out.error instanceof RunnerRefusal && noClass.out.error.id === 'prod_sql_l1_shape_not_ok');
    const shapeOnly = await gated('l1-shape', tablesWith(['review_unclassified']));
    check('l1-shape with an unclassified table: refused, the table is counted and its name appears nowhere in the output', shapeOnly.out.error instanceof RunnerRefusal && shapeEvent(shapeOnly.out.events)?.auth_tables_unreviewed === 1 && !JSON.stringify(shapeOnly.out.events).includes('review_unclassified'));
  }
  // The staging-2 inventory action: pinned, read-only, names and types only; plan-only default through the existing guarded staging runner.
  const rebuilt = RECORDED_PROJECT_REFS.stagingRebuilt ?? 'abcdefghijklmnopqrst';
  const inv = REBUILT_STAGING_SQL_ACTIONS['auth-schema-inventory']!;
  const invOut = resolve(tmpdir(), `tnbs-auth-inventory-test-${process.pid}.json`);
  const invPlan = (over: Partial<Parameters<typeof planRebuiltSqlRun>[0]> = {}) => planRebuiltSqlRun({ action: 'auth-schema-inventory', dbUrl: url(rebuilt), confirm: inv.confirmation, out: invOut, recordedRebuiltRef: rebuilt, ...over });
  const invSql = real(inv.file!).toString('utf8');
  const invStatements = splitSqlStatements(invSql);
  check('the inventory action is a snapshot-kind, confirmation-gated action whose file is pinned by SHA-256 and exists', inv.kind === 'snapshot' && inv.confirmation === 'TAKE TNBS AUTH SCHEMA INVENTORY' && inv.file === 'supabase/rollout/auth-schema-inventory.sql' && createHash('sha256').update(real(inv.file)).digest('hex') === inv.sha256 && inv.pinned === false);
  check('the inventory SQL is read-only by content: only set local and select; every FROM and JOIN is a pg_catalog relation; no auth table, no information_schema, no data change, no transaction control',
    invStatements.length === 4 && invStatements.map((s) => s.clean.trim().split(/\s+/)[0]!.toLowerCase()).join() === 'set,set,select,select' && invStatements.slice(0, 2).every((s) => /^set local /i.test(s.clean.trim()))
    && [...invSql.replace(/--[^\n]*/g, '').matchAll(/\b(from|join)\s+([a-z_.]+)/gi)].every((m) => m[2]!.toLowerCase().startsWith('pg_catalog.')) && !/information_schema/i.test(invSql.replace(/--[^\n]*/g, ''))
    && !/\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|call|do|begin|commit|rollback|vacuum|reindex|cluster|refresh|lock)\b/i.test(invStatements.map((s) => s.clean).join(' ')) && !/\bauth\./i.test(invStatements.map((s) => s.clean).join(' ')));
  check('the inventory plan is made offline: the snapshot step reads exactly the pinned file, nothing connects, and the output must be a new absolute path outside the repository',
    invPlan().kind === 'snapshot' && invPlan().steps.length === 1 && invPlan().steps[0]!.sql === invSql && invPlan().outPath === invOut
    && [undefined, 'relative.json', resolve(REPOSITORY_ROOT, 'inventory.json')].every((out) => { try { invPlan({ out }); return false; } catch { return true; } }));
  check('the inventory action refuses production, the old staging project, any other ref, the 6543 pooler, a wrong or another action\'s confirmation and a missing address (the existing staging target guard)',
    [url(RECORDED_PROJECT_REFS.production), url(RECORDED_PROJECT_REFS.staging), url('zzzzzzzzzzzzzzzzzzzz'), url(rebuilt, 6543)].every((dbUrl) => { try { invPlan({ dbUrl }); return false; } catch { return true; } })
    && [undefined, 'yes', REBUILT_STAGING_SQL_ACTIONS.snapshot!.confirmation].every((confirm) => { try { invPlan({ confirm }); return false; } catch { return true; } }) && (() => { try { invPlan({ dbUrl: undefined }); return false; } catch { return true; } })());
  check('through the wrapper the inventory events are allow-listed: the action id is on its list and the verified and done events pass with nothing withheld',
    wrapper.ACTIONS.includes('auth-schema-inventory') && [{ msg: 'staging-sql.verified', action: 'auth-schema-inventory', steps: 1, target: 'recorded rebuilt staging project' }, { msg: 'staging-sql.plan_only', hint: 'add --execute to run' }, { msg: 'staging-sql.done', action: 'auth-schema-inventory' }]
      .every((e) => wrapper.allowListLine(JSON.stringify(e), { fields: 0 }) !== null) && (() => { const c = { fields: 0 }; wrapper.allowListLine(JSON.stringify({ msg: 'staging-sql.done', action: 'not-an-action' }), c); return c.fields === 1; })());
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

// ---------------------------------------------------------------------------------------------------------------
// OPEN-1 (Route A for the SQL files): window-on, window-off and security-hardening-backout are built; the rest stay not built
// ---------------------------------------------------------------------------------------------------------------
{
  const collapse = (s: string) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  check('window-on, window-off and security-hardening-backout are runnable actions with their own exact phrases; none is in the missing list', ['window-on', 'window-off', 'security-hardening-backout'].every((id) => PROD_SQL_ACTION_IDS.includes(id) && action(id).phrase === `RUN TNBS PRODUCTION SQL ${id.toUpperCase()}` && !PROD_SQL_MISSING.some((m) => m.id === id)));
  check('what is still not built is exactly: reconciliation (refused as not built, none invented); the three DRAFT actions below are built', PROD_SQL_MISSING.map((m) => m.id).sort().join() === 'reconciliation');
  const on = plan('window-on').statements.map((s) => collapse(s.raw));
  const off = plan('window-off').statements.map((s) => collapse(s.raw));
  check('window-on is exactly the two statements the reviewed runbook and doc 16 section 3.1 give (update to true, then the verify select), nothing else', on.join('|') === 'update internal.backout_window set email_edits_paused = true|select email_edits_paused from internal.backout_window');
  check('window-off is exactly the inverse update (to false) and the same verify select, nothing else', off.join('|') === 'update internal.backout_window set email_edits_paused = false|select email_edits_paused from internal.backout_window');
  const doc16 = readFileSync(resolve(REPOSITORY_ROOT, 'docs/build-plan/16-staging-and-hosting-plan.md'), 'utf8').replace(/\s+/g, ' ');
  check('the window statements appear in doc 16 section 3.1 as the source says (activate, verify)', doc16.includes('update internal.backout_window set email_edits_paused = true') && doc16.includes('select email_edits_paused from internal.backout_window'));
  check('both window actions are write actions in the runner\'s own transaction (wrapped), with the flag report and the expected value pinned', ['window-on', 'window-off'].every((id) => action(id).mode === 'write' && action(id).report === 'flag' && action(id).flagName === 'email_edits_paused' && plan(id).shape === 'wrapped') && action('window-on').flagExpect === true && action('window-off').flagExpect === false);
  const hb = real('supabase/backout/security-hardening-backout.sql');
  const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${hb.length}\0`), hb])).digest('hex');
  check('security-hardening-backout.sql is the reviewed file byte for byte: its git blob id is the one at commit f1189dc, so a later merge of that branch is identical', blob === '608b69d1ef0d2fd5179446cb661c8bc8a0ac1756' && action('security-hardening-backout').sha256 === 'f5cda7a44579cdbc86d5df2d192d9bfe41924f1ef46bdfbf2c412b84d6181d0e');
  check('the hardening backout runs as written (own begin ... commit), is not read-only, and is not an irreversible (connection-ending) step', plan('security-hardening-backout').shape === 'own' && action('security-hardening-backout').mode === 'write' && action('security-hardening-backout').irreversible === undefined
    && !['window-on', 'window-off', 'security-hardening-backout'].some((id) => PROD_SQL_IRREVERSIBLE_ACTIONS.includes(id) || plan(id).statements.some((s) => /pg_terminate_backend/i.test(s.clean))));
  const windowOnly = (id: string) => (sql: string) => (sql.startsWith('select email_edits_paused') ? { rows: [{ email_edits_paused: id === 'window-on' }], rowCount: 1 } : { rows: [], rowCount: 1 });
  for (const id of ['window-on', 'window-off']) {
    const c = new Recorder(windowOnly(id));
    const out = await runPlan(id, c);
    const flag = out.events.find((e) => e.msg === 'prod-sql.flag');
    check(`${id}: begin, lock timeout, the update, the verify select, then one commit; reports the flag and committed`, out.error === undefined && c.sent[0] === 'begin' && c.sent[1] === "set local lock_timeout = '10s'" && c.sent.length === 5 && c.sent[4] === 'commit'
      && JSON.stringify(flag) === JSON.stringify({ msg: 'prod-sql.flag', action: id, index: 2, flag: { email_edits_paused: id === 'window-on' } }) && resultsOf(out.events).join() === 'committed');
    for (const [name, rows] of [['the wrong value', [{ email_edits_paused: id !== 'window-on' }]], ['no row', []], ['two rows', [{ email_edits_paused: id === 'window-on' }, { email_edits_paused: id === 'window-on' }]], ['a text value', [{ email_edits_paused: id === 'window-on' ? 'true' : 'false' }]], ['another column', [{ x: id === 'window-on' }]]] as const) {
      const bad = new Recorder((sql) => (sql.startsWith('select email_edits_paused') ? { rows, rowCount: rows.length } : { rows: [], rowCount: 1 }));
      const o = await runPlan(id, bad);
      check(`${id}: a verify select that returns ${name} is refused (prod_sql_flag_not_expected), rolled back, never committed`, o.error instanceof RunnerRefusal && o.error.id === 'prod_sql_flag_not_expected' && bad.sent[bad.sent.length - 1] === 'rollback' && !bad.sent.includes('commit') && resultsOf(o.events).join() === 'rolled_back');
    }
    const down = new Recorder((sql) => { if (sql.startsWith('update')) throw new Error('boom'); return { rows: [], rowCount: 0 }; });
    const failed = await runPlan(id, down);
    check(`${id}: a failing update rolls back, never commits, and prints no flag`, failed.error !== undefined && !down.sent.includes('commit') && resultsOf(failed.events).join() === 'rolled_back' && !failed.events.some((e) => e.msg === 'prod-sql.flag'));
    const lost = new Recorder((sql) => { if (sql === 'commit') throw new Error('connection lost'); return windowOnly(id)(sql); });
    const unknown = await runPlan(id, lost);
    check(`${id}: a failed COMMIT is unknown, never retried or rolled back (CR17)`, unknown.error !== undefined && resultsOf(unknown.events).join() === 'unknown' && lost.sent.filter((s) => s === 'commit').length === 1 && !lost.sent.includes('rollback'));
    const planOnly = await captureLog(() => runnerMain(argvFor(id), ENV, () => { throw new Error('must not connect'); }));
    check(`${id}: plan-only is the default (verified, then plan_only; no client; no warning)`, planOnly.error === undefined && planOnly.events.map((e) => e.msg).join() === 'prod-sql.verified,prod-sql.plan_only' && planOnly.events[0]!.statements === 2);
    check(`${id}: refused with another action's phrase, with no phrase, and with a changed file`, refusalOf(() => plan(id, { confirm: action(id === 'window-on' ? 'window-off' : 'window-on').phrase })) === 'confirmation_required' && refusalOf(() => plan(id, { confirm: undefined })) === 'confirmation_required'
      && refusalOf(() => plan(id, { files: withFile(action(id).file, (b) => Buffer.from(b.toString('utf8').replace(/true|false/, id === 'window-on' ? 'false' : 'true'))) })) === 'prod_sql_hash_mismatch');
    check(`${id}: a changed target, port or project is refused like every other action`, refusalOf(() => plan(id, { target: 'staging' })) === 'prod_sql_target_refused' && refusalOf(() => plan(id, { dbUrl: url(RECORDED_PROJECT_REFS.stagingRebuilt!) })) === 'target_not_recorded_production' && refusalOf(() => plan(id, { dbUrl: url(RECORDED_PROJECT_REFS.production, 6543) })) === 'port_must_be_5432');
  }
  {
    // A flag action whose file does not end with the verifying select is refused at plan time, even when its pins were updated to match.
    const a = action('window-on');
    const noSelect = Buffer.from('update internal.backout_window set email_edits_paused = true;\n');
    const oneSelect = Buffer.from('select email_edits_paused from internal.backout_window;\n');
    const own = Buffer.from('begin;\nupdate internal.backout_window set email_edits_paused = true;\ncommit;\n');
    for (const [name, bytes] of [['no verify select', noSelect], ['only the select', oneSelect], ['its own transaction and no select', own]] as const) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      check(`a flag action with ${name} is refused as a shape refusal`, withPinsChanged([[a, { sha256: hash }]], () => refusalOf(() => plan('window-on', { files: withFile(a.file, bytes) }))) === 'prod_sql_shape_refused');
    }
    check('a flag action with no pinned flag name or expected value is refused as a shape refusal', withPinsChanged([[a, { flagName: undefined }]], () => refusalOf(() => plan('window-on'))) === 'prod_sql_shape_refused' && withPinsChanged([[a, { flagExpect: undefined }]], () => refusalOf(() => plan('window-on'))) === 'prod_sql_shape_refused');
  }
  {
    const c = new Recorder();
    const out = await runPlan('security-hardening-backout', c);
    check('security-hardening-backout: own file, so exactly one begin and one commit are sent, both from the file (no double wrap); reported committed', out.error === undefined && nonStatement(c.sent).join('|') === `begin|set local lock_timeout = '10s'|commit` && c.sent.filter((s) => ctlOf(s) === 'begin').length === 1 && c.sent.length === 4 + 3 && resultsOf(out.events).join() === 'committed');
    const bad = new Recorder((sql) => { if (/^grant execute on all functions in schema internal/.test(sql)) throw new Error('boom'); return { rows: [], rowCount: 0 }; });
    const failed = await runPlan('security-hardening-backout', bad);
    check('security-hardening-backout: a failed statement rolls back and never commits', failed.error !== undefined && bad.sent[bad.sent.length - 1] === 'rollback' && !bad.sent.some((s) => ctlOf(s) === 'commit') && resultsOf(failed.events).join() === 'rolled_back');
  }
  const counter = { fields: 0 };
  const good = JSON.stringify({ msg: 'prod-sql.flag', action: 'window-on', index: 2, flag: { email_edits_paused: true } });
  const unknownFlag = JSON.stringify({ msg: 'prod-sql.flag', action: 'window-off', index: 2, flag: { email_edits_paused: 'unknown' } });
  check('the wrapper passes a flag event (true, false or unknown) for the window actions with nothing withheld', wrapper.allowListLine(good, counter) !== null && wrapper.allowListLine(unknownFlag, counter) !== null && counter.fields === 0);
  const c2 = { fields: 0 };
  [{ msg: 'prod-sql.flag', action: 'm1', index: 2, flag: { email_edits_paused: true } }, { msg: 'prod-sql.flag', action: 'window-on', index: 2, flag: { other: true } }, { msg: 'prod-sql.flag', action: 'window-on', index: 2, flag: { email_edits_paused: 'yes' } }, { msg: 'prod-sql.flag', action: 'window-on', index: 'x', flag: { email_edits_paused: true }, note: 'free text' }]
    .forEach((e) => wrapper.allowListLine(JSON.stringify(e), c2));
  check('the wrapper withholds a flag event with another action, another flag name, a non-boolean value, a non-numeric index, and drops an unknown key (5 fields)', c2.fields === 5);
  check('the wrapper\'s flag names and refusal list equal the runner\'s, and only the two window actions use the flag report', JSON.stringify([...wrapper.PROD_SQL_FLAG_NAMES]) === JSON.stringify([...PROD_SQL_FLAG_NAMES]) && PROD_SQL_ACTIONS.filter((a) => a.report === 'flag').map((a) => a.id).join() === 'window-on,window-off' && (REFUSAL_IDS as readonly string[]).includes('prod_sql_flag_not_expected') && wrapper.REFUSAL_IDS.includes('prod_sql_flag_not_expected'));
}

// ---------------------------------------------------------------------------------------------------------------
// DRAFT, PENDING REVIEW: read-only-inventory (A1), bootstrap-identity-check (BO3); profile-bootstrap-backout and dnc-enum-cast-backout are DO NOT USE
// ---------------------------------------------------------------------------------------------------------------
{
  const NEW = ['read-only-inventory', 'bootstrap-identity-check'] as const;
  const DNU = ['profile-bootstrap-backout', 'dnc-enum-cast-backout'] as const;
  const dnuText = (id: string) => real(PROD_SQL_DO_NOT_USE.find((m) => m.id === id)!.file).toString('utf8');
  const text = (id: string) => real(action(id).file).toString('utf8');
  const strip = (t: string) => t.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  check('the two DRAFT read-only actions are runnable with their own exact phrases and none is in the missing list', NEW.every((id) => PROD_SQL_ACTION_IDS.includes(id) && action(id).phrase === 'RUN TNBS PRODUCTION SQL ' + id.toUpperCase() && !PROD_SQL_MISSING.some((m) => m.id === id)));
  check('each new file says DRAFT, PENDING REVIEW, NOT EXECUTED ANYWHERE, and cites doc 17 and its runbook step in its header comment', NEW.every((id) => {
    const header = text(id).split('\n').filter((l) => l.startsWith('--')).join('\n');
    return /DRAFT, PENDING REVIEW/.test(header) && /NOT EXECUTED ANYWHERE/.test(header) && /doc 17/.test(header) && /301418b/.test(header) && /f1189dc/.test(header) && (id === 'read-only-inventory' ? /A1/.test(header) && /BO3/.test(header) : /BO3/.test(header) && /BEFORE the M1 backouts/.test(header));
  }));
  check('every proposed item of the inventory is marked "(proposed, not from a reviewed doc)" in its header', (text('read-only-inventory').match(/\(proposed, not from a reviewed doc/g) ?? []).length === 3);
  check('both DO NOT USE headers start with DO NOT USE, say the forward fix is RETAINED, name the migration they would reverse, and say a replacement needs its own separate review', DNU.every((id) => {
    const t2 = dnuText(id);
    const mig = id === 'profile-bootstrap-backout' ? '20260723004500_profile_service_bootstrap.sql' : '20260723010400_dnc_activity_enum_cast.sql';
    return t2.startsWith('-- ====') && /^-- DO NOT USE\. DO NOT RUN THIS FILE\./m.test(t2.split('\n').slice(0, 4).join('\n')) && /RETAIN THE FORWARD FIX/.test(t2) && t2.includes(mig) && /separate review/.test(t2) && /prod_sql_action_do_not_use/.test(t2);
  }));
  check('the profile header says why: the restored guard fails open for a NULL-role (pending or disabled) user; the DNC header says why: SQLSTATE 42804 for an authorized editor', /FAILS OPEN/.test(dnuText('profile-bootstrap-backout')) && /NULL/.test(dnuText('profile-bootstrap-backout')) && /42804/.test(dnuText('dnc-enum-cast-backout')) && /17\.6/.test(dnuText('dnc-enum-cast-backout')));

  // ---- the inventory
  const inv = action('read-only-inventory');
  const invPlan = plan('read-only-inventory');
  const invSql = strip(text('read-only-inventory'));
  check('the inventory is a read-only action with the counts report, planned as exactly one select statement with no transaction control of its own', inv.mode === 'read_only' && inv.report === 'counts' && invPlan.shape === 'read_only' && invPlan.statements.length === 1 && /^select /.test(invSql) && sqlControl(invPlan.statements[0]!) === null);
  check('the inventory holds no write, DDL, lock or function call that changes state (only select, count, sum, coalesce and lower)', !/\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|call|do|set|reset|lock|vacuum|analyze|comment|pg_[a-z_]+|nextval|setval|for update|into)\b/i.test(invSql));
  check('the inventory reads only public.profiles and auth.users', [...invSql.matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]!.toLowerCase()).every((t) => t === 'public.profiles' || t === 'auth.users') && /public\.profiles/.test(invSql) && /auth\.users/.test(invSql));
  check('the inventory\'s pinned count names are exactly its output columns, in order, and are all whole-number counts of fixed names (20 names, no id, email or name column)', (() => {
    const outer = invSql.slice('select '.length, invSql.indexOf(' from (')).split(',').map((c) => c.trim().replace(/^[a-z]\./, ''));
    return JSON.stringify(outer) === JSON.stringify(inv.countNames) && outer.length === 20 && outer.every((n) => /^[a-z_]+$/.test(n) && !/email$|name$|^id$/.test(n.replace(/^(duplicate_email_groups|duplicate_email_rows|email_mismatches|approved_auth_email_null)$/, 'ok')));
  })());
  {
    const row = Object.fromEntries((inv.countNames ?? []).map((n, i) => [n, String(i)]));
    const c = new Recorder((sql) => (/^select\b/i.test(sql.trim()) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const out = await runPlan('read-only-inventory', c);
    const ev = out.events.filter((e) => e.msg === 'prod-sql.counts');
    check('inventory run: begin read only, the one pinned select, rollback; never a commit; one counts event with exactly the pinned names and the numbers; read_only_done', out.error === undefined && c.sent[0] === 'begin read only' && c.sent.length === 3 && c.sent[2] === 'rollback' && !c.sent.some((x) => ctlOf(x) === 'commit')
      && ev.length === 1 && JSON.stringify(Object.keys(ev[0]!.counts as object)) === JSON.stringify(inv.countNames) && Object.values(ev[0]!.counts as object).join() === (inv.countNames ?? []).map((_, i) => i).join() && resultsOf(out.events).join() === 'read_only_done');
    const odd = new Recorder((sql) => (/^select\b/i.test(sql.trim()) ? { rows: [{ profiles_total: 'a@b.example', auth_users_total: -3 }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const o2 = await runPlan('read-only-inventory', odd);
    const counts = o2.events.find((e) => e.msg === 'prod-sql.counts')!.counts as Record<string, number>;
    check('inventory run: a value that is not a whole number (text, negative, missing) is printed as -1, never echoed', counts.profiles_total === -1 && counts.auth_users_total === -1 && counts.profiles_guest_pending === -1 && !JSON.stringify(o2.events).includes('a@b.example'));
    const two = new Recorder((sql) => (/^select\b/i.test(sql.trim()) ? { rows: [row, row], rowCount: 2 } : { rows: [], rowCount: 0 }));
    const o3 = await runPlan('read-only-inventory', two);
    check('inventory run: more than one row is printed as -1 for every count', Object.values(o3.events.find((e) => e.msg === 'prod-sql.counts')!.counts as object).every((v) => v === -1));
    const cc = { fields: 0 };
    check('the wrapper passes the inventory counts event with nothing withheld, and the wrapper\'s count names equal the runner\'s', wrapper.allowListLine(JSON.stringify(ev[0]), cc) !== null && cc.fields === 0 && JSON.stringify([...wrapper.PROD_SQL_COUNT_NAMES]) === JSON.stringify([...PROD_SQL_COUNT_NAMES]) && JSON.stringify(wrapper.PROD_SQL_ACTIONS) === JSON.stringify(PROD_SQL_ACTION_IDS));
  }
  {
    // The existing retire-email count and the inventory's email_mismatches are the same statement text for the comparison.
    const retire = strip(real('supabase/backout/retire-app-credentials.sql').toString('utf8'));
    check('the inventory\'s email_mismatches compares lower(profile email) with lower(auth email) for approved profiles, as retire-email does', /where p\.status = 'approved' and lower\(p\.email\) <> lower\(u\.email\)/.test(retire) && /lower\(pr\.email\) <> lower\(u\.email\)/.test(invSql) && /pr\.status::text = 'approved'/.test(invSql));
  }

  // ---- the BO3 identity check
  {
    const idc = action('bootstrap-identity-check');
    const idcSql = strip(text('bootstrap-identity-check'));
    const idcPlan = plan('bootstrap-identity-check');
    check('the identity check is a read-only action with the counts report, exactly one select, no transaction control of its own', idc.mode === 'read_only' && idc.report === 'counts' && idcPlan.shape === 'read_only' && idcPlan.statements.length === 1 && /^select /.test(idcSql) && sqlControl(idcPlan.statements[0]!) === null);
    check('the identity check holds no write, DDL, lock or state-changing function', !/\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|call|do|set|reset|lock|vacuum|analyze|comment|pg_[a-z_]+|nextval|setval|for update|into)\b/i.test(idcSql));
    check('the identity check reads only public.profiles, auth.users and internal.auth_events, and ties the exception to kind first_manager_bootstrap and its user_id', [...idcSql.matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]!.toLowerCase()).every((x) => ['public.profiles', 'auth.users', 'internal.auth_events'].includes(x)) && /internal\.auth_events/.test(idcSql) && /kind = 'first_manager_bootstrap'/.test(idcSql) && /user_id/.test(idcSql));
    check('its four pinned count names are exactly its output columns in order, whole-number counts only (the identity itself is never an output column)', (() => {
      const outer = idcSql.slice('select '.length, idcSql.indexOf(' from (')).split(',').map((x) => x.trim().replace(/^[a-z]\./, ''));
      return JSON.stringify(outer) === JSON.stringify(idc.countNames) && outer.join() === 'bootstrap_events,bootstrap_profiles_present,bootstrap_profiles_with_auth_user,other_approved_profiles_without_auth_user' && !outer.some((n) => /(^|_)(id|email|name)$/.test(n) || n === 'user_id');
    })());
    check('the action order is BO3 before the M1 backouts (the identity check is listed before backout-m1c, backout-m1b and backout-m1), and its header says so', ['backout-m1c', 'backout-m1b', 'backout-m1'].every((b) => PROD_SQL_ACTION_IDS.indexOf('bootstrap-identity-check') < PROD_SQL_ACTION_IDS.indexOf(b)) && /BEFORE the M1 backouts/.test(text('bootstrap-identity-check')));
    const row = Object.fromEntries((idc.countNames ?? []).map((n, i) => [n, String(i)]));
    const c = new Recorder((sql) => (/^select\b/i.test(sql.trim()) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const out = await runPlan('bootstrap-identity-check', c);
    const ev = out.events.filter((e) => e.msg === 'prod-sql.counts');
    check('identity check run: begin read only, the one pinned select, rollback; never a commit; one counts event with exactly the four pinned names and the numbers; read_only_done', out.error === undefined && c.sent[0] === 'begin read only' && c.sent.length === 3 && c.sent[2] === 'rollback' && !c.sent.some((x) => ctlOf(x) === 'commit') && ev.length === 1 && JSON.stringify(Object.keys(ev[0]!.counts as object)) === JSON.stringify(idc.countNames) && Object.values(ev[0]!.counts as object).join() === '0,1,2,3' && resultsOf(out.events).join() === 'read_only_done');
    const odd = new Recorder((sql) => (/^select\b/i.test(sql.trim()) ? { rows: [{ bootstrap_events: '71000000-0000-4000-8000-000000000001', bootstrap_profiles_present: true }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const o2 = await runPlan('bootstrap-identity-check', odd);
    const cc = { fields: 0 };
    check('identity check run: an id, a boolean or a missing value is printed as -1, never echoed; the wrapper passes the event with nothing withheld', Object.values(o2.events.find((e) => e.msg === 'prod-sql.counts')!.counts as object).every((v) => v === -1) && !JSON.stringify(o2.events).includes('71000000') && wrapper.allowListLine(JSON.stringify(ev[0]), cc) !== null && cc.fields === 0);
  }

  // ---- the two DO NOT USE backouts: never runnable; the historical text is kept as a record only
  const bodyOf = (t2: string, open: RegExp) => { const i = t2.search(open); return t2.slice(i, t2.indexOf('$$;', i) + 3); };
  check('the profile record file still holds the guard body of 20260720000300_profiles.sql byte for byte (a historical record, never run)', bodyOf(dnuText('profile-bootstrap-backout'), /as \$\$\nbegin\n  if \(new\.role/) === bodyOf(real('supabase/migrations/20260720000300_profiles.sql').toString('utf8'), /as \$\$\nbegin\n  if \(new\.role/));
  check('the DNC record file still holds the set_do_not_contact body of 20260720001100_rpc.sql byte for byte (a historical record, never run)', bodyOf(dnuText('dnc-enum-cast-backout'), /as \$\$\ndeclare\n  v_uid/) === bodyOf(real('supabase/migrations/20260720001100_rpc.sql').toString('utf8').slice(real('supabase/migrations/20260720001100_rpc.sql').toString('utf8').indexOf('create or replace function public.set_do_not_contact(')), /as \$\$\ndeclare\n  v_uid/));
  for (const id of DNU) {
    const refusal = refusalOf(() => plan(id, { confirm: 'RUN TNBS PRODUCTION SQL ' + id.toUpperCase() }));
    const refused = await captureLog(() => runnerMain(['--target=production', '--action=' + id, '--confirm=RUN TNBS PRODUCTION SQL ' + id.toUpperCase(), '--execute'], ENV, () => { throw new Error('must not connect'); }));
    check(id + ': even with its old phrase and --execute the runner is refused (prod_sql_action_do_not_use), prints no verified or plan event, and never connects', refusal === 'prod_sql_action_do_not_use' && refused.error !== undefined && !refused.events.some((e) => e.msg === 'prod-sql.verified' || e.msg === 'prod-sql.plan_only' || e.msg === 'prod-sql.statement'));
  }
  for (const id of NEW) {
    const other = action(NEW.find((n) => n !== id)!).phrase;
    check(id + ': refused with another action\'s phrase, with no phrase, with a changed file (hash), a changed target, a staging port and a non-production project', refusalOf(() => plan(id, { confirm: other })) === 'confirmation_required' && refusalOf(() => plan(id, { confirm: undefined })) === 'confirmation_required'
      && refusalOf(() => plan(id, { files: withFile(action(id).file, (b) => Buffer.concat([b, Buffer.from('\n-- x\n')])) })) === 'prod_sql_hash_mismatch' && refusalOf(() => plan(id, { target: 'staging' })) === 'prod_sql_target_refused'
      && refusalOf(() => plan(id, { dbUrl: url(RECORDED_PROJECT_REFS.production, 6543) })) === 'port_must_be_5432' && refusalOf(() => plan(id, { dbUrl: url(RECORDED_PROJECT_REFS.stagingRebuilt!) })) === 'target_not_recorded_production' && refusalOf(() => plan(id, { files: { readFile: () => { throw new Error('gone'); } } })) === 'prod_sql_file_unreadable');
    const planOnly = await captureLog(() => runnerMain(argvFor(id), ENV, () => { throw new Error('must not connect'); }));
    check(id + ': plan-only is the default (verified, then plan_only; no client; no warning)', planOnly.error === undefined && planOnly.events.map((e) => e.msg).join() === 'prod-sql.verified,prod-sql.plan_only');
  }
  check('a read-only action carrying its own begin is refused (the inventory cannot be turned into a writing file)', (() => {
    const bytes = Buffer.from('begin;\n' + text('read-only-inventory') + '\ncommit;\n');
    return withPinsChanged([[inv, { sha256: createHash('sha256').update(bytes).digest('hex') }]], () => refusalOf(() => plan('read-only-inventory', { files: withFile(inv.file, bytes) }))) === 'prod_sql_shape_refused';
  })());
}

console.log(`prod-sql: ${passed} checks passed`);
