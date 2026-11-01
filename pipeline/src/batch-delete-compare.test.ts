// Offline test of the read-only batch_delete definition comparison (batch-delete-compare.ts) and of its runner action.
// No database and no network: the "live" definition is text shaped like pg_get_functiondef output, and the executor runs
// against a recording fake client. The real-catalogue proof is batch-delete-compare-a3.test.ts.
// Run: npx tsx src/batch-delete-compare.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BATCH_DELETE_LIVE_SQL, compareBatchDelete, extractBatchDeleteFromFile, normaliseFunctionDefinition, shortHash } from './batch-delete-compare.js';
import { RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { REBUILT_STAGING_SQL_ACTIONS, REPOSITORY_ROOT, executeRebuiltSqlPlan, planRebuiltSqlRun } from './staging-rebuilt.js';

const m1c = readFileSync(resolve(REPOSITORY_ROOT, 'supabase/pending/M1c_batch_delete_audit.sql'), 'utf8');
const expected = extractBatchDeleteFromFile(m1c);
assert.ok(expected, 'extracts exactly one definition from the pinned file');
assert.match(expected!, /^create function public\.batch_delete\(p_batch_id uuid\)/);
assert.match(expected!, /\n\$\$;$/);
assert.ok(!expected!.includes('revoke all on function'), 'extraction stops at the closing dollar quote');

/** What PostgreSQL 16 prints for that function: its own layout, `$function$` quoting, no VOLATILE. */
const body = expected!.slice(expected!.indexOf('as $$') + 5, expected!.lastIndexOf('$$;'));
const live = (over: { header?: string; body?: string } = {}): string =>
  `CREATE OR REPLACE FUNCTION public.batch_delete(p_batch_id uuid)\n RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'internal', 'pg_temp'\n` +
  (over.header ?? '') + `AS $function$${over.body ?? body}$function$\n`;

let n = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };

check('the reviewed text and the PostgreSQL layout of the same function compare equal', compareBatchDelete(expected!, live()).match === true);
check('CRLF line ends in the file do not matter', compareBatchDelete(expected!.replace(/\n/g, '\r\n'), live()).match === true);
check('the dollar-quote tag does not matter', compareBatchDelete(expected!, live().replace(/\$function\$/g, '$fn$')).match === true);
const base = compareBatchDelete(expected!, live());
check('the event carries two 12-character hashes of the normalised texts', /^[0-9a-f]{12}$/.test(base.expected_hash) && base.expected_hash === base.live_hash && base.expected_hash === shortHash(normaliseFunctionDefinition(expected!, 'file')!.text));

const differs = (name: string, text: string | null, liveHash?: string) => {
  const r = compareBatchDelete(expected!, text);
  check(`difference is false: ${name}`, r.match === false && (liveHash === undefined || r.live_hash === liveHash));
};
differs('function absent', null, 'absent');
differs('a comment word changed in the body', live({ body: body.replace('kept', 'kEpt') }));
differs('the guard raise removed', live({ body: body.replace("raise exception 'not permitted'", "raise notice 'not permitted'") }));
differs('one trailing space added in the body', live({ body: body.replace('return true;', 'return true; ') }));
differs('the audit insert removed', live({ body: body.replace(/insert into internal\.batch_delete_audit[^;]*;/, '') }));
differs('SECURITY INVOKER', live().replace('SECURITY DEFINER', 'SECURITY INVOKER'), undefined);
differs('no SECURITY DEFINER', live().replace(' SECURITY DEFINER\n', '\n'));
differs('another search_path', live().replace("'public', 'internal', 'pg_temp'", "'public', 'pg_temp'"));
differs('search_path order changed', live().replace("'public', 'internal', 'pg_temp'", "'internal', 'public', 'pg_temp'"));
differs('STABLE', live().replace(' SECURITY DEFINER', ' STABLE\n SECURITY DEFINER'));
for (const clause of ['STRICT', 'COST 5', 'LEAKPROOF', 'PARALLEL SAFE', "SET work_mem TO '1MB'", 'ROWS 5']) {
  check(`an extra header clause is unrecognised, never a pass: ${clause}`, compareBatchDelete(expected!, live({ header: ` ${clause}\n` })).live_hash === 'unrecognised');
}
differs('a different argument name', live().replace('p_batch_id', 'p_id'), 'unrecognised');
differs('a different schema', live().replace('public.batch_delete', 'internal.batch_delete'), 'unrecognised');
differs('empty text', '', 'unrecognised');
check('a volatile header with the file layout is accepted on the live side too (same facts)', compareBatchDelete(expected!, live().replace(' LANGUAGE', ' VOLATILE\n LANGUAGE')).match === true);

