// A3 LOCAL test of the migration-ledger preflight (doc 16 section 1.3 step 4) against REAL PostgreSQL catalogue
// states. It needs a task-owned throwaway EMPTY database (no public.profiles) and an admin login that may create
// roles and schemas there. Skipped unless LEDGER_A3_ADMIN_URL is set; it must be a LOOPBACK URL (refused
// otherwise). The assessment runs as a separate low-privilege login (zz_ledger_runner) so the rights checks are
// real. Run: LEDGER_A3_ADMIN_URL=... npx tsx src/ledger-preflight-a3.test.ts
// The hosted half (the real Supabase ledger and roles) is not covered; see doc 16 section 1.5.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runLedgerPreflight } from './ledger-preflight.js';

const ADMIN = process.env.LEDGER_A3_ADMIN_URL;
const RUNNER = 'zz_ledger_runner';

function loopback(raw: string): URL {
  const u = new URL(raw);
  if (u.search || u.hash) throw new Error('refusing: a test URL must not carry a query string or fragment');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('refusing: test URLs must be loopback');
  return u;
}

const LEDGER = 'supabase_migrations.schema_migrations';
const CLI_SHAPE = `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key, statements text[], name text);`;
const GRANT_RW = `grant usage on schema supabase_migrations to ${RUNNER}; grant select, insert on ${LEDGER} to ${RUNNER};`;

interface Scenario { name: string; setup: string; failed: string[] }

