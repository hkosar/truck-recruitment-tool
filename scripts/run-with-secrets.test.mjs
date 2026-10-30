// Tests for scripts/run-with-secrets.mjs. Run: node --test scripts/run-with-secrets.test.mjs
// Uses a fake terminal (a stream that says it is a TTY); no real secret is involved.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ALLOWED, FROM_ENV_BASE_NAMES, PROMPT_ONLY, PROMPT_PROOF_PREFIX, REFUSAL_IDS, allowListLine, main, maskTargets, parseArgs, promptProof, readHidden, scrub } from './run-with-secrets.mjs';

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
  assert.deepEqual(ALLOWED, ['STAGING_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEST_USER_PASSWORD', 'OWNER_STAGING_PASSWORD', 'PRODUCTION_DB_URL']);
});

test('PRODUCTION_DB_URL is prompt-only: --from-env refuses it before anything runs, while the hidden-prompt path accepts the name', () => {
  assert.throws(() => parseArgs(['--from-env', '--secret', 'PRODUCTION_DB_URL', '--', 'node', 'x']), /can only be entered at the hidden prompt/);
  assert.throws(() => parseArgs(['--from-env', '--secret', 'STAGING_DB_URL', '--secret', 'PRODUCTION_DB_URL', '--', 'node', 'x']), /can only be entered at the hidden prompt/);
  assert.deepEqual(parseArgs(['--secret', 'PRODUCTION_DB_URL', '--', 'node', 'x']).secrets, ['PRODUCTION_DB_URL']);
  assert.equal(parseArgs(['--from-env', '--secret', 'STAGING_DB_URL', '--', 'node', 'x']).fromEnv, true);
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
  assert.equal(run({ msg: 'staging-sql.environment_event_trigger', position: 1, name: 'tokenFragmentQ7', event: 'ddl_command_end', enabled: 'O', function: 'rls_auto_enable' }).shown.name, '<withheld>', 'an identifier-shaped fragment is not a reviewed name');
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

// ---- --from-env (staging Doppler path). Offline: the "Doppler environment" is a fake object.
const STG = { DOPPLER_PROJECT: 'truck-recruitment-tool', DOPPLER_CONFIG: 'stg' };
const nonTty = () => { const s = new PassThrough(); s.isTTY = false; return s; };
const EXIT_0 = "console.log(JSON.stringify({ msg: 'staging-sql.selftest', ok: true }));console.error('stderr is withheld ' + process.env.STAGING_DB_URL);";
const runFromEnv = async (env, extraArgs = ['--secret', 'STAGING_DB_URL'], childCode = EXIT_0) => {
  const out = sink(); const err = sink();
  const code = await main({ argv: ['--from-env', ...extraArgs, '--', 'node', '-e', childCode], env, stdin: nonTty(), stdout: out.stream, stderr: err.stream });
  await new Promise((r) => setImmediate(r));
  return { code, out: out.text(), err: err.text() };
};

test('from-env: the flag is parsed, and without it fromEnv is false', () => {
  assert.equal(parseArgs(['--from-env', '--secret', 'STAGING_DB_URL', '--', 'node', 'x']).fromEnv, true);
  assert.equal(parseArgs(['--secret', 'STAGING_DB_URL', '--', 'node', 'x']).fromEnv, false);
});

test('from-env: succeeds with no prompt on a non-terminal stdin; the secret is masked and the allow-list still applies', async () => {
  const r = await runFromEnv({ ...STG, STAGING_DB_URL: URL_SECRET, PATH: process.env.PATH });
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes('Enter STAGING_DB_URL'), 'no prompt is shown');
  assert.match(r.out, /"msg":"staging-sql.selftest","ok":true\}/);
  assert.match(r.out, /run-with-secrets: exit code 0; 1 output line\(s\) withheld; 0 field\(s\) withheld/);
  assert.equal(r.err, '', 'the child stderr line is withheld, not shown');
  assert.ok(!(r.out + r.err).includes('Zq@x-Secret'));
});

