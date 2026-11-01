// Tests for the role-password action (role-password.ts): offline refusals and verifier vectors always run; the real-PostgreSQL half
// (verifier equals the server's own, a client logs in after ALTER ROLE with the verifier) runs only when ROLE_PASSWORD_PG_URL is set.
// ROLE_PASSWORD_PG_URL must be a LOOPBACK superuser URL on a throwaway cluster the test owner started, a tr_ database whose comment starts
// "role-password-owned:". No hosted service is contacted.
// Run: npx tsx src/role-password.test.ts   (real PG: ROLE_PASSWORD_PG_URL=postgresql://postgres@127.0.0.1:<port>/tr_role_password npx tsx src/role-password.test.ts)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  ROLE_PASSWORD_ACTIONS, ROLE_PASSWORD_ROLES, ROLE_PASSWORD_VARIABLES, STATEMENT_TIMEOUT_SQL, executeRolePassword, passwordProblem, planRolePassword, runRolePassword, scramSha256Verifier,
} from './role-password.js';
import { REFUSAL_IDS, RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { REPOSITORY_ROOT, type RebuiltSqlClient } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const REBUILT = RECORDED_PROJECT_REFS.stagingRebuilt as string;
const pooler = (ref: string, user = 'postgres', port = 5432) => `postgresql://${user}.${ref}:runner-pw-not-real@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
const PW = 'Zx9-test-password-NOT-A-REAL-SECRET-4471!'; // fixture only; 41 printable ASCII characters
const APP = ROLE_PASSWORD_ACTIONS['set-app-password'];
const MAINT = ROLE_PASSWORD_ACTIONS['set-maintenance-password'];
let n = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };
const refusalOf = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return e instanceof RunnerRefusal ? e.id : `other:${(e as Error).message}`; } };
const base = { action: 'set-app-password', dbUrl: pooler(REBUILT), confirm: APP.confirmation, password: PW };

/** Captures console.log lines while `fn` runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value?: T; error?: unknown }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { return { lines, value: await fn() }; } catch (error) { return { lines, error }; } finally { console.log = orig; }
}

async function main(): Promise<void> {
  // ---- verifier format and vectors (offline)
  const v = scramSha256Verifier(PW, Buffer.alloc(16, 7));
  check('verifier has the PostgreSQL form SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>', /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/.test(v));
  // RFC 7677 section 3 example (user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations): its SaltedPassword/keys are fixed; the stored-key and
  // server-key below were computed independently with Python hashlib/hmac (pbkdf2_hmac, 'Client Key', 'Server Key') and are checked into this test as the vector.
  const rfc = scramSha256Verifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'));
  check('RFC 7677 example salt and password (pencil) give the independently computed (Python hashlib/hmac) StoredKey and ServerKey', rfc === 'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=');
  check('fresh random salt each time, same password', scramSha256Verifier(PW) !== scramSha256Verifier(PW));
  check('verifier never contains the password', !scramSha256Verifier(PW).includes(PW));
  check('password rule: short, long, space, control, non-ASCII, empty and missing are rejected; a 32-character printable ASCII password is accepted',
    ['short', 'x'.repeat(129), `${'x'.repeat(40)} y`, `${'x'.repeat(40)}\n`, `${'x'.repeat(40)}é`, '', undefined].every((p) => passwordProblem(p as string | undefined) !== null) && passwordProblem('x'.repeat(32)) === null && passwordProblem('x'.repeat(128)) === null);

  // ---- planning and refusals (offline, before any connection)
  const plan = planRolePassword(base);
  check('plan for the recorded rebuilt project, session port, exact phrase: role recruiter_app, verifier ready, no connection made', plan.role === 'recruiter_app' && plan.target.projectRef === REBUILT && /^SCRAM-SHA-256\$/.test(plan.verifier));
  check('maintenance action maps to recruiter_maintenance with its own variable and phrase', planRolePassword({ ...base, action: 'set-maintenance-password', confirm: MAINT.confirmation }).role === 'recruiter_maintenance'
    && APP.passwordVariable === 'STAGING_APP_DB_PASSWORD' && MAINT.passwordVariable === 'STAGING_MAINT_DB_PASSWORD' && (APP.confirmation as string) !== (MAINT.confirmation as string));
  check('exactly two roles and two variables are possible', ROLE_PASSWORD_ROLES.join() === 'recruiter_app,recruiter_maintenance' && ROLE_PASSWORD_VARIABLES.join() === 'STAGING_APP_DB_PASSWORD,STAGING_MAINT_DB_PASSWORD');
  check('wrong role / arbitrary action names are refused (unknown_action)', ['set-postgres-password', 'set-authenticator-password', 'set-app-password ', '__proto__', 'constructor', ''].every((a) => refusalOf(() => planRolePassword({ ...base, action: a })) === 'unknown_action'));
  check('wrong target: production, the old staging project and an unrecorded project are refused', refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(RECORDED_PROJECT_REFS.production) })) === 'production_refused'
    && refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(RECORDED_PROJECT_REFS.staging) })) === 'target_not_recorded_staging'
    && refusalOf(() => planRolePassword({ ...base, dbUrl: pooler('zzzzzzzzzzzzzzzzzzzz') })) === 'target_not_recorded_staging');
  check('production is refused even if it were (wrongly) the recorded rebuilt ref', refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(RECORDED_PROJECT_REFS.production), recordedRebuiltRef: RECORDED_PROJECT_REFS.production })) === 'ref_invalid');
  check('an unrecorded rebuilt ref refuses everything', refusalOf(() => planRolePassword({ ...base, recordedRebuiltRef: null })) === 'ref_not_recorded');
  check('transaction pooler port 6543 and a missing URL are refused', refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(REBUILT, 'postgres', 6543) })) === 'port_must_be_5432' && refusalOf(() => planRolePassword({ ...base, dbUrl: undefined })) === 'db_url_required');
  check('missing, wrong, partial and wrong-case confirmation are refused', [undefined, '', APP.confirmation.toLowerCase(), `${APP.confirmation} `, MAINT.confirmation, 'yes'].every((c) => refusalOf(() => planRolePassword({ ...base, confirm: c })) === 'confirmation_required'));
  check('missing or weak password variable is refused (role_password_refused)', [undefined, '', 'short', `${'x'.repeat(40)} y`].every((p) => refusalOf(() => planRolePassword({ ...base, password: p })) === 'role_password_refused'));
  check('connecting as an application role is refused (the runner must be the privileged login)', ['recruiter_app', 'recruiter_maintenance'].every((u) => refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(REBUILT, u) })) === 'role_password_refused'));
  check('the refusal id is a registered fixed identifier and the wrapper copy agrees', (REFUSAL_IDS as readonly string[]).includes('role_password_refused')
    && (await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href) as { REFUSAL_IDS: string[] }).REFUSAL_IDS.join() === REFUSAL_IDS.join());
  const msg = (() => { try { planRolePassword({ ...base, password: 'short-secret' }); } catch (e) { return String((e as Error).message); } return ''; })();
  check('a refusal message never carries the password value', msg !== '' && !msg.includes('short-secret') && !msg.includes('runner-pw-not-real'));

  // ---- executor against a fake client: statements, events, rollback, unknown commit, redaction
  const sent: string[] = [];
  const fake = (over: { rows?: (sql: string, call: number) => unknown[]; failOn?: RegExp; failCommit?: boolean; failRollback?: boolean } = {}): RebuiltSqlClient => {
    let facts = 0;
    return {
      connect: async () => undefined,
      end: async () => undefined,
      query: async (sql: string) => {
        sent.push(sql);
        if (over.failOn?.test(sql)) throw Object.assign(new Error(`boom ${PW} ${plan.verifier}`), { code: '42501' });
        if (sql === 'commit' && over.failCommit) throw Object.assign(new Error('commit lost'), { code: '08006' });
        if (sql === 'rollback' && over.failRollback) throw new Error('no answer');
        if (/from pg_roles/.test(sql)) { facts += 1; return { rows: over.rows ? over.rows(sql, facts) : [{ rolcanlogin: facts > 1, rolsuper: false, rolinherit: true, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolconnlimit: -1, has_valid_until: false, config: '', matches: 1 }] }; }
        return { rows: [], rowCount: 0 };
      },
    };
  };
  let r = await captured(() => runRolePassword(fake(), plan));
  const alter = sent.filter((s) => /^alter role/.test(s));
  check('success: begin, statement_timeout, lock_timeout, one ALTER ROLE ... LOGIN PASSWORD with the verifier, commit; one committed event', r.error === undefined && sent[0] === 'begin' && sent[1] === STATEMENT_TIMEOUT_SQL && /lock_timeout/.test(sent[2]!)
    && alter.length === 1 && alter[0] === `alter role recruiter_app login password '${plan.verifier}'` && sent[sent.length - 1] === 'commit' && r.lines.length === 1 && JSON.parse(r.lines[0]!).result === 'committed');
  check('the plain password is in no statement sent to the server, and no event line holds the password or the verifier', !sent.some((s) => s.includes(PW)) && !r.lines.join('\n').includes(PW) && !r.lines.join('\n').includes(plan.verifier));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: () => [] }), plan));
  check('role missing: refused, rolled back, no ALTER ever sent', r.error instanceof RunnerRefusal && sent.every((s) => !/^alter role/.test(s)) && sent.includes('rollback') && JSON.parse(r.lines[0]!).result === 'rolled_back');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: () => [{ rolsuper: true, matches: 1 }] }), plan));
  check('superuser role: refused before ALTER, rolled back', r.error instanceof RunnerRefusal && sent.every((s) => !/^alter role/.test(s)) && sent.includes('rollback'));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: (_s, call) => [{ rolcanlogin: call > 1, rolsuper: false, rolcreatedb: call > 1, matches: 1 }] }), plan));
  check('another attribute changed: refused after ALTER, rolled back, never committed', r.error instanceof RunnerRefusal && !sent.includes('commit') && sent.includes('rollback') && JSON.parse(r.lines[0]!).result === 'rolled_back');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: () => [{ rolcanlogin: false, rolsuper: false, matches: 1 }] }), plan));
  check('LOGIN not on after the statement: refused, rolled back', r.error instanceof RunnerRefusal && !sent.includes('commit') && sent.includes('rollback'));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ failOn: /^alter role/ }), plan));
  check('ALTER failure: rolled back; the driver message (which here carries both secrets) is not printed and classifies to a fixed id plus SQLSTATE', JSON.parse(r.lines[0]!).result === 'rolled_back' && !r.lines.join('\n').includes(PW)
    && JSON.stringify(classifyRunnerFailure(r.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '42501' }));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ failOn: /^alter role/, failRollback: true }), plan));
  check('ALTER failure and rollback not acknowledged: rollback_not_confirmed', JSON.parse(r.lines[0]!).result === 'rollback_not_confirmed');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ failCommit: true }), plan));
  check('COMMIT failure: result unknown, no rollback and no second ALTER (nothing is retried)', JSON.parse(r.lines[0]!).result === 'unknown' && !sent.includes('rollback') && sent.filter((s) => /^alter role/.test(s)).length === 1);
  const bad = { ...plan, role: 'postgres' };
  sent.length = 0;
  r = await captured(() => runRolePassword(fake(), bad));
  check('a tampered plan (other role, bad verifier) sends nothing', r.error instanceof RunnerRefusal && sent.length === 0
    && (await captured(() => runRolePassword(fake(), { ...plan, verifier: `${plan.verifier}'; drop role x; --` }))).error instanceof RunnerRefusal);
  sent.length = 0;
  let connected = 0;
  await captured(() => executeRolePassword(plan, () => ({ ...fake(), connect: async () => { connected += 1; } })));
  check('the executor connects once and only runs the one transaction', connected === 1 && sent.filter((s) => s === 'begin').length === 1);

  // ---- the real command line, plan-only: verifies, prints only fixed events, never connects (the URL's host is not reachable) and never prints a secret
  const cli = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'staging-sql-runner.ts'), '--project=rebuilt', ...args], { env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env }, encoding: 'utf8', cwd: resolve(import.meta.dirname, '..'), timeout: 60_000 });
  const confirmArg = `--confirm=${APP.confirmation}`;
  const planOnly = cli({ STAGING_DB_URL: pooler(REBUILT), STAGING_APP_DB_PASSWORD: PW }, '--action=set-app-password', confirmArg);
  const planLines = planOnly.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l) as Record<string, unknown>);
  check('command line plan-only: exit 0, exactly the verified and plan_only events, nothing connected or sent', planOnly.status === 0 && planLines.length === 2 && planLines[0]!.msg === 'staging-sql.verified' && planLines[0]!.action === 'set-app-password' && planLines[1]!.msg === 'staging-sql.plan_only');
  check('command line output carries neither the password, the runner password, the host nor a verifier', !/Zx9-test|runner-pw-not-real|pooler\.supabase|SCRAM-SHA/.test(planOnly.stdout + planOnly.stderr));
  const noPw = cli({ STAGING_DB_URL: pooler(REBUILT) }, '--action=set-app-password', confirmArg);
  const wrongVar = cli({ STAGING_DB_URL: pooler(REBUILT), STAGING_MAINT_DB_PASSWORD: PW }, '--action=set-app-password', confirmArg);
  const prod = cli({ STAGING_DB_URL: pooler(RECORDED_PROJECT_REFS.production), STAGING_APP_DB_PASSWORD: PW }, '--action=set-app-password', confirmArg);
  check('command line refusals: missing password env, the other role\'s variable, and production each exit 1 with one fixed refusal', ([[noPw, 'role_password_refused'], [wrongVar, 'role_password_refused'], [prod, 'production_refused']] as const).every(([r, id]) => r.status === 1 && JSON.parse(r.stderr.trim()).refusal === id && !r.stderr.includes('Zx9-test')));

  // ---- source contract: the module reads no environment, prints no secret, builds the statement only from checked constants
  const src = readFileSync(resolve(import.meta.dirname, 'role-password.ts'), 'utf8');
  check('module does not read process.env, never logs the password/verifier, has no drop/delete/grant/revoke SQL', !/process\.env/.test(src) && !/console\.(log|error)\([^)]*(password|verifier)/i.test(src.replace(/line\(\{[^}]*\}\)/g, '')) && !/\b(drop|delete from|truncate|grant|revoke)\b/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));

  // ---- real PostgreSQL (throwaway loopback cluster only)
  const URL_ENV = process.env.ROLE_PASSWORD_PG_URL;
  if (!URL_ENV) {
    console.log('skip real-PostgreSQL half (set ROLE_PASSWORD_PG_URL, loopback only)');
    console.log(`role-password offline: ${n} checks passed`);
    return;
  }
  const u = new URL(URL_ENV);
  assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname) && u.port !== '' && u.port !== '5432' && u.port !== '6543' && u.search === '', 'refusing: ROLE_PASSWORD_PG_URL must be a plain loopback URL on the owned cluster port');
  assert.match(decodeURIComponent(u.pathname.slice(1)), /^tr_[a-z0-9_]+$/, 'refusing: database name must start with tr_');
  const admin = new pg.Client({ connectionString: URL_ENV });
  admin.on('error', () => undefined);
  await admin.connect();
  assert.match((await admin.query("select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()")).rows[0].c as string, /^role-password-owned:/, 'refusing: database is not task-owned');
  assert.equal((await admin.query('show password_encryption')).rows[0].password_encryption, 'scram-sha-256');
  const loginAs = async (role: string, password: string): Promise<{ ok: boolean; who?: string; code?: string }> => {
    const c = new pg.Client({ host: u.hostname, port: Number(u.port), user: role, password, database: decodeURIComponent(u.pathname.slice(1)) });
    c.on('error', () => undefined);
    try { await c.connect(); const who = (await c.query('select current_user as u')).rows[0].u as string; return { ok: true, who }; } catch (e) { return { ok: false, code: (e as { code?: string }).code }; } finally { await c.end().catch(() => undefined); }
  };
  const asClient = (): RebuiltSqlClient => admin as unknown as RebuiltSqlClient;
  const attrs = async (role: string) => JSON.stringify((await admin.query('select rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil, rolconfig from pg_roles where rolname = $1', [role])).rows[0]);
  const rolePw = async (role: string) => (await admin.query('select rolpassword as p from pg_authid where rolname = $1', [role])).rows[0].p as string | null;

  // PostgreSQL's own verifier for the same password and salt equals ours.
  await admin.query('drop role if exists tr_ref_role');
  await admin.query(`create role tr_ref_role login password '${PW}'`); // the server hashes it (scram-sha-256); the fixture value is not a secret
  const server = (await rolePw('tr_ref_role'))!;
  const [, iter, salt] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(server)!;
  check('local verifier equals the one PostgreSQL computed for the same password and salt (byte for byte)', scramSha256Verifier(PW, Buffer.from(salt!, 'base64'), Number(iter)) === server);
  await admin.query('drop role tr_ref_role');

  for (const [action, spec] of Object.entries(ROLE_PASSWORD_ACTIONS)) {
    const role = spec.role;
    await admin.query(`drop role if exists ${role}`);
    await admin.query(`create role ${role} nologin nocreatedb connection limit 7`);
    await admin.query(`comment on role ${role} is 'keep me'`);
    await admin.query(`alter role ${role} set search_path = pg_catalog`);
    const before = await attrs(role);
    check(`${role}: starts NOLOGIN and cannot log in`, !(await loginAs(role, PW)).ok);
    const p = planRolePassword({ action, dbUrl: pooler(REBUILT), confirm: spec.confirmation, password: PW });
    const run = await captured(() => executeRolePassword(p, () => ({ connect: async () => undefined, end: async () => undefined, query: (s: string, a?: unknown[]) => admin.query(s, a) })));
    check(`${role}: committed through the real executor path`, run.error === undefined && JSON.parse(run.lines[0]!).result === 'committed');
    const stored = (await rolePw(role))!;
    check(`${role}: stored password is the local SCRAM verifier, not the plain password`, stored === p.verifier && !stored.includes(PW));
    const login = await loginAs(role, PW);
    check(`${role}: a real client logs in with the original password (SCRAM) as ${role}`, login.ok && login.who === role);
    check(`${role}: wrong password and a one-character-off password are refused (28P01)`, (await loginAs(role, `${PW}x`)).code === '28P01' && (await loginAs(role, PW.slice(0, -1))).code === '28P01');
    const after = JSON.parse(await attrs(role)) as Record<string, unknown>;
    check(`${role}: only LOGIN changed; other attributes, connection limit and role settings unchanged`, JSON.stringify({ ...after, rolcanlogin: false }) === JSON.stringify({ ...JSON.parse(before), rolcanlogin: false }) && after.rolcanlogin === true && after.rolconnlimit === 7);
    check(`${role}: unrelated role comment kept`, (await admin.query("select shobj_description(oid, 'pg_authid') as c from pg_roles where rolname = $1", [role])).rows[0].c === 'keep me');
  }
  // Re-run replaces the verifier (new salt); the new password works and the old one stops.
  const NEW_PW = `${PW}-second`;
  await captured(() => runRolePassword(asClient(), planRolePassword({ ...base, password: NEW_PW })));
  check('a second run replaces the password: new works, old refused', (await loginAs('recruiter_app', NEW_PW)).ok && (await loginAs('recruiter_app', PW)).code === '28P01');
  // Failure paths on a real server.
  await admin.query('drop role if exists recruiter_app');
  const miss = await captured(() => runRolePassword(asClient(), planRolePassword(base)));
  check('role absent on the real server: refused, rolled back, no role created', miss.error instanceof RunnerRefusal && JSON.parse(miss.lines[0]!).result === 'rolled_back' && (await admin.query("select count(*)::int as c from pg_roles where rolname = 'recruiter_app'")).rows[0].c === 0);
  await admin.query("create role recruiter_app nologin superuser");
  const sup = await captured(() => runRolePassword(asClient(), planRolePassword(base)));
  check('a superuser role named recruiter_app is refused and stays NOLOGIN with no password', sup.error instanceof RunnerRefusal && (await rolePw('recruiter_app')) === null && !(await loginAs('recruiter_app', PW)).ok);
  await admin.query('drop role recruiter_app');
  // statement_timeout is applied inside the transaction only.
  await admin.query('create role recruiter_app nologin');
  const seen: string[] = [];
  await captured(() => runRolePassword({ connect: async () => undefined, end: async () => undefined, query: async (s: string, a?: unknown[]) => { const res = await admin.query(s, a); if (/^alter role/.test(s)) seen.push(String((await admin.query("select current_setting('statement_timeout') as t, current_setting('lock_timeout') as l")).rows[0].t)); return res; } }, planRolePassword(base)));
  check('statement timeout 30s is in force while the ALTER runs and is gone after commit', seen[0] === '30s' && (await admin.query("select current_setting('statement_timeout') as t")).rows[0].t === '0');
  await admin.query('drop role recruiter_app');
  await admin.query('drop role if exists recruiter_maintenance');
  await admin.end();
  console.log(`role-password: ${n} checks passed (offline and real PostgreSQL)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
