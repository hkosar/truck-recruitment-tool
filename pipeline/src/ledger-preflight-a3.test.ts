// A3 LOCAL test of the migration-ledger preflight (doc 16 section 1.3 step 4) against REAL PostgreSQL catalogue
// states. It needs a task-owned throwaway EMPTY database (no public.profiles) and an admin login that may create
// roles and schemas there. Skipped unless LEDGER_A3_ADMIN_URL is set; it must be a LOOPBACK URL (refused
// otherwise). The assessment runs as a separate low-privilege login (zz_ledger_runner) so the rights checks are
// real. For every scenario the REAL initialization (the runner's LEDGER_TABLE_SQL) and a ledger insert are then run
// as that same login inside a rolled-back transaction: a PASS must never be followed by a failure there
// (soundness), and scenarios marked init:'fails' prove the counterexample really breaks the runner.
// Run: LEDGER_A3_ADMIN_URL=... npx tsx src/ledger-preflight-a3.test.ts
// The hosted half (the real Supabase ledger and roles) is not covered; see doc 16 section 1.5.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runLedgerPreflight } from './ledger-preflight.js';
import { LEDGER_INSERT_SQL, LEDGER_TABLE_SQL } from './staging-rebuilt.js';

const ADMIN = process.env.LEDGER_A3_ADMIN_URL;
const RUNNER = 'zz_ledger_runner';
const OWNER = 'zz_ledger_owner';

function loopback(raw: string): URL {
  const u = new URL(raw);
  if (u.search || u.hash) throw new Error('refusing: a test URL must not carry a query string or fragment');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('refusing: test URLs must be loopback');
  return u;
}

const LEDGER = 'supabase_migrations.schema_migrations';
const CLI_SHAPE = `create schema supabase_migrations; create table ${LEDGER} (version text not null primary key, statements text[], name text);`;
/** The runner owns the schema and the table (the only accepted arrangement). */
const OWN = `alter schema supabase_migrations owner to ${RUNNER}; alter table ${LEDGER} owner to ${RUNNER};`;
/** Another role owns the table; the runner only has the privileges a plain grant gives. */
const GRANT_ONLY = `grant usage on schema supabase_migrations to ${RUNNER}; grant select, insert on ${LEDGER} to ${RUNNER};`;
const SCHEMA = 'create schema supabase_migrations;';
const GENERIC = `${SCHEMA} create table ${LEDGER}`;
const OWNED_BY_OTHER = (grant: string) => `create role ${OWNER} nologin; ${CLI_SHAPE} alter schema supabase_migrations owner to ${OWNER}; alter table ${LEDGER} owner to ${OWNER}; ${grant} ${GRANT_ONLY}`;

interface Scenario { name: string; setup: string; failed: string[]; init?: 'ok' | 'fails' }

