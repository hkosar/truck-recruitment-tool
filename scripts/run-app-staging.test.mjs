// Tests for scripts/run-app-staging.mjs. Run: node --test scripts/run-app-staging.test.mjs
// Offline: no database, no network, no Doppler. The "app" is a tiny fake script written to a temporary directory.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { APP_BASE_NAMES, APP_SECRET_NAMES, appLogLine, buildAppEnv, main, parseAppArgs } from './run-app-staging.mjs';

const STG2 = 'ojqtsftfclhxauhjwott';
const OLD_STG = 'yhyoxhtguyturgdhwywc';
const PROD = 'ejrfobddnojbijzrjbii';
const dbUrl = (user, ref, port = 5432) => `postgresql://${user}.${ref}:Fake-Pw-Zz9981-only@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
const K1 = 'A'.repeat(43);
const K2 = 'B'.repeat(43);
const K3 = 'C'.repeat(43);
const goodEnv = () => ({
  DOPPLER_PROJECT: 'truck-recruitment-tool',
  DOPPLER_CONFIG: 'stg',
  DATABASE_URL: dbUrl('recruiter_app', STG2),
  KEY_LINKS: K1,
  KEY_SESSIONS: K2,
  KEY_RATE: K3,
  PATH: 'x',
  DOPPLER_TOKEN: 'dp.st.should-not-pass',
  STAGING_DB_URL: dbUrl('postgres', STG2),
});
const refused = (env, re) => assert.throws(() => buildAppEnv(env, 8788), re);

test('accepts the exact staging scope; the child gets only base names, the four secrets and forced values', () => {
  const child = buildAppEnv(goodEnv(), 8788);
  assert.deepEqual(Object.keys(child).sort(), ['APP_ORIGIN', 'DATABASE_URL', 'EMAIL_MODE', 'HOST', 'KEY_LINKS', 'KEY_RATE', 'KEY_SESSIONS', 'PATH', 'PORT', 'STAGING_BANNER', 'TRUSTED_PROXY_HOPS']);
  assert.equal(child.APP_ORIGIN, 'http://localhost:8788');
  assert.equal(child.EMAIL_MODE, 'test');
  assert.equal(child.HOST, '127.0.0.1');
  assert.equal(child.TRUSTED_PROXY_HOPS, '0');
  assert.deepEqual(APP_SECRET_NAMES, ['DATABASE_URL', 'KEY_LINKS', 'KEY_SESSIONS', 'KEY_RATE']);
  assert.ok(APP_BASE_NAMES.every((n) => !/KEY|URL|TOKEN|SECRET|PASSWORD/.test(n)));
});

test('refuses a wrong or missing Doppler project or config (prd, dev, none)', () => {
  for (const [p, c] of [['truck-recruitment-tool', 'prd'], ['truck-recruitment-tool', 'dev'], ['other', 'stg'], [undefined, undefined]]) {
    refused({ ...goodEnv(), DOPPLER_PROJECT: p, DOPPLER_CONFIG: c }, /only the staging Doppler scope/);
  }
});

test('accepts a token-scoped run that supplies only the project/config variables, and drops them from the child', () => {
  const env = goodEnv();
  const child = buildAppEnv(env, 8788);
  assert.ok(!('DOPPLER_PROJECT' in child) && !('DOPPLER_CONFIG' in child) && !('DOPPLER_TOKEN' in child));
  const { DOPPLER_PROJECT, DOPPLER_CONFIG, ...noScope } = env;
  refused(noScope, /only the staging Doppler scope/);
});

test('refuses each missing or empty required name, naming only the variable', () => {
  for (const name of APP_SECRET_NAMES) {
    for (const v of [undefined, '', '  ']) {
      const env = goodEnv();
      env[name] = v;
      refused(env, new RegExp(`refusing: ${name} is missing or empty`));
    }
  }
});

test('refuses production, the old staging project, other projects, other logins, other ports and unparseable URLs', () => {
  refused({ ...goodEnv(), DATABASE_URL: dbUrl('recruiter_app', PROD) }, /production project/);
  refused({ ...goodEnv(), DATABASE_URL: dbUrl('recruiter_app', OLD_STG) }, /does not target the recorded staging-2/);
  refused({ ...goodEnv(), DATABASE_URL: dbUrl('recruiter_app', 'abcdefghijklmnopqrst') }, /does not target the recorded staging-2/);
  refused({ ...goodEnv(), DATABASE_URL: dbUrl('postgres', STG2) }, /recruiter_app login/);
  refused({ ...goodEnv(), DATABASE_URL: dbUrl('recruiter_maintenance', STG2) }, /recruiter_app login/);
  refused({ ...goodEnv(), DATABASE_URL: dbUrl('recruiter_app', STG2, 6543) }, /session-mode port/);
  refused({ ...goodEnv(), DATABASE_URL: `postgresql://recruiter_app.${STG2}:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres?host=evil` }, /not a valid Supabase database URL/);
  refused({ ...goodEnv(), DATABASE_URL: 'postgres://u:p@localhost:5432/postgres' }, /not a valid Supabase database URL/);
  refused({ ...goodEnv(), DATABASE_URL: 'not a url' }, /not a valid Supabase database URL/);
});

