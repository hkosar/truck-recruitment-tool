// Offline subprocess tests of the real executable and wrapper. pg is replaced before the runner loads;
// socket connects are prohibited. Connection strings below are synthetic planner inputs only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { REPOSITORY_ROOT } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';
import { FIRST_MANAGER_CREATE_CONFIRMATION } from './first-manager-bootstrap.js';

const self = fileURLToPath(import.meta.url);
const tsx = resolve(REPOSITORY_ROOT, 'pipeline/node_modules/tsx/dist/cli.mjs');
const fixture = process.argv.find((arg) => arg.startsWith('--fixture='))?.slice('--fixture='.length);

async function runFixture(scenario: string): Promise<void> {
  Socket.prototype.connect = (() => { throw new Error('test prohibits network connections'); }) as typeof Socket.prototype.connect;
  let wrote = false;
  let audited = false;
  let commits = 0;
  let rollbacks = 0;
  let lateEvent = false;
  process.once('beforeExit', () => {
    assert.equal(commits, scenario === 'drop' ? 0 : 1, 'COMMIT is never retried');
    if (scenario !== 'rollback-tag') assert.equal(rollbacks, scenario === 'drop' ? 1 : 0, 'unknown COMMIT is never rolled back');
    else assert.ok(rollbacks <= 1, 'a definite rollback is never retried');
    assert.equal(lateEvent, scenario === 'localized-late', 'late client error event was observed');
  });
  const lost = Object.assign(new Error('synthetic localized connection failure'), { code: 'ZZ999', severity: 'FATALER FEHLER' });
  class FakeClient extends EventEmitter {
    async connect() { assert.equal(this.listenerCount('error'), 1); }
    async end() {
      // pg can emit the connection error after the query rejection has reached the runner.
      await new Promise((done) => setImmediate(done));
      if (scenario === 'drop') throw new Error('synthetic close failure');
    }
    async query(sql: string) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text === 'commit') {
        commits += 1;
        if (scenario.startsWith('localized-')) {
          if (scenario === 'localized-before') this.emit('error', lost);
          else setImmediate(() => { lateEvent = true; this.emit('error', lost); });
          throw lost;
        }
        return { command: scenario === 'rollback-tag' ? 'ROLLBACK' : 'COMMIT', rows: [], rowCount: null };
      }
      if (text === 'rollback') { rollbacks += 1; if (scenario === 'drop') throw lost; return { command: 'ROLLBACK', rows: [], rowCount: null }; }
      if (text.includes("to_regclass('internal.roster_lock')")) return { rows: [{ m1_tables: true, m1_sign_in_functions: true, m1b_function: true, account_link_present: false }] };
      if (text === 'select count(*)::int as n from internal.roster_lock') return { rows: [{ n: 1 }] };
      if (text === 'select 1 from internal.roster_lock for update') return { rows: [{}], rowCount: 1 };
      if (text.includes('as profiles_total')) return { rows: [{ profiles_total: Number(wrote), managers: Number(wrote), email_profiles: Number(wrote), email_exact_lower: Number(wrote), email_pristine_guest: 0, owner_manager_self_approved: Number(wrote), email_blocked: 0, bootstrap_events: Number(audited) }] };
      if (text.startsWith('with n as')) {
        if (scenario === 'drop') { this.emit('error', lost); throw lost; }
        wrote = true;
        return { rows: [{ id: 'test-profile' }], rowCount: 1 };
      }
      if (text.startsWith('insert into internal.auth_events')) audited = true;
      if (text.includes('internal.auth_mint_lock(')) return { rows: [{ user_id: 'test-profile' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  }
  pg.Client = FakeClient as unknown as typeof pg.Client;
  // The --from-env wrapper input is deliberately unused; the fixture supplies its own synthetic planner input.
  process.env.STAGING_DB_URL = `postgresql://postgres.${RECORDED_PROJECT_REFS.stagingRebuilt}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  delete process.env.PRODUCTION_DB_URL;
  const runner = resolve(REPOSITORY_ROOT, 'pipeline/src/first-manager-runner.ts');
  process.argv = [process.execPath, runner, '--target=staging', '--action=first-manager-create', `--confirm=${FIRST_MANAGER_CREATE_CONFIRMATION.staging}`, '--execute'];
  await import(pathToFileURL(runner).href);
}

const sink = () => {
  const stream = new PassThrough();
  let output = '';
  stream.on('data', (chunk) => { output += chunk.toString(); });
  return { stream, text: () => output };
};
const events = (output: string) => output.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
const childArgs = (scenario: string) => [tsx, self, `--fixture=${scenario}`];
const childEnv = () => ({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' });

export async function testFirstManagerFailures(): Promise<void> {
  const failures: string[] = [];
  const check = async (name: string, body: () => void | Promise<void>) => {
    try { await body(); console.log(`PASS ${name}`); }
    catch (err) { failures.push(name); console.error(`FAIL ${name}\n${String(err)}`); }
  };
  const wrapper = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
  for (const scenario of ['drop', 'localized-before', 'localized-late', 'rollback-tag']) {
    await check(`failure executable: ${scenario}`, () => {
      const child = spawnSync(process.execPath, childArgs(scenario), { cwd: REPOSITORY_ROOT, env: childEnv(), encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 1, child.stdout + child.stderr);
      const all = events(child.stdout + child.stderr);
      const results = all.filter((event) => event.msg === 'first-manager.result');
      assert.deepEqual(results.map((event) => event.result), [scenario.startsWith('localized-') ? 'unknown' : scenario === 'drop' ? 'rollback_not_confirmed' : 'rolled_back']);
      assert.equal(all.some((event) => event.msg === 'first-manager.done'), false);
      assert.equal(all.some((event) => event.msg === 'first-manager.refused'), !scenario.startsWith('localized-'), 'unknown COMMIT must never be called refused');
      if (scenario === 'rollback-tag') assert.equal(all.find((event) => event.msg === 'first-manager.refused')?.refusal, 'first_manager_refused');
      for (const stream of [child.stdout, child.stderr]) {
        const counter = { fields: 0 };
        const lines = stream.trim() ? stream.trim().split(/\r?\n/) : [];
        assert.equal(lines.filter((line) => wrapper.allowListLine(line, counter) === null).length, 0, 'both streams: 0 withheld lines');
        assert.equal(counter.fields, 0, 'both streams: 0 withheld fields');
      }
    });
    await check(`failure wrapper: ${scenario}; both streams, 0 withheld lines and 0 withheld fields`, async () => {
      const out = sink(); const err = sink();
      const code = await wrapper.main({ argv: ['--from-env', '--secret', 'STAGING_DB_URL', '--cwd', REPOSITORY_ROOT, '--', 'node', ...childArgs(scenario)], env: { ...childEnv(), DOPPLER_PROJECT: 'truck-recruitment-tool', DOPPLER_CONFIG: 'stg', STAGING_DB_URL: 'unused-synthetic-input' }, stdout: out.stream, stderr: err.stream });
      assert.equal(code, 1);
      assert.match(out.text(), /exit code 1; 0 output line\(s\) withheld; 0 field\(s\) withheld/);
      const all = events(out.text() + err.text());
      assert.deepEqual(all.filter((event) => event.msg === 'first-manager.result').map((event) => event.result), [scenario.startsWith('localized-') ? 'unknown' : scenario === 'drop' ? 'rollback_not_confirmed' : 'rolled_back']);
      assert.equal(all.some((event) => event.msg === 'first-manager.refused'), !scenario.startsWith('localized-'));
    });
  }
  assert.deepEqual(failures, [], 'first-manager failure regressions');
}

if (fixture) await runFixture(fixture);
else if (process.argv[1] && resolve(process.argv[1]) === self) await testFirstManagerFailures();
