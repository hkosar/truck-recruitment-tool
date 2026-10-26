// Tests for scripts/run-with-secrets.mjs. Run: node --test scripts/run-with-secrets.test.mjs
// Uses a fake terminal (a stream that says it is a TTY); no real secret is involved.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ALLOWED, REFUSAL_IDS, allowListLine, main, maskTargets, parseArgs, readHidden, scrub } from './run-with-secrets.mjs';

function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.raw = false;
  s.setRawMode = (on) => { s.raw = on; };
  return s;
}
function sink() {
  const chunks = [];
  const w = new PassThrough();
  w.on('data', (c) => chunks.push(c.toString('utf8')));
  return { stream: w, text: () => chunks.join('') };
}
const URL_SECRET = 'postgresql://postgres.abcdefghijklmnopqrst:Zq%40x-Secret-Pw-9981@aws-0-us-east-2.pooler.supabase.com:5432/postgres';

test('hidden prompt: nothing typed is echoed, backspace and arrow keys are handled, raw mode is restored', async () => {
  const stdin = fakeTty();
  const out = sink();
  const p = readHidden('Enter X: ', stdin, out.stream);
  assert.equal(stdin.raw, true);
  stdin.write('abcd');
  stdin.write('\u007fe\u001b[Df\r');
  assert.equal(await p, 'abcef');
  assert.equal(stdin.raw, false);
  assert.equal(out.text(), 'Enter X: \n');
});

test('hidden prompt: Ctrl+C cancels and a non-terminal input is refused', async () => {
  const stdin = fakeTty();
  const p = readHidden('Enter X: ', stdin, sink().stream);
  stdin.write('abc\u0003');
  await assert.rejects(p, /cancelled/);
  const piped = new PassThrough();
  await assert.rejects(readHidden('Enter X: ', piped, sink().stream), /not a terminal/);
});

test('arguments: only allowed secret names, only a `node` child, no duplicates, no unknown options', () => {
  assert.deepEqual(parseArgs(['--secret', 'STAGING_DB_URL', '--cwd', 'pipeline', '--', 'node', 'x.mjs', '--a=b']).childArgs, ['x.mjs', '--a=b']);
  for (const bad of [
    ['--secret', 'PATH', '--', 'node', 'x'],
    ['--secret', 'STAGING_DB_URL', '--', 'cmd', 'x'],
    ['--secret', 'STAGING_DB_URL', '--secret', 'STAGING_DB_URL', '--', 'node', 'x'],
    ['--secret', 'STAGING_DB_URL', '--bogus', '--', 'node', 'x'],
    ['--', 'node', 'x'],
    ['--secret', 'STAGING_DB_URL'],
  ]) assert.throws(() => parseArgs(bad), `${bad.join(' ')} must be refused`);
  assert.deepEqual(ALLOWED, ['STAGING_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEST_USER_PASSWORD', 'OWNER_STAGING_PASSWORD']);
});

test('scrub: the value, its URL-encoded form and a URL secret host, user and password are all masked', () => {
  const targets = maskTargets(URL_SECRET);
  const line = `x ${URL_SECRET} y ${encodeURIComponent(URL_SECRET)} z Zq@x-Secret-Pw-9981 at aws-0-us-east-2.pooler.supabase.com`;
  const s = scrub(line, targets);
  for (const leak of ['Zq%40x', 'Zq@x-Secret', 'pooler.supabase.com', 'abcdefghijklmnopqrst', 'postgresql://']) assert.ok(!s.includes(leak), `leaked ${leak}: ${s}`);
});

test('a secret already set in the environment is refused before anything is read or run', async () => {
  await assert.rejects(
    main({ argv: ['--secret', 'STAGING_DB_URL', '--', 'node', '-e', '0'], env: { STAGING_DB_URL: 'already-here' }, stdin: fakeTty(), stdout: sink().stream, stderr: sink().stream }),
    /already set in this terminal/,
  );
});