test('refusal messages never contain a secret value', () => {
  const env = { ...goodEnv(), DATABASE_URL: dbUrl('postgres', PROD) };
  try { buildAppEnv(env, 8788); assert.fail('must refuse'); } catch (e) {
    for (const v of ['Fake-Pw-Zz9981-only', K1, K2, K3, PROD]) assert.ok(!String(e.message).includes(v));
  }
});

test('refuses EMAIL_MODE other than test, a non-localhost bind and any SendGrid setting (any capitalisation)', () => {
  refused({ ...goodEnv(), EMAIL_MODE: 'production' }, /EMAIL_MODE must be test/);
  refused({ ...goodEnv(), EMAIL_MODE: 'live' }, /EMAIL_MODE must be test/);
  refused({ ...goodEnv(), HOST: '0.0.0.0' }, /HOST must be 127\.0\.0\.1/);
  refused({ ...goodEnv(), HOST: '::' }, /HOST must be 127\.0\.0\.1/);
  refused({ ...goodEnv(), HOST: 'example.com' }, /HOST must be 127\.0\.0\.1/);
  refused({ ...goodEnv(), SENDGRID_API_KEY: 'SG.x' }, /SendGrid/);
  refused({ ...goodEnv(), sendgrid_from_address: 'a@b.invalid' }, /SendGrid/);
  assert.equal(buildAppEnv({ ...goodEnv(), EMAIL_MODE: 'test', HOST: '127.0.0.1' }, 8788).EMAIL_MODE, 'test');
});

test('an inherited APP_ORIGIN, PORT, MAINTENANCE_MODE or NODE_OPTIONS cannot reach the child', () => {
  const child = buildAppEnv({ ...goodEnv(), APP_ORIGIN: 'https://evil.example', PORT: '1', MAINTENANCE_MODE: 'true', NODE_OPTIONS: '--require x' }, 9100);
  assert.equal(child.APP_ORIGIN, 'http://localhost:9100');
  assert.equal(child.PORT, '9100');
  assert.ok(!('MAINTENANCE_MODE' in child) && !('NODE_OPTIONS' in child));
});

test('arguments: only --port with a whole number 1024-65535', () => {
  assert.deepEqual(parseAppArgs([]), { port: 8788 });
  assert.deepEqual(parseAppArgs(['--port', '9100']), { port: 9100 });
  for (const bad of [['--port'], ['--port', 'x'], ['--port', '80'], ['--port', '70000'], ['--host', '0.0.0.0'], ['--email-mode', 'production'], ['node', 'x']]) {
    assert.throws(() => parseAppArgs(bad), `${bad.join(' ')} must be refused`);
  }
});

