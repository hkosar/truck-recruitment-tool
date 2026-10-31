#!/usr/bin/env node
// Offline contract check for the guarded production SQL runner (doc 18, Route A; cutover gap OPEN-1):
// pipeline/src/prod-sql.ts, prod-sql-split.ts, prod-sql-runner.ts and their wiring in refusals.ts, scripts/run-with-secrets.mjs, the pipeline test chain and CI.
// Text-level and file-level: it re-hashes every pinned file, checks the guard statements themselves (comments stripped first) and that the tests are wired into
// verification. The behaviour is proven by prod-sql.test.ts (offline) and prod-sql-a3.test.ts (real PostgreSQL 16, loopback). No dependencies, no network, no database.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const failures = [];
const read = (rel) => (existsSync(resolve(root, rel)) ? readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n') : undefined);
/** Source without comments (// and block), so a forbidden word in prose does not count and a real statement does. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
/**
 * An independent port of splitSqlStatements (pipeline/src/prod-sql-split.ts) returning each top-level statement's raw text, so the stage digests can be
 * recomputed here without TypeScript or dependencies. Same rules: comments, quoted strings and identifiers and dollar-quoted bodies never end a statement.
 */
function splitStatements(text) {
  const out = [];
  let raw = '';
  let clean = '';
  const push = () => { if (clean.trim() !== '') out.push(raw.trim()); raw = ''; clean = ''; };
  const identChar = /[A-Za-z0-9_\u0080-￿$]/;
  const dollarTag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\\' && (i === 0 || text[i - 1] === '\n') && clean.trim() === '') throw new Error('meta_command');
    if (ch === '-' && next === '-') { let j = i; while (j < n && text[j] !== '\n') j += 1; raw += text.slice(i, j); clean += ' '; i = j; continue; }
    if (ch === '/' && next === '*') {
      let depth = 1; let j = i + 2;
      while (j < n && depth > 0) { if (text[j] === '/' && text[j + 1] === '*') { depth += 1; j += 2; } else if (text[j] === '*' && text[j + 1] === '/') { depth -= 1; j += 2; } else j += 1; }
      if (depth > 0) throw new Error('unterminated');
      raw += text.slice(i, j); clean += ' '; i = j; continue;
    }
    if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && /[eE]/.test(text[i - 1] ?? '') && !identChar.test(text[i - 2] ?? ' ');
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error('unterminated');
        if (escapes && text[j] === '\\') { j += 2; continue; }
        if (text[j] === ch) { if (text[j + 1] === ch) { j += 2; continue; } j += 1; break; }
        j += 1;
      }
      raw += text.slice(i, j); clean += `${ch}${ch}`; i = j; continue;
    }
    if (ch === '$' && !identChar.test(text[i - 1] ?? ' ')) {
      const tag = dollarTag.exec(text.slice(i, i + 130))?.[0];
      if (tag !== undefined) {
        const end = text.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error('unterminated');
        raw += text.slice(i, end + tag.length); clean += '$$'; i = end + tag.length; continue;
      }
    }
    if (ch === ';') { push(); i += 1; continue; }
    raw += ch; clean += ch; i += 1;
  }
  push();
  return out;
}
const need = (name, c, re, what) => { if (!c || !re.test(c)) failures.push(`${name} must keep: ${what}`); };

const mod = read('pipeline/src/prod-sql.ts');
const split = read('pipeline/src/prod-sql-split.ts');
const runner = read('pipeline/src/prod-sql-runner.ts');
const refusals = read('pipeline/src/refusals.ts');
const wrapper = read('scripts/run-with-secrets.mjs');
const pkg = read('pipeline/package.json');
const ci = read('.github/workflows/ci.yml');
const safety = read('.github/ci/repository-safety.sh');
const doc = read('docs/build-plan/18-production-sql-route-options.md');
for (const [name, v] of [['prod-sql.ts', mod], ['prod-sql-split.ts', split], ['prod-sql-runner.ts', runner], ['refusals.ts', refusals], ['run-with-secrets.mjs', wrapper], ['pipeline/package.json', pkg]]) if (!v) failures.push(`missing ${name}`);
for (const f of ['pipeline/src/prod-sql.test.ts', 'pipeline/src/prod-sql-a3.test.ts']) if (!existsSync(resolve(root, f))) failures.push(`missing ${f}`);