test('end to end: the child gets the secret in its environment only; only allow-listed lines are shown, everything else is withheld and counted; exit status passes through', async () => {
  const stdin = fakeTty();
  const out = sink();
  const err = sink();
  const childCode = [
    'const v = process.env.STAGING_DB_URL;',
    'const pw = decodeURIComponent(new URL(v).password);',
    'console.log(JSON.stringify({ msg: "staging-sql.selftest", ok: v.length > 0, exact_match: process.argv.some((a) => a.includes("Secret-Pw")) }));',
    'console.log(JSON.stringify({ msg: "other.event", has: true }));',
    'console.log("echo " + v);',
    'console.log("fragment " + pw.slice(0, 9) + " " + new URL(v).hostname.slice(4, 22));',
    'console.log(JSON.stringify({ msg: "staging-sql.refused", refusal: "server_or_driver_error", err_code: "28P01", err: "password authentication failed for user " + new URL(v).username }));',
    'console.log(JSON.stringify({ msg: "staging-sql.step_failed", step: pw }));',
    'console.error("error mentions " + new URL(v).hostname + " and " + pw);',
    'process.exit(3);',
  ].join('\n');
  const run = main({ argv: ['--secret', 'STAGING_DB_URL', '--', 'node', '-e', childCode], env: { PATH: process.env.PATH }, stdin, stdout: out.stream, stderr: err.stream });
  await new Promise((r) => setImmediate(r));
  stdin.write(`${URL_SECRET}\r`);
  assert.equal(await run, 3);
  await new Promise((r) => setImmediate(r));
  const shown = out.text() + err.text();
  assert.match(out.text(), /"msg":"staging-sql.selftest","ok":true\}/);
  assert.match(out.text(), /"msg":"staging-sql.refused","refusal":"server_or_driver_error","err_code":"28P01"\}/);
  assert.match(out.text(), /"msg":"staging-sql.step_failed","step":"<withheld>"/);
  for (const leak of ['Zq%40x', 'Zq@x-Secret', 'Secret-Pw', 'Zq@x-Secr', 'pooler.supabase.com', 'abcdefghijklmnopqrst', 'echo', 'fragment', 'other.event', 'authentication failed', 'exact_match']) assert.ok(!shown.includes(leak), `leaked or passed through ${leak}`);
  // 4 lines withheld whole (other.event, echo, fragment, stderr); 3 fields withheld inside accepted lines (exact_match key, err key, step value)
  assert.match(out.text(), /run-with-secrets: exit code 3; 4 output line\(s\) withheld; 3 field\(s\) withheld \(not on the allow-list\)/);
  assert.ok(out.text().includes('Enter STAGING_DB_URL'), 'the prompt text itself is shown (it carries no value)');
});

