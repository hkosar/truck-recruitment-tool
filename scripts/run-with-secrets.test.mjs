// Tests for scripts/run-with-secrets.mjs. Run: node --test scripts/run-with-secrets.test.mjs
// Uses a fake terminal (a stream that says it is a TTY); no real secret is involved.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ALLOWED, main, maskTargets, parseArgs, readHidden, scrub } from './run-with-secrets.mjs';

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

test('end to end: the child gets the secret in its environment only; output is scrubbed; exit status passes through', async () => {
  const stdin = fakeTty();
  const out = sink();
  const err = sink();
  const childCode = [
    'const v = process.env.STAGING_DB_URL;',
    'console.log(JSON.stringify({ msg: "child.event", has: v.length > 0, argvHasIt: process.argv.some((a) => a.includes("Secret-Pw")) }));',
    'console.log("echo " + v);',
    'console.error("error mentions " + new URL(v).hostname + " and " + decodeURIComponent(new URL(v).password));',
    'process.exit(3);',
  ].join('\n');
  const run = main({ argv: ['--secret', 'STAGING_DB_URL', '--', 'node', '-e', childCode], env: { PATH: process.env.PATH }, stdin, stdout: out.stream, stderr: err.stream });
  await new Promise((r) => setImmediate(r));
  stdin.write(`${URL_SECRET}\r`);
  assert.equal(await run, 3);
  await new Promise((r) => setImmediate(r));
  const shown = out.text() + err.text();
  assert.match(out.text(), /"msg":"child.event","has":true,"argvHasIt":false/);
  for (const leak of ['Zq%40x', 'Zq@x-Secret', 'Secret-Pw', 'pooler.supabase.com', 'abcdefghijklmnopqrst']) assert.ok(!shown.includes(leak), `leaked ${leak}`);
  assert.match(shown, /echo <masked>/);
  assert.ok(out.text().includes('Enter STAGING_DB_URL'), 'the prompt text itself is shown (it carries no value)');
});