test('from-env: the child environment is limited to the base names plus the requested secret (asserted inside the child)', async () => {
  const env = {
    ...STG, DOPPLER_ENVIRONMENT: 'stg', DOPPLER_TOKEN: 'dp.st.stg.fake-token-value', STAGING_DB_URL: URL_SECRET, SUPABASE_SERVICE_ROLE_KEY: 'other-secret-not-requested', OWNER_STAGING_PASSWORD: 'owner-pw-not-requested',
    NODE_OPTIONS: '', RANDOM_OTHER: 'x', PATH: process.env.PATH, TEMP: 't', HOME: 'h', COMSPEC: 'c',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // a fake SystemRoot would stop node itself on Windows
  // Windows itself adds a few variables (HOMEDRIVE, USERNAME, ...) to every new process, so the child checks the two things that matter:
  // nothing from the parent outside the base list and the secret arrives, and what should arrive does arrive. Elsewhere it is exact.
  const expected = ['COMSPEC', 'HOME', 'PATH', 'STAGING_DB_URL', 'TEMP', ...(env.SystemRoot ? ['SystemRoot'] : [])];
  const code = `const keys = Object.keys(process.env);
    const leaked = ['DOPPLER_PROJECT', 'DOPPLER_CONFIG', 'DOPPLER_ENVIRONMENT', 'DOPPLER_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'OWNER_STAGING_PASSWORD', 'NODE_OPTIONS', 'RANDOM_OTHER'].filter((k) => keys.includes(k));
    const present = ${JSON.stringify(expected)}.every((k) => keys.includes(k));
    const exact = process.platform === 'win32' || JSON.stringify([...keys].sort()) === JSON.stringify(${JSON.stringify([...expected].sort())});
    console.log(JSON.stringify({ msg: 'staging-sql.selftest', ok: leaked.length === 0 && present && exact }));`;
  const r = await runFromEnv(env, ['--secret', 'STAGING_DB_URL'], code);
  assert.equal(r.code, 0);
  assert.match(r.out, /"ok":true/, 'DOPPLER_*, DOPPLER_TOKEN, other secrets, NODE_OPTIONS and unknown names must not reach the child');
  assert.ok(FROM_ENV_BASE_NAMES.every((n) => n === n.toUpperCase()));
  assert.ok(!FROM_ENV_BASE_NAMES.some((n) => /DOPPLER|KEY|PASSWORD|TOKEN|SECRET|NODE/.test(n)));
});

test('from-env: DOPPLER_TOKEN and the other secrets are not passed even when the child asks for nothing else', async () => {
  const code = "console.log(JSON.stringify({ msg: 'staging-sql.selftest', ok: ['DOPPLER_TOKEN', 'DOPPLER_CONFIG', 'DOPPLER_PROJECT', 'SUPABASE_SERVICE_ROLE_KEY'].every((k) => process.env[k] === undefined) }));";
  const r = await runFromEnv({ ...STG, DOPPLER_TOKEN: 'dp.st.stg.fake', SUPABASE_SERVICE_ROLE_KEY: 'not-requested-value', STAGING_DB_URL: URL_SECRET, PATH: 'p' }, ['--secret', 'STAGING_DB_URL'], code);
  assert.match(r.out, /"ok":true/);
});

test('from-env: several secrets are all passed and masked; each missing, empty or blank one is refused by variable name only', async () => {
  const both = { ...STG, STAGING_DB_URL: URL_SECRET, SUPABASE_SERVICE_ROLE_KEY: 'service-role-fake-value-1234', PATH: 'p' };
  const code = "console.log(JSON.stringify({ msg: 'staging-sql.selftest', ok: process.env.STAGING_DB_URL.length > 0 && process.env.SUPABASE_SERVICE_ROLE_KEY.length > 0 }));";
  const r = await runFromEnv(both, ['--secret', 'STAGING_DB_URL', '--secret', 'SUPABASE_SERVICE_ROLE_KEY'], code);
  assert.match(r.out, /"ok":true/);
  for (const bad of [undefined, '', '   ']) {
    await assert.rejects(runFromEnv({ ...STG, STAGING_DB_URL: bad, PATH: 'p' }), (e) => e.message === 'refusing: STAGING_DB_URL is missing or empty in the environment (--from-env)');
  }
  await assert.rejects(runFromEnv({ ...both, SUPABASE_SERVICE_ROLE_KEY: '' }, ['--secret', 'STAGING_DB_URL', '--secret', 'SUPABASE_SERVICE_ROLE_KEY']), /SUPABASE_SERVICE_ROLE_KEY is missing or empty/);
});

test('from-env: any scope other than project truck-recruitment-tool and config stg is refused with one fixed message that carries no value', async () => {
  const fixed = 'refusing: --from-env is only for the staging Doppler scope (project truck-recruitment-tool, config stg); run it through doppler run with exactly that project and config';
  for (const scope of [
    { DOPPLER_PROJECT: 'truck-recruitment-tool', DOPPLER_CONFIG: 'prd' },
    { DOPPLER_PROJECT: 'truck-recruitment-tool', DOPPLER_CONFIG: 'dev' },
    { DOPPLER_PROJECT: 'truck-recruitment-tool' },
    { DOPPLER_CONFIG: 'stg' },
    { DOPPLER_PROJECT: 'other-project', DOPPLER_CONFIG: 'stg' },
    { DOPPLER_PROJECT: 'truck-recruitment-tool', DOPPLER_CONFIG: 'stg_prd' },
    { DOPPLER_PROJECT: 'truck-recruitment-tool', DOPPLER_CONFIG: 'STG' },
    {},
  ]) {
    await assert.rejects(runFromEnv({ ...scope, STAGING_DB_URL: URL_SECRET, PATH: 'p' }), (e) => e.message === fixed);
  }
});

test('prompt path is unchanged without the flag: a pre-set secret is still refused and the child still gets the whole parent environment', async () => {
  await assert.rejects(
    main({ argv: ['--secret', 'STAGING_DB_URL', '--', 'node', '-e', '0'], env: { ...STG, STAGING_DB_URL: 'already-here' }, stdin: fakeTty(), stdout: sink().stream, stderr: sink().stream }),
    /already set in this terminal/,
  );
  const stdin = fakeTty(); const out = sink();
  const code = "console.log(JSON.stringify({ msg: 'staging-sql.selftest', ok: process.env.EXTRA_PARENT_VAR === 'kept' && process.env.DOPPLER_CONFIG === 'prompt-path' }));";
  const run = main({ argv: ['--secret', 'STAGING_DB_URL', '--', 'node', '-e', code], env: { PATH: process.env.PATH, EXTRA_PARENT_VAR: 'kept', DOPPLER_CONFIG: 'prompt-path' }, stdin, stdout: out.stream, stderr: sink().stream });
  await new Promise((r) => setImmediate(r));
  stdin.write(`${URL_SECRET}\r`);
  assert.equal(await run, 0);
  assert.match(out.text(), /"ok":true/);
  assert.ok(out.text().includes('Enter STAGING_DB_URL'));
});

test('prompt proof: a prompted production URL reaches the child with a matching proof; a forged ambient proof is replaced, and a staging prompt carries none', async () => {
  const PROOF = PROMPT_PROOF_PREFIX + PROMPT_ONLY[0];
  const code = [
    "const c = require('node:crypto');",
    "const v = process.env.PRODUCTION_DB_URL;",
    `const want = c.createHash('sha256').update('tnbs-prompt-proof:' + v).digest('hex');`,
    `console.log(JSON.stringify({ msg: 'staging-sql.selftest', ok: process.env.${PROOF} === want }));`,
  ].join('\n');
  const stdin = fakeTty(); const out = sink();
  const run = main({ argv: ['--secret', 'PRODUCTION_DB_URL', '--', 'node', '-e', code], env: { PATH: process.env.PATH, [PROOF]: 'forged' }, stdin, stdout: out.stream, stderr: sink().stream });
  await new Promise((r) => setImmediate(r));
  stdin.write(`${URL_SECRET}\r`);
  assert.equal(await run, 0);
  assert.match(out.text(), /"ok":true/);
  assert.equal(promptProof(URL_SECRET).length, 64);
  // A staging prompt run must not forward an ambient proof either.
  const stdin2 = fakeTty(); const out2 = sink();
  const code2 = `console.log(JSON.stringify({ msg: 'staging-sql.selftest', ok: process.env.${PROOF} === undefined }));`;
  const run2 = main({ argv: ['--secret', 'STAGING_DB_URL', '--', 'node', '-e', code2], env: { PATH: process.env.PATH, [PROOF]: 'forged' }, stdin: stdin2, stdout: out2.stream, stderr: sink().stream });
  await new Promise((r) => setImmediate(r));
  stdin2.write(`${URL_SECRET}\r`);
  assert.equal(await run2, 0);
  assert.match(out2.text(), /"ok":true/);
});
