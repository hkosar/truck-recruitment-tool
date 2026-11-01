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
let warningSentences = {};
let irreversibleIds = [];
let listOfTables = [];
let listOfStopTables = [];
const PROD_SQL_STOP_ACTIONS_UNEXPECTED = (src) => [...src.matchAll(/\{ id: '([a-z0-9-]+)'[^}]*?stopTables: '([a-z_]+)'/g)].map((m) => `${m[1]}:${m[2]}`).join() !== 'l1-shape:report,l1-sweep:must_be_empty';
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
for (const f of ['pipeline/src/prod-sql.test.ts', 'pipeline/src/prod-sql-a3.test.ts', 'pipeline/src/prod-sql-a2-backouts-a3.test.ts']) if (!existsSync(resolve(root, f))) failures.push(`missing ${f}`);

// ---------------------------------------------------------------------------------------------------------------
// The action table: every pinned file exists and still has the pinned SHA-256; stages tile their file; phrases are unique and exact.
// ---------------------------------------------------------------------------------------------------------------
const actions = [];
if (mod) {
  const c = code(mod);
  for (const m of c.matchAll(/MIGRATION\('([a-z0-9-]+)', '[^']*', '([^']+)', '([0-9a-f]{64})'\)/g)) actions.push({ id: m[1], file: `supabase/migrations/${m[2]}`, sha: m[3], manifestName: m[2], phrase: `RUN TNBS PRODUCTION SQL ${m[1].toUpperCase()}` });
  for (const m of c.matchAll(/\{ id: '([a-z0-9-]+)', step: '[^']*', file: '([^']+)', sha256: '([0-9a-f]{64})'(?:, statements: \[(\d+), (\d+)\], stageSha256: '([0-9a-f]{64})')?, mode: '(read_only|write)', report: '(none|rows|digest|counts|shape|flag)'(?:, gate: '([a-z0-9-]+)')?(?:, flagName: '([a-z_]+)', flagExpect: (true|false))?[^}]*?phrase: '([^']+)' \}/g)) {
    actions.push({ id: m[1], file: m[2], sha: m[3], from: m[4] === undefined ? undefined : Number(m[4]), to: m[5] === undefined ? undefined : Number(m[5]), stageSha: m[6], mode: m[7], report: m[8], gate: m[9], flagName: m[10], flagExpect: m[11] === undefined ? undefined : m[11] === 'true', phrase: m[12] });
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
    listOfTables = tables;
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
  // ---- B1: the reviewed auth table list is ONE pinned data file; a table is listed only with an explicit classification and a cited source; the gate keeps
  // refusing anything not classified; nothing is bulk-added; the list is not repeated in code.
  {
    const FILE = 'supabase/rollout/auth-table-classification.json';
    const CLASSES = ['credential-bearing: handled by L1', 'credential-bearing: STOP', 'not credential-bearing: reviewed'];
    const pinFile = /export const AUTH_CLASSIFICATION_FILE = '([^']+)'/.exec(c)?.[1];
    const pinSha = /export const AUTH_CLASSIFICATION_SHA256 = '([0-9a-f]{64})'/.exec(c)?.[1];
    const pinnedClasses = (/export const AUTH_CLASSIFICATIONS = \[([^\]]*)\] as const/.exec(c)?.[1].match(/'([^']+)'/g) ?? []).map((q) => q.slice(1, -1));
    if (pinFile !== FILE) failures.push(`prod-sql.ts: AUTH_CLASSIFICATION_FILE must be ${FILE}`);
    if (JSON.stringify(pinnedClasses) !== JSON.stringify(CLASSES)) failures.push('prod-sql.ts: AUTH_CLASSIFICATIONS must be exactly "credential-bearing: handled by L1", "credential-bearing: STOP", "not credential-bearing: reviewed"');
    const bytes = existsSync(resolve(root, FILE)) ? readFileSync(resolve(root, FILE)) : undefined;
    if (!bytes) failures.push(`missing ${FILE}`);
    else {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== pinSha) failures.push(`prod-sql.ts pins the classification file at ${String(pinSha).slice(0, 12)}... but ${FILE} is ${actual.slice(0, 12)}... (the list changed or the pin is stale: review, then update the pin)`);
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { failures.push(`${FILE} is not valid JSON`); }
      const entries = Array.isArray(data?.tables) ? data.tables : [];
      listOfStopTables = entries.filter((e) => e?.classification === 'credential-bearing: STOP').map((e) => e.table);
      if (entries.length === 0) failures.push(`${FILE} lists no tables`);
      const seen = new Set();
      for (const e of entries) {
        if (typeof e?.table !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(e.table) || seen.has(e.table)) failures.push(`${FILE}: an entry has a missing, badly named or repeated table`);
        seen.add(e?.table);
        if (!CLASSES.includes(e?.classification)) failures.push(`${FILE}: ${e?.table} has no explicit allowed classification`);
        if (typeof e?.source !== 'string' || e.source.trim() === '') failures.push(`${FILE}: ${e?.table} has no cited source`);
        else {
          const cited = e.source.match(/[A-Za-z0-9_./-]+\.(?:sql|md|ts|mjs|json)\b/g) ?? [];
          if (cited.length === 0) failures.push(`${FILE}: the source of ${e.table} must cite at least one repository file`);
          for (const f of cited) if (!existsSync(resolve(root, f))) failures.push(`${FILE}: the source of ${e.table} cites ${f}, which does not exist`);
        }
      }
      const handled = entries.filter((e) => e?.classification === 'credential-bearing: handled by L1').map((e) => e.table);
      if ([...handled].sort().join() !== [...listOfTables].sort().join()) failures.push(`${FILE}: the tables classified "handled by L1" must be exactly L1_AUTH_TABLES (${listOfTables.join()})`);
      const l1Sql = (read('supabase/rollout/L1-close-legacy-auth.sql') ?? '').replace(/--[^\n]*/g, '');
      for (const t of handled) {
        const clears = t === 'users' ? /update\s+auth\.users\b/i.test(l1Sql) : new RegExp(`delete\\s+from\\s+auth\\.${t}\\b`, 'i').test(l1Sql);
        if (!clears) failures.push(`${FILE}: ${t} is classified "handled by L1" but the L1 file does not clear it`);
      }
      // Every listed table must be a table of the staging-2 capture (the mirror fixture), every captured table must be listed, and a table with a secret, hash, code or credential column must not be reviewed as harmless.
      const MIRROR = 'supabase/tests/a3/harness/auth-staging2-mirror.json';
      let mirror;
      try { mirror = JSON.parse(readFileSync(resolve(root, MIRROR), 'utf8')); } catch { failures.push(`missing or invalid ${MIRROR}`); }
      const captured = Object.keys(mirror?.tables ?? {});
      if (captured.length !== 27) failures.push(`${MIRROR}: expected the 27 captured tables, found ${captured.length}`);
      for (const t of captured) if (!seen.has(t)) failures.push(`${FILE}: the captured table ${t} is not classified`);
      for (const t of seen) if (!captured.includes(t)) failures.push(`${FILE}: ${t} is not in the staging-2 capture; add it only from reviewed evidence`);
      // A SCIM user resource may carry a password (RFC 7643 section 4.1.1) and the table is unrestricted json that L1 does not clear: it stays STOP until a reviewed contract proves otherwise.
      if (entries.find((e) => e.table === 'scim_users')?.classification !== 'credential-bearing: STOP') failures.push(`${FILE}: scim_users must be classified credential-bearing: STOP (unrestricted resource json; RFC 7643 section 4.1.1 defines a password attribute)`);
      for (const e of entries) {
        const secretCol = (mirror?.tables?.[e.table] ?? []).find((c) => /secret|token|code_hash|otp_code|code_verifier|authorization_code|credential|session_data|encrypted_password/i.test(c.column));
        if (secretCol && e.classification === 'not credential-bearing: reviewed') failures.push(`${FILE}: ${e.table} has the column ${secretCol.column} but is classified as not credential-bearing`);
      }
    }
    need('prod-sql.ts', c, /const known = new Set<string>\(classification\.map\(\(e\) => e\.table\)\);/, 'the shape gate knows exactly the tables the classification file lists (a STOP table is listed, so it is judged by emptiness below; an unlisted table stops the gate)');
    need('prod-sql.ts', c, /const unreviewedAuthTables = tables === undefined \? 0 : tables\.filter\(\(r\) => typeof r\.table_name !== 'string' \|\| !known\.has\(r\.table_name\)\)\.length;/, 'every auth table that is not in the known set (or has no name) is counted unreviewed, and unreviewed stops the gate');
    need('prod-sql.ts', c, /const shape = evaluateL1Shape\(columnResult, tableResult, classification \?\? \[\]\);/, 'a plan without a verified classification fails closed');
    need('prod-sql.ts', c, /const classification = action\.report === 'shape' \|\| action\.gate !== undefined \|\| action\.stopTables !== undefined \? loadAuthClassification\(files\) : undefined;/, 'the classification is read, pin-checked and parsed at plan time for the shape stage and the gated sweep');
    need('prod-sql.ts', c, /if \(sha256Hex\(bytes\) !== AUTH_CLASSIFICATION_SHA256\) throw new RunnerRefusal\('prod_sql_hash_mismatch'/, 'the classification file hash refusal');
    if (/L1_REVIEWED_OTHER_AUTH_TABLES|const known = new Set<string>\(\[/.test(c)) failures.push('prod-sql.ts must not repeat the reviewed table list in code (it lives only in the classification file)');
  }
  // Read-only actions never write; every action that has report 'counts' names its columns.
  for (const a of actions) if (a.report === 'counts' && !new RegExp(`id: '${a.id}'[^}]*countNames: \\[`).test(c)) failures.push(`prod-sql.ts: ${a.id} reports counts but pins no countNames`);
  // The files doc 17 names that exist on this branch must all have an action.
  for (const f of ['supabase/pending/M1_same_origin_signin.sql', 'supabase/pending/M1b_add_person.sql', 'supabase/pending/M1c_batch_delete_audit.sql', 'supabase/backout/pre-cutover-snapshot.sql', 'supabase/backout/retire-app-credentials.sql',
    'supabase/backout/M1-backout.sql', 'supabase/backout/M1b-backout.sql', 'supabase/backout/M1c-backout.sql', 'supabase/rollout/L1-close-legacy-auth.sql',
    'supabase/backout/security-hardening-backout.sql', 'supabase/rollout/backout-window-on.sql', 'supabase/rollout/backout-window-off.sql',
    'supabase/rollout/read-only-inventory.sql', 'supabase/rollout/bootstrap-identity-check.sql']) {
    if (existsSync(resolve(root, f)) && !actions.some((a) => a.file === f)) failures.push(`prod-sql.ts: ${f} exists but has no action`);
  }
  const missingSrc = c.slice(c.indexOf('export const PROD_SQL_MISSING'), c.indexOf('export const PROD_SQL_DO_NOT_USE'));
  // Anything listed as missing must stay absent from the table; a listed file that has appeared must be pinned by its own reviewed change (drift).
  for (const m of missingSrc.matchAll(/\{ id: '([a-z0-9-]+)', step: '[^']*',(?: file: '([^']+)',)? reason:/g)) {
    if (actions.some((a) => a.id === m[1])) failures.push(`prod-sql.ts: ${m[1]} is both runnable and listed as missing`);
    if (m[2] && !m[2].endsWith('09-production-baseline-reconciliation.sql') && existsSync(resolve(root, m[2]))) failures.push(`prod-sql.ts: ${m[2]} now exists in the repository; move it from PROD_SQL_MISSING to the action table with a pin (a reviewed change)`);
  }
  // ---- Every action the cutover runbook names resolves: it is a built action (table) or an explicit missing entry (with a reason), never both and never neither.
  // The runbook (docs/build-plan/17-signin-cutover-runbook-draft.md) lives on the cutover-prep branch; its actions are listed here with the step that names them.
  {
    const BUILT = ['migration-security-hardening', 'migration-profile-service-bootstrap', 'migration-dnc-activity-enum-cast', 'migration-contact-logs-dnc-guard', 'snapshot', 'm1', 'm1b', 'm1c', 'window-on', 'l1-shape', 'l1-counts', 'l1-sweep',
      'retire-nologin', 'retire-terminate', 'retire-backends', 'retire-revoke', 'retire-checks', 'retire-email', 'backout-m1c', 'backout-m1b', 'backout-m1', 'security-hardening-backout', 'read-only-inventory', 'bootstrap-identity-check', 'window-off'];
    const MISSING = ['reconciliation'];
    const tableIds = actions.map((a) => a.id);
    const missingIds = [...missingSrc.matchAll(/\{ id: '([a-z0-9-]+)', step: '[^']*',(?: file: '[^']+',)? reason:/g)].map((m) => m[1]);
    if (JSON.stringify([...tableIds].sort()) !== JSON.stringify([...BUILT].sort())) failures.push(`prod-sql.ts: the built actions (${tableIds.join()}) must be exactly the runbook actions this contract resolves as built (${BUILT.join()}); a new or removed action needs a reviewed change here too`);
    if (JSON.stringify([...missingIds].sort()) !== JSON.stringify([...MISSING].sort())) failures.push(`prod-sql.ts: the missing list (${missingIds.join()}) must be exactly ${MISSING.join()}: an action leaves it only when reviewed SQL for it is pinned`);
    for (const id of [...BUILT, ...MISSING]) if (tableIds.includes(id) === missingIds.includes(id)) failures.push(`prod-sql.ts: runbook action ${id} must be exactly one of built or missing`);
    // No SQL was invented for a missing action: no file under supabase/ is named for it.
    for (const f of ['supabase/backout/reconciliation.sql', 'supabase/rollout/reconciliation.sql']) if (existsSync(resolve(root, f))) failures.push(`${f} exists but its action is listed as missing; pin it by a reviewed change`);
  }
  // ---- DRAFT, PENDING REVIEW: read-only-inventory (A1), bootstrap-identity-check (BO3); profile-bootstrap-backout and dnc-enum-cast-backout are DO NOT USE (refused, never actions).
  {
    const strip = (t) => t.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    const spec = [['read-only-inventory', 'read_only', 'counts'], ['bootstrap-identity-check', 'read_only', 'counts']];
    for (const [id, mode, report] of spec) {
      const a = actions.find((x) => x.id === id);
      if (!a) { failures.push('prod-sql.ts: missing action ' + id); continue; }
      if (a.mode !== mode || a.report !== report || a.from !== undefined || a.flagName !== undefined) failures.push('prod-sql.ts: ' + id + ' must be a whole-file ' + mode + ' action with report ' + report);
      const text = readFileSync(resolve(root, a.file), 'utf8');
      const header = text.split('\n').filter((l) => l.startsWith('--')).join('\n');
      if (!/DRAFT, PENDING REVIEW/.test(header) || !/NOT EXECUTED ANYWHERE/.test(header) || !/doc 17/.test(header) || !/301418b/.test(header) || !/f1189dc/.test(header)) failures.push(a.file + ': the header must say DRAFT, PENDING REVIEW and NOT EXECUTED ANYWHERE and cite doc 17 at 301418b and f1189dc');
      const parts = splitStatements(text).map(strip);
      if (parts.length !== 1 || !/^select /.test(parts[0])) failures.push(a.file + ': must be exactly one select statement');
      if (/\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|call|do|set|reset|lock|vacuum|analyze|comment|nextval|setval|into|begin|commit|rollback)\b|\bpg_[a-z_]+/i.test(parts[0] ?? '')) failures.push(a.file + ': a read-only check must hold no write, DDL, lock, transaction control or pg_ function');
      const tables = [...(parts[0] ?? '').matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1].toLowerCase());
      const allowedTables = id === 'read-only-inventory' ? ['public.profiles', 'auth.users'] : ['public.profiles', 'auth.users', 'internal.auth_events'];
      if (tables.length === 0 || tables.some((t) => !allowedTables.includes(t))) failures.push(a.file + ': may read only ' + allowedTables.join(', '));
      const outer = (parts[0] ?? '').slice('select '.length, (parts[0] ?? '').indexOf(' from (')).split(',').map((x) => x.trim().replace(/^[a-z]\./, ''));
      const pinned = [...c.matchAll(new RegExp("id: '" + id + "'[^}]*?countNames: \\[([^\\]]*)\\]", 'g'))].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((n) => n[1]))[0] ?? [];
      const expectedCount = id === 'read-only-inventory' ? 20 : 4;
      if (outer.join() !== pinned.join() || pinned.length !== expectedCount) failures.push(a.file + ': the pinned countNames must equal the ' + expectedCount + ' output columns in order');
      if (id === 'read-only-inventory') {
        if ((text.match(/\(proposed, not from a reviewed doc/g) ?? []).length !== 3) failures.push(a.file + ': each proposed count must be marked "(proposed, not from a reviewed doc)" (3 of them)');
        if (!/bootstrap-identity-check/.test(header) || !/CANNOT show that the missing one is the first manager/.test(header)) failures.push(a.file + ': the header must say the orphan total cannot identify the first manager and point to bootstrap-identity-check');
      } else {
        if (!/first_manager_bootstrap/.test(parts[0]) || !/internal\.auth_events/.test(parts[0])) failures.push(a.file + ': must tie the check to internal.auth_events kind first_manager_bootstrap');
        if (!/BEFORE the M1 backouts/.test(header)) failures.push(a.file + ': the header must say it runs BEFORE the M1 backouts');
        if (/\b(user_id|email|full_name)\b/.test(parts[0].slice('select '.length, parts[0].indexOf(' from (')))) failures.push(a.file + ': the outer select must return counts only, never an identity');
      }
    }
    // The two historical backouts are DO NOT USE: refused by id, never an action, header marked, the forward fix retained. The restored bodies stay equal to the earlier definitions (a record).
    const dnuSrc = c.slice(c.indexOf('export const PROD_SQL_DO_NOT_USE'), c.indexOf('export const PROD_SQL_ACTION_IDS'));
    const dnuIds = [...dnuSrc.matchAll(/\{ id: '([a-z0-9-]+)', step: '[^']*', file: '([^']+)', reason:/g)].map((m) => m[1] + '=' + m[2]);
    const dnuWant = ['profile-bootstrap-backout=supabase/backout/profile-bootstrap-backout.sql', 'dnc-enum-cast-backout=supabase/backout/dnc-enum-cast-backout.sql'];
    if (JSON.stringify(dnuIds) !== JSON.stringify(dnuWant)) failures.push('prod-sql.ts: PROD_SQL_DO_NOT_USE must list exactly ' + dnuWant.join(' and '));
    if (!/RunnerRefusal\('prod_sql_action_do_not_use'/.test(c)) failures.push("prod-sql.ts: the planner must refuse a DO NOT USE action with 'prod_sql_action_do_not_use'");
    for (const entry of dnuWant) {
      const [id, file] = entry.split('=');
      if (actions.some((x) => x.id === id || x.file === file)) failures.push('prod-sql.ts: ' + id + ' is DO NOT USE and must never be in the action table');
      const text = read(file);
      if (text === undefined || text === null) { failures.push('missing ' + file); continue; }
      const top = text.split('\n').slice(0, 9).join('\n');
      if (!/^-- DO NOT USE\. DO NOT RUN THIS FILE\./m.test(top) || !/RETAIN THE FORWARD FIX/.test(top)) failures.push(file + ': the header must start with DO NOT USE and say the forward fix is retained');
      const migration = id === 'profile-bootstrap-backout' ? '20260723004500_profile_service_bootstrap.sql' : '20260723010400_dnc_activity_enum_cast.sql';
      if (!text.includes(migration)) failures.push(file + ': the header must name the migration it reverses (' + migration + ')');
      const earlier = id === 'profile-bootstrap-backout' ? 'supabase/migrations/20260720000300_profiles.sql' : 'supabase/migrations/20260720001100_rpc.sql';
      const marker = id === 'profile-bootstrap-backout' ? 'as $$\nbegin\n  if (new.role' : 'as $$\ndeclare\n  v_uid';
      const src = read(earlier) ?? '';
      const from = id === 'profile-bootstrap-backout' ? 0 : src.indexOf('create or replace function public.set_do_not_contact(');
      const bodyOf = (tx, st) => { const i = tx.indexOf(marker, st); return i < 0 ? null : tx.slice(i, tx.indexOf('$$;', i) + 3); };
      const mine = bodyOf(text, 0);
      if (mine === null || mine !== bodyOf(src, from)) failures.push(file + ': the historical function body must still equal, byte for byte, the earlier definition in ' + earlier);
    }
  }

  // ---- The window statements are the reviewed ones: two statements per file (the update, then the verify select), the same verify select in both, and each update
  // is the one doc 16 section 3.1 and the runbook give. The flag and its expected value are pinned in the table and match the update.
  {
    const strip = (t) => t.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    const verifySelect = 'select email_edits_paused from internal.backout_window';
    const doc16 = (read('docs/build-plan/16-staging-and-hosting-plan.md') ?? '').replace(/\s+/g, ' ');
    const flagActions = actions.filter((a) => a.report === 'flag');
    if (flagActions.map((a) => a.id).join() !== 'window-on,window-off') failures.push("prod-sql.ts: only window-on and window-off may use report 'flag'");
    if (actions.some((a) => a.report !== 'flag' && (a.flagName !== undefined || a.flagExpect !== undefined))) failures.push('prod-sql.ts: only a flag action may pin flagName or flagExpect');
    for (const [id, value] of [['window-on', true], ['window-off', false]]) {
      const a = actions.find((x) => x.id === id);
      if (!a) continue;
      if (a.flagName !== 'email_edits_paused' || a.flagExpect !== value || a.mode !== 'write') failures.push(`prod-sql.ts: ${id} must be a write action that expects email_edits_paused = ${value}`);
      let parts = [];
      try { parts = splitStatements(readFileSync(resolve(root, a.file), 'utf8')).map(strip); } catch { failures.push(`${a.file} could not be split by the contract's own splitter`); continue; }
      const update = `update internal.backout_window set email_edits_paused = ${value}`;
      if (parts.length !== 2 || parts[0] !== update || parts[1] !== verifySelect) failures.push(`${a.file} must be exactly: ${update}; ${verifySelect}; (nothing else)`);
      if (id === 'window-on' && !doc16.includes(update)) failures.push('docs/build-plan/16-staging-and-hosting-plan.md section 3.1 no longer holds the window-on update statement the file copies');
      if (!doc16.includes(verifySelect)) failures.push('docs/build-plan/16-staging-and-hosting-plan.md section 3.1 no longer holds the verify select the window files copy');
      const header = readFileSync(resolve(root, a.file), 'utf8').split('\n').filter((l) => l.startsWith('--')).join('\n');
      if (!/docs\/build-plan\/16-staging-and-hosting-plan\.md section 3\.1/.test(header) || !/f1189dc/.test(header) || !/VERBATIM/.test(header)) failures.push(`${a.file}: the header comment must cite doc 16 section 3.1, the reviewed runbook commit f1189dc and say the statements are copied VERBATIM`);
    }
    // The hardening backout is the reviewed file byte for byte: its git blob id is the one recorded at f1189dc (a later merge of that branch is then identical).
    const hb = existsSync(resolve(root, 'supabase/backout/security-hardening-backout.sql')) ? readFileSync(resolve(root, 'supabase/backout/security-hardening-backout.sql')) : undefined;
    if (!hb) failures.push('missing supabase/backout/security-hardening-backout.sql');
    else {
      const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${hb.length}\0`), hb])).digest('hex');
      if (blob !== '608b69d1ef0d2fd5179446cb661c8bc8a0ac1756') failures.push(`supabase/backout/security-hardening-backout.sql is not the file reviewed at f1189dc (git blob ${blob}); it must be copied byte for byte`);
    }
    // The flag report is judged inside the transaction, before the commit, and is the only thing that prints the flag.
    need('prod-sql.ts', c, /if \(action\.report === 'flag' && commandOf\(statement\) === 'select'\) enforceFlag\(action, result\);/, 'the flag is judged right after the verify select, inside the transaction and before the commit');
    need('prod-sql.ts', c, /if \(flagValue\(action, result\) !== action\.flagExpect\) throw new RunnerRefusal\('prod_sql_flag_not_expected'/, 'a flag that is not the expected value refuses (the caller rolls back)');
    need('prod-sql.ts', c, /if \(action\.flagName === undefined \|\| action\.flagExpect === undefined \|\| body\.length < 2 \|\| commandOf\(body\[body\.length - 1\]!\) !== 'select'\) throw new RunnerRefusal\('prod_sql_shape_refused'/, 'a flag action must pin its flag and end with the select that reads it');
  }

  // ---- B2: an action whose pinned statements end database connections (pg_terminate_backend) cannot be undone by a rollback, so it must carry the
  // irreversible flag (derived here from the statements themselves, not from the table), and nothing else may carry it.
  {
    const terminating = [];
    for (const a of actions) {
      const text = existsSync(resolve(root, a.file)) ? readFileSync(resolve(root, a.file), 'utf8') : '';
      let stage;
      try { const all = splitStatements(text); stage = a.from === undefined ? all : all.slice(a.from - 1, a.to); } catch { stage = [text]; }
      if (stage.some((st) => /pg_terminate_backend/i.test(st.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')))) terminating.push(a.id);
    }
    const flagged = actions.filter((a) => new RegExp(`id: '${a.id}'[^}]*?irreversible: 'terminates_connections'`).test(c)).map((a) => a.id);
    if (terminating.join() !== flagged.join()) failures.push(`prod-sql.ts: the actions whose pinned statements call pg_terminate_backend (${terminating.join() || 'none'}) must be exactly the actions flagged irreversible: 'terminates_connections' (${flagged.join() || 'none'})`);
    if (terminating.length === 0) failures.push('prod-sql.ts: no action calls pg_terminate_backend any more; if retire-terminate changed, review the irreversible-step warning before relaxing this check');
    need('prod-sql.ts', c, /export function emitIrreversibleWarning\(action: ProdSqlAction, warning: ProdSqlWarning\): void \{\s*if \(action\.irreversible === undefined\) return;\s*line\(\{ msg: 'prod-sql\.warning', action: action\.id, warning, notice: PROD_SQL_WARNINGS\[warning\] \}\);/, 'the fixed warning event (action id, warning id, fixed sentence; nothing else)');
    need('prod-sql.ts', c, /await runProdSqlPlan\(client, plan\);\s*\} catch \(err\) \{\s*emitIrreversibleWarning\(plan\.action, 'rollback_does_not_restore_connections'\);\s*throw err;\s*\} finally \{/, 'the after-failure warning for every run that ends in an error (rolled_back, rollback_not_confirmed or unknown): a rollback does not restore ended connections');
    const byId = Object.fromEntries([...(/export const PROD_SQL_WARNINGS = \{([\s\S]*?)\} as const;/.exec(c)?.[1] ?? '').matchAll(/([a-z_]+): '([^']*)'/g)].map((m) => [m[1], m[2]]));
    if (Object.keys(byId).join() !== 'connections_end_cannot_be_undone,rollback_does_not_restore_connections') failures.push('prod-sql.ts: PROD_SQL_WARNINGS must hold exactly connections_end_cannot_be_undone and rollback_does_not_restore_connections');
    for (const [id, words] of [['connections_end_cannot_be_undone', ['ENDS every database connection', 'cannot be brought back', 'a rollback does not restore them']], ['rollback_does_not_restore_connections', ['rolled_back or unknown', 'stay ended', 'STOP', 'do not retry', 'retire-backends']]]) {
      for (const w of words) if (!(byId[id] ?? '').includes(w)) failures.push(`prod-sql.ts: the ${id} warning must say "${w}"`);
    }
    warningSentences = byId;
    irreversibleIds = flagged;
  }

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
  need('prod-sql.ts', c, /if \(plan\.gate !== undefined\) \{[\s\S]*?enforceL1Shape\(action, gateResults\[0\], gateResults\[1\], plan\.classification\);\s*\}\s*if \(action\.stopTables === 'must_be_empty'\) \{[\s\S]*?\}\s*const shapeRows: unknown\[\] = \[\];\s*for \(const \[i, statement\] of body\.entries\(\)\)/, 'the gate runs, and must pass, and then the STOP-table check runs, before the first statement of the gated action');
  need('prod-sql.ts', c, /if \(action\.report === 'shape'\) \{[\s\S]*?enforceL1Shape\(action, shapeRows\[0\], shapeRows\[1\], plan\.classification\);\s*\}\s*if \(shape === 'read_only'\)/, 'the shape stage is judged before its read-only transaction is rolled back and reported done');
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
  // ---- STOP tables (Hunter's item 28, option 1): the sweep proceeds only while every credential-bearing STOP table is EMPTY, checked under a lock held to COMMIT.
  need('prod-sql.ts', c, /\{ id: 'l1-sweep'[^}]*?gate: 'l1-shape', stopTables: 'must_be_empty'/, "the l1-sweep action carries stopTables: 'must_be_empty' (removing it removes the emptiness check and the lock)");
  need('prod-sql.ts', c, /\{ id: 'l1-shape'[^}]*?report: 'shape', stopTables: 'report'/, "the l1-shape action reports the STOP tables as information (stopTables: 'report'; read-only, no lock)");
  if (PROD_SQL_STOP_ACTIONS_UNEXPECTED(c)) failures.push("prod-sql.ts: only l1-shape ('report') and l1-sweep ('must_be_empty') may carry stopTables");
  need('prod-sql.ts', c, /if \(action\.stopTables === 'must_be_empty'\) await client\.query\(READ_COMMITTED_SQL\);\s*if \(shape !== 'read_only'\) await client\.query\(LOCK_TIMEOUT_SQL\);\s*if \(plan\.gate !== undefined\)/, 'read committed is set before any query of the sweep transaction (so the count after the lock sees a fresh snapshot), then the 10 second lock timeout, then the gate');
  need('prod-sql.ts', c, /const LOCK_TIMEOUT_SQL = "set local lock_timeout = '10s'";/, 'a bounded lock timeout of 10 seconds');
  need('prod-sql.ts', c, /if \(action\.stopTables === 'must_be_empty'\) \{\s*if \(plan\.classification === undefined\) throw new RunnerRefusal\('prod_sql_shape_refused'[^\n]*\n\s*const stop = await readStopTables\(client, plan\.classification, true\);\s*reportStopTables\(action, stop\);\s*if \(stop\.populated > 0\) throw new RunnerRefusal\('prod_sql_l1_stop_table_populated'/, 'inside the sweep transaction: lock and count the STOP tables (lock = true), print the fixed event, and refuse (rolling back) unless none is populated; no classification means refuse');
  need('prod-sql.ts', c, /if \(action\.stopTables === 'report' && plan\.classification !== undefined\) reportStopTables\(action, await readStopTables\(client, plan\.classification, false\)\);\s*enforceL1Shape/, 'the read-only shape stage reports the STOP-table counts without a lock (lock = false) and still enforces the shape');
  const lockMode = /export const STOP_LOCK_MODE = '([a-z ]+)';/.exec(c)?.[1];
  if (!['share', 'share row exclusive', 'exclusive', 'access exclusive'].includes(lockMode ?? '')) failures.push(`prod-sql.ts: STOP_LOCK_MODE must be a table lock mode that conflicts with ROW EXCLUSIVE (what INSERT takes): share, share row exclusive, exclusive or access exclusive; found ${String(lockMode)}`);
  need('prod-sql.ts', c, /export const stopTablesLockSql = \(tables: readonly string\[\]\): string => `lock table \$\{tables\.map\(qualified\)\.join\(', '\)\} in \$\{STOP_LOCK_MODE\} mode`;/, 'the lock statement: LOCK TABLE <every existing STOP table> IN <STOP_LOCK_MODE> MODE, one statement, no NOWAIT (the lock timeout bounds the wait), no ONLY (children are locked too)');
  need('prod-sql.ts', c, /export const stopTableCountSql = \(table: string\): string => `select count\(\*\)::bigint as n from \$\{qualified\(table\)\}`;/, 'the STOP-table read is a count only; no column or row of the table is ever selected');
  const rst = c.slice(c.indexOf('export async function readStopTables'), c.indexOf('function reportStopTables'));
  if (!/await client\.query\(stopTablesLockSql\(existing\)\);/.test(rst) || rst.indexOf('await client.query(stopTablesLockSql(existing))') > rst.indexOf('await client.query(stopTableCountSql(t))') || rst.indexOf('await client.query(stopTableCountSql(t))') < 0) failures.push('prod-sql.ts: readStopTables must take the lock BEFORE it counts');
  if (!/if \(lock && existing\.length > 0\)/.test(rst)) failures.push('prod-sql.ts: readStopTables must lock only when asked to (the sweep) and only the tables that exist');
  if (!/STOP_LOCK_FAILURE_CODES: readonly string\[\] = \['55P03', '40P01', '42809'\];/.test(c) || !/throw new RunnerRefusal\('prod_sql_l1_stop_table_lock_failed'/.test(rst)) failures.push('prod-sql.ts: a lock timeout (55P03), a deadlock (40P01) or an unlockable object (42809) must be the fixed refusal prod_sql_l1_stop_table_lock_failed');
  need('prod-sql.ts', c, /const populated = existing\.filter\(\(t\) => counts\[t\] !== 0\)\.length;/, 'anything but an exact zero count (including an unreadable answer, -1) counts as populated');
  need('prod-sql.ts', c, /export const stopTablesOf = \(classification: readonly AuthTableClassification\[\]\): string\[\] =>\s*classification\.filter\(\(e\) => e\.classification === STOP_CLASSIFICATION\)\.map\(\(e\) => e\.table\)\.sort\(\);/, 'the STOP tables are taken from the pinned classification file, in sorted order');
  if (listOfStopTables.length !== 13) failures.push(`prod-sql.ts contract: the classification file lists ${listOfStopTables.length} STOP tables; item 28 was approved for 13 (review before changing this number)`);
  for (const t of listOfStopTables) if (c.includes(`'${t}'`) || c.includes(`"${t}"`) || new RegExp(`auth\\.${t}\\b`).test(c)) failures.push(`prod-sql.ts must not hard-code the STOP table ${t} (the list lives only in the classification file)`);
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
  const warnAt = c.indexOf("emitIrreversibleWarning(plan.action, 'connections_end_cannot_be_undone')");
  if (warnAt < 0 || warnAt > c.indexOf('if (!args.execute)') || warnAt < c.indexOf("'prod-sql.verified'")) failures.push('prod-sql-runner.ts: the irreversible-step warning must be printed with the plan (after prod-sql.verified), before the plan-only return and before anything connects');
  const planAt = c.indexOf('if (!args.execute)');
  const execAt = c.indexOf('await executeProdSqlPlan');
  if (planAt < 0 || execAt < 0 || planAt > execAt) failures.push('prod-sql-runner.ts: the plan-only return must come before anything connects');
  if (/(connection|dbUrl|password|host)[^\n]*console\.(log|error)|console\.(log|error)[^\n]*(dbUrl|password|\.host|\.db\b)/.test(c)) failures.push('prod-sql-runner.ts must not print connection details');
  if (/hint:\s*'[^']*--execute/.test(c) === false) failures.push('prod-sql-runner.ts: the plan-only event must say "add --execute to run"');
}

// ---------------------------------------------------------------------------------------------------------------
// B1: the staging-2 auth schema inventory: a pinned, read-only, names-and-types-only query run through the existing guarded staging runner.
// ---------------------------------------------------------------------------------------------------------------
{
  const INV = 'supabase/rollout/auth-schema-inventory.sql';
  const rebuilt = read('pipeline/src/staging-rebuilt.ts');
  const entry = rebuilt ? /'auth-schema-inventory': \{ kind: 'snapshot', file: '([^']+)', sha256: '([0-9a-f]{64})', confirmation: '([^']+)', pinned: false \},/.exec(rebuilt) : null;
  if (!entry) failures.push("staging-rebuilt.ts must define the 'auth-schema-inventory' action as a snapshot-kind action with a pinned sha256 and a confirmation phrase");
  else {
    if (entry[1] !== INV) failures.push(`staging-rebuilt.ts: the auth-schema-inventory action must run ${INV}`);
    if (entry[3] !== 'TAKE TNBS AUTH SCHEMA INVENTORY') failures.push('staging-rebuilt.ts: the auth-schema-inventory confirmation must be "TAKE TNBS AUTH SCHEMA INVENTORY"');
    if (!existsSync(resolve(root, INV))) failures.push(`missing ${INV}`);
    else {
      const actual = createHash('sha256').update(readFileSync(resolve(root, INV))).digest('hex');
      if (actual !== entry[2]) failures.push(`staging-rebuilt.ts pins the inventory query at ${entry[2].slice(0, 12)}... but ${INV} is ${actual.slice(0, 12)}... (the query changed or the pin is stale: review, then update the pin)`);
      const text = readFileSync(resolve(root, INV), 'utf8');
      const stripped = text.replace(/--[^\n]*/g, '');
      let parts = [];
      try { parts = splitStatements(text); } catch { failures.push(`${INV} could not be split by the contract's own splitter`); }
      const words = parts.map((st) => st.replace(/--[^\n]*/g, '').replace(/'[^']*'/g, "''").trim());
      if (words.map((w) => w.split(/\s+/)[0].toLowerCase()).join() !== 'set,set,select,select') failures.push(`${INV} must be exactly two "set local" statements and two selects`);
      if (!words.slice(0, 2).every((w) => /^set local (statement_timeout|lock_timeout) = ''$/i.test(w))) failures.push(`${INV}: the two set statements must be set local statement_timeout / lock_timeout`);
      for (const m of stripped.matchAll(/\b(from|join)\s+([A-Za-z_.]+)/gi)) if (!m[2].toLowerCase().startsWith('pg_catalog.')) failures.push(`${INV} reads ${m[2]}: only pg_catalog relations may follow FROM or JOIN (never a table of the auth schema, never row data)`);
      if (/information_schema/i.test(stripped)) failures.push(`${INV} must read pg_catalog, not information_schema (which hides what the role cannot use)`);
      if (/\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|call|do|begin|commit|rollback|vacuum|reindex|cluster|refresh|lock)\b/i.test(words.join(' '))) failures.push(`${INV} must hold no data change, no definition change and no transaction control (the runner provides begin read only and rollback)`);
      if (/\bauth\./i.test(words.join(' '))) failures.push(`${INV} must not name any auth relation outside a string literal`);
      if (/\b(select|returning)\s+[^;]*\b(password|token|secret|identity_data|raw_[a-z_]*meta_data)\b/i.test(words.join(' '))) failures.push(`${INV} must not select any value column`);
    }
  }
  if (rebuilt) {
    need('staging-rebuilt.ts', code(rebuilt), /if \(spec\.sha256 !== undefined && createHash\('sha256'\)\.update\(bytes\)\.digest\('hex'\) !== spec\.sha256\) throw new Error/, 'the plan refuses a file that does not match its pinned SHA-256');
    need('staging-rebuilt.ts', code(rebuilt), /if \(spec\.kind === 'snapshot'\) \{\s*if \(!input\.out \|\| !isAbsolute\(input\.out\)\)[\s\S]*?snapshot output must be outside the repository[\s\S]*?refusing to overwrite/, 'the snapshot output rules the inventory relies on (absolute, outside the repository, never overwritten)');
    need('staging-rebuilt.ts', code(rebuilt), /if \(plan\.kind === 'snapshot'\) \{\s*await client\.query\('begin read only'\);[\s\S]*?flag: 'wx'[\s\S]*?await client\.query\('rollback'\);/, 'the snapshot is sent inside begin read only, written to a new local file, and rolled back');
  }
  const inventoryActions = wrapper ? /export const ACTIONS = \[([\s\S]*?)\];/.exec(wrapper)?.[1].match(/'([a-z0-9-]+)'/g) ?? [] : [];
  if (!inventoryActions.includes("'auth-schema-inventory'")) failures.push('run-with-secrets.mjs ACTIONS must list auth-schema-inventory');
  if (doc) {
    for (const w of ['staging-2 capture classified', 'Auth release: (not verified)', 'Decision needed', 'not proof of production parity', 'auth-schema-inventory', 'auth-table-classification.json', 'credential-bearing: handled by L1', 'credential-bearing: STOP', 'not credential-bearing: reviewed', 'separate approval']) {
      if (!doc.includes(w)) failures.push(`doc 18 must keep the auth inventory section (missing: "${w}")`);
    }
    for (const t of ['identities', 'mfa_factors', 'mfa_challenges', 'mfa_amr_claims', 'sso_providers', 'sso_domains', 'saml_providers', 'saml_relay_states', 'audit_log_entries', 'instances']) {
      if (!doc.includes('`' + t + '`')) failures.push(`doc 18's PENDING classification table must name ${t}`);
    }
  }
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
const NEW_IDS = ['prod_sql_target_refused', 'prod_sql_action_not_built', 'prod_sql_file_unreadable', 'prod_sql_hash_mismatch', 'prod_sql_shape_refused', 'prod_sql_commit_rolled_back', 'prod_sql_l1_shape_not_ok', 'prod_sql_flag_not_expected', 'prod_sql_action_do_not_use', 'prod_sql_l1_stop_table_populated', 'prod_sql_l1_stop_table_lock_failed'];
if (refusals && wrapper) {
  for (const id of NEW_IDS) {
    if (!refusals.includes(`'${id}'`)) failures.push(`refusals.ts is missing ${id}`);
    if (!wrapper.includes(`'${id}'`)) failures.push(`run-with-secrets.mjs REFUSAL_IDS is missing ${id}`);
  }
}
if (wrapper) {
  for (const required of ["'prod-sql.verified'", "'prod-sql.plan_only'", "'prod-sql.statement'", "'prod-sql.counts'", "'prod-sql.flag'", "'prod-sql.shape'", "'prod-sql.stop_tables'", "'prod-sql.warning'", "'prod-sql.result'", "'prod-sql.done'", "'prod-sql.refused'", 'export const PROD_SQL_ACTIONS', 'export const PROD_SQL_COUNT_NAMES', 'export const PROD_SQL_SHAPE_CHECKS',
    "export const PROMPT_ONLY = ['PRODUCTION_DB_URL']", 'can only be entered at the hidden prompt, never taken from the environment', "sha256: pat(/^[0-9a-f]{64}$/)", "target: oneOf(['production'])"]) {
    if (!wrapper.includes(required)) failures.push(`run-with-secrets.mjs is missing: ${required}`);
  }
  for (const required of ["FROM_ENV_PROJECT = 'truck-recruitment-tool'", "FROM_ENV_CONFIG = 'stg'"]) if (!wrapper.includes(required)) failures.push(`run-with-secrets.mjs: --from-env scope changed (${required})`);
  if (!/'prod-sql\.warning': \{ action: oneOf\(PROD_SQL_IRREVERSIBLE_ACTIONS\), warning: oneOf\(Object\.keys\(PROD_SQL_WARNINGS\)\), notice: oneOf\(Object\.values\(PROD_SQL_WARNINGS\)\) \}/.test(wrapper)) failures.push('run-with-secrets.mjs: the prod-sql.warning event must allow only the irreversible actions, the fixed warning ids and the fixed sentences');
  {
    const wrapperSentences = Object.fromEntries([...(/export const PROD_SQL_WARNINGS = \{([\s\S]*?)\};/.exec(wrapper)?.[1] ?? '').matchAll(/([a-z_]+): '([^']*)'/g)].map((m) => [m[1], m[2]]));
    if (JSON.stringify(wrapperSentences) !== JSON.stringify(warningSentences)) failures.push('run-with-secrets.mjs PROD_SQL_WARNINGS must equal PROD_SQL_WARNINGS in prod-sql.ts (ids and sentences)');
    const wrapperIrreversible = (/export const PROD_SQL_IRREVERSIBLE_ACTIONS = \[([\s\S]*?)\];/.exec(wrapper)?.[1].match(/'([a-z0-9-]+)'/g) ?? []).map((q) => q.slice(1, -1));
    if (wrapperIrreversible.join() !== irreversibleIds.join()) failures.push('run-with-secrets.mjs PROD_SQL_IRREVERSIBLE_ACTIONS must equal the actions flagged irreversible in the table');
  }
  // The wrapper's action list equals the table (derived here from the table text).
  const listed = /export const PROD_SQL_ACTIONS = \[([\s\S]*?)\];/.exec(wrapper)?.[1].match(/'([a-z0-9-]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  if (JSON.stringify(listed) !== JSON.stringify(actions.map((a) => a.id))) failures.push('run-with-secrets.mjs PROD_SQL_ACTIONS must equal the action table ids, in order');
  {
    const flagNames = /export const PROD_SQL_FLAG_NAMES = \[([^\]]*)\]/.exec(wrapper)?.[1].match(/'([a-z_]+)'/g)?.map((q) => q.slice(1, -1)) ?? [];
    const tableFlags = [...new Set(actions.filter((a) => a.flagName !== undefined).map((a) => a.flagName))];
    if (JSON.stringify(flagNames) !== JSON.stringify(tableFlags)) failures.push('run-with-secrets.mjs PROD_SQL_FLAG_NAMES must equal the flagName values in the action table');
    if (!/'prod-sql\.flag': \{ action: oneOf\(\['window-on', 'window-off'\]\)/.test(wrapper)) failures.push('run-with-secrets.mjs: the prod-sql.flag event must allow only the two window actions');
  }
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
if (doc) {
  for (const w of ['STOP tables: stop unless empty', 'IN SHARE MODE', 'prod_sql_l1_stop_table_populated', 'prod_sql_l1_stop_table_lock_failed', 'prod-sql.stop_tables', 'lock_timeout', 'deadlock']) {
    if (!doc.includes(w)) failures.push(`doc 18 must describe the STOP-table check (missing: "${w}")`);
  }
  for (const w of ['Irreversible step: ending connections', 'retire-terminate', 'cannot be undone', 'rollback does not restore', 'prod-sql.warning', 'rolled_back', 'retire-backends', 'three times in a row', '60 seconds']) {
    if (!doc.includes(w)) failures.push(`doc 18 must keep the irreversible-step warning (missing: "${w}")`);
  }
}

if (failures.length > 0) {
  console.error('verify-prod-sql-runner-contract: FAILED');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`verify-prod-sql-runner-contract: ok (${actions.length} actions, every pinned file re-hashed; guard statements, wrapper allow-list, refusal ids, test chain and CI wiring checked)`);