const scenarios: Scenario[] = [
  { name: 'schema absent, runner may not create schemas', setup: `revoke create on database current_database_placeholder from ${RUNNER};`, failed: ['runner_can_create_schema'], init: 'fails' },
  { name: 'schema absent, runner may create schemas', setup: '', failed: [], init: 'ok' },
  { name: 'ledger fully compatible but the runner lacks CREATE on the database (create schema if not exists is checked before IF NOT EXISTS)', setup: `${CLI_SHAPE} ${OWN} revoke create on database current_database_placeholder from ${RUNNER};`, failed: ['runner_can_create_schema'], init: 'fails' },
  { name: 'schema present, table absent, runner has no CREATE in it', setup: `${SCHEMA} grant usage on schema supabase_migrations to ${RUNNER};`, failed: ['runner_can_create_table_in_schema'], init: 'fails' },
  { name: 'schema present, table absent, runner may create tables in it', setup: `${SCHEMA} grant usage, create on schema supabase_migrations to ${RUNNER};`, failed: [], init: 'ok' },
  { name: 'exact CLI shape, runner has select+insert but another role owns the table (the unconditional ALTER fails: previously a false PASS)', setup: `${CLI_SHAPE} ${GRANT_ONLY}`, failed: ['runner_owns_ledger_table'], init: 'fails' },
  { name: 'exact CLI shape owned by the runner', setup: `${CLI_SHAPE} ${OWN}`, failed: [], init: 'ok' },
  { name: 'version-only table owned by someone else (columns would have to be added)', setup: `${GENERIC} (version text not null primary key); ${GRANT_ONLY}`, failed: ['runner_owns_ledger_table'], init: 'fails' },
  { name: 'version-only table owned by the runner (the tool adds the columns)', setup: `${GENERIC} (version text not null primary key); ${OWN}`, failed: [], init: 'ok' },
  { name: 'table owned by a role the runner is a member of WITH inheritance (not accepted: only the runner itself)', setup: OWNED_BY_OTHER(`grant ${OWNER} to ${RUNNER} with inherit true;`), failed: ['runner_owns_ledger_table'], init: 'ok' },
  { name: 'table owned by a role the runner is a member of WITHOUT inheritance (the ALTER fails: previously a false PASS)', setup: OWNED_BY_OTHER(`grant ${OWNER} to ${RUNNER} with inherit false;`), failed: ['runner_owns_ledger_table'], init: 'fails' },
  { name: 'name is a stored generated column (the explicit INSERT into name fails: previously a false PASS)', setup: `${GENERIC} (version text not null primary key, statements text[], name text generated always as (version || 'x') stored); ${OWN}`, failed: ['reviewed_columns_have_no_default_identity_or_generation'], init: 'fails' },
  { name: 'name has a default (conservatively not accepted)', setup: `${GENERIC} (version text not null primary key, statements text[], name text default 'x'); ${OWN}`, failed: ['reviewed_columns_have_no_default_identity_or_generation'], init: 'ok' },
  { name: 'statements is text, not text[]', setup: `${GENERIC} (version text not null primary key, statements text, name text); ${OWN}`, failed: ['statements_is_text_array_or_absent'] },
  { name: 'statements is integer[]', setup: `${GENERIC} (version text not null primary key, statements integer[], name text); ${OWN}`, failed: ['statements_is_text_array_or_absent'], init: 'fails' },
  { name: 'name is integer', setup: `${GENERIC} (version text not null primary key, statements text[], name integer); ${OWN}`, failed: ['name_is_text_or_absent'], init: 'fails' },
  { name: 'version is varchar', setup: `${GENERIC} (version varchar not null primary key, statements text[], name text); ${OWN}`, failed: ['version_is_text_not_null'] },
  { name: 'version is not the first column (order does not matter)', setup: `${GENERIC} (name text, statements text[], version text not null primary key); ${OWN}`, failed: [], init: 'ok' },
  { name: 'extra required column without a default', setup: `${GENERIC} (version text not null primary key, statements text[], name text, extra int not null); ${OWN}`, failed: ['only_the_reviewed_columns'], init: 'fails' },
  { name: 'extra required column WITH a default (conservatively not accepted)', setup: `${GENERIC} (version text not null primary key, statements text[], name text, extra int not null default 0); ${OWN}`, failed: ['only_the_reviewed_columns'], init: 'ok' },
  { name: 'extra nullable column (conservatively not accepted)', setup: `${GENERIC} (version text not null primary key, statements text[], name text, extra int); ${OWN}`, failed: ['only_the_reviewed_columns'], init: 'ok' },
  { name: 'version has no key', setup: `${GENERIC} (version text not null, statements text[], name text); ${OWN}`, failed: ['version_is_the_primary_or_unique_key'] },
  { name: 'version unique constraint instead of primary key', setup: `${GENERIC} (version text not null unique, statements text[], name text); ${OWN}`, failed: [], init: 'ok' },
  { name: 'composite primary key', setup: `${GENERIC} (version text not null, statements text[], name text not null, primary key (version, name)); ${OWN}`, failed: ['version_is_the_primary_or_unique_key', 'no_other_constraints', 'no_other_indexes'] },
  { name: 'an extra check constraint', setup: `${CLI_SHAPE} alter table ${LEDGER} add constraint zz_chk check (length(version) > 3); ${OWN}`, failed: ['no_other_constraints'] },
  { name: 'an extra index', setup: `${CLI_SHAPE} create index zz_idx on ${LEDGER} (name); ${OWN}`, failed: ['no_other_indexes'] },
  { name: 'a trigger on the ledger', setup: `${CLI_SHAPE} create function public.zz_noop() returns trigger language plpgsql as $f$ begin return new; end $f$; create trigger zz_trg before insert on ${LEDGER} for each row execute function public.zz_noop(); ${OWN}`, failed: ['no_triggers_rules_or_row_security'] },
  { name: 'row-level security enabled', setup: `${CLI_SHAPE} alter table ${LEDGER} enable row level security; ${OWN}`, failed: ['no_triggers_rules_or_row_security'] },
  { name: 'ledger already has a row', setup: `${CLI_SHAPE} insert into ${LEDGER} (version) values ('20260101000000'); ${OWN}`, failed: ['ledger_is_empty'] },
  { name: 'runner cannot insert', setup: `${CLI_SHAPE} ${OWN} revoke insert on ${LEDGER} from ${RUNNER};`, failed: ['runner_can_insert'], init: 'fails' },
  { name: 'runner cannot select (so emptiness is unreadable)', setup: `${CLI_SHAPE} ${OWN} revoke select on ${LEDGER} from ${RUNNER};`, failed: ['runner_can_select', 'ledger_is_empty'] },
  { name: 'runner has no usage on the ledger schema', setup: `${CLI_SHAPE} ${OWN} revoke usage on schema supabase_migrations from ${RUNNER};`, failed: ['runner_schema_usage', 'ledger_is_empty'], init: 'fails' },
  { name: 'a view instead of a table', setup: `${SCHEMA} create view ${LEDGER} as select 'x'::text as version; alter schema supabase_migrations owner to ${RUNNER}; alter view ${LEDGER} owner to ${RUNNER};`, failed: ['ledger_is_ordinary_table', 'version_is_text_not_null', 'version_is_the_primary_or_unique_key', 'ledger_is_empty'], init: 'fails' },
  { name: 'public.profiles already exists', setup: 'create table public.profiles (id int);', failed: ['public_profiles_absent'] },
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
  const reset = `drop schema if exists supabase_migrations cascade; drop table if exists public.profiles; drop function if exists public.zz_noop() cascade; grant create on database ${dbName} to ${RUNNER};`;
  const dropRoles = async () => {
    await admin.query(`drop owned by ${OWNER}`).catch(() => undefined);
    await admin.query(`drop role if exists ${OWNER}`).catch(() => undefined);
  };
  await dropRoles();
  await admin.query(`drop role if exists ${RUNNER}`).catch(() => undefined);
  await admin.query(`create role ${RUNNER} login password '${pw}'`);
  await admin.query(`grant connect on database ${dbName} to ${RUNNER}; grant usage on schema public to ${RUNNER};`);
  const runnerUrl = new URL(url.toString());
  runnerUrl.username = RUNNER;
  runnerUrl.password = pw;
  let passed = 0;
  let initSucceeded = 0;
  try {
    for (const s of scenarios) {
      await admin.query(reset);
      await dropRoles();
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
        // soundness: the real initialization and a ledger insert, as this same login (rolled back)
        let initError: string | null = null;
        await runner.query('begin');
        try {
          await runner.query(LEDGER_TABLE_SQL);
          await runner.query(LEDGER_INSERT_SQL, ['20990101000000', 'zz_probe']);
        } catch (err) {
          initError = (err as { code?: string }).code ?? 'error';
        } finally {
          await runner.query('rollback');
        }
        if (a.ok) assert.equal(initError, null, `scenario "${s.name}": the preflight PASSED but the real initialization/insert failed (${initError})`);
        if (s.init === 'fails') assert.notEqual(initError, null, `scenario "${s.name}": expected the real initialization/insert to fail`);
        if (s.init === 'ok') assert.equal(initError, null, `scenario "${s.name}": expected the real initialization/insert to succeed (got ${initError})`);
        if (initError === null) initSucceeded += 1;
        console.log(`PASS ${s.name} [preflight ${a.ok ? 'PASS' : 'refused'}; real initialization+insert ${initError === null ? 'succeeded' : `failed (${initError})`}]`);
      } finally {
        await runner.end();
      }
      passed += 1;
    }
  } finally {
    await admin.query(reset).catch(() => undefined);
    await dropRoles();
    await admin.query(`drop owned by ${RUNNER}; drop role if exists ${RUNNER}`).catch(() => undefined);
    await admin.end();
  }
  console.log(`PASS ${passed} ledger-preflight catalogue scenarios (${initSucceeded} where the real initialization and insert succeeded)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
