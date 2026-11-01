// LOCAL real-PostgreSQL test of the L1 STOP-table check (Hunter's item 28, option 1: stop unless the 13 STOP tables are empty).
// It runs the tool's real planner (with the real, pinned repository files, including the pinned L1 SQL and classification) and the real executor through
// the injected-client seam the A3 test uses: the production guard refuses local URLs by design, so the plan is made with a synthetic production address
// and only the CLIENT is replaced by a loopback client. The database holds a minimal `auth` schema of the 27 classified tables (names from the pinned
// classification file; only the columns L1 and the shape gate touch, plus the foreign keys that matter). No Supabase service is involved: the hosted half
// (the Supabase Auth service's own writes, the hosted login's privileges, TLS) is NOT covered.
// Skipped unless PROD_SQL_STOP_PG_URL is set; it must be a LOOPBACK URL on the owned cluster's own port, a tr_ database, and the database comment must be
// "stop-test-owned:...". DESTRUCTIVE TO THE THROWAWAY DATABASE ONLY (it drops and rebuilds schema auth in it).
// Run: PROD_SQL_STOP_PG_URL=postgresql://postgres@127.0.0.1:<port>/tr_stop_test npx tsx src/prod-sql-stop-tables-pg.test.ts

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PROD_SQL_ACTIONS, STOP_CLASSIFICATION, executeProdSqlPlan, loadAuthClassification, planProdSql, stopTablesOf } from './prod-sql.js';
import { RunnerRefusal } from './refusals.js';
import { REPOSITORY_ROOT } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const URL_ENV = process.env.PROD_SQL_STOP_PG_URL;
const PROD_URL = `postgresql://postgres.${RECORDED_PROJECT_REFS.production}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;

interface Outcome { events: Array<Record<string, unknown>>; error?: unknown; sent: string[]; ms: number }
interface Hooks { before?: (sql: string, client: pg.Client) => Promise<void>; options?: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Resolves true when `p` has settled within `ms`, false while it is still pending. */
const settledWithin = async (p: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

async function main(): Promise<void> {
  if (!URL_ENV) {
    console.log('skip prod-sql STOP-table real-PG test (set PROD_SQL_STOP_PG_URL, loopback only)');
    return;
  }
  const u = new URL(URL_ENV);
  assert.ok(['postgresql:', 'postgres:'].includes(u.protocol) && u.search === '' && u.hash === '', 'refusing: PROD_SQL_STOP_PG_URL must be a plain postgresql URL');
  assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname), 'refusing: PROD_SQL_STOP_PG_URL must be loopback');
  assert.ok(u.port !== '' && u.port !== '5432' && u.port !== '6543', 'refusing: PROD_SQL_STOP_PG_URL must name the owned cluster\'s own port');
  assert.match(decodeURIComponent(u.pathname.replace(/^\//, '')), /^tr_[a-z0-9_]+$/, 'refusing: the test database name must start with tr_');
  const admin = new pg.Client({ connectionString: URL_ENV });
  admin.on('error', () => console.error('the admin connection reported an error'));
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  assert.match((await q('select current_database() as d')).rows[0].d as string, /^tr_/);
  assert.match((await q("select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()")).rows[0].c as string, /^stop-test-owned:/, 'refusing: the database is not task-owned');
  const wrapper = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
  let n = 0;
  const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };
  const info = (name: string, text: string) => console.log(`INFO ${name}: ${text}`);

  const classification = loadAuthClassification();
  const STOP = stopTablesOf(classification);
  const L1 = ['users', 'sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state'];
  const OTHER = classification.map((e) => e.table).filter((t) => !STOP.includes(t) && !L1.includes(t));
  assert.equal(STOP.length, 13);

  /** Drops and rebuilds schema auth: the five L1 tables with the columns L1 touches, the 13 STOP tables and the 9 reviewed tables, and the foreign keys that matter. */
  const resetSchema = async (opts: { drop?: string[]; extra?: string[] } = {}): Promise<void> => {
    await q('drop schema if exists auth cascade');
    await q('create schema auth');
    await q(`create table auth.users (id uuid primary key default gen_random_uuid(), email text, encrypted_password text, confirmation_token text, recovery_token text, email_change_token_new text, email_change_token_current text, phone_change_token text, reauthentication_token text)`);
    await q('create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade)');
    await q('create table auth.refresh_tokens (id bigserial primary key, token text, session_id uuid references auth.sessions(id) on delete cascade)');
    await q('create table auth.one_time_tokens (id uuid primary key default gen_random_uuid(), token_hash text)');
    await q('create table auth.flow_state (id uuid primary key default gen_random_uuid(), auth_code text)');
    // mfa_factors first: mfa_challenges has a foreign key to it.
    for (const t of [...STOP, ...OTHER].sort((x, y) => (x === 'mfa_factors' ? -1 : y === 'mfa_factors' ? 1 : 0))) {
      if (opts.drop?.includes(t)) continue;
      // Each table gets an id and one data column; mfa_challenges, mfa_amr_claims and saml_relay_states keep their real foreign keys (to the STOP table mfa_factors, to sessions, and to flow_state: the captured saml_relay_states -> flow_state ON DELETE CASCADE, which L1's own flow_state delete fires).
      const fk = t === 'mfa_challenges' ? ', factor_id uuid references auth.mfa_factors(id) on delete cascade' : t === 'mfa_amr_claims' ? ', session_id uuid references auth.sessions(id) on delete cascade' : t === 'saml_relay_states' ? ', flow_state_id uuid references auth.flow_state(id) on delete cascade' : '';
      await q(`create table auth."${t}" (id uuid primary key default gen_random_uuid(), data text${fk})`);
    }
    for (const t of opts.extra ?? []) await q(`create table auth."${t}" (id int)`);
  };
  /** L1 data: three users with tokens, sessions with refresh tokens, one-time tokens, flow state; and a reviewed-table row that cascades from a session. */
  const seedL1 = async (): Promise<void> => {
    await q("insert into auth.users (email, confirmation_token, recovery_token) select 'user' || g || '@example.invalid', 'tok-c' || g, 'tok-r' || g from generate_series(1, 3) g");
    await q('insert into auth.sessions (user_id) select id from auth.users');
    await q("insert into auth.refresh_tokens (token, session_id) select 'rt-' || id, id from auth.sessions");
    await q("insert into auth.one_time_tokens (token_hash) values ('h1'), ('h2')");
    await q("insert into auth.flow_state (auth_code) values ('c1'), ('c2')");
    await q("insert into auth.mfa_amr_claims (data, session_id) select 'password', id from auth.sessions");
  };
  /** One fingerprint of the L1 data (row counts and an md5 over every row of the five L1 tables). */
  const l1Fingerprint = async (): Promise<string> => (await q(`select
      (select count(*) from auth.sessions)::text || ',' || (select count(*) from auth.refresh_tokens) || ',' || (select count(*) from auth.one_time_tokens) || ',' || (select count(*) from auth.flow_state) || ',' ||
      (select count(*) from auth.users where coalesce(confirmation_token, '') <> '' or coalesce(recovery_token, '') <> '') || ',' ||
      md5(coalesce((select string_agg(t::text, '|' order by t::text) from auth.users t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from auth.sessions t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from auth.refresh_tokens t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from auth.one_time_tokens t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from auth.flow_state t), '')) as f`)).rows[0].f as string;
  const stopRows = async (): Promise<number> => Number((await q(`select ${STOP.filter((t) => true).map((t) => `(select count(*) from auth."${t}")`).join(' + ')} as n`)).rows[0].n);
  const l1Cleared = async (): Promise<boolean> => (await l1Fingerprint()).startsWith('0,0,0,0,0,');

  const eventSink = new AsyncLocalStorage<Array<Record<string, unknown>>>();
  {
    const log = console.log;
    console.log = (...x: unknown[]) => { const sink = eventSink.getStore(); if (sink !== undefined) { try { const e = JSON.parse(String(x[0])); if (typeof e === 'object' && e !== null && typeof e.msg === 'string' && e.msg.startsWith('prod-sql.')) { sink.push(e); return; } } catch { /* not an event */ } } log(...x); };
    const err = console.error;
    console.error = (...x: unknown[]) => { if (eventSink.getStore() === undefined) err(...x); };
  }
  /** Runs one action's real plan through the real executor against a real loopback client; `before` may hold a query back (it runs before the statement is sent). */
  const run = async (id: string, hooks: Hooks = {}): Promise<Outcome & { pid: Promise<number> }> => {
    const a = PROD_SQL_ACTIONS.find((x) => x.id === id)!;
    const plan = planProdSql({ target: 'production', action: id, dbUrl: PROD_URL, confirm: a.phrase });
    const events: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const client = new pg.Client({ connectionString: URL_ENV, ...(hooks.options === undefined ? {} : { options: hooks.options }) });
    let resolvePid: (p: number) => void = () => undefined;
    const pid = new Promise<number>((r) => { resolvePid = r; });
    const seam = {
      connect: async () => { await client.connect(); resolvePid(((client as unknown as { processID: number }).processID)); },
      end: () => client.end(),
      on: (ev: 'error', l: () => void) => client.on(ev, l),
      query: async (sql: string, p?: unknown[]) => { sent.push(sql.trim()); if (hooks.before) await hooks.before(sql.trim(), client); return client.query(sql, p as unknown[]); },
    };
    const started = Date.now();
    let error: unknown;
    // Each run's events go to its own list through AsyncLocalStorage, so two sweeps running at the same time do not mix them.
    try { await eventSink.run(events, () => executeProdSqlPlan(plan, () => seam as never)); } catch (e) { error = e; }
    return { events, error, sent, ms: Date.now() - started, pid };
  };
  /** Starts a run in the background; resolves when it has finished. */
  const runLater = (id: string, hooks: Hooks = {}) => { const p = run(id, hooks); return p; };
  const resultOf = (o: Outcome) => o.events.filter((e) => e.msg === 'prod-sql.result').map((e) => e.result).join();
  const stopEvent = (o: Outcome) => o.events.find((e) => e.msg === 'prod-sql.stop_tables') as { locked: boolean; tables: Record<string, number | string>; tables_present: number; tables_populated: number; passed: boolean } | undefined;
  const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 8000): Promise<void> => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); } throw new Error(`timed out waiting for: ${what}`); };
  const newClient = async (): Promise<pg.Client> => { const c = new pg.Client({ connectionString: URL_ENV }); c.on('error', () => undefined); await c.connect(); return c; };
  const lockRows = async (pid: number) => (await q("select c.relname, l.mode, l.granted from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace s on s.oid = c.relnamespace where l.pid = $1 and s.nspname = 'auth' order by 1, 2", [pid])).rows as Array<{ relname: string; mode: string; granted: boolean }>;
  const isFirstDelete = (sql: string) => sql.startsWith('delete from auth.refresh_tokens');

  // ---- 1. All 13 empty: the sweep proceeds.
  {
    await resetSchema(); await seedL1();
    const before = await l1Fingerprint();
    const out = await run('l1-sweep');
    const ev = stopEvent(out);
    check('real PG, all 13 STOP tables empty: the sweep commits, clears the L1 data, and the stop_tables event shows 13 present, 0 populated, locked', out.error === undefined && resultOf(out) === 'committed' && ev?.locked === true && ev.tables_present === 13 && ev.tables_populated === 0 && ev.passed === true && Object.values(ev.tables).every((v) => v === 0) && await l1Cleared() && before !== await l1Fingerprint());
    check('real PG, the sweep leaves every STOP table empty and the reviewed cascade table cleared with its sessions (L1 behaves as before)', await stopRows() === 0 && Number((await q('select count(*) as n from auth.mfa_amr_claims')).rows[0].n) === 0);
    const k = { fields: 0 };
    check('real PG, every event of the committed sweep passes the wrapper allow-list with nothing withheld', out.events.every((e) => wrapper.allowListLine(JSON.stringify(e), k) !== null) && k.fields === 0);
    const again = await run('l1-sweep');
    check('real PG, the second sweep (doc 17 step 6) is also allowed and changes nothing', again.error === undefined && resultOf(again) === 'committed');
  }

  // ---- 2. One row in a STOP table: refuse, roll back, leave everything untouched.
  {
    await resetSchema(); await seedL1();
    await q("insert into auth.scim_users (data) values ('sensitive-looking value that must never be printed')");
    const before = await l1Fingerprint();
    const out = await run('l1-sweep');
    const ev = stopEvent(out);
    check('real PG, one row in scim_users: refused with prod_sql_l1_stop_table_populated, rolled back, never committed', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_populated' && resultOf(out) === 'rolled_back' && !out.sent.some((s) => /^(delete|update)\b/.test(s)));
    check('real PG, after the refusal the STOP row and ALL L1 data are exactly as they were', Number((await q('select count(*) as n from auth.scim_users')).rows[0].n) === 1 && await l1Fingerprint() === before);
    check('real PG, the event reports only fixed metadata: the category, a count per table, the populated count; the row content appears nowhere', ev?.passed === false && ev.tables_populated === 1 && ev.tables.scim_users === 1 && Object.entries(ev.tables).filter(([t]) => t !== 'scim_users').every(([, v]) => v === 0) && !JSON.stringify(out.events).includes('sensitive') && out.events.some((e) => e.msg === 'prod-sql.stop_tables' && e.classification === STOP_CLASSIFICATION));
    const b = await newClient();
    const t0 = Date.now();
    await b.query("insert into auth.scim_users (data) values ('after the rollback')");
    await b.end();
    check('real PG, the refusal released its locks: another session inserts into a STOP table at once (under one second)', Date.now() - t0 < 1000);
    // The check runs per table: each of the 13 refuses on its own.
    let each = true;
    for (const t of STOP) {
      await resetSchema(); await seedL1();
      await q(`insert into auth."${t}" (data${t === 'mfa_challenges' ? ', factor_id' : ''}) values ('x'${t === 'mfa_challenges' ? ', null' : ''})`);
      const o = await run('l1-sweep');
      if (!(o.error instanceof RunnerRefusal && o.error.id === 'prod_sql_l1_stop_table_populated' && stopEvent(o)?.tables[t] === 1 && stopEvent(o)?.tables_populated === 1)) each = false;
    }
    check('real PG, each one of the 13 STOP tables on its own stops the sweep when it holds one row', each);
  }

  // ---- 3. A concurrent INSERT during the sweep blocks until the sweep commits (and, in a second run, until it rolls back).
  for (const mode of ['commit', 'rollback'] as const) {
    await resetSchema(); await seedL1();
    const before = await l1Fingerprint();
    let paused: (v: void) => void = () => undefined;
    const reachedFirstDelete = new Promise<void>((r) => { paused = r; });
    let release: (v: void) => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const sweep = runLater('l1-sweep', { before: async (sql) => { if (isFirstDelete(sql)) { paused(); await gate; if (mode === 'rollback') throw Object.assign(new Error('injected failure before the first delete'), { code: 'XX999' }); } } });
    await reachedFirstDelete;
    // The sweep holds its locks and has not deleted anything yet.
    const holders = (await q("select l.pid, l.mode, l.granted, c.relname from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'auth' and l.mode = 'ShareRowExclusiveLock' and l.granted")).rows as Array<{ pid: number; relname: string }>;
    check(`real PG (${mode}): while the sweep is paused it holds a granted ShareRowExclusiveLock on each of the 13 STOP tables`, STOP.every((t) => holders.some((h) => h.relname === t)) && new Set(holders.map((h) => h.pid)).size === 1);
    const holderPid = holders[0]!.pid;
    const reader = await newClient();
    const readStart = Date.now();
    const readCount = Number((await reader.query('select count(*) as n from auth.mfa_factors')).rows[0].n);
    check(`real PG (${mode}): a plain SELECT on a locked STOP table is not blocked (SHARE does not conflict with reads)`, Date.now() - readStart < 1000 && readCount === 0);
    await reader.end();
    const writer = await newClient();
    let writerDone = false; let writerEnd = 0;
    const insertP = writer.query("insert into auth.mfa_factors (data) values ('inserted during the sweep')").then(() => { writerDone = true; writerEnd = Date.now(); });
    await sleep(1200);
    const waiting = (await q("select l.pid, l.mode, l.granted, c.relname from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'auth' and c.relname = 'mfa_factors' and not l.granted")).rows as Array<{ pid: number; mode: string }>;
    check(`real PG (${mode}): a concurrent INSERT into a STOP table stays blocked for the whole pause (1.2 s) and pg_locks shows it waiting for RowExclusiveLock behind the sweep's ShareRowExclusiveLock`, !writerDone && waiting.length === 1 && waiting[0]!.mode === 'RowExclusiveLock' && waiting[0]!.pid !== holderPid);
    check(`real PG (${mode}): the inserted row is not visible and the L1 data is untouched while the sweep is paused`, Number((await q('select count(*) as n from auth.mfa_factors')).rows[0].n) === 0 && await l1Fingerprint() === before);
    const releasedAt = Date.now();
    release();
    const out = await sweep;
    await insertP;
    if (mode === 'commit') {
      check('real PG (commit): the sweep committed, and the blocked INSERT completed only AFTER the sweep ended (never before it)', out.error === undefined && resultOf(out) === 'committed' && writerDone && writerEnd >= releasedAt && await l1Cleared());
      check('real PG (commit): the row inserted after the commit exists (the lock delays a writer, it does not discard it); the emptiness was a fact up to the commit only', Number((await q('select count(*) as n from auth.mfa_factors')).rows[0].n) === 1);
    } else {
      check('real PG (rollback): the sweep rolled back (injected failure), the blocked INSERT completed only after the rollback, and the L1 data is untouched', out.error !== undefined && resultOf(out) === 'rolled_back' && writerDone && writerEnd >= releasedAt && await l1Fingerprint() === before);
    }
    await writer.end();
  }

  // ---- 4. An insert made before the lock is taken is counted (the sweep waits for it, then sees it).
  for (const outcome of ['commit', 'rollback'] as const) {
    await resetSchema(); await seedL1();
    const before = await l1Fingerprint();
    const early = await newClient();
    await early.query('begin');
    await early.query("insert into auth.oauth_clients (data) values ('in flight before the sweep')");
    let done = false;
    const sweep = runLater('l1-sweep').then((o) => { done = true; return o; });
    const earlyPid = (await early.query('select pg_backend_pid() as p')).rows[0].p as number;
    await waitFor('the sweep to wait for the lock', async () => (await q("select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'oauth_clients' and not l.granted and l.mode = 'ShareRowExclusiveLock'")).rows[0].n === 1);
    check(`real PG (${outcome}): the sweep waits (does not count) while an earlier insert is still in flight; pg_locks shows its ShareRowExclusiveLock request not granted`, !done && (await lockRows(earlyPid)).some((r) => r.relname === 'oauth_clients' && r.granted));
    await early.query(outcome === 'commit' ? 'commit' : 'rollback');
    const out = await sweep;
    await early.end();
    if (outcome === 'commit') {
      check('real PG (commit): once that insert is committed the sweep COUNTS it: refused as populated (oauth_clients = 1), rolled back, L1 data untouched, the row remains', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_populated' && stopEvent(out)?.tables.oauth_clients === 1 && resultOf(out) === 'rolled_back' && await l1Fingerprint() === before && Number((await q('select count(*) as n from auth.oauth_clients')).rows[0].n) === 1);
    } else {
      check('real PG (rollback): if that insert is rolled back instead the table is empty and the sweep proceeds and commits', out.error === undefined && resultOf(out) === 'committed' && await l1Cleared());
    }
  }

  // ---- 5. lock_timeout: a blocked lock is the fixed refusal after the bounded wait.
  {
    await resetSchema(); await seedL1();
    const before = await l1Fingerprint();
    const holder = await newClient();
    await holder.query('begin');
    await holder.query('lock table auth.scim_tokens in row exclusive mode');
    const out = await run('l1-sweep');
    await holder.query('rollback'); await holder.end();
    check('real PG, a STOP table that cannot be locked within the lock timeout: fixed refusal prod_sql_l1_stop_table_lock_failed, rolled back, never committed, no delete or update sent', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_lock_failed' && resultOf(out) === 'rolled_back' && !out.sent.some((s) => /^(delete|update)\b/.test(s)) && !out.sent.some((s) => /^select count/.test(s)));
    check('real PG, the wait is bounded by the 10 second lock timeout (measured between 9.5 and 14 seconds), and the L1 data and every STOP table are untouched', out.ms >= 9500 && out.ms <= 14000 && await l1Fingerprint() === before && await stopRows() === 0);
    info('lock timeout wait', `${out.ms} ms`);
    check('real PG, the refusal output names no driver text and passes the wrapper allow-list', (() => { const k = { fields: 0 }; return out.events.every((e) => wrapper.allowListLine(JSON.stringify(e), k) !== null) && k.fields === 0 && !/timeout|canceling/i.test(JSON.stringify(out.events)); })());
  }

  // ---- 6. A server whose default isolation is repeatable read still counts rows committed while the lock was awaited.
  {
    await resetSchema(); await seedL1();
    const control = await newClient();
    await control.query('begin isolation level repeatable read');
    await control.query('select 1 from auth.sessions limit 1'); // the snapshot is taken here, as it would be by an early query of a sweep that did not set read committed
    const other = await newClient();
    await other.query("insert into auth.instances (data) values ('committed after the snapshot')");
    await other.end();
    await control.query('lock table auth.instances in share mode');
    const stale = Number((await control.query('select count(*) as n from auth.instances')).rows[0].n);
    await control.query('rollback'); await control.end();
    info('control', `a repeatable-read transaction that took its snapshot before the lock counts ${stale} rows although one is committed (the staleness read committed prevents)`);
    check('real PG control: the stale-snapshot hazard is real (count 0 under repeatable read although one row is committed)', stale === 0);
    await q('truncate auth.instances');
    const early = await newClient();
    await early.query('begin');
    await early.query("insert into auth.mfa_factors (data) values ('in flight')");
    const sweep = runLater('l1-sweep', { options: '-c default_transaction_isolation=repeatable\\ read' });
    await waitFor('the sweep to wait for the lock', async () => (await q("select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'mfa_factors' and not l.granted and l.mode = 'ShareRowExclusiveLock'")).rows[0].n === 1);
    await early.query('commit'); await early.end();
    const out = await sweep;
    check('real PG, with the SERVER default set to repeatable read the sweep still counts the row committed during the lock wait (the runner sets read committed first): refused as populated', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_populated' && stopEvent(out)?.tables.mfa_factors === 1);
  }

  // ---- 7. Deadlock with L1's own statements: no hang; one side ends and the database stays consistent.
  {
    await resetSchema(); await seedL1();
    const before = await l1Fingerprint();
    let paused: (v: void) => void = () => undefined;
    const reached = new Promise<void>((r) => { paused = r; });
    let release: (v: void) => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const sweep = runLater('l1-sweep', { before: async (sql) => { if (isFirstDelete(sql)) { paused(); await gate; } } });
    await reached;
    const other = await newClient();
    await other.query('begin');
    await other.query("update auth.flow_state set auth_code = 'touched by another transaction' where auth_code = 'c1'");
    const otherInsert = other.query("insert into auth.scim_users (data) values ('blocked by the sweep lock')").then(() => 'inserted', (e: { code?: string }) => `error:${e.code}`);
    await sleep(500);
    release();
    const t0 = Date.now();
    const out = await sweep;
    const otherResult = await otherInsert;
    await other.query('rollback').catch(() => undefined); await other.end();
    const code = (out.error as { code?: string } | undefined)?.code;
    info('deadlock', `elapsed ${Date.now() - t0} ms; sweep ${resultOf(out)}${code ? ` (SQLSTATE ${code})` : ''}; the other transaction's insert: ${otherResult}`);
    check('real PG, a deadlock between the sweep and another transaction that holds an L1 row lock and writes a STOP table is resolved by PostgreSQL within seconds (no hang)', Date.now() - t0 < 8000);
    check('real PG, after the deadlock either the sweep committed (the other side was ended) or it rolled back with SQLSTATE 40P01 reported as server_or_driver_error, and the L1 data is untouched when it rolled back', out.error === undefined ? resultOf(out) === 'committed' : (code === '40P01' && resultOf(out) === 'rolled_back' && await l1Fingerprint() === before));
  }

  // ---- 8. l1-shape: read-only information, no lock, never refuses on a populated STOP table, still refuses on an unclassified table.
  {
    await resetSchema(); await seedL1();
    await q("insert into auth.mfa_factors (data) values ('a'), ('b')");
    let paused: (v: void) => void = () => undefined;
    const reached = new Promise<void>((r) => { paused = r; });
    let release: (v: void) => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const shape = runLater('l1-shape', { before: async (sql) => { if (sql === 'rollback') { paused(); await gate; } } });
    await reached;
    const w = await newClient();
    const t0 = Date.now();
    await w.query("insert into auth.mfa_factors (data) values ('c')");
    check('real PG, while l1-shape is running (all reads done, transaction still open) an INSERT into a STOP table is NOT blocked: the shape stage takes no lock', Date.now() - t0 < 1000);
    await w.end();
    release();
    const out = await shape;
    const ev = stopEvent(out);
    check('real PG, l1-shape reports the count per STOP table as information (locked false, mfa_factors 2 at the time it counted), does not refuse, ends read_only_done, and sent no lock statement', out.error === undefined && resultOf(out) === 'read_only_done' && ev?.locked === false && ev.tables.mfa_factors === 2 && ev.tables_populated === 1 && ev.passed === false && !out.sent.some((s) => /^lock table/.test(s)));
    await resetSchema({ extra: ['review_unclassified'] }); await seedL1();
    const bad = await run('l1-shape');
    const badSweep = await run('l1-sweep');
    check('real PG, an auth table that is not in the classification file still stops l1-shape and l1-sweep (shape refusal, counted not named); the sweep took no lock and changed nothing', bad.error instanceof RunnerRefusal && bad.error.id === 'prod_sql_l1_shape_not_ok' && badSweep.error instanceof RunnerRefusal && badSweep.error.id === 'prod_sql_l1_shape_not_ok' && !badSweep.sent.some((s) => /^lock table|^select count/.test(s)) && !JSON.stringify([...bad.events, ...badSweep.events]).includes('review_unclassified') && !(await l1Cleared()));
  }

  // ---- 9. A STOP table the schema does not have is absent, not an error.
  {
    await resetSchema({ drop: ['webauthn_challenges', 'scim_tokens'] }); await seedL1();
    const out = await run('l1-sweep');
    const ev = stopEvent(out);
    check('real PG, two STOP tables missing from the schema are reported as absent and not locked; the other 11 are checked, and the sweep commits', out.error === undefined && resultOf(out) === 'committed' && ev?.tables_present === 11 && ev.tables.webauthn_challenges === 'absent' && ev.tables.scim_tokens === 'absent' && !out.sent.some((s) => s.startsWith('lock table') && /webauthn_challenges|scim_tokens/.test(s)));
  }

  // ---- 10. Two concurrent sweeps do not deadlock: SHARE ROW EXCLUSIVE conflicts with itself, so the second waits at its LOCK statement; L1's own cascade into saml_relay_states works.
  {
    await resetSchema(); await seedL1();
    await q("insert into auth.saml_relay_states (flow_state_id, data) select id, 'x' from auth.flow_state limit 0");
    let paused: (v: void) => void = () => undefined;
    const reached = new Promise<void>((r) => { paused = r; });
    let release: (v: void) => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const first = runLater('l1-sweep', { before: async (sql) => { if (isFirstDelete(sql)) { paused(); await gate; } } });
    await reached;
    const second = runLater('l1-sweep');
    let secondDone = false; second.then(() => { secondDone = true; }, () => { secondDone = true; });
    await waitFor('the second sweep to wait for the first sweep\'s lock', async () => (await q("select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where not l.granted and l.mode = 'ShareRowExclusiveLock' and c.relname = any($1)", [STOP])).rows[0].n >= 1);
    await sleep(300);
    check('real PG, a second sweep started while the first holds its locks waits (pg_locks: a not-granted ShareRowExclusiveLock request on a STOP table), it has not finished, and it has not deleted anything', !secondDone && (await q("select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where not l.granted and l.mode = 'ShareRowExclusiveLock' and c.relname = any($1)", [STOP])).rows[0].n >= 1);
    release();
    const [o1, o2] = [await first, await second];
    const codes = [o1, o2].map((o) => (o.error as { code?: string } | undefined)?.code);
    info('two sweeps', `first ${resultOf(o1)}, second ${resultOf(o2)}; error codes ${JSON.stringify(codes)}`);
    check('real PG, with the captured saml_relay_states -> flow_state cascade in place, two concurrent sweeps do not deadlock: no 40P01, the first commits, the second waits for it and then also commits (nothing left to clear), L1 data is cleared and every STOP table is empty', o1.error === undefined && o2.error === undefined && resultOf(o1) === 'committed' && resultOf(o2) === 'committed' && !codes.includes('40P01') && await l1Cleared() && await stopRows() === 0);
    check('real PG, both sweeps\' events pass the wrapper allow-list with nothing withheld', (() => { const k = { fields: 0 }; return [...o1.events, ...o2.events].every((e) => wrapper.allowListLine(JSON.stringify(e), k) !== null) && k.fields === 0; })());
  }

  // ---- 11. Own cascade: L1's flow_state delete cascades into the (empty) saml_relay_states and leaves it empty; the re-count before COMMIT agrees.
  {
    await resetSchema(); await seedL1();
    const out = await run('l1-sweep');
    const recount = out.sent.map((s, i) => (/^select count/.test(s) ? i : -1)).filter((i) => i >= 0);
    check('real PG, the captured cascade into saml_relay_states is exercised (the foreign key exists), the table was counted empty before and again before COMMIT (26 counts in all), nothing was deleted from it, and the sweep commits', out.error === undefined && resultOf(out) === 'committed' && recount.length === 26 && Number((await q('select count(*) as n from auth.saml_relay_states')).rows[0].n) === 0 && (await q("select count(*)::int as n from pg_constraint where conname like 'saml_relay_states_flow_state_id_fkey' and confdeltype = 'c'")).rows[0].n === 1);
  }

  // ---- 12. A trigger of the sweep's own transaction writes a STOP table after the first count (SHARE ROW EXCLUSIVE cannot stop the transaction's own writes): the re-count refuses and everything rolls back.
  {
    await resetSchema(); await seedL1();
    await q("create function auth.synthetic_stop_writer() returns trigger language plpgsql as $$ begin insert into auth.scim_users (data) values ('written inside the sweep'); return old; end $$");
    await q('create trigger synthetic_stop_writer after delete on auth.flow_state for each row execute function auth.synthetic_stop_writer()');
    const before = await l1Fingerprint();
    const out = await run('l1-sweep');
    check('real PG, a synthetic AFTER DELETE trigger on flow_state that inserts into scim_users (a STOP table, written by the sweep\'s own transaction): the re-count before COMMIT refuses with prod_sql_l1_stop_table_populated, the run is rolled_back, no COMMIT was sent, scim_users is empty again and every L1 row is as before', out.error instanceof RunnerRefusal && out.error.id === 'prod_sql_l1_stop_table_populated' && resultOf(out) === 'rolled_back' && !out.sent.includes('commit') && out.sent.some((s) => /^delete from auth\.flow_state/.test(s)) && await stopRows() === 0 && await l1Fingerprint() === before && stopEvent(out)?.passed === true);
    await q('drop trigger synthetic_stop_writer on auth.flow_state');
  }

  await q('drop schema if exists auth cascade');
  await admin.end();
  console.log(`prod-sql STOP-table real-PG: ${n} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
