// Tests for scripts/run-app-staging.mjs. Run: node --test scripts/run-app-staging.test.mjs
// Offline: no database, no network, no Doppler. The "app" is a tiny fake script written to a temporary directory.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { APP_BASE_NAMES, APP_LOG_EVENTS, APP_SECRET_NAMES, CONFIG_ERROR_MESSAGES, MIN_MASKABLE_LENGTH, appLogLine, buildAppEnv, launcherMaskTargets, main, maskLine, parseAppArgs, signalAction } from './run-app-staging.mjs';

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
/** A fake built app folder: dist-server/ for the entry the test writes, and dist/index.html (the web pages the server needs). */
const builtApp = (dir) => {
  mkdirSync(join(dir, 'dist-server'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html>');
};

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

const AT0 = '2026-11-01T10:00:00.000Z';
const UUID_A = '0b9d3c1e-5a7f-4c2b-8e6d-1f2a3b4c5d6e';
const UUID_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ev = (event, f = {}) => JSON.stringify({ at: AT0, event, ...f });
/** One line in the exact shape app/server/main.ts consoleLogger prints, for EVERY log(...) call in the app source. */
const REAL_LINES = [
  ev('listening', { port: 8788 }),
  ev('db_warmup', { pool: 'auth', open: 2, ms: 40 }),
  ...['db_pool_acquire_failed', 'db_unavailable_at_start', 'client_ip_unavailable', 'signin_admission_unavailable', 'signin_identity_work_failed', 'provider_rate_limited', 'provider_configuration', 'provider_unreachable'].map((category) => ev('operator_alert', { category })),
  ev('operator_alert', { category: 'db_pool_acquire_failed', pool: 'data' }),
  ev('server_error', { route: 'session' }),
  ev('server_error', { route: '/api/batches/:id/rename' }),
  ev('server_error', { route: '/api/team' }),
  ev('signin_admission_failed'), ev('signin_identity_work_failed'), ev('touch_failed'), ev('unhandled_request_error'),
  ev('signout_revoke_failed', { outcome: 'unknown' }), ev('signout_revoke_failed', { outcome: 'failed' }),
  ev('shutdown_started', { accepted: 3, continuations: 1, budgetMs: 45000 }),
  ev('shutdown', { abandoned: 0 }),
  ev('batch_renamed', { batch: UUID_A, actor: UUID_B }), ev('batch_deleted', { batch: UUID_A, actor: UUID_B }),
];

test('log lines: every real app event passes unchanged with zero withheld; everything else is withheld and counted', () => {
  const counter = { fields: 0 };
  for (const l of REAL_LINES) assert.equal(appLogLine(`${l}\n`, counter), l, l);
  assert.equal(counter.fields, 0);
  assert.equal(appLogLine(`${ev('listening', { port: 8788 })}\r\n`), ev('listening', { port: 8788 }));
  const withheld = [
    ev('x', { a: 1 }), ev('Listening', { port: 1 }), ev('constructor'), ev('__proto__'), // unknown event names
    ev('listening', { port: 8788, extra: 1 }), ev('listening', { port: 8788, host: '127.0.0.1' }), // extra field: the whole line is withheld
    ev('listening', { port: 'x' }), ev('listening', { port: -1 }), ev('listening', { port: 70000 }), ev('listening', { port: 1.5 }), ev('listening', { port: null }), ev('listening', { port: true }),
    ev('listening', { port: { a: 1 } }),
    ev('operator_alert', { category: 'free text here' }), ev('operator_alert', { category: 'db_pool_acquire_failed', pool: 'other' }),
    ev('server_error', { route: '/api/Aaaa1234' }), ev('server_error', { route: '/anything/else' }), ev('server_error', { route: `/api/${'a'.repeat(21)}` }), ev('server_error', { route: '/api/a/a/a/a/a/a' }),
    ev('batch_renamed', { batch: 'not-a-uuid', actor: UUID_B }), ev('batch_renamed', { batch: UUID_A, actor: UUID_B, note: UUID_A }),
    ev('touch_failed', { note: 'anything' }),
    JSON.stringify({ event: 'listening', port: 1 }), JSON.stringify({ at: 'nope', event: 'listening', port: 1 }), JSON.stringify({ at: '2026-11-01 10:00:00', event: 'listening', port: 1 }),
    JSON.stringify({ at: AT0, event: ['listening'], port: 1 }),
    'Error: connect ECONNREFUSED 1.2.3.4:5432', '    at file:///x.js:1:1', '[]', '{}', 'null', '',
  ];
  for (const bad of withheld) assert.equal(appLogLine(bad, { fields: 0 }), null, bad);
  assert.equal(appLogLine('ConfigError: KEY_LINKS: is required'), 'ConfigError: KEY_LINKS: is required');
  assert.equal(appLogLine('ConfigError: DATABASE_URL: must be a postgres:// URL'), 'ConfigError: DATABASE_URL: must be a postgres:// URL');
  assert.equal(appLogLine('ConfigError: KEY_LINKS: is required and then some secret text'), null);
});

test('the allow-list has no free-text field: only enums, bounded integers and two tight patterns', () => {
  for (const [event, fields] of Object.entries(APP_LOG_EVENTS)) {
    assert.match(event, /^[a-z][a-z0-9_]{0,60}$/);
    for (const [name, spec] of Object.entries(fields)) {
      const kinds = Object.keys(spec);
      assert.equal(kinds.length, 1, `${event}.${name}`);
      if (kinds[0] === 'enum') assert.ok(spec.enum.length > 0 && spec.enum.every((v) => /^[a-z_]{1,40}$/.test(v)), `${event}.${name} enum`);
      else if (kinds[0] === 'int') assert.ok(Number.isInteger(spec.int) && spec.int <= 3_600_000, `${event}.${name} int`);
      else assert.ok(kinds[0] === 'pattern' && ['uuid', 'route'].includes(spec.pattern), `${event}.${name} pattern`);
    }
  }
});

test('finding 3: only the exact fixed config-error messages pass as non-JSON; arbitrary text after "must" is withheld', () => {
  for (const m of CONFIG_ERROR_MESSAGES) {
    assert.equal(appLogLine(m), m);
    assert.equal(appLogLine(`ConfigError: ${m}`), `ConfigError: ${m}`);
  }
  for (const bad of [
    'ConfigError: KEY_LINKS: must contain the value Fake-Pw-Zz9981-only',
    'ConfigError: DATABASE_URL: must be a postgres:// URL (got postgresql://u:pw@host)',
    'KEY_LINKS: must be anything at all here',
    'ConfigError: SOME_NAME: must be a port number',
    'ConfigError: PORT: must be a port number ',
    'ConfigError: KEY_LINKS: the three keys must differ\nextra',
  ]) assert.equal(appLogLine(bad), null, bad);
});

test('finding 2: a database password under 8 characters is refused at start, raw or decoded; 8 is accepted; masking has no length filter', () => {
  const withPw = (pw) => ({ ...goodEnv(), DATABASE_URL: `postgresql://recruiter_app.${STG2}:${pw}@aws-0-us-east-2.pooler.supabase.com:5432/postgres` });
  for (const pw of ['abc', 'abcdefg', 'a%41%42%43%44']) {
    // the last one is 13 characters raw but only 5 decoded: still refused
    refused(withPw(pw), new RegExp(`password is shorter than ${MIN_MASKABLE_LENGTH} characters`));
  }
  refused({ ...goodEnv(), DATABASE_URL: `postgresql://recruiter_app.${STG2}@aws-0-us-east-2.pooler.supabase.com:5432/postgres` }, /./);
  assert.doesNotThrow(() => buildAppEnv(withPw('abcdefgh'), 8788));
  assert.ok(launcherMaskTargets('ab').includes('ab'), 'a 2-character value is still a mask target');
  assert.ok(launcherMaskTargets('x').includes('x'));
  assert.equal(maskLine('note a1 and a1', launcherMaskTargets('a1')), 'note <masked> and <masked>');
});

const NASTY_PW = 'q"u\\oé中\u{1F600}&=/?#%x;+ \tz'; // quote, backslash, accents, CJK, emoji, URL-special characters, a space and a tab
const nastyEnv = () => ({ ...goodEnv(), DATABASE_URL: `postgresql://recruiter_app.${STG2}:${encodeURIComponent(NASTY_PW)}@aws-0-us-east-2.pooler.supabase.com:5432/postgres` });

test('finding 1: the nasty-password URL is accepted by the guards (the reproduction precondition)', () => {
  assert.equal(buildAppEnv(nastyEnv(), 8788).DATABASE_URL, nastyEnv().DATABASE_URL);
});

const b64 = (x) => Buffer.from(x, 'utf8').toString('base64');
const b64url = (x) => Buffer.from(x, 'utf8').toString('base64url');
/** Every spelling of the password a leaking child could print; none may appear in the output. */
function leakForms(pw) {
  const j = JSON.stringify(pw).slice(1, -1);
  const mixedHex = encodeURIComponent(pw).replace(/%[0-9A-F]{2}/g, (m, off) => (off % 2 ? m.toLowerCase() : m));
  return [pw, j, j.replace(/\//g, '\\/'), encodeURIComponent(pw), encodeURIComponent(pw).toLowerCase(), mixedHex, b64(pw), b64url(pw), b64(pw).replace(/=+$/, ''),
    j.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`), '\\u00e9', '\\u4e2d', '\\ud83d\\ude00', 'u\\\\o', 'q\\"u', 'q%22u'];
}

test('finding 1 and review round 3: JSON-escaped, unicode, URL (any hex case), base64, split lines/fields and byte-chunked forms never reach the output (through main)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    builtApp(dir);
    writeFileSync(join(dir, 'dist-server', 'main.js'), [
      'const e = process.env;',
      'const pw = decodeURIComponent(new URL(e.DATABASE_URL).password);',
      'const at = new Date().toISOString();',
      "const asciiOnly = (s) => s.replace(/[^\\x20-\\x7e]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));",
      "const line = (event, obj) => process.stdout.write(JSON.stringify({ at, event, ...obj }) + '\\n');",
      'const enc = encodeURIComponent(pw);',
      "line('probe', { note: pw });",
      "line('probe', { note: 'x' + pw + 'y', other: enc });",
      "line('probe', { note: e.DATABASE_URL });",
      "line('operator_alert', { category: pw });",
      "line('listening', { port: 9100, note: pw });",
      "process.stdout.write(asciiOnly(JSON.stringify({ at, event: 'probe', note: pw })) + '\\n');",
      "process.stdout.write(JSON.stringify({ at, event: 'probe', note: pw }).replace(/\\//g, '\\\\/') + '\\n');",
      "process.stdout.write('{\"at\":\"' + at + '\",\"event\":\"probe\",\"note\":\"' + enc.toLowerCase() + '\"}\\n');",
      "const mixed = enc.replace(/%[0-9A-F]{2}/g, (m, i) => (i % 2 ? m.toLowerCase() : m));",
      "line('probe', { note: mixed });",
      "line('server_error', { route: mixed });",
      "line('probe', { note: Buffer.from(pw).toString('base64') });",
      "line('probe', { note: Buffer.from(pw).toString('base64url') });",
      'const h = Math.floor(pw.length / 2);',
      "line('probe', { note: pw.slice(0, h) });",
      "line('probe', { note: pw.slice(h) });",
      "line('probe', { first: pw.slice(0, h), second: pw.slice(h) });",
      "line('probe', { nested: { deep: pw } });",
      "process.stderr.write(JSON.stringify({ at, event: 'probe', note: pw }) + '\\n');",
      "const slow = Buffer.from(JSON.stringify({ at, event: 'probe', note: pw.slice(0, 3) + '\\u00e9\\u4e2d' + pw.slice(3) }) + '\\n');",
      '(async () => {',
      '  for (const b of slow) { process.stdout.write(Buffer.from([b])); await new Promise((r) => setTimeout(r, 1)); }',
      "  line('listening', { port: 9100 });",
      "  line('db_warmup', { pool: 'auth', open: 2, ms: 40 });",
      '})();',
    ].join('\n'));
    const out = sink();
    const err = sink();
    const code = await main({ argv: ['--port', '9100'], env: nastyEnv(), stdout: out.stream, stderr: err.stream, appDir: dir });
    assert.equal(code, 0);
    const text = out.text() + err.text();
    for (const f of leakForms(NASTY_PW)) assert.ok(!text.includes(f), `output must not contain a form of the password: ${JSON.stringify(f).slice(0, 12)}...`);
    for (const form of [NASTY_PW, b64(NASTY_PW), b64url(NASTY_PW), encodeURIComponent(NASTY_PW)]) {
      for (let i = 0; i + 8 <= form.length; i += 1) assert.ok(!text.includes(form.slice(i, i + 8)), `a fragment of the password reached the output (window ${i})`);
    }
    for (const frag of ['q"u', 'oé', '中😀', 'é']) assert.ok(!text.includes(frag), 'no plaintext fragment (including multibyte) of the password');
    const shown = text.split('\n').filter((x) => x.startsWith('{'));
    assert.deepEqual(shown.map((l) => JSON.parse(l).event), ['listening', 'db_warmup']);
    assert.ok(!text.includes('probe') && !text.includes('<masked>'));
    assert.ok(!text.includes('Fake') && !text.includes(K1));
    assert.match(text, /exit code 0; \d+ output line\(s\) withheld; \d+ field\(s\) withheld/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('second layer: URL-encoded targets are masked in any mix of upper/lower-case hex digits', () => {
  const t = launcherMaskTargets('abc%def&ghi');
  assert.ok(t.includes('abc%25def%26ghi'));
  for (const spelling of ['abc%25def%26ghi', 'abc%25def%26ghi'.toLowerCase(), 'abc%25def%2' + '6ghi', 'abc%25def%26ghi'.replace('%26', '%26')]) assert.equal(maskLine(`x ${spelling} y`, t), 'x <masked> y');
  const hexy = launcherMaskTargets('p/q:r');
  assert.equal(maskLine('v=p%2fq%3Ar', hexy), 'v=<masked>');
  assert.equal(maskLine('v=p%2Fq%3ar', hexy), 'v=<masked>');
});

test('finding 3 through main: a fabricated config line is withheld and counted, an exact one is shown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    builtApp(dir);
    writeFileSync(join(dir, 'dist-server', 'main.js'), [
      "console.error('ConfigError: KEY_LINKS: must include whatever diagnostic prose the app wrote');",
      "console.error('ConfigError: PORT: must be a port number');",
      'process.exit(1);',
    ].join('\n'));
    const out = sink();
    const err = sink();
    const code = await main({ argv: [], env: goodEnv(), stdout: out.stream, stderr: err.stream, appDir: dir });
    assert.equal(code, 1);
    assert.ok(!(out.text() + err.text()).includes('diagnostic prose'));
    assert.ok(err.text().includes('ConfigError: PORT: must be a port number'));
    assert.match(out.text(), /exit code 1; 1 output line\(s\) withheld; 0 field\(s\) withheld/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sink() {
  const chunks = [];
  const w = new PassThrough();
  w.on('data', (c) => chunks.push(c.toString('utf8')));
  return { stream: w, text: () => chunks.join('') };
}

test('a fake app runs on a localhost-only environment; only allow-listed lines pass, nothing else leaks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    builtApp(dir);
    writeFileSync(join(dir, 'dist-server', 'main.js'), [
      'const e = process.env;',
      "const log = (event, f) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...f }) + '\\n');",
      "log('listening', { port: Number(e.PORT) });",
      "log('operator_alert', { category: 'url ' + e.DATABASE_URL + ' key ' + e.KEY_SESSIONS });",
      "log('db_warmup', { pool: 'auth', open: Object.keys(e).length, ms: 5 });",
      "log('has_token', { token: Boolean(e.DOPPLER_TOKEN || e.STAGING_DB_URL || e.SENDGRID_API_KEY) });",
      "process.stderr.write('Error: connect failed for ' + e.DATABASE_URL + '\\n');",
      "console.log('plain text with ' + e.KEY_LINKS);",
      "log('shutdown', { abandoned: 0 });",
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
    assert.match(text, /"event":"listening","port":9100\}/);
    assert.match(text, /"event":"db_warmup","pool":"auth","open":\d+,"ms":5\}/);
    assert.match(text, /"event":"shutdown","abandoned":0\}/);
    assert.ok(!text.includes('operator_alert') && !text.includes('has_token') && !text.includes('<masked>'));
    assert.ok(!text.includes('DOPPLER_TOKEN') && !text.includes('STAGING_DB_URL'));
    assert.ok(!text.includes('plain text') && !text.includes('connect failed'));
    assert.match(text, /exit code 3; 4 output line\(s\) withheld; 1 field\(s\) withheld/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to start (before any child) when the app is not built or a guard fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    await assert.rejects(main({ argv: [], env: goodEnv(), stdout: sink().stream, stderr: sink().stream, appDir: dir }), /not built/);
    await assert.rejects(main({ argv: [], env: { ...goodEnv(), EMAIL_MODE: 'production' }, stdout: sink().stream, stderr: sink().stream, appDir: dir }), /EMAIL_MODE must be test/);
    // The server bundle alone is not enough: without app/dist the real app crashes at start, so the launcher refuses first.
    mkdirSync(join(dir, 'dist-server'));
    writeFileSync(join(dir, 'dist-server', 'main.js'), "process.stdout.write('started\\n');");
    let started = false;
    await assert.rejects(main({ argv: [], env: goodEnv(), stdout: sink().stream, stderr: sink().stream, appDir: dir, onChild: () => { started = true; } }), /^Error: refusing: app\/dist\/index\.html is not built \(run `npm run build` in app first; this launcher builds and installs nothing\)$/);
    assert.equal(started, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review r3 finding 2: Windows line endings (CRLF) do not hide the exact config-error lines', async () => {
  for (const m of ['KEY_LINKS: must be at least 43 base64url characters (256-bit key)', 'KEY_LINKS: the three keys must differ']) {
    assert.equal(appLogLine(`ConfigError: ${m}\r`), `ConfigError: ${m}`);
    assert.equal(appLogLine(`ConfigError: ${m}\r\n`), `ConfigError: ${m}`);
  }
  assert.equal(appLogLine('ConfigError: PORT: must be a port number\r\r'), null, 'only one trailing CR is removed');
  assert.equal(appLogLine('ConfigError: PORT: must\r be a port number'), null);
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    builtApp(dir);
    // The real failure mode: an uncaught ConfigError printed by Node's crash printer, plus explicit CRLF lines on any platform.
    writeFileSync(join(dir, 'dist-server', 'main.js'), [
      "process.stderr.write('ConfigError: KEY_LINKS: the three keys must differ\\r\\n');",
      "process.stderr.write('ConfigError: KEY_LINKS: must include made-up prose\\r\\n');",
      'class ConfigError extends Error { constructor(v, r) { super(`${v}: ${r}`); this.name = "ConfigError"; } }',
      "throw new ConfigError('KEY_LINKS', 'must be at least 43 base64url characters (256-bit key)');",
    ].join('\n'));
    const out = sink();
    const err = sink();
    const code = await main({ argv: [], env: goodEnv(), stdout: out.stream, stderr: err.stream, appDir: dir });
    assert.equal(code, 1);
    const shown = err.text().split('\n').filter(Boolean);
    assert.deepEqual(shown, ['ConfigError: KEY_LINKS: the three keys must differ', 'ConfigError: KEY_LINKS: must be at least 43 base64url characters (256-bit key)']);
    assert.ok(!err.text().includes('\r') && !err.text().includes('made-up prose'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the database policy refusals of app/server/config.ts are on the exact config-error list', () => {
  for (const m of [
    'DATABASE_URL: must be a postgres:// URL with a host and no query parameters or fragment',
    'DATABASE_URL: a hosted database needs verify-full TLS, and no root certificate is pinned (pipeline/src/supabase-root-ca.ts)',
    'DATABASE_URL: the pinned root certificate is not a valid CA certificate matching its SHA-256 (pipeline/src/supabase-root-ca.ts)',
  ]) {
    assert.ok(CONFIG_ERROR_MESSAGES.includes(m), m);
    assert.equal(appLogLine(`ConfigError: ${m}\r`), `ConfigError: ${m}`);
  }
});

test('Ctrl+C on Windows is left to the app (orderly shutdown); other signals and platforms are forwarded', () => {
  assert.equal(signalAction('win32', 'SIGINT'), 'wait');
  assert.equal(signalAction('win32', 'SIGTERM'), 'forward');
  assert.equal(signalAction('linux', 'SIGINT'), 'forward');
  assert.equal(signalAction('darwin', 'SIGTERM'), 'forward');
});

test('the allow-list holds on its own: with NO masking targets every review reproduction is still withheld', () => {
  const pw = 'Fake-Pw-Zz9981-only';
  const h = Math.floor(pw.length / 2);
  for (const note of [pw, encodeURIComponent(pw), b64(pw), b64url(pw), pw.slice(0, h), pw.slice(h)]) {
    assert.equal(appLogLine(ev('probe', { note }), { fields: 0 }, []), null);
    assert.equal(appLogLine(ev('operator_alert', { category: note }), { fields: 0 }, []), null);
    assert.equal(appLogLine(ev('server_error', { route: note }), { fields: 0 }, []), null);
  }
  assert.equal(appLogLine(ev('probe', { first: pw.slice(0, h), second: pw.slice(h) }), { fields: 0 }, []), null);
});

test('config-error lines are buffered by complete lines: a split or partial line never passes, a whole one does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-app-staging-test-'));
  try {
    builtApp(dir);
    writeFileSync(join(dir, 'dist-server', 'main.js'), [
      "const w = (s) => new Promise((r) => setTimeout(() => { process.stderr.write(s); r(); }, 5));",
      '(async () => {',
      "  await w('ConfigError: PORT: must be'); await w(' a port number\\nConfigError: KEY_LI'); await w('NKS: is required\\n');",
      "  await w('ConfigError: PORT: must be a port number'); await w(' and the rest of a secret\\n');",
      "  await w('ConfigError: PORT: must be a port'); // no newline, ever",
      '})();',
    ].join('\n'));
    const out = sink();
    const err = sink();
    await main({ argv: [], env: goodEnv(), stdout: out.stream, stderr: err.stream, appDir: dir });
    assert.equal(err.text(), 'ConfigError: PORT: must be a port number\nConfigError: KEY_LINKS: is required\n');
    assert.match(out.text(), /2 output line\(s\) withheld/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
