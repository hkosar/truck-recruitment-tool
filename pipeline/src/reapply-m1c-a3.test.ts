// A3 LOCAL test of the reapply-m1c state checks (doc 16 section 3.3) against REAL PostgreSQL catalogue
// states, using the runner's real plan and executor. It needs a task-owned throwaway database that holds a
// FRESH apply of M1, M1b and M1c (scripts/a3-build-test-db.mjs). Skipped unless REAPPLY_A3_ADMIN_URL is set;
// it must be a LOOPBACK URL (refused otherwise). It changes only that database's M1c audit objects and puts
// them back after every scenario. Run: REAPPLY_A3_ADMIN_URL=... npx tsx src/reapply-m1c-a3.test.ts
// The hosted half (the real Supabase catalogue) is not covered; see doc 16 section 1.5.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { M1C_STATE_PROBE_SQL, classifyM1cState, idempotentReapplySql, type M1cStateFacts } from './reapply.js';
import { REBUILT_STAGING_SQL_ACTIONS, REPOSITORY_ROOT, executeRebuiltSqlPlan, planRebuiltSqlRun } from './staging-rebuilt.js';

const ADMIN = process.env.REAPPLY_A3_ADMIN_URL;
const FN = 'internal.batch_delete_audit_append_only()';
const T = 'internal.batch_delete_audit';
const REF = 'abcdefghijklmnopqrst';

function loopback(raw: string): string {
  const u = new URL(raw);
  if (u.search || u.hash) throw new Error('refusing: a test URL must not carry a query string or fragment');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('refusing: test URLs must be loopback');
  return raw;
}