check('a file with two definitions is not extracted', extractBatchDeleteFromFile(`${expected}\n${expected}`) === null);
check('a file with no definition is not extracted', extractBatchDeleteFromFile('select 1;') === null);
check('an unrecognised pinned text throws instead of comparing', (() => { try { compareBatchDelete('create function public.batch_delete(x int) returns int language sql as $$ select 1 $$;', live()); return false; } catch { return true; } })());
check('the live query is a single read-only select with a fixed signature and no parameters', /^select pg_get_functiondef\(to_regprocedure\('public\.batch_delete\(uuid\)'\)\)/.test(BATCH_DELETE_LIVE_SQL) && !/;|insert|update|alter|create|drop|delete from/i.test(BATCH_DELETE_LIVE_SQL.replaceAll('batch_delete', 'x')));

// ---- the runner action (plan and executor)
const REF = 'abcdefghijklmnopqrst';
const url = `postgresql://postgres.${REF}:x@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const spec = REBUILT_STAGING_SQL_ACTIONS['batch-delete-compare']!;
check('the action is a read-only kind with an exact confirmation and the pinned file hash', spec.kind === 'batch-delete-compare' && spec.confirmation === 'COMPARE TNBS BATCH DELETE DEFINITION' && spec.sha256 === '86cd3de2ab4f1b2283c344088e31d05fbc8e719ebaa17318987a7082c42dfb26');
const plan = planRebuiltSqlRun({ action: 'batch-delete-compare', dbUrl: url, confirm: spec.confirmation, recordedRebuiltRef: REF });
check('the plan holds the extracted function text and one empty step', plan.expectedFunction === expected && plan.steps.length === 1 && plan.steps[0]!.sql === '');
assert.throws(() => planRebuiltSqlRun({ action: 'batch-delete-compare', dbUrl: url, confirm: 'wrong', recordedRebuiltRef: REF }), /--confirm=/);
assert.throws(() => planRebuiltSqlRun({ action: 'batch-delete-compare', dbUrl: url, confirm: undefined, recordedRebuiltRef: REF }), /--confirm=/);
assert.throws(() => planRebuiltSqlRun({ action: 'batch-delete-compare', dbUrl: url.replace(':5432', ':6543'), confirm: spec.confirmation, recordedRebuiltRef: REF }), /5432/);
check('the plan is refused for a wrong confirmation, a missing one and the transaction pooler port', true);

async function run(liveText: string | null): Promise<{ sent: string[]; lines: string[]; error?: unknown }> {
  const sent: string[] = [];
  const lines: string[] = [];
  const client = {
    connect: async () => undefined,
    query: async (sql: string) => { sent.push(sql); return /pg_get_functiondef/.test(sql) ? { rows: liveText === null ? [] : [{ def: liveText }] } : { rows: [] }; },
    end: async () => undefined,
  };
  const out = console.log;
  console.log = (...a: unknown[]) => { lines.push(String(a[0])); };
  try {
    await executeRebuiltSqlPlan(plan, () => client as never);
    return { sent, lines };
  } catch (error) {
    return { sent, lines, error };
  } finally {
    console.log = out;
  }
}

const ok = await run(live());
check('match: only the fixed event is printed, with true and two hashes', ok.error === undefined && ok.lines.length === 1 && JSON.parse(ok.lines[0]!).msg === 'staging-sql.batch_delete_compare' && JSON.parse(ok.lines[0]!).match === true);
check('match: nothing is sent but the settings, begin read only, the fixed select and rollback', JSON.stringify(ok.sent.filter((s) => !/set_config/.test(s))) === JSON.stringify(['begin read only', BATCH_DELETE_LIVE_SQL, 'rollback']));
for (const [name, text] of [['altered body', live({ body: body.replace('return true;', 'return false;') })], ['absent', null], ['unrecognised header', live({ header: ' STRICT\n' })]] as const) {
  const r = await run(text);
  const printed = r.lines.join('\n');
  check(`mismatch (${name}): fixed event match=false, no definition text printed, refused with the fixed id, transaction rolled back`,
    JSON.parse(r.lines[0]!).match === false && !printed.includes('batch_delete(') && !printed.includes('raise exception') && !printed.includes('declare') &&
    r.error instanceof RunnerRefusal && classifyRunnerFailure(r.error).refusal === 'batch_delete_definition_mismatch' && r.sent[r.sent.length - 1] === 'rollback');
}
console.log(`${n} checks passed`);