test('allow-list: only enumerated events with their own keys; every value fits its pattern; nothing else, and the counters say how much was dropped', () => {
  const run = (o) => { const counter = { fields: 0 }; const raw = allowListLine(JSON.stringify(o), counter); return { shown: raw === null ? null : JSON.parse(raw), fields: counter.fields }; };
  assert.deepEqual(run({ msg: 'staging-sql.ledger_preflight_check', check: 'runner_owns_ledger_table', ok: false }), { shown: { msg: 'staging-sql.ledger_preflight_check', check: 'runner_owns_ledger_table', ok: false }, fields: 0 });
  assert.deepEqual(run({ msg: 'staging-sql.ledger_preflight', case: 'table_present', ok: false, checks: 15, failed: 1, secretish: 'x', host: 'db.example.supabase.co' }), { shown: { msg: 'staging-sql.ledger_preflight', case: 'table_present', ok: false, checks: 15, failed: 1 }, fields: 2 });
  assert.equal(run({ msg: 'staging-sql.step_failed', step: 'supabase/pending/M1c_batch_delete_audit.sql (precheck)' }).shown.step, 'supabase/pending/M1c_batch_delete_audit.sql (precheck)');
  for (const bad of ['postgresql://u:p@h/db', 'a\nb', 'x (anything)', 'db.abcdefghijklmnopqrst.supabase.co:5432']) { const r = run({ msg: 'staging-sql.step_failed', step: bad }); assert.equal(r.shown.step, '<withheld>'); assert.equal(r.fields, 1); }
  // refusal: an identifier from the fixed list, never text
  assert.deepEqual(run({ msg: 'staging-sql.refused', refusal: 'ledger_preflight_failed' }).shown, { msg: 'staging-sql.refused', refusal: 'ledger_preflight_failed' });
  assert.deepEqual(run({ msg: 'staging-sql.refused', refusal: 're-apply M1c refused: the retained audit table is missing; fragment-Zq9981' }), { shown: { msg: 'staging-sql.refused', refusal: '<withheld>' }, fields: 1 });
  assert.deepEqual(run({ msg: 'staging-sql.refused', err: 're-apply M1c refused: M1c is still applied; run its backout first fragment-Zq9981 [P0001]', err_code: 'P0001' }), { shown: { msg: 'staging-sql.refused', err_code: 'P0001' }, fields: 1 });
  assert.equal(run({ msg: 'staging-sql.refused', err_code: 'secret: abc' }).shown.err_code, '<withheld>');
  assert.equal(run({ msg: 'staging-sql.m1c_partial_state_refused', failed_checks: ['triggers', 'postgresql://x'] }).shown.failed_checks, '<withheld>');
  // values a loose character filter would accept but the per-key patterns do not
  assert.equal(run({ msg: 'staging-sql.environment_event_trigger', name: 'evil.host.example.com', event: 'a', enabled: 'O', function: 'f' }).shown.name, '<withheld>');
  assert.equal(run({ msg: 'staging-sql.environment_default_acl', role: 'someone_else', role_present: true }).shown.role, '<withheld>');
  assert.deepEqual(run({ msg: 'staging-sql.environment_default_acl', role: 'anon', role_present: true, tables_public: ['SELECT', 'password123'] }).shown.tables_public, '<withheld>');
  assert.equal(run({ msg: 'staging-sql.verified', action: 'reset', steps: 1, target: 'recorded rebuilt staging project', file: '/c/Users/someone/file.sql' }).fields, 1);
  assert.equal(run({ msg: 'staging-sql.verified', action: 'reset', steps: 1, target: 'some other target' }).shown.target, '<withheld>');
  // seed progress lines are exact
  assert.equal(allowListLine('created manager fixture for run R20261026_A'), null, 'the run id pattern is lower-case letters, digits and hyphens only');
  assert.equal(allowListLine('created manager fixture for run tnbs-stg2-a5b-01'), 'created manager fixture for run tnbs-stg2-a5b-01');
  assert.equal(allowListLine('created 6 fictional users; expires 2026-11-26T00:00:00.000Z'), 'created 6 fictional users; expires 2026-11-26T00:00:00.000Z');
  for (const bad of ['', 'plain text', 'Error: connect ECONNREFUSED 10.0.0.5:5432', '    at Object.<anonymous> (file.js:1:1)', '{"msg":"other.event"}', '{"msg":"staging-sql.x"}', '{"msg":"staging-sql.done"} trailing', '[1,2]', 'null', '{"msg":5}', 'created x fixture for run ;rm -rf', 'created owner fixture for run r1', 'created 6 fictional users; expires tomorrow', '{"msg":"staging-sql.__proto__"}', '{"msg":"staging-sql.constructor"}']) assert.equal(allowListLine(bad), null, `should be withheld: ${bad}`);
});

test('the refusal identifiers in the wrapper equal the runner list (pipeline/src/refusals.ts)', () => {
  const src = readFileSync(new URL('../pipeline/src/refusals.ts', import.meta.url), 'utf8');
  const block = /export const REFUSAL_IDS = \[([\s\S]*?)\] as const;/.exec(src)[1];
  const runnerIds = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...REFUSAL_IDS].sort(), [...runnerIds].sort());
  assert.equal(new Set(runnerIds).size, runnerIds.length);
});