// ---------------------------------------------------------------------------------------------------------------
// The action table: every pinned file exists and still has the pinned SHA-256; stages tile their file; phrases are unique and exact.
// ---------------------------------------------------------------------------------------------------------------
const actions = [];
if (mod) {
  const c = code(mod);
  for (const m of c.matchAll(/MIGRATION\('([a-z0-9-]+)', '[^']*', '([^']+)', '([0-9a-f]{64})'\)/g)) actions.push({ id: m[1], file: `supabase/migrations/${m[2]}`, sha: m[3], manifestName: m[2], phrase: `RUN TNBS PRODUCTION SQL ${m[1].toUpperCase()}` });
  for (const m of c.matchAll(/\{ id: '([a-z0-9-]+)', step: '[^']*', file: '([^']+)', sha256: '([0-9a-f]{64})'(?:, statements: \[(\d+), (\d+)\], stageSha256: '([0-9a-f]{64})')?, mode: '(read_only|write)', report: '(none|rows|digest|counts|shape)'(?:, gate: '([a-z0-9-]+)')?[^}]*?phrase: '([^']+)' \}/g)) {
    actions.push({ id: m[1], file: m[2], sha: m[3], from: m[4] === undefined ? undefined : Number(m[4]), to: m[5] === undefined ? undefined : Number(m[5]), stageSha: m[6], mode: m[7], report: m[8], gate: m[9], phrase: m[10] });
  }
  const declared = [...c.slice(0, c.indexOf('export const PROD_SQL_MISSING')).matchAll(/(?:MIGRATION\(|\{ id: )'([a-z0-9-]+)'/g)].map((m) => m[1]);
  if (actions.length !== declared.length || actions.length < 20) failures.push(`prod-sql.ts: the action table could not be read completely (read ${actions.length} of ${declared.length}; expected at least 20)`);
  if (new Set(actions.map((a) => a.id)).size !== actions.length) failures.push('prod-sql.ts: duplicate action ids');
  if (new Set(actions.map((a) => a.phrase)).size !== actions.length) failures.push('prod-sql.ts: duplicate phrases (each action needs its own exact phrase)');
  for (const a of actions) {
    if (a.phrase !== `RUN TNBS PRODUCTION SQL ${a.id.toUpperCase()}`) failures.push(`prod-sql.ts: the phrase of ${a.id} must be "RUN TNBS PRODUCTION SQL ${a.id.toUpperCase()}"`);
    const bytes = existsSync(resolve(root, a.file)) ? readFileSync(resolve(root, a.file)) : undefined;
    if (!bytes) { failures.push(`prod-sql.ts: pinned file is missing: ${a.file}`); continue; }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== a.sha) failures.push(`prod-sql.ts: ${a.id} pins ${a.sha.slice(0, 12)}... but ${a.file} is ${actual.slice(0, 12)}... (the file changed or the pin is stale: review, then update the pin)`);
    if (a.manifestName) {
      const manifest = read('docs/build-plan/migration-checksums.sha256') ?? '';
      const line = manifest.split('\n').map((l) => l.split('\t')).find((cols) => cols[0] === a.manifestName);
      if (line?.[1] !== a.sha) failures.push(`prod-sql.ts: ${a.id} does not agree with docs/build-plan/migration-checksums.sha256`);
    }
  }
  // Stage ranges of one file tile it exactly: from statement 1 through the parsed FINAL statement, no gap, no overlap, every stage with a pin, and every
  // stage digest recomputed here from the file's own statements (an independent port of the splitter; a disagreement fails, so a bug in either shows up).
  for (const file of [...new Set(actions.filter((a) => a.from !== undefined).map((a) => a.file))]) {
    const stages = actions.filter((a) => a.file === file && a.from !== undefined).sort((a, b) => a.from - b.from);
    stages.forEach((s, i) => { if (s.from !== (i === 0 ? 1 : stages[i - 1].to + 1) || s.to < s.from || !s.stageSha) failures.push(`prod-sql.ts: the stages of ${file} must tile it without gap or overlap, each with a stage pin`); });
    if (new Set(stages.map((s) => s.sha)).size !== 1) failures.push(`prod-sql.ts: every stage of ${file} must pin the same whole-file hash`);
    let statements;
    try { statements = splitStatements(readFileSync(resolve(root, file), 'utf8')); } catch { failures.push(`prod-sql.ts: ${file} could not be split by the contract's own splitter`); continue; }
    if (stages[stages.length - 1].to !== statements.length) failures.push(`prod-sql.ts: the stages of ${file} end at statement ${stages[stages.length - 1].to} but the file has ${statements.length} statements (an unexecuted tail)`);
    for (const s of stages) {
      if (s.to > statements.length) { failures.push(`prod-sql.ts: ${s.id} ends past the last statement of ${file}`); continue; }
      const digest = createHash('sha256').update(statements.slice(s.from - 1, s.to).join('\u0000')).digest('hex');
      if (digest !== s.stageSha) failures.push(`prod-sql.ts: ${s.id} pins stage digest ${String(s.stageSha).slice(0, 12)}... but statements ${s.from}-${s.to} of ${file} hash to ${digest.slice(0, 12)}... (the stage changed or the pin is stale: review, then update the pin)`);
    }
  }
  // The shape gate: l1-shape is the only 'shape' stage, l1-sweep is gated by it, nothing else is; the reviewed inventory is the file's own shape check.
  const shapeStages = actions.filter((a) => a.report === 'shape');
  if (shapeStages.map((a) => a.id).join() !== 'l1-shape' || shapeStages[0]?.mode !== 'read_only') failures.push("prod-sql.ts: l1-shape must be the one read-only 'shape' stage");
  if (actions.filter((a) => a.gate !== undefined).map((a) => `${a.id}>${a.gate}`).join() !== 'l1-sweep>l1-shape') failures.push("prod-sql.ts: l1-sweep must be gated by l1-shape and no other action may have a gate");
  {
    const l1 = actions.find((a) => a.id === 'l1-shape');
    const l1Text = l1 && existsSync(resolve(root, l1.file)) ? splitStatements(readFileSync(resolve(root, l1.file), 'utf8')) : [];
    const listOf = (name) => (new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(c)?.[1].match(/'([a-z_]+)'/g) ?? []).map((q) => q.slice(1, -1));
    const tables = listOf('L1_AUTH_TABLES');
    const cols = listOf('L1_USERS_TOKEN_COLUMNS');
    if (tables.join() !== 'users,sessions,refresh_tokens,one_time_tokens,flow_state') failures.push('prod-sql.ts: L1_AUTH_TABLES must be the L1 file\'s own listed tables (users, sessions, refresh_tokens, one_time_tokens, flow_state)');
    if (cols.length !== 6) failures.push('prod-sql.ts: L1_USERS_TOKEN_COLUMNS must list the six auth.users token columns');
    if (l1Text.length >= 2) {
      for (const t of tables.filter((x) => x !== 'users')) if (!l1Text[0].includes(`'${t}'`)) failures.push(`prod-sql.ts: ${t} is not named by the L1 file's first shape select (the reviewed inventory differs from the file)`);
      for (const col of cols) if (!l1Text[0].includes(`'${col}'`)) failures.push(`prod-sql.ts: ${col} is not named by the L1 file's first shape select (the reviewed inventory differs from the file)`);
      if (!/information_schema\.columns/.test(l1Text[0]) || !/information_schema\.tables/.test(l1Text[1]) || !/table_schema = 'auth'/.test(l1Text[0]) || !/table_schema = 'auth'/.test(l1Text[1])) failures.push('prod-sql.ts: the L1 file\'s first two statements are no longer the two auth information_schema shape selects');
    } else failures.push('prod-sql.ts: the L1 file has fewer than two statements');
    const expectedChecks = ['results_read', ...tables.map((t) => `table_${t}`), ...cols.map((col) => `users_${col}`), 'no_unreviewed_auth_tables'];
    const wrapperChecks = (wrapper ? /export const PROD_SQL_SHAPE_CHECKS = \[([\s\S]*?)\];/.exec(wrapper)?.[1].match(/'([a-z_]+)'/g) ?? [] : []).map((q) => q.slice(1, -1));
    if (JSON.stringify(wrapperChecks) !== JSON.stringify(expectedChecks)) failures.push('run-with-secrets.mjs PROD_SQL_SHAPE_CHECKS must equal the shape check names derived from L1_AUTH_TABLES and L1_USERS_TOKEN_COLUMNS');
  }
  // Read-only actions never write; every action that has report 'counts' names its columns.
  for (const a of actions) if (a.report === 'counts' && !new RegExp(`id: '${a.id}'[^}]*countNames: \\[`).test(c)) failures.push(`prod-sql.ts: ${a.id} reports counts but pins no countNames`);
  // The files doc 17 names that exist on this branch must all have an action.
  for (const f of ['supabase/pending/M1_same_origin_signin.sql', 'supabase/pending/M1b_add_person.sql', 'supabase/pending/M1c_batch_delete_audit.sql', 'supabase/backout/pre-cutover-snapshot.sql', 'supabase/backout/retire-app-credentials.sql',
    'supabase/backout/M1-backout.sql', 'supabase/backout/M1b-backout.sql', 'supabase/backout/M1c-backout.sql', 'supabase/rollout/L1-close-legacy-auth.sql']) {
    if (existsSync(resolve(root, f)) && !actions.some((a) => a.file === f)) failures.push(`prod-sql.ts: ${f} exists but has no action`);
  }
  // Anything listed as missing must stay absent from the table; a listed file that has appeared must be pinned by its own reviewed change (drift).
  for (const m of c.matchAll(/\{ id: '([a-z0-9-]+)', step: '[^']*',(?: file: '([^']+)',)? reason:/g)) {
    if (actions.some((a) => a.id === m[1])) failures.push(`prod-sql.ts: ${m[1]} is both runnable and listed as missing`);
    if (m[2] && !m[2].endsWith('09-production-baseline-reconciliation.sql') && existsSync(resolve(root, m[2]))) failures.push(`prod-sql.ts: ${m[2]} now exists in the repository; move it from PROD_SQL_MISSING to the action table with a pin (a reviewed change)`);
  }
  if (!c.includes("id: 'security-hardening-backout'")) failures.push('prod-sql.ts: the missing list must name security-hardening-backout');

  // ---- Guard statements (the statements themselves, comments stripped).
  for (const required of ["'bootstrap_target_required'", "'prod_sql_target_refused'", "'target_not_recorded_production'", "'port_must_be_5432'", "'confirmation_required'", "'prod_sql_hash_mismatch'", "'prod_sql_shape_refused'",
    "'prod_sql_action_not_built'", "'prod_sql_commit_rolled_back'", 'RECORDED_PROJECT_REFS.production', 'parseSupabaseDbTarget', "selectFirstManagerDbUrl('production', env)", "'begin read only'", "result: 'unknown'", "'rollback_not_confirmed'",
    "set local lock_timeout"]) {
    if (!c.includes(required)) failures.push(`prod-sql.ts is missing: ${required}`);
  }
  need('prod-sql.ts', c, /if \(input\.target !== PROD_SQL_TARGET\) \{\s*throw new RunnerRefusal\('prod_sql_target_refused'/, 'the production-only target refusal');
  need('prod-sql.ts', c, /export const PROD_SQL_TARGET = 'production' as const/, 'the single target constant');
  need('prod-sql.ts', c, /if \(db\.projectRef !== RECORDED_PROJECT_REFS\.production\) \{\s*throw new RunnerRefusal\('target_not_recorded_production'/, 'the recorded-production-ref refusal');
  need('prod-sql.ts', c, /if \(db\.port !== 5432\) throw new RunnerRefusal\('port_must_be_5432'/, 'the session-port refusal');
  need('prod-sql.ts', c, /if \(sha256Hex\(bytes\) !== action\.sha256\) throw new RunnerRefusal\('prod_sql_hash_mismatch'/, 'the whole-file hash refusal');
  need('prod-sql.ts', c, /if \(stageDigest\(statements\) !== action\.stageSha256\) throw new RunnerRefusal\('prod_sql_hash_mismatch'/, 'the stage hash refusal');
  need('prod-sql.ts', c, /if \(!stagesTile\(action\.file, all\.length\)\) throw new RunnerRefusal\('prod_sql_shape_refused'/, 'the stage coverage refusal (stages tile the file through its final statement)');
  need('prod-sql.ts', c, /export function stagesTile\(file: string, total: number[^)]*\): boolean \{[\s\S]*?return stages\.length > 0 && next === total \+ 1;/, 'stagesTile: first stage at 1, no gap, no overlap, last stage ends at the final statement');
  need('prod-sql.ts', c, /if \(stageDigest\(gate\) !== gateAction\.stageSha256\) throw new RunnerRefusal\('prod_sql_hash_mismatch'/, 'the shape gate is verified against its own stage pin');
  need('prod-sql.ts', c, /if \(!shape\.passed\) throw new RunnerRefusal\('prod_sql_l1_shape_not_ok'/, 'a failed L1 shape check stops the run');
  need('prod-sql.ts', c, /if \(plan\.gate !== undefined\) \{[\s\S]*?enforceL1Shape\(action, gateResults\[0\], gateResults\[1\]\);\s*\}\s*const shapeRows: unknown\[\] = \[\];\s*for \(const \[i, statement\] of body\.entries\(\)\)/, 'the gate runs, and must pass, before the first statement of the gated action');
  need('prod-sql.ts', c, /if \(action\.report === 'shape'\) enforceL1Shape\(action, shapeRows\[0\], shapeRows\[1\]\);\s*if \(shape === 'read_only'\)/, 'the shape stage is judged before its read-only transaction is rolled back and reported done');
  if (!/export function evaluateL1Shape\(/.test(c) || !/no_unreviewed_auth_tables/.test(c)) failures.push('prod-sql.ts must keep evaluateL1Shape with the reviewed-inventory check');
  need('prod-sql.ts', c, /line\?\.\[1\] !== action\.sha256\) throw new RunnerRefusal\('prod_sql_hash_mismatch'/, 'the migration-manifest agreement refusal');
  need('prod-sql.ts', c, /if \(input\.confirm !== action\.phrase\) \{\s*throw new RunnerRefusal\('confirmation_required'/, 'the exact per-action phrase refusal');
  need('prod-sql.ts', c, /if \(found === 'invalid'\) throw new RunnerRefusal\('prod_sql_shape_refused'/, 'the refusal of any transaction shape other than wrapped or own');
  need('prod-sql.ts', c, /if \(action\.mode === 'read_only' && found !== 'wrapped'\) throw/, 'the read-only action refusal when the file carries its own transaction control');
  need('prod-sql.ts', c, /const body = shape === 'own' \? statements\.slice\(1, -1\) : statements;/, 'no double wrap: an own-transaction file sends its own begin and commit only');
  need('prod-sql.ts', c, /shape === 'read_only' \? 'begin read only' : shape === 'own' \? statements\[0\]!\.raw : 'begin'/, 'begin read only / the file\'s own begin / the runner\'s begin');
  need('prod-sql.ts', c, /committing = true;\s*const committed = await client\.query\(shape === 'own' \? statements\[statements\.length - 1\]!\.raw : 'commit'\);\s*if \(committed\?\.command === 'ROLLBACK'\) \{\s*committing = false;\s*throw new RunnerRefusal\('prod_sql_commit_rolled_back'/, 'CR17: committing flag before COMMIT; a COMMIT returning ROLLBACK is a definite failure');
  need('prod-sql.ts', c, /if \(committing\) \{\s*line\(\{ msg: 'prod-sql\.result', action: action\.id, result: 'unknown', statements: ran \}\);\s*throw new ProdSqlResultUnknown\(err\);/, 'CR17: a failed COMMIT is unknown and is neither rolled back nor retried');
  need('prod-sql.ts', c, /\.on\?\.\('error', \(\) => undefined\);\s*await client\.connect\(\);/, 'the pg error listener attached before connect');
  if (c.match(/query\('commit'\)|query\(shape === 'own'[^)]*commit/g)?.length !== 1) failures.push('prod-sql.ts: exactly one COMMIT send site is allowed (never retried)');
  if (/\b(severity|\.message)\b/.test(c.replace(/err instanceof Error \? err\.message : String\(err\)/g, ''))) failures.push('prod-sql.ts must not read severity or message text of a database error');
  // The planner order: target, action, url, ref, port, file hash, manifest, shape, then the phrase; nothing connects in the planner.
  const planBody = c.slice(c.indexOf('export function planProdSql'), c.indexOf('export function selectProdSqlDbUrl'));
  let at = -1;
  for (const s of ['prod_sql_target_refused', "'unknown_action'", "'db_url_required'", 'target_not_recorded_production', 'port_must_be_5432', 'prod_sql_hash_mismatch', 'prod_sql_shape_refused', "input.confirm !== action.phrase"]) {
    const i = planBody.indexOf(s, at + 1);
    if (i < 0) failures.push(`prod-sql.ts: planner is missing or out of order: ${s}`); else at = i;
  }
  if (/new pg\.|\.connect\(|clientFactory|createPool/.test(planBody)) failures.push('prod-sql.ts: the planner must not open a connection');
  // No ambient environment, no network, no hard-coded address or secret, no repeated production ref.
  for (const forbidden of [/process\.env/, /\bfetch\s*\(/, /sb_secret_|postgres(ql)?:\/\//i, /password\s*[:=]/i, /service_role_key/i, /doppler/i]) if (forbidden.test(c)) failures.push(`prod-sql.ts must not contain ${forbidden}`);
  if (mod.includes(PRODUCTION_REF)) failures.push('prod-sql.ts must read the production ref from target-guard.ts, not repeat it');
  // Reporting prints counts, enumerated words and the pinned hash only.
  const reporting = mod.slice(mod.indexOf('// Reporting'), mod.indexOf('// Execution'));
  if (/\.host\b|\.user\b|\.password\b|\.database\b|err\b|\.message\b/.test(reporting)) failures.push('prod-sql.ts: the reporting section must not print connection details or error text');
  for (const event of ['prod-sql.counts', 'prod-sql.statement', 'prod-sql.result']) if (!mod.includes(`'${event}'`)) failures.push(`prod-sql.ts does not emit ${event}`);
}

if (split) {
  const c = code(split);
  for (const required of ["'meta_command'", "'unterminated'", "'sql_standard_function_body'", "'concurrently'", "'not_transactional'", "return 'wrapped'", "return 'own'", "return 'invalid'", 'DOLLAR_TAG']) if (!c.includes(required)) failures.push(`prod-sql-split.ts is missing: ${required}`);
  if (/\b(readFileSync|process\.env|fetch|console\.)/.test(c)) failures.push('prod-sql-split.ts must stay pure (no file, environment, network or output)');
}

if (runner) {
  const c = code(runner);
  for (const required of ['let target: string | undefined;', "arg === '--execute'", "'prod-sql.plan_only'", "'prod-sql.refused'", 'classifyRunnerFailure', 'selectProdSqlDbUrl(env)', 'planProdSql(', 'if (!args.execute)', 'ProdSqlResultUnknown']) {
    if (!c.includes(required)) failures.push(`prod-sql-runner.ts is missing: ${required}`);
  }
  if (/target\s*=\s*'(staging|production)'/.test(c) || /let target[^;]*=/.test(c)) failures.push('prod-sql-runner.ts: --target must have no default');
  if ((c.match(/process\.env/g) ?? []).length !== 1) failures.push('prod-sql-runner.ts: process.env may be read exactly once, at the direct-invocation entry point');
  const planAt = c.indexOf('if (!args.execute)');
  const execAt = c.indexOf('await executeProdSqlPlan');
  if (planAt < 0 || execAt < 0 || planAt > execAt) failures.push('prod-sql-runner.ts: the plan-only return must come before anything connects');
  if (/(connection|dbUrl|password|host)[^\n]*console\.(log|error)|console\.(log|error)[^\n]*(dbUrl|password|\.host|\.db\b)/.test(c)) failures.push('prod-sql-runner.ts must not print connection details');
  if (/hint:\s*'[^']*--execute/.test(c) === false) failures.push('prod-sql-runner.ts: the plan-only event must say "add --execute to run"');
}

// The older runners must still refuse production and must not know about this tool.
for (const f of ['pipeline/src/staging-sql-runner.ts', 'pipeline/src/staging-rebuilt.ts', 'pipeline/src/first-manager-bootstrap.ts']) {
  const s = read(f);
  if (!s) failures.push(`missing ${f}`);
  else if (/prod-sql|prod_sql/.test(s)) failures.push(`${f} must not reference the production SQL runner (separate runner, separate per-action phrases)`);
}

// ---------------------------------------------------------------------------------------------------------------
// Wiring: refusal ids, wrapper allow-list (events, enumerated lists), prompt-only URL, package scripts, verification chain, doc.
// ---------------------------------------------------------------------------------------------------------------
const NEW_IDS = ['prod_sql_target_refused', 'prod_sql_action_not_built', 'prod_sql_file_unreadable', 'prod_sql_hash_mismatch', 'prod_sql_shape_refused', 'prod_sql_commit_rolled_back', 'prod_sql_l1_shape_not_ok'];
if (refusals && wrapper) {
  for (const id of NEW_IDS) {
    if (!refusals.includes(`'${id}'`)) failures.push(`refusals.ts is missing ${id}`);
    if (!wrapper.includes(`'${id}'`)) failures.push(`run-with-secrets.mjs REFUSAL_IDS is missing ${id}`);
  }
}
if (wrapper) {
  for (const required of ["'prod-sql.verified'", "'prod-sql.plan_only'", "'prod-sql.statement'", "'prod-sql.counts'", "'prod-sql.shape'", "'prod-sql.result'", "'prod-sql.done'", "'prod-sql.refused'", 'export const PROD_SQL_ACTIONS', 'export const PROD_SQL_COUNT_NAMES', 'export const PROD_SQL_SHAPE_CHECKS',
    "export const PROMPT_ONLY = ['PRODUCTION_DB_URL']", 'can only be entered at the hidden prompt, never taken from the environment', "sha256: pat(/^[0-9a-f]{64}$/)", "target: oneOf(['production'])"]) {
    if (!wrapper.includes(required)) failures.push(`run-with-secrets.mjs is missing: ${required}`);
  }
  for (const required of ["FROM_ENV_PROJECT = 'truck-recruitment-tool'", "FROM_ENV_CONFIG = 'stg'"]) if (!wrapper.includes(required)) failures.push(`run-with-secrets.mjs: --from-env scope changed (${required})`);
  // The wrapper's action list equals the table (derived here from the table text).
  const listed = /export const PROD_SQL_ACTIONS = \[([\s\S]*?)\];/.exec(wrapper)?.[1].match(/'([a-z0-9-]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  if (JSON.stringify(listed) !== JSON.stringify(actions.map((a) => a.id))) failures.push('run-with-secrets.mjs PROD_SQL_ACTIONS must equal the action table ids, in order');
  const names = /export const PROD_SQL_COUNT_NAMES = \[([\s\S]*?)\];/.exec(wrapper)?.[1].match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  const tableNames = [...new Set([...(mod ? code(mod) : '').matchAll(/countNames: \[([^\]]*)\]/g)].flatMap((m) => m[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1)))];
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...tableNames].sort())) failures.push('run-with-secrets.mjs PROD_SQL_COUNT_NAMES must equal the countNames in the action table');
}
if (pkg) {
  for (const required of ['"prod-sql": "tsx src/prod-sql-runner.ts"', '"test:prod-sql": "tsx src/prod-sql.test.ts"']) if (!pkg.includes(required)) failures.push(`pipeline/package.json is missing: ${required}`);
  if (!/"test": "[^"]*tsx src\/prod-sql\.test\.ts/.test(pkg)) failures.push('pipeline/package.json: the "test" script (and so "build" and "verify") must run src/prod-sql.test.ts');
}
if (!ci || !ci.includes('node scripts/verify-prod-sql-runner-contract.mjs')) failures.push('.github/workflows/ci.yml must run scripts/verify-prod-sql-runner-contract.mjs next to the first-manager contract');
if (!safety || !safety.includes('verify-prod-sql-runner-contract.mjs')) failures.push('.github/ci/repository-safety.sh must run verify-prod-sql-runner-contract.mjs');
if (!doc) failures.push('missing docs/build-plan/18-production-sql-route-options.md');
else if (!doc.includes("BUILT, PENDING REVIEW AND HUNTER'S OPEN-1 CHOICE")) failures.push('doc 18 must carry the section marked "BUILT, PENDING REVIEW AND HUNTER\'S OPEN-1 CHOICE"');

if (failures.length > 0) {
  console.error('verify-prod-sql-runner-contract: FAILED');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`verify-prod-sql-runner-contract: ok (${actions.length} actions, every pinned file re-hashed; guard statements, wrapper allow-list, refusal ids, test chain and CI wiring checked)`);
