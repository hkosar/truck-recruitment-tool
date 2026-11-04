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
writeFileSync(join(root, 'pipeline/src/role-password.ts'), [
  'export const ROLE_PASSWORD_ACTIONS = {',
  "  'set-app-password': { role: 'recruiter_app', passwordVariable: 'X', confirmation: 'SET APP PW' },",
  '} as const;',
  '',
].join('\n'));
writeFileSync(join(root, 'scripts/only-in.test.mjs'), "// zzonlytestword appears only in a test file\n");
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

test('role-password actions: the phrase must be that action\'s phrase', () => {
  assert.deepEqual(kinds("`--action=set-app-password '--confirm=SET APP PW'`\n"), []);
  assert.deepEqual(kinds("`--action=set-app-password '--confirm=APPLY TNBS M1'`\n"), ['CONFIRM']);
});

test('citation line 0 is flagged', () => {
  assert.deepEqual(kinds('see scripts/probe.mjs:0\n'), ['CITATION']);
});

test('citations of files outside the repo are INFO, not findings', () => {
  const info = [];
  const md = 'notes thr_i5azang2ic/owner-step11.md:50; handoff-2026-11-04.md:43\nbut scripts/nothere.mjs:1 is still a finding\n';
  const out = checkRunbook(md, { root, info });
  assert.equal(out.length, 1);
  assert.match(out[0], /^CITATION line=2 /);
  assert.equal(info.length, 2);
  assert.match(info[0], /^OUTSIDE-REPO line=1 .*thr_i5azang2ic\/owner-step11\.md/);
  assert.match(info[1], /^OUTSIDE-REPO line=1 .*handoff-2026-11-04\.md/);
  assert.deepEqual(checkRunbook(md.split('\n')[0], { root }), []); // works without an info array
});

test('a bold or "Expected output" heading starts an expected block too', () => {
  const bad = (h) => `${h}\n\`\`\`\nWIBBLE gone=yes\n\`\`\`\n`;
  for (const h of ['**Expected:**', '**Expected**:', 'Expected output:', '__Expected__', 'Expected']) assert.deepEqual(kinds(bad(h)), ['EXPECTED'], h);
  assert.deepEqual(kinds('Expected results are fine\n```\nWIBBLE gone=yes\n```\n'), []);
});

test('the pair check is skipped when the registry files are absent', () => {
  const empty = mkdtempSync(join(tmpdir(), 'runbook-check-empty-'));
  try {
    mkdirSync(join(empty, 'scripts'));
    writeFileSync(join(empty, 'scripts/a.mjs'), "const a = ['apply-m1', 'APPLY TNBS M1', 'OTHER PHRASE'];\n");
    assert.deepEqual(checkRunbook("`--action=apply-m1 '--confirm=OTHER PHRASE'`\n", { root: empty }), []);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('words that only occur in test files do not count; bare refusal spans inside fences are not checked', () => {
  assert.deepEqual(kinds('PASS: `SUMMARY zzonlytestword=<n>`\n'), ['EXPECTED']);
  assert.deepEqual(kinds('```\nA refusal `plan_refusd` happens.\n```\n'), []);
});

test('git mode works from any folder; an internal crash exits 3, not 1', () => {
  const script = fileURLToPath(new URL('./check-runbook-vs-code.mjs', import.meta.url));
  const md = join(root, 'nothing.md');
  writeFileSync(md, 'Nothing to check.\n');
  for (const cwd of [fileURLToPath(new URL('.', import.meta.url)), tmpdir()]) {
    const r = spawnSync(process.execPath, [script, md], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `cwd ${cwd}: ${r.stderr}`);
    assert.match(r.stdout, /SUMMARY findings=0/);
  }
  const crash = spawnSync(process.execPath, [script, md], { encoding: 'utf8', env: { ...process.env, GIT_DIR: join(root, 'no-such-git-dir') } });
  assert.equal(crash.status, 3);
  assert.match(crash.stderr, /INTERNAL ERROR/);
  assert.doesNotMatch(crash.stdout, /FINDING/);
});

test('command line prints INFO lines without changing the exit code', () => {
  const script = fileURLToPath(new URL('./check-runbook-vs-code.mjs', import.meta.url));
  const md = join(root, 'info.md');
  writeFileSync(md, 'see thr_abc123/note.md:5\n');
  const r = spawnSync(process.execPath, [script, md, '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^INFO OUTSIDE-REPO line=1 /m);
});

test('cleanup',() => { rmSync(root, { recursive: true, force: true }); });