interface Outcome { sent: string[]; error?: string; events: string[] }

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip reapply-m1c A3 test (set REAPPLY_A3_ADMIN_URL, loopback only)');
    return;
  }
  const url = loopback(ADMIN);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const q = (sql: string) => admin.query(sql);
  const facts = async (): Promise<M1cStateFacts> => (await q(M1C_STATE_PROBE_SQL)).rows[0] as M1cStateFacts;
  const hasExec = async () => (await q(`select coalesce(has_function_privilege('service_role', to_regprocedure('${FN}'), 'execute'), false) as e`)).rows[0].e as boolean;
  const batchDeleteBackout = readFileSync(resolve(REPOSITORY_ROOT, 'supabase/backout/M1c-backout.sql'), 'utf8');

  const spec = REBUILT_STAGING_SQL_ACTIONS['reapply-m1c']!;
  const fake = `postgresql://postgres.${REF}:x@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const plan = planRebuiltSqlRun({ action: 'reapply-m1c', dbUrl: fake, confirm: spec.confirmation, recordedRebuiltRef: REF });

  /** The real executor against the local database; records what it sent and what it logged. */
  async function runAction(): Promise<Outcome> {
    const sent: string[] = [];
    const events: string[] = [];
    const client = new pg.Client({ connectionString: url });
    const wrapped = {
      connect: () => client.connect(),
      query: (sql: string, params?: unknown[]) => { sent.push(sql); return client.query(sql, params as never); },
      end: () => client.end(),
    };
    const logs = console.log; const errs = console.error;
    const grab = (l: unknown[]) => { try { events.push((JSON.parse(String(l[0])) as { msg: string }).msg); } catch { /* not an event line */ } };
    console.log = (...a: unknown[]) => grab(a); console.error = (...a: unknown[]) => grab(a);
    try {
      await executeRebuiltSqlPlan(plan, () => wrapped as never);
      return { sent, events };
    } catch (err) {
      return { sent, events, error: (err as Error).message };
    } finally {
      console.log = logs; console.error = errs;
    }
  }
  const lastStep = plan.steps[plan.steps.length - 1]!.sql;
  const mutating = (o: Outcome) => o.sent.filter((s) => !/select set_config|with\s+fn as|as service_role_execute/.test(s));

  const grantDirect = `grant execute on function ${FN} to service_role;`;
  const restoreTriggers = `
    drop trigger if exists batch_delete_audit_no_update_delete on ${T};
    drop trigger if exists batch_delete_audit_no_truncate on ${T};
    create trigger batch_delete_audit_no_update_delete before update or delete on ${T} for each row execute function ${FN};
    create trigger batch_delete_audit_no_truncate before truncate on ${T} for each statement execute function ${FN};`;
  const backOut = `${batchDeleteBackout}`;
  // puts the M1c objects back after a backed-out scenario: the runner's own idempotent form of the reviewed file
  const restoreM1c = idempotentReapplySql(readFileSync(resolve(REPOSITORY_ROOT, 'supabase/pending/M1c_batch_delete_audit.sql'), 'utf8'));
  const cleanFresh = `
    revoke execute on function ${FN} from service_role;
    revoke execute on function ${FN} from public;
    revoke delete on public.batches from recruiter_api;
    revoke all on ${T} from recruiter_api;`;

  type Expect = 'refuse' | 'recover' | 'normal';
  const scenarios: { name: string; setup: string; cleanup: string; expect: Expect; failedCheck?: string }[] = [
    { name: 'fresh apply (no direct grant): nothing to recover, refused', setup: '', cleanup: '', expect: 'refuse', failedCheck: 'service_role_direct_execute' },
    { name: 'interrupted state: guards intact, only the direct service_role grant extra', setup: grantDirect, cleanup: '', expect: 'recover' },
    { name: 'interrupted state but trigger function search_path is the one M1 pins (the M1c file would have reset it)', setup: `${grantDirect} alter function ${FN} set search_path = public, internal, pg_temp;`, cleanup: `alter function ${FN} set search_path = internal, pg_temp; ${cleanFresh}`, expect: 'refuse', failedCheck: 'trigger_function_pinned' },
    { name: 'interrupted state but trigger function has another search_path', setup: `${grantDirect} alter function ${FN} set search_path = public;`, cleanup: `alter function ${FN} set search_path = internal, pg_temp; ${cleanFresh}`, expect: 'refuse', failedCheck: 'trigger_function' },
    { name: 'disabled no_update_delete trigger', setup: `${grantDirect} alter table ${T} disable trigger batch_delete_audit_no_update_delete;`, cleanup: `alter table ${T} enable trigger batch_delete_audit_no_update_delete; ${cleanFresh}`, expect: 'refuse', failedCheck: 'triggers' },
    { name: 'disabled no_truncate trigger', setup: `${grantDirect} alter table ${T} disable trigger batch_delete_audit_no_truncate;`, cleanup: `alter table ${T} enable trigger batch_delete_audit_no_truncate; ${cleanFresh}`, expect: 'refuse', failedCheck: 'triggers' },
    { name: 'trigger attached to a different function', setup: `${grantDirect}
      create function internal.zz_other_trigger_fn() returns trigger language plpgsql as $f$ begin return old; end $f$;
      drop trigger batch_delete_audit_no_update_delete on ${T};
      create trigger batch_delete_audit_no_update_delete before update or delete on ${T} for each row execute function internal.zz_other_trigger_fn();`,
      cleanup: `${restoreTriggers} drop function internal.zz_other_trigger_fn(); ${cleanFresh}`, expect: 'refuse', failedCheck: 'triggers' },
    { name: 'trigger with AFTER timing', setup: `${grantDirect}
      drop trigger batch_delete_audit_no_update_delete on ${T};
      create trigger batch_delete_audit_no_update_delete after update or delete on ${T} for each row execute function ${FN};`,
      cleanup: `${restoreTriggers} ${cleanFresh}`, expect: 'refuse', failedCheck: 'triggers' },
    { name: 'restored direct DELETE on public.batches for recruiter_api', setup: `${grantDirect} grant delete on public.batches to recruiter_api;`, cleanup: cleanFresh, expect: 'refuse', failedCheck: 'batches_delete_clean' },
    { name: 'EXECUTE also held through PUBLIC', setup: `${grantDirect} grant execute on function ${FN} to public;`, cleanup: cleanFresh, expect: 'refuse' },
    { name: 'EXECUTE also inherited through a role service_role belongs to', setup: `${grantDirect}
      create role zz_inherit_role nologin; grant execute on function ${FN} to zz_inherit_role; grant zz_inherit_role to service_role;`,
      cleanup: `revoke zz_inherit_role from service_role; revoke execute on function ${FN} from zz_inherit_role; drop role zz_inherit_role; ${cleanFresh}`, expect: 'refuse', failedCheck: 'service_role_other_path_execute' },
    { name: 'EXECUTE only inherited (no direct entry to revoke)', setup: `create role zz_inherit_role nologin; grant execute on function ${FN} to zz_inherit_role; grant zz_inherit_role to service_role;`,
      cleanup: `revoke zz_inherit_role from service_role; revoke execute on function ${FN} from zz_inherit_role; drop role zz_inherit_role; ${cleanFresh}`, expect: 'refuse' },
    { name: 'recruiter_api holds a privilege on the audit table', setup: `${grantDirect} grant select on ${T} to recruiter_api;`, cleanup: cleanFresh, expect: 'refuse', failedCheck: 'table_acl_clean' },
    { name: 'recruiter_api holds EXECUTE on the trigger function', setup: `${grantDirect} grant execute on function ${FN} to recruiter_api;`, cleanup: `revoke execute on function ${FN} from recruiter_api; ${cleanFresh}`, expect: 'refuse', failedCheck: 'function_acl_clean' },
    { name: 'backed-out state, a trigger missing (batch_delete absent)', setup: `${backOut} drop trigger batch_delete_audit_no_truncate on ${T};`, cleanup: `${restoreM1c} ${cleanFresh}`, expect: 'refuse', failedCheck: 'triggers' },
    { name: 'backed-out state, a trigger disabled (batch_delete absent)', setup: `${backOut} alter table ${T} disable trigger batch_delete_audit_no_update_delete;`, cleanup: `${restoreM1c} ${cleanFresh}`, expect: 'refuse', failedCheck: 'triggers' },
    { name: 'backed-out state, trigger function missing (batch_delete absent)', setup: `${backOut} drop trigger batch_delete_audit_no_update_delete on ${T}; drop trigger batch_delete_audit_no_truncate on ${T}; drop function ${FN};`, cleanup: `${restoreM1c} ${cleanFresh}`, expect: 'refuse', failedCheck: 'trigger_function' },
    { name: 'backed-out state, PUBLIC can execute the trigger function (batch_delete absent)', setup: `${backOut} grant execute on function ${FN} to public;`, cleanup: `${restoreM1c} ${cleanFresh}`, expect: 'refuse' },
    { name: 'valid backed-out state after M1 re-apply (function search_path pinned by M1): normal re-apply', setup: `${backOut} alter function ${FN} set search_path = public, internal, pg_temp; grant execute on function ${FN} to service_role;`, cleanup: '', expect: 'normal' },
    { name: 'valid backed-out state (batch_delete absent, guards intact): normal re-apply', setup: backOut, cleanup: '', expect: 'normal' },
  ];

  const start = await facts();
  assert.equal(start.batch_delete, true, 'start state must be a fresh full apply (batch_delete present)');
  assert.equal(classifyM1cState(start).state, 'refuse'); // fresh: no extra grant to recover
  let passed = 0;
  try {
    for (const s of scenarios) {
      if (s.setup) await q(s.setup);
      const before = await hasExec();
      const o = await runAction();
      const label = `scenario "${s.name}"`;
      if (s.expect === 'refuse') {
        assert.ok(o.error && /refused|re-apply M1c/.test(o.error), `${label}: expected a refusal, got ${o.error ?? 'success'} events=${o.events}`);
        assert.ok(o.events.includes('staging-sql.m1c_partial_state_refused'), `${label}: events ${o.events}`);
        assert.deepEqual(mutating(o), [], `${label}: a refusal must send nothing but the read-only probe`);
        assert.equal(await hasExec(), before, `${label}: the refusal must not change the grant`);
      } else if (s.expect === 'recover') {
        assert.equal(o.error, undefined, `${label}: ${o.error}`);
        assert.ok(o.events.includes('staging-sql.m1c_interrupted_run_detected') && o.events.includes('staging-sql.m1c_postcondition_ok'), `${label}: events ${o.events}`);
        assert.deepEqual(mutating(o), [lastStep], `${label}: only the revoke may be sent`);
        assert.equal(await hasExec(), false, `${label}: service_role must have lost EXECUTE`);
      } else {
        assert.equal(o.error, undefined, `${label}: ${o.error}`);
        assert.ok(o.events.includes('staging-sql.m1c_postcondition_ok'), `${label}: events ${o.events}`);
        assert.equal(mutating(o).length, plan.steps.length, `${label}: the full plan runs`);
        assert.equal(await hasExec(), false);
        assert.equal((await facts()).batch_delete, true, `${label}: batch_delete is back`);
      }
      if (s.failedCheck) {
        // the refusal event names the failed fact
        const again = classifyM1cState(await facts());
        assert.ok(again.failed.includes(s.failedCheck), `${label}: expected failed check ${s.failedCheck}, got ${again.failed}`);
      }
      if (s.cleanup) await q(s.cleanup);
      const after = await facts();
      assert.deepEqual({ ...after, service_role_direct_execute: false }, { ...start, service_role_direct_execute: false }, `${label}: state not restored`);
      assert.equal(after.service_role_direct_execute, false, `${label}: state not restored (grant)`);
      console.log(`PASS ${s.name}`);
      passed += 1;
    }
  } finally {
    await admin.end();
  }
  console.log(`PASS ${passed} reapply-m1c catalogue-state scenarios`);
}

main().catch((err) => { console.error(err); process.exit(1); });
