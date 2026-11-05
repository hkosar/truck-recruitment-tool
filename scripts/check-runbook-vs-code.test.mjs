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

test('a .md citation under a real top-level folder is checked; thr_ notes and bare names are INFO only', () => {
  mkdirSync(join(root, 'docs/build-plan'), { recursive: true });
  writeFileSync(join(root, 'docs/build-plan/14-design.md'), 'one\ntwo\n');
  const info = [];
  assert.deepEqual(checkRunbook('see docs/build-plan/14-desing.md:1\n', { root, info }).map((f) => f.split(' ')[0]), ['CITATION']); // typo
  assert.deepEqual(checkRunbook('see docs/14-design.md:1\n', { root, info }).map((f) => f.split(' ')[0]), ['CITATION']); // wrong folder
  assert.deepEqual(checkRunbook('see docs/build-plan/14-design.md:2\n', { root, info }), []);
  assert.deepEqual(info, []);
  assert.deepEqual(checkRunbook('see thr_abc123/note.md:5 and handoff.md:3\n', { root, info }), []);
  assert.equal(info.length, 2);
});

test('./, wrong-case, backslash and partial-folder forms of a repo path are checked; thr_ stays INFO', () => {
  mkdirSync(join(root, 'docs/build-plan'), { recursive: true });
  writeFileSync(join(root, 'docs/build-plan/14-design.md'), 'one\ntwo\n');
  const info = [];
  const k = (md) => checkRunbook(md, { root, info }).map((f) => f.split(' ')[0]);
  for (const bad of ['./docs/build-plan/14-desing.md:1', 'Docs/build-plan/14-desing.md:1', 'docs\\build-plan\\14-desing.md:1', 'build-plan/14-desing.md:1']) {
    assert.deepEqual(k(`see ${bad}\n`), ['CITATION'], bad);
  }
  assert.deepEqual(k('see Docs/build-plan/14-design.md:2\n'), ['CITATION']); // exact case does not exist
  assert.deepEqual(k('see ./docs/build-plan/14-design.md:2\n'), []);
  assert.deepEqual(k('see ./docs/build-plan/14-design.md:99\n'), ['CITATION']);
  assert.deepEqual(k('see docs\\build-plan\\14-design.md:2\n'), []);
  assert.deepEqual(k('see build-plan/14-design.md:2\n'), []);
  assert.deepEqual(info, []);
  assert.deepEqual(k('see thr_abc123/docs/x.md:1\n'), []);
  assert.equal(info.length, 1);
});

test('a missing non-.md file outside the top-level folders is a finding', () => {
  assert.deepEqual(kinds('see foo/bar/nothere.mjs:1\n'), ['CITATION']);
});

test('a non-.md thr_ citation is INFO only', () => {
  const info = [];
  assert.deepEqual(checkRunbook('see thr_abc123/out.json:3 and thr_abc123/scripts/nothere.mjs:1\n', { root, info }), []);
  assert.equal(info.length, 2);
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
  assert.deepEqual(kinds('PASS: `EVENT zzonlytestword`\n'), ['EXPECTED']);
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
  assert.match(r.stdout, /^SUMMARY findings=0 info=1$/m);
});