test('log lines: structured app lines pass, anything else is withheld and counted', () => {
  const counter = { fields: 0 };
  assert.equal(appLogLine('{"at":"2026-11-01T10:00:00.000Z","event":"listening","port":8788}', counter), '{"at":"2026-11-01T10:00:00.000Z","event":"listening","port":8788}');
  assert.equal(appLogLine('{"at":"2026-11-01T10:00:00.000Z","event":"db_warmup","pool":"auth","open":2,"ms":40}\n', counter).includes('"open":2'), true);
  assert.equal(appLogLine('{"at":"2026-11-01T10:00:00.000Z","event":"x","nested":{"a":1}}', counter), '{"at":"2026-11-01T10:00:00.000Z","event":"x","nested":"<withheld>"}');
  assert.equal(counter.fields, 1);
  for (const bad of ['Error: connect ECONNREFUSED 1.2.3.4:5432', '    at file:///x.js:1:1', '{"event":"x"}', '{"at":"nope","event":"x"}', '{"at":"2026-11-01T10:00:00.000Z","event":"Bad Event"}', '[]', '']) {
    assert.equal(appLogLine(bad), null, bad);
  }
  assert.equal(appLogLine('ConfigError: KEY_LINKS: is required'), 'ConfigError: KEY_LINKS: is required');
  assert.equal(appLogLine('ConfigError: DATABASE_URL: must be a postgres:// URL'), 'ConfigError: DATABASE_URL: must be a postgres:// URL');
  assert.equal(appLogLine('ConfigError: KEY_LINKS: is required and then some secret text'), null);
});

function sink() {
  const chunks = [];
  const w = new PassThrough();
  w.on('data', (c) => chunks.push(c.toString('utf8')));
  return { stream: w, text: () => chunks.join('') };
}

test('a fake app runs on a localhost-only environment; its log lines pass with every secret masked and nothing else leaks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    mkdirSync(join(dir, 'dist-server'));
    writeFileSync(join(dir, 'dist-server', 'main.js'), [
      'const e = process.env;',
      "const log = (event, f) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...f }) + '\\n');",
      "log('listening', { port: Number(e.PORT), host: e.HOST, mode: e.EMAIL_MODE, origin: e.APP_ORIGIN });",
      "log('leaky', { note: 'url ' + e.DATABASE_URL + ' key ' + e.KEY_SESSIONS });",
      "log('env_names', { count: Object.keys(e).length, hasEmailKeys: Boolean(e.SENDGRID_API_KEY) });",
      "log('has_token', { token: Boolean(e.DOPPLER_TOKEN || e.STAGING_DB_URL) });",
      "process.stderr.write('Error: connect failed for ' + e.DATABASE_URL + '\\n');",
      "console.log('plain text with ' + e.KEY_LINKS);",
      'process.exit(3);',
    ].join('\n'));
    const out = sink();
    const err = sink();
    const code = await main({ argv: ['--port', '9100'], env: goodEnv(), stdout: out.stream, stderr: err.stream, appDir: dir });
    assert.equal(code, 3);
    const text = out.text() + err.text();
    for (const secret of ['Fake-Pw-Zz9981-only', K1, K2, K3, `recruiter_app.${STG2}`, 'dp.st.should-not-pass', 'aws-0-us-east-2.pooler.supabase.com']) {
      assert.ok(!text.includes(secret), `output must not contain a secret (${secret.slice(0, 6)}...)`);
    }
    assert.match(text, /"event":"listening","port":9100,"host":"127\.0\.0\.1","mode":"test","origin":"http:\/\/localhost:9100"/);
    assert.match(text, /"event":"leaky","note":"url <masked> key <masked>"/);
    assert.match(text, /"has_token":|"token":false/);
    assert.ok(!text.includes('DOPPLER_TOKEN') && !text.includes('STAGING_DB_URL'));
    assert.ok(!text.includes('plain text') && !text.includes('connect failed'));
    assert.match(text, /exit code 3; 2 output line\(s\) withheld; 0 field\(s\) withheld/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to start (before any child) when the app is not built or a guard fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    await assert.rejects(main({ argv: [], env: goodEnv(), stdout: sink().stream, stderr: sink().stream, appDir: dir }), /not built/);
    await assert.rejects(main({ argv: [], env: { ...goodEnv(), EMAIL_MODE: 'production' }, stdout: sink().stream, stderr: sink().stream, appDir: dir }), /EMAIL_MODE must be test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
