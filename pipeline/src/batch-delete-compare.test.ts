// Offline test of the read-only batch_delete definition comparison (batch-delete-compare.ts) and of its runner action.
// No database and no network: the "live" definition is text shaped like pg_get_functiondef output, and the executor runs
// against a recording fake client. The real-catalogue proof is batch-delete-compare-a3.test.ts.
// Run: npx tsx src/batch-delete-compare.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BATCH_DELETE_LIVE_SQL, BATCH_DELETE_STATEMENT_TIMEOUT_SQL, compareBatchDelete, extractBatchDeleteFromFile, normaliseFunctionDefinition, shortHash } from './batch-delete-compare.js';
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

const GOOD_CONFIG = ['search_path=public, internal, pg_temp'];
let n = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };

check('the reviewed text and the PostgreSQL layout of the same function compare equal', compareBatchDelete(expected!, live(), GOOD_CONFIG).match === true);
check('CRLF line ends in the file do not matter', compareBatchDelete(expected!.replace(/\n/g, '\r\n'), live(), GOOD_CONFIG).match === true);
check('the dollar-quote tag does not matter', compareBatchDelete(expected!, live().replace(/\$function\$/g, '$fn$'), GOOD_CONFIG).match === true);
const base = compareBatchDelete(expected!, live(), GOOD_CONFIG);
check('the event carries two 12-character hashes of the normalised texts', /^[0-9a-f]{12}$/.test(base.expected_hash) && base.expected_hash === base.live_hash && base.expected_hash === shortHash(normaliseFunctionDefinition(expected!, 'file')!.text));

const differs = (name: string, text: string | null, liveHash?: string, config: unknown = GOOD_CONFIG) => {
  const r = compareBatchDelete(expected!, text, config);
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
check('a volatile header with the file layout is accepted on the live side too (same facts)', compareBatchDelete(expected!, live().replace(' LANGUAGE', ' VOLATILE\n LANGUAGE'), GOOD_CONFIG).match === true);

// ---- exact search_path (review finding B1): no case folding, no splitting of free text
const SP = "'public', 'internal', 'pg_temp'";
const withSp = (list: string): string => live().replace(SP, list);
differs('A: ONE schema named "public, internal" then pg_temp', withSp("'public, internal', 'pg_temp'"), 'unrecognised', ['search_path="public, internal", pg_temp']);
differs('B: "Public" (upper case)', withSp("'Public', 'internal', 'pg_temp'"), 'unrecognised', ['search_path="Public", internal, pg_temp']);
differs('C: "INTERNAL" (upper case)', withSp("'public', 'INTERNAL', 'pg_temp'"), 'unrecognised', ['search_path=public, "INTERNAL", pg_temp']);
differs('D: all three inside ONE quoted element (pg_temp effectively first)', withSp("'public, internal, pg_temp'"), 'unrecognised', ['search_path="public, internal, pg_temp"']);
differs('pg_temp first', withSp("'pg_temp', 'public', 'internal'"), undefined, ['search_path=pg_temp, public, internal']);
differs('pg_temp in the middle', withSp("'public', 'pg_temp', 'internal'"), undefined, ['search_path=public, pg_temp, internal']);
differs('pg_temp missing', withSp("'public', 'internal'"), undefined, ['search_path=public, internal']);
differs('quoted comma in a middle element', withSp("'public', 'internal, pg_temp'"), 'unrecognised', ['search_path=public, "internal, pg_temp"']);
differs('an unquoted element on the live side', withSp("public, 'internal', 'pg_temp'"), 'unrecognised');
differs('an element with a space', withSp("'public', 'inter nal', 'pg_temp'"), 'unrecognised');
differs('a trailing empty element', withSp("'public', 'internal', 'pg_temp', ''"), 'unrecognised');
for (const [name, config] of [['proconfig missing (null)', null], ['proconfig empty', []], ['proconfig upper case', ['search_path=Public, internal, pg_temp']], ['proconfig quoted comma', ['search_path="public, internal, pg_temp"']], ['proconfig pg_temp first', ['search_path=pg_temp, public, internal']], ['proconfig extra entry', ['search_path=public, internal, pg_temp', 'work_mem=1MB']], ['proconfig not an array', 'search_path=public, internal, pg_temp']] as const) {
  differs(`stored setting differs even though the header looks right: ${name}`, live(), undefined, config);
}
check('the stored-setting check does not depend on the header: equal header and equal setting is the only match', compareBatchDelete(expected!, live(), GOOD_CONFIG).match === true && compareBatchDelete(expected!, live(), null).match === false);
check('a CR byte in the LIVE body is a difference (live line ends are not normalised)', compareBatchDelete(expected!, live({ body: body.replace('\n', '\r\n') }), GOOD_CONFIG).match === false);
check('a CRLF pinned file still equals the LF live body (file-side normalisation only)', compareBatchDelete(expected!.replace(/\n/g, '\r\n'), live(), GOOD_CONFIG).match === true);

check('a file with two definitions is not extracted', extractBatchDeleteFromFile(`${expected}\n${expected}`) === null);
check('a file with no definition is not extracted', extractBatchDeleteFromFile('select 1;') === null);
check('an unrecognised pinned text throws instead of comparing', (() => { try { compareBatchDelete('create function public.batch_delete(x int) returns int language sql as $$ select 1 $$;', live()); return false; } catch { return true; } })());
check('the statement timeout is 30 s, transaction-local and never raises a stricter value', BATCH_DELETE_STATEMENT_TIMEOUT_SQL === "select set_config('statement_timeout', '30s', true) from pg_catalog.pg_settings where name = 'statement_timeout' and (setting::bigint = 0 or setting::bigint > 30000)");
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
    query: async (sql: string) => { sent.push(sql); return /pg_get_functiondef/.test(sql) ? { rows: liveText === null ? [] : [{ def: liveText, config: GOOD_CONFIG }] } : { rows: [] }; },
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
check('match: nothing is sent but the settings, begin read only, the statement timeout, the fixed select and rollback', JSON.stringify(ok.sent.filter((s) => s === BATCH_DELETE_STATEMENT_TIMEOUT_SQL || !/set_config/.test(s))) === JSON.stringify(['begin read only', BATCH_DELETE_STATEMENT_TIMEOUT_SQL, BATCH_DELETE_LIVE_SQL, 'rollback']));
for (const [name, text] of [['altered body', live({ body: body.replace('return true;', 'return false;') })], ['absent', null], ['unrecognised header', live({ header: ' STRICT\n' })]] as const) {
  const r = await run(text);
  const printed = r.lines.join('\n');
  check(`mismatch (${name}): fixed event match=false, no definition text printed, refused with the fixed id, transaction rolled back`,
    JSON.parse(r.lines[0]!).match === false && !printed.includes('batch_delete(') && !printed.includes('raise exception') && !printed.includes('declare') &&
    r.error instanceof RunnerRefusal && classifyRunnerFailure(r.error).refusal === 'batch_delete_definition_mismatch' && r.sent[r.sent.length - 1] === 'rollback');
}
console.log(`${n} checks passed`);