test('Windows drive paths: inside the checked folder they are repo paths, anywhere else INFO', () => {
  mkdirSync(join(root, 'docs/build-plan'), { recursive: true });
  writeFileSync(join(root, 'docs/build-plan/14-design.md'), 'one\ntwo\n');
  const fwd = root.replace(/\\/g, '/');
  const bs = fwd.replace(/\//g, '\\');
  const info = [];
  const k = (md) => checkRunbook(md, { root, info }).map((f) => f.split(' ')[0]);
  for (const base of [bs, fwd, bs.toLowerCase()]) {
    const sep = base.includes('\\') ? '\\' : '/';
    assert.deepEqual(k(`see ${base}${sep}docs${sep}build-plan${sep}14-design.md:2\n`), [], base);
    assert.deepEqual(k(`see ${base}${sep}docs${sep}build-plan${sep}14-design.md:99\n`), ['CITATION'], base);
    assert.deepEqual(k(`see ${base}${sep}scripts${sep}nothere.mjs:1\n`), ['CITATION'], base);
  }
  assert.deepEqual(info, []);
  // a citation never starts in the middle of a path after a backslash: a UNC path is not read at all (no finding, no INFO)
  assert.deepEqual(k('see \\\\srv\\share\\scripts\\nothere.mjs:1\n'), []);
  assert.deepEqual(info, []);
  for (const outside of ['C:\\Users\\hunte\\.bb\\thread-storage\\thr_x\\note.md:5', 'C:/Users/hunte/.bb/thread-storage/thr_x/note.md:5', 'D:\\other\\scripts\\nothere.mjs:1', 'C:/other/scripts/nothere.mjs:1']) {
    info.length = 0;
    assert.deepEqual(k(`see ${outside}\n`), [], outside);
    assert.equal(info.length, 1, outside);
    assert.match(info[0], /^OUTSIDE-REPO line=1 /, outside);
  }
  info.length = 0;
  assert.deepEqual(k(`see (${bs}x\\docs\\build-plan\\14-design.md:2)\n`), [], 'a sibling folder with the same prefix is outside');
  assert.equal(info.length, 1);
  // a code file in a sibling: if the sibling counted as inside this would be a CITATION finding
  info.length = 0;
  assert.deepEqual(k(`see ${bs}-old\\scripts\\nothere.mjs:1 and ${fwd}x/scripts/nothere.mjs:1\n`), []);
  assert.equal(info.length, 2);
});

test('a drive path inside the checked folder is never an unknown-folder INFO: a missing file is a finding; . and .. are normalised', () => {
  mkdirSync(join(root, 'docs/build-plan'), { recursive: true });
  writeFileSync(join(root, 'docs/build-plan/14-design.md'), 'one\ntwo\n');
  writeFileSync(join(root, 'README.md'), 'r\n');
  const fwd = root.replace(/\\/g, '/');
  const bs = fwd.replace(/\//g, '\\');
  const info = [];
  const k = (md) => checkRunbook(md, { root, info }).map((f) => f.split(' ')[0]);
  for (const base of [bs, fwd]) {
    const s = base.includes('\\') ? '\\' : '/';
    for (const bad of [`doc${s}build-plan${s}14-design.md:2`, `READNE.md:3`, `notes${s}x.md:1`, `.${s}docs${s}build-plan${s}14-desing.md:1`, `docs${s}.${s}build-plan${s}14-desing.md:1`]) {
      assert.deepEqual(k(`see ${base}${s}${bad}\n`), ['CITATION'], `${base}${s}${bad}`);
    }
    assert.deepEqual(k(`see ${base}${s}.${s}docs${s}build-plan${s}14-design.md:2\n`), [], 'real file behind a . segment');
    assert.deepEqual(k(`see ${base}${s}.${s}docs${s}build-plan${s}14-design.md:99\n`), ['CITATION'], 'real file behind a . segment, wrong line');
    assert.deepEqual(k(`see ${base}${s}README.md:1\n`), []);
    assert.deepEqual(k(`see ${base}${s}docs${s}..${s}docs${s}build-plan${s}14-design.md:2\n`), [], '.. that stays inside is resolved');
    assert.deepEqual(k(`see ${base}${s}docs${s}..${s}docs${s}build-plan${s}14-desing.md:2\n`), ['CITATION'], '.. that stays inside, typo');
  }
  assert.deepEqual(info, []);
  // a path that climbs out of the repo after normalising is INFO, like ../ in a relative path
  assert.deepEqual(k(`see ${bs}\\..\\other\\scripts\\nothere.mjs:1 and ${fwd}/../x/note.md:2 and C:/../x/note.md:1\n`), []);
  assert.equal(info.length, 3);
});

test('a full drive path into the repo must be the exact repo-relative file: no suffix matching', () => {
  mkdirSync(join(root, 'docs/build-plan'), { recursive: true });
  mkdirSync(join(root, 'pipeline/src'), { recursive: true });
  writeFileSync(join(root, 'docs/build-plan/14-design.md'), 'one\ntwo\n');
  const fwd = root.replace(/\\/g, '/');
  const bs = fwd.replace(/\//g, '\\');
  const info = [];
  const k = (md) => checkRunbook(md, { root, info }).map((f) => f.split(' ')[0]);
  for (const base of [bs, fwd]) {
    const s = base.includes('\\') ? '\\' : '/';
    for (const bad of [`build-plan${s}14-design.md:2`, `14-design.md:2`, `src${s}refusals.ts:1`, `refusals.ts:1`]) {
      assert.deepEqual(k(`see ${base}${s}${bad}\n`), ['CITATION'], `${base}${s}${bad}`);
    }
    assert.deepEqual(k(`see ${base}${s}docs${s}build-plan${s}14-design.md:2\n`), [], 'correct full path still passes');
    assert.deepEqual(k(`see ${base}${s}pipeline${s}src${s}refusals.ts:1\n`), [], 'correct full path still passes');
  }
  assert.deepEqual(k('see build-plan/14-design.md:2 and refusals.ts:1\n'), [], 'short relative paths still suffix-match');
  assert.deepEqual(info, []);
});

test('../ citations stay INFO; the repo-folder rule uses the first two folder levels and ignores case', () => {
  const info = [];
  const k = (md) => checkRunbook(md, { root, info }).map((f) => f.split(' ')[0]);
  assert.deepEqual(k('see ../docs/build-plan/14-desing.md:1 and ../x/note.md:2\n'), []);
  assert.equal(info.length, 2);
  // second-level folder (build-plan) counts, case-insensitively; a third-level folder name does not
  mkdirSync(join(root, 'docs/build-plan/deep'), { recursive: true });
  writeFileSync(join(root, 'docs/build-plan/deep/z.md'), 'z\n');
  info.length = 0;
  assert.deepEqual(k('see BUILD-PLAN/nothere.md:1\n'), ['CITATION']);
  assert.deepEqual(k('see deep/nothere.md:1\n'), []);
  assert.equal(info.length, 1);
  mkdirSync(join(root, 'MixedDir'), { recursive: true }); // repo folder names are lower-cased too
  writeFileSync(join(root, 'MixedDir/a.md'), 'a\n');
  assert.deepEqual(k('see mixeddir/nothere.md:1\n'), ['CITATION']);
});

// A checked folder whose own path has spaces (or the text SPACE_0x20_) is matched as a whole; no text of a citation is ever rewritten.
const SENT = 'SPACE_0x20_';
function withRoot(name, files, fn) {
  const base = mkdtempSync(join(tmpdir(), 'runbook-check-sp-'));
  const r = join(base, name);
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(r, f, '..'), { recursive: true }); writeFileSync(join(r, f), body); }
  try { fn(r); } finally { rmSync(base, { recursive: true, force: true }); }
}
const spKinds = (md, r, info = []) => checkRunbook(md, { root: r, info }).map((f) => f.split(' ')[0]);

test('spaced checked root: absolute citations match with either slash and any case; sibling and mid-token roots do not', () => {
  withRoot('checked root', { 'scripts/plain.mjs': 'a\nb\n', 'docs/n.md': 'x\n' }, (r) => {
    const fwd = r.replace(/\\/g, '/');
    const bs = fwd.replace(/\//g, '\\');
    for (const [base, s] of [[fwd, '/'], [bs, '\\'], [fwd.toUpperCase(), '/']]) {
      assert.deepEqual(spKinds(`see ${base}${s}scripts${s}plain.mjs:2\n`, r), [], base);
      assert.deepEqual(spKinds(`see ${base}${s}scripts${s}plain.mjs:99\n`, r), ['CITATION'], base);
      assert.deepEqual(spKinds(`see ${base}${s}scripts${s}gone.mjs:1\n`, r), ['CITATION'], base);
    }
    const info = [];
    assert.deepEqual(spKinds(`see ${fwd}x/scripts/plain.mjs:1 and ${fwd}-old/scripts/gone.mjs:1\n`, r, info), [], 'sibling folders are outside');
    assert.equal(info.length, 2);
  });
});

test('a file literally named with the sentinel is found, not rewritten', () => {
  for (const name of ['checked root', 'checkedroot']) {
    withRoot(name, { [`scripts/literal${SENT}file.mjs`]: 'one\n' }, (r) => {
      assert.deepEqual(spKinds(`see scripts/literal${SENT}file.mjs:1\n`, r), [], name);
    });
  }
});

test('a missing sentinel-named file is not satisfied by its de-sentinelled twin', () => {
  for (const name of ['checked root', 'checkedroot']) {
    withRoot(name, { 'scripts/hidden file.mjs': 'one\n', 'scripts/other.mjs': 'one\n' }, (r) => {
      assert.deepEqual(spKinds(`see scripts/hidden${SENT}file.mjs:1\n`, r), ['CITATION'], name);
    });
  }
});

test('a checked root that itself contains the sentinel keeps its text (spaced or not)', () => {
  for (const name of [`checked${SENT}root`, `checked root${SENT}x`]) {
    withRoot(name, { 'scripts/plain.mjs': 'a\nb\n' }, (r) => {
      const fwd = r.replace(/\\/g, '/');
      assert.deepEqual(spKinds(`see ${fwd}/scripts/plain.mjs:2\n`, r), [], name);
      assert.deepEqual(spKinds(`see ${fwd}/scripts/plain.mjs:99\n`, r), ['CITATION'], name);
    });
  }
});

// Path matrix: checked-root spelling x slash style x case x tail. Outcomes: ok = no finding, no info; miss = CITATION finding; outside = no finding, one INFO.
const MATRIX_TAILS = [
  ['', 'scripts/plain.mjs:2', 'ok'],
  ['', 'scripts/plain.mjs:99', 'miss'],
  ['', 'scripts/gone.mjs:1', 'miss'],
  ['x', 'scripts/gone.mjs:1', 'outside'],
  ['-old', 'scripts/gone.mjs:1', 'outside'],
  ['.old', 'scripts/gone.mjs:1', 'outside'],
];
const MATRIX_ROOTS = ['plainroot', 'spaced root', 'meta (a+b) [c] $d ^e.f', 'meta.x'];

test('path matrix: root with/without spaces and regex metacharacters x slash x case x sibling folder', () => {
  for (const name of MATRIX_ROOTS) {
    withRoot(name, { 'scripts/plain.mjs': 'a\nb\n' }, (r) => {
      const fwd = r.replace(/\\/g, '/');
      const bs = fwd.replace(/\//g, '\\');
      for (const [spell, s] of [[fwd, '/'], [bs, '\\'], [fwd.toUpperCase(), '/'], [bs.toLowerCase(), '\\']]) {
        for (const [suffix, tail, want] of MATRIX_TAILS) {
          const info = [];
          const got = spKinds(`see ${spell}${suffix}${s}${tail.replace(/\//g, s)}\n`, r, info);
          const label = `${name} | ${spell}${suffix} | ${tail} -> ${want}`;
          assert.deepEqual(got, want === 'miss' ? ['CITATION'] : [], label);
          assert.equal(info.length, want === 'outside' ? 1 : 0, label);
        }
      }
    });
  }
});

test('the checked root appearing mid-token is not a repo citation', () => {
  for (const name of ['checked root', 'checkedroot']) {
    withRoot(name, { 'scripts/plain.mjs': 'a\nb\n' }, (r) => {
      const fwd = r.replace(/\\/g, '/');
      const bs = fwd.replace(/\//g, '\\');
      assert.deepEqual(spKinds(`see x${bs}\\f.md:1 and x${fwd}/f.md:1\n`, r), [], name);
    });
  }
});

test('spaced checked root mid-token with a code-file tail is not a repo citation', () => {
  withRoot('checked root', { 'scripts/plain.mjs': 'a\nb\n' }, (r) => {
    const fwd = r.replace(/\\/g, '/');
    assert.deepEqual(spKinds(`see prefix${fwd}/scripts/missing.mjs:1\n`, r), []);
  });
});

test('unspaced checked root containing + $ ^ , & = # % [ ] ( ) in the middle of its name is matched as a whole root', () => {
  withRoot('meta+nospace$^(x)[1]y', { 'scripts/plain.mjs': 'a\nb\n' }, (r) => {
    const fwd = r.replace(/\\/g, '/');
    assert.deepEqual(spKinds(`see ${fwd}/scripts/plain.mjs:2\n`, r), []);
  });
});
test('cleanup', () => { rmSync(root, { recursive: true, force: true }); });
