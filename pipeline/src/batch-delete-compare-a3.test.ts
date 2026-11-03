// A3 LOCAL test of the batch_delete definition comparison (batch-delete-compare.ts, doc 16 section 3.3) against a REAL
// PostgreSQL catalogue, using the runner's real plan and executor. It needs a task-owned throwaway database that holds a
// FRESH apply of M1, M1b and M1c (scripts/a3-build-test-db.mjs). Skipped unless BDC_A3_ADMIN_URL is set; it must be a
// LOOPBACK URL and a database whose name starts with tr_. It changes only public.batch_delete and puts it back after every
// scenario (and at the end). The hosted half (the real Supabase catalogue) is not covered; see doc 16 section 1.5.
// Run: BDC_A3_ADMIN_URL=... npx tsx src/batch-delete-compare-a3.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { BATCH_DELETE_STATEMENT_TIMEOUT_SQL, extractBatchDeleteFromFile } from './batch-delete-compare.js';
import { classifyRunnerFailure } from './refusals.js';
import { REBUILT_STAGING_SQL_ACTIONS, REPOSITORY_ROOT, executeRebuiltSqlPlan, planRebuiltSqlRun } from './staging-rebuilt.js';

const ADMIN = process.env.BDC_A3_ADMIN_URL;
const REF = 'abcdefghijklmnopqrst';

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip batch-delete-compare A3 test (set BDC_A3_ADMIN_URL, loopback only)');
    return;
  }
  const u = new URL(ADMIN);
  if (u.search || u.hash || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) throw new Error('refusing: test URLs must be loopback, without query or fragment');
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  assert.match((await admin.query('select current_database() as d')).rows[0].d as string, /^tr_/, 'refusing: the test database name must start with tr_');
  const fileText = readFileSync(resolve(REPOSITORY_ROOT, 'supabase/pending/M1c_batch_delete_audit.sql'), 'utf8');
  const fn = extractBatchDeleteFromFile(fileText)!;
  assert.ok(fn);
  // Restoring the reviewed text: create or replace keeps the owner and the ACL, so the grants stay as applied.
  const restore = fn.replace(/^create function/i, 'create or replace function');
  const liveDef = async () => (await admin.query("select pg_get_functiondef('public.batch_delete(uuid)'::regprocedure) as d")).rows[0].d as string;
  const acl = async () => (await admin.query("select proacl::text as a, proowner::regrole::text as o from pg_proc where oid = 'public.batch_delete(uuid)'::regprocedure")).rows[0] as { a: string; o: string };

  const spec = REBUILT_STAGING_SQL_ACTIONS['batch-delete-compare']!;
  const fake = `postgresql://postgres.${REF}:x@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const plan = planRebuiltSqlRun({ action: 'batch-delete-compare', dbUrl: fake, confirm: spec.confirmation, recordedRebuiltRef: REF });

  interface Outcome { sent: string[]; events: Array<Record<string, unknown>>; refusal?: string; raw: string }
  async function runAction(): Promise<Outcome> {
    const sent: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const raw: string[] = [];
    const client = new pg.Client({ connectionString: ADMIN });
    const wrapped = {
      connect: () => client.connect(),
      query: (sql: string, params?: unknown[]) => { sent.push(sql); return client.query(sql, params as never); },
      end: () => client.end(),
    };
    const logs = console.log; const errs = console.error;
    const grab = (l: unknown[]) => { raw.push(String(l[0])); try { events.push(JSON.parse(String(l[0]))); } catch { /* not an event line */ } };
    console.log = (...a: unknown[]) => grab(a); console.error = (...a: unknown[]) => grab(a);
    try {
      await executeRebuiltSqlPlan(plan, () => wrapped as never);
      return { sent, events, raw: raw.join('\n') };
    } catch (err) {
      return { sent, events, refusal: classifyRunnerFailure(err).refusal, raw: raw.join('\n') };
    } finally {
      console.log = logs; console.error = errs;
    }
  }

  let n = 0;
  const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };
  const matchOf = (o: Outcome) => o.events.find((e) => e.msg === 'staging-sql.batch_delete_compare')?.match;
  const hashes = (o: Outcome) => o.events.find((e) => e.msg === 'staging-sql.batch_delete_compare') as { expected_hash: string; live_hash: string } | undefined;
  const noDefinitionLeak = (o: Outcome) => !/declare|lock_and_validate|batch_delete_audit|raise exception|security definer/i.test(o.raw);

  try {
    const before = { def: await liveDef(), acl: await acl() };
    const fresh = await runAction();
    check('fresh M1/M1b/M1c apply: match = true, no refusal', matchOf(fresh) === true && fresh.refusal === undefined);
    check('match: the two printed hashes are equal 12-character prefixes', /^[0-9a-f]{12}$/.test(hashes(fresh)!.expected_hash) && hashes(fresh)!.expected_hash === hashes(fresh)!.live_hash);
    check('match: only the settings, begin read only, the statement timeout, the fixed select and rollback were sent', JSON.stringify(fresh.sent.filter((s) => !s.startsWith('select set_config($1')).map((s) => (/pg_get_functiondef/.test(s) ? 'select' : s === BATCH_DELETE_STATEMENT_TIMEOUT_SQL ? 'timeout' : s))) === '["begin read only","timeout","select","rollback"]');
    await admin.query('begin');
    await admin.query(BATCH_DELETE_STATEMENT_TIMEOUT_SQL);
    const st = (await admin.query("select current_setting('statement_timeout') as s")).rows[0].s as string;
    await admin.query('rollback');
    check('the timeout statement sets a 30 s statement_timeout on a real server (transaction-local)', st === '30s');
    const proconfig = async () => (await admin.query("select proconfig from pg_proc where oid = 'public.batch_delete(uuid)'::regprocedure")).rows[0].proconfig as string[];
    check('the stored setting of the reviewed function is exactly one string "search_path=public, internal, pg_temp"', JSON.stringify(await proconfig()) === '["search_path=public, internal, pg_temp"]');
    check('match: the definition text is never printed', noDefinitionLeak(fresh));
    check('read-only: the live definition and ACL are unchanged by the run', (await liveDef()) === before.def && JSON.stringify(await acl()) === JSON.stringify(before.acl));
    check('the live text really is in PostgreSQL layout (CREATE OR REPLACE ... $function$), not the file layout', /^CREATE OR REPLACE FUNCTION public\.batch_delete/.test(before.def) && before.def.includes('$function$'));

    const scenarios: Array<[string, string]> = [
      ['a comment word changed in the body', restore.replace('kept although', 'kept, although')],
      ['the permission guard raises a different message', restore.replace("raise exception 'not permitted'", "raise exception 'not allowed'")],
      ['the audit insert removed', restore.replace(/insert into internal\.batch_delete_audit[^;]*;/, '')],
      ['the delete changed (extra predicate)', restore.replace('delete from public.batches where id = p_batch_id;', 'delete from public.batches where id = p_batch_id and true;')],
      ['body whitespace changed', restore.replace('return true;', 'return true; ')],
      ['SECURITY INVOKER', restore.replace('security definer', 'security invoker')],
      ['search_path without internal', restore.replace('public, internal, pg_temp', 'public, pg_temp')],
      ['search_path A: one schema "public, internal" then pg_temp', restore.replace('public, internal, pg_temp', '"public, internal", pg_temp')],
      ['search_path B: "Public" upper case', restore.replace('public, internal, pg_temp', '"Public", internal, pg_temp')],
      ['search_path C: "INTERNAL" upper case', restore.replace('public, internal, pg_temp', 'public, "INTERNAL", pg_temp')],
      ['search_path D: all three in one quoted element (pg_temp effectively first)', restore.replace('public, internal, pg_temp', '"public, internal, pg_temp"')],
      ['search_path with pg_temp first', restore.replace('public, internal, pg_temp', 'pg_temp, public, internal')],
      ['search_path with pg_temp in the middle', restore.replace('public, internal, pg_temp', 'public, pg_temp, internal')],
      ['search_path with a quoted comma in the middle element', restore.replace('public, internal, pg_temp', 'public, "internal, pg_temp"')],
      ['search_path in a different order', restore.replace('public, internal, pg_temp', 'internal, public, pg_temp')],
      ['STRICT added', restore.replace('volatile\n', 'volatile strict\n')],
      ['STABLE instead of volatile', restore.replace('volatile\n', 'stable\n')],
      ['COST changed', restore.replace('volatile\n', 'volatile cost 7\n')],
    ];
    for (const [name, replacement] of scenarios) {
      assert.notEqual(replacement, restore, `scenario text must differ: ${name}`);
      await admin.query(replacement);
      const o = await runAction();
      check(`altered function (${name}): match = false, refused batch_delete_definition_mismatch, hashes differ or live unrecognised, no definition printed`,
        matchOf(o) === false && o.refusal === 'batch_delete_definition_mismatch' && (hashes(o)!.live_hash !== hashes(o)!.expected_hash) && noDefinitionLeak(o) && o.sent[o.sent.length - 1] === 'rollback');
      await admin.query(restore);
      check(`restored after (${name}): match = true again`, matchOf(await runAction()) === true);
    }

    // The owner and privileges are not part of the definition (reapply-m1c and the role matrix check them): an ACL change alone matches.
    await admin.query('grant execute on function public.batch_delete(uuid) to public');
    check('an ACL change alone does not change the definition comparison (privileges are checked elsewhere)', matchOf(await runAction()) === true);
    await admin.query('revoke execute on function public.batch_delete(uuid) from public');

    await admin.query('drop function public.batch_delete(uuid)');
    const absent = await runAction();
    check('function dropped: match = false, live_hash absent, refused', matchOf(absent) === false && hashes(absent)!.live_hash === 'absent' && absent.refusal === 'batch_delete_definition_mismatch');
    await admin.query(restore);
    await admin.query('revoke all on function public.batch_delete(uuid) from public, anon, authenticated');
    await admin.query('grant execute on function public.batch_delete(uuid) to recruiter_api');
    const end = { def: await liveDef(), acl: await acl() };
    check('the function and its ACL are back exactly as applied', end.def === before.def && JSON.stringify(end.acl) === JSON.stringify(before.acl));
    check('and the comparison matches again', matchOf(await runAction()) === true);
  } finally {
    await admin.end();
  }
  console.log(`${n} checks passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
