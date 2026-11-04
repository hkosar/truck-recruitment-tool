import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRunbook } from './check-runbook-vs-code.mjs';

const root = mkdtempSync(join(tmpdir(), 'runbook-check-'));
mkdirSync(join(root, 'pipeline', 'src'), { recursive: true });
mkdirSync(join(root, 'scripts'), { recursive: true });
writeFileSync(join(root, 'pipeline/src/refusals.ts'), "export const REFUSAL_IDS = [\n  'plan_refused',\n  'db_tls_refused',\n] as const;\n");
writeFileSync(join(root, 'pipeline/src/staging-rebuilt.ts'), [
  'export const ACTIONS = {',
  "  'apply-m1': { kind: 'file', file: 'x.sql', confirmation: 'APPLY TNBS M1', pinned: false },",
  "  'window-on': {",
  '    kind: \'inline\',',
  "    confirmation: 'TURN ON WINDOW',",
  '  },',
  '};',
  "log({ msg: 'staging-sql.done', action });",
  '',
].join('\n'));
writeFileSync(join(root, 'scripts/probe.mjs'), [
  'emit(`EVENT probe=${name} expected=recorded observed=${o} result=${r}`);',
  "emit('EVENT probe=x expected=n/a observed=none result=SKIPPED');",
  "emit('result=PASS');",
  '',
].join('\n'));

const kinds = (md) => checkRunbook(md, { root }).map((f) => f.split(' ')[0]).filter((k) => k !== 'UNMENTIONED');

test('a good runbook has no findings', () => {
  const md = [
    '# Runbook',
    'Run `--action=apply-m1 --confirm=APPLY TNBS M1` then check.',
    'Tool at pipeline/src/staging-rebuilt.ts:1-8 and scripts/probe.mjs:1-3.',
    'PASS: `{"msg":"staging-sql.done","action":"apply-m1"}`; `EVENT probe=<name> expected=recorded observed=<class> result=PASS`; SKIPPED is allowed when no bucket.',
    'STOP on `{"msg":"x","refusal":"plan_refused"}` or `db_tls_refused` refusal.',
    '',
  ].join('\n');
  assert.deepEqual(checkRunbook(md, { root }), []);
});

test('unknown refusal ids are flagged, explicit and bare', () => {
  const md = 'STOP `"refusal":"nope_refused"`\nA refusal `plan_refusd` happens.\n';
  assert.deepEqual(kinds(md), ['REFUSAL', 'REFUSAL']);
});

test('unknown action, unknown phrase and mismatched pair are flagged', () => {
  assert.deepEqual(kinds("`--action=apply-m9`\n"), ['ACTION']);
  assert.deepEqual(kinds("`--confirm=APPLY TNBS M9`\n"), ['CONFIRM']);
  assert.deepEqual(kinds("`--action=apply-m1 '--confirm=TURN ON WINDOW'`\n"), ['CONFIRM']);
  assert.deepEqual(kinds("`--action=window-on '--confirm=TURN ON WINDOW' --execute`\n"), []);
});

test('expected: block lines must be in the code', () => {
  const good = 'expected:\n```\nEVENT probe=a expected=recorded result=PASS\n```\n';
  const bad = 'expected:\n```\nEVENT probe=a expected=recorded result=PASS\nWIBBLE gone=yes\n```\n';
  assert.deepEqual(kinds(good), []);
  assert.deepEqual(kinds(bad), ['EXPECTED']);
});

test('existing-style PASS spans must be in the code', () => {
  assert.deepEqual(kinds('PASS: `{"msg":"staging-sql.missing"}`\n'), ['EXPECTED']);
  assert.deepEqual(kinds('PASS: `{"msg":"staging-sql.done","bogus_key":1}`\n'), ['EXPECTED']);
  assert.deepEqual(kinds('PASS: `SUMMARY zzzzqq=<n>`\n'), ['EXPECTED']);
});

test('citations must name an existing file and line', () => {
  assert.deepEqual(kinds('see scripts/probe.mjs:3 and refusals.ts:1-4, 2\n'), []);
  assert.deepEqual(kinds('see scripts/probe.mjs:4\n'), ['CITATION']);
  assert.deepEqual(kinds('see scripts/nothere.mjs:1\n'), ['CITATION']);
  assert.deepEqual(kinds('see refusals.ts:2-99\n'), ['CITATION']);
  assert.deepEqual(kinds('old code abcdef1:scripts/nothere.mjs:1 and (:406)\n'), []);
});

test('a result= value the cited code prints but the runbook never mentions is flagged', () => {
  const md = 'See scripts/probe.mjs:1. Output has result=PASS lines only. result=RECORDED too.\n';
  const out = checkRunbook(md, { root });
  assert.equal(out.length, 1);
  assert.match(out[0], /^UNMENTIONED .*result=SKIPPED/);
});

test('command line: exit 1 with FINDING lines on a bad runbook, exit 0 on a good one, 2 on bad usage', () => {
  const script = fileURLToPath(new URL('./check-runbook-vs-code.mjs', import.meta.url));
  const bad = join(root, 'bad.md');
  const good = join(root, 'good.md');
  writeFileSync(bad, '`--action=apply-m9`\n');
  writeFileSync(good, 'Nothing to check.\n');
  const rb = spawnSync(process.execPath, [script, bad, '--root', root], { encoding: 'utf8' });
  assert.equal(rb.status, 1);
  assert.match(rb.stdout, /^FINDING ACTION line=1 /m);
  const rg = spawnSync(process.execPath, [script, good, '--root', root], { encoding: 'utf8' });
  assert.equal(rg.status, 0);
  assert.match(rg.stdout, /SUMMARY findings=0/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
});

test('cleanup', () => { rmSync(root, { recursive: true, force: true }); });