const scenarios: Scenario[] = [
  { name: 'schema absent, runner may not create schemas', setup: '', failed: ['runner_can_create_schema'] },
  { name: 'schema absent, runner may create schemas', setup: `grant create on database current_database_placeholder to ${RUNNER};`, failed: [] },
  { name: 'schema present, table absent, runner has no CREATE in it', setup: `create schema supabase_migrations; grant usage on schema supabase_migrations to ${RUNNER};`, failed: ['runner_can_create_table_in_schema'] },
  { name: 'schema present, table absent, runner may create tables in it', setup: `create schema supabase_migrations; grant usage, create on schema supabase_migrations to ${RUNNER};`, failed: [] },
  { name: 'exact CLI shape, runner has select+insert, no rows', setup: `${CLI_SHAPE} ${GRANT_RW}`, failed: [] },
  { name: 'exact CLI shape owned by the runner', setup: `${CLI_SHAPE} alter schema supabase_migrations owner to ${RUNNER}; alter table ${LEDGER} owner to ${RUNNER};`, failed: [] },
  { name: 'version-only table owned by someone else (columns would have to be added)', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key); ${GRANT_RW}`, failed: ['runner_owns_table_if_columns_must_be_added'] },
  { name: 'version-only table owned by the runner (the tool adds the columns)', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key); alter schema supabase_migrations owner to ${RUNNER}; alter table ${LEDGER} owner to ${RUNNER};`, failed: [] },
  { name: 'statements is text, not text[]', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key, statements text, name text); ${GRANT_RW}`, failed: ['statements_is_text_array_or_absent'] },
  { name: 'statements is integer[]', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key, statements integer[], name text); ${GRANT_RW}`, failed: ['statements_is_text_array_or_absent'] },
  { name: 'name is integer', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key, statements text[], name integer); ${GRANT_RW}`, failed: ['name_is_text_or_absent'] },
  { name: 'version is varchar', setup: `create schema supabase_migrations; create table ${LEDGER} (version varchar not null primary key, statements text[], name text); ${GRANT_RW}`, failed: ['version_is_text_not_null'] },
  { name: 'version is not the first column (order does not matter)', setup: `create schema supabase_migrations; create table ${LEDGER} (name text, statements text[], version text not null primary key); ${GRANT_RW}`, failed: [] },
  { name: 'extra required column without a default', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key, statements text[], name text, extra int not null); ${GRANT_RW}`, failed: ['no_extra_required_columns_without_default'] },
  { name: 'extra required column WITH a default', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key, statements text[], name text, extra int not null default 0); ${GRANT_RW}`, failed: [] },
  { name: 'version has no key', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null, statements text[], name text); ${GRANT_RW}`, failed: ['version_is_the_primary_or_unique_key'] },
  { name: 'version unique constraint instead of primary key', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null unique, statements text[], name text); ${GRANT_RW}`, failed: [] },
  { name: 'composite primary key', setup: `create schema supabase_migrations; create table ${LEDGER} (version text not null, statements text[], name text not null, primary key (version, name)); ${GRANT_RW}`, failed: ['version_is_the_primary_or_unique_key', 'no_other_constraints', 'no_other_indexes'] },
  { name: 'an extra check constraint', setup: `${CLI_SHAPE} alter table ${LEDGER} add constraint zz_chk check (length(version) > 3); ${GRANT_RW}`, failed: ['no_other_constraints'] },
  { name: 'an extra index', setup: `${CLI_SHAPE} create index zz_idx on ${LEDGER} (name); ${GRANT_RW}`, failed: ['no_other_indexes'] },
  { name: 'a trigger on the ledger', setup: `${CLI_SHAPE} create function public.zz_noop() returns trigger language plpgsql as $f$ begin return new; end $f$; create trigger zz_trg before insert on ${LEDGER} for each row execute function public.zz_noop(); ${GRANT_RW}`, failed: ['no_triggers_rules_or_row_security'] },
  { name: 'row-level security enabled', setup: `${CLI_SHAPE} alter table ${LEDGER} enable row level security; ${GRANT_RW}`, failed: ['no_triggers_rules_or_row_security'] },
  { name: 'ledger already has a row', setup: `${CLI_SHAPE} insert into ${LEDGER} (version) values ('20260101000000'); ${GRANT_RW}`, failed: ['ledger_is_empty'] },
  { name: 'runner cannot insert', setup: `${CLI_SHAPE} grant usage on schema supabase_migrations to ${RUNNER}; grant select on ${LEDGER} to ${RUNNER};`, failed: ['runner_can_insert'] },
  { name: 'runner cannot select (so emptiness is unreadable)', setup: `${CLI_SHAPE} grant usage on schema supabase_migrations to ${RUNNER}; grant insert on ${LEDGER} to ${RUNNER};`, failed: ['runner_can_select', 'ledger_is_empty'] },
  { name: 'runner has no usage on the ledger schema', setup: `${CLI_SHAPE} grant select, insert on ${LEDGER} to ${RUNNER};`, failed: ['runner_schema_usage', 'ledger_is_empty'] },
  { name: 'a view instead of a table', setup: `create schema supabase_migrations; create view ${LEDGER} as select 'x'::text as version; ${GRANT_RW.replace('grant select, insert', 'grant select')}`, failed: ['ledger_is_ordinary_table', 'version_is_text_not_null', 'runner_owns_table_if_columns_must_be_added', 'version_is_the_primary_or_unique_key', 'runner_can_insert', 'ledger_is_empty'] },
  { name: 'public.profiles already exists', setup: 'create table public.profiles (id int);', failed: ['public_profiles_absent', 'runner_can_create_schema'] },
];

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip ledger preflight A3 test (set LEDGER_A3_ADMIN_URL, loopback only)');
    return;
  }
  const url = loopback(ADMIN);
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  const dbName = (await admin.query('select current_database() as d')).rows[0].d as string;
  assert.match(dbName, /^tr_/, 'refusing: the test database name must start with tr_');
  assert.equal((await admin.query("select to_regclass('public.profiles') as t")).rows[0].t, null, 'refusing: the test database must be empty (no public.profiles)');
  const pw = randomBytes(18).toString('hex');
  await admin.query(`drop role if exists ${RUNNER}`).catch(() => undefined);
  await admin.query(`create role ${RUNNER} login password '${pw}'`);
  await admin.query(`grant connect on database ${dbName} to ${RUNNER}; grant usage on schema public to ${RUNNER};`);
  const runnerUrl = new URL(url.toString());
  runnerUrl.username = RUNNER;
  runnerUrl.password = pw;
  let passed = 0;
  try {
    for (const s of scenarios) {
      await admin.query(`drop schema if exists supabase_migrations cascade; drop table if exists public.profiles; drop function if exists public.zz_noop() cascade; revoke create on database ${dbName} from ${RUNNER};`);
      await admin.query(s.setup.replace('current_database_placeholder', dbName));
      const runner = new pg.Client({ connectionString: runnerUrl.toString() });
      await runner.connect();
      try {
        await runner.query('begin read only');
        const a = await runLedgerPreflight(runner as never);
        await runner.query('rollback');
        const failed = a.checks.filter((c) => !c.ok).map((c) => c.check).sort();
        assert.deepEqual(failed, [...s.failed].sort(), `scenario "${s.name}": failed checks`);
        assert.equal(a.ok, s.failed.length === 0, `scenario "${s.name}": ok flag`);
      } finally {
        await runner.end();
      }
      console.log(`PASS ${s.name}`);
      passed += 1;
    }
  } finally {
    await admin.query(`drop schema if exists supabase_migrations cascade; drop table if exists public.profiles; drop function if exists public.zz_noop() cascade; revoke create on database ${dbName} from ${RUNNER};`).catch(() => undefined);
    await admin.query(`drop owned by ${RUNNER}; drop role if exists ${RUNNER}`).catch(() => undefined);
    await admin.end();
  }
  console.log(`PASS ${passed} ledger-preflight catalogue scenarios`);
}

main().catch((err) => { console.error(err); process.exit(1); });
