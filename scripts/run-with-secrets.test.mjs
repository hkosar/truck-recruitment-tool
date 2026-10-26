// Tests for scripts/run-with-secrets.mjs. Run: node --test scripts/run-with-secrets.test.mjs
// Uses a fake terminal (a stream that says it is a TTY); no real secret is involved.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ALLOWED, allowListLine, main, maskTargets, parseArgs, readHidden, scrub } from './run-with-secrets.mjs';

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
  assert.deepEqual(ALLOWED, ['STAGING_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEST_USER_PASSWORD']);
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
    'console.log(JSON.stringify({ msg: "staging-sql.probe", ok: v.length > 0, exact_match: process.argv.some((a) => a.includes("Secret-Pw")) }));',
    'console.log(JSON.stringify({ msg: "other.event", has: true }));',
    'console.log("echo " + v);',
    'console.log("fragment " + pw.slice(0, 9) + " " + new URL(v).hostname.slice(4, 22));',
    'console.log(JSON.stringify({ msg: "staging-sql.refused", err: "password authentication failed for user " + new URL(v).username + " [28P01]" }));',
    'console.error("error mentions " + new URL(v).hostname + " and " + pw);',
    'process.exit(3);',
  ].join('\n');
  const run = main({ argv: ['--secret', 'STAGING_DB_URL', '--', 'node', '-e', childCode], env: { PATH: process.env.PATH }, stdin, stdout: out.stream, stderr: err.stream });
  await new Promise((r) => setImmediate(r));
  stdin.write(`${URL_SECRET}\r`);
  assert.equal(await run, 3);
  await new Promise((r) => setImmediate(r));
  const shown = out.text() + err.text();
  assert.match(out.text(), /"msg":"staging-sql.probe","ok":true,"exact_match":false/);
  assert.match(out.text(), /"msg":"staging-sql.refused","err":"<withheld>","err_code":"28P01"/);
  for (const leak of ['Zq%40x', 'Zq@x-Secret', 'Secret-Pw', 'Zq@x-Secr', 'pooler.supabase.com', 'abcdefghijklmnopqrst', 'echo', 'fragment', 'other.event', 'authentication failed']) assert.ok(!shown.includes(leak), `leaked or passed through ${leak}`);
  assert.match(out.text(), /run-with-secrets: exit code 3; 4 output line\(s\) withheld/);
  assert.ok(out.text().includes('Enter STAGING_DB_URL'), 'the prompt text itself is shown (it carries no value)');
});

test('allow-list: events keep only fixed keys and plain values; free text is reduced to a known guard message or a code; seed progress lines pass; the rest is null', () => {
  const ev = (o) => JSON.parse(allowListLine(JSON.stringify(o)));
  assert.deepEqual(ev({ msg: 'staging-sql.ledger_preflight_check', check: 'runner_owns_ledger_table', ok: false }), { msg: 'staging-sql.ledger_preflight_check', check: 'runner_owns_ledger_table', ok: false });
  assert.deepEqual(ev({ msg: 'staging-sql.ledger_preflight', case: 'table_present', ok: false, checks: 15, failed: 1, secretish: 'x', host: 'db.example.supabase.co' }), { msg: 'staging-sql.ledger_preflight', case: 'table_present', ok: false, checks: 15, failed: 1 });
  assert.deepEqual(ev({ msg: 'staging-sql.step_failed', step: 'supabase/pending/M1c_batch_delete_audit.sql (precheck)' }).step, 'supabase/pending/M1c_batch_delete_audit.sql (precheck)');
  assert.equal(ev({ msg: 'staging-sql.step_failed', step: 'postgresql://u:p@h/db' }).step, '<withheld>');
  assert.equal(ev({ msg: 'staging-sql.step_failed', step: 'a\nb' }).step, '<withheld>');
  assert.equal(ev({ msg: 'staging-sql.refused', err: 'ledger preflight: 2 check(s) failed; the replay must not run' }).err, 'ledger preflight: 2 check(s) failed; the replay must not run');
  assert.deepEqual(ev({ msg: 'staging-sql.refused', err: 'connect ECONNREFUSED 10.0.0.5:5432 [ECONNREFUSED]' }), { msg: 'staging-sql.refused', err: '<withheld>', err_code: 'ECONNREFUSED' });
  assert.deepEqual(ev({ msg: 'staging-sql.refused', err: 'something unexpected with a value' }), { msg: 'staging-sql.refused', err: '<withheld>' });
  assert.deepEqual(ev({ msg: 'staging-sql.m1c_partial_state_refused', failed_checks: ['triggers', 'postgresql://x'] }).failed_checks, ['triggers', '<withheld>']);
  assert.equal(allowListLine('created owner fixture for run r20261026-a'), 'created owner fixture for run r20261026-a');
  assert.equal(allowListLine('created 8 fictional users; expires 2026-11-26T00:00:00.000Z'), 'created 8 fictional users; expires 2026-11-26T00:00:00.000Z');
  for (const bad of ['', 'plain text', 'Error: connect ECONNREFUSED 10.0.0.5:5432', '    at Object.<anonymous> (file.js:1:1)', '{"msg":"other.event"}', '{"msg":"staging-sql.x"} trailing', '[1,2]', 'null', '{"msg":5}', 'created x fixture for run ;rm -rf']) assert.equal(allowListLine(bad), null, `should be withheld: ${bad}`);
});
