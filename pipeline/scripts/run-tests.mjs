// `npm test` for the pipeline: runs src/smoke-tests.ts first, then every file in TESTS (test-list.mjs) in sorted order, each as its own
// process with the local tsx and the same environment as the caller. The first failure stops the run with that file's exit code (what
// `a && b && c` did). One line per file. Plain Node, no dependencies, no network.
// Before anything runs the discovered pipeline/src/**/*.test.ts files are compared with TESTS + NOT_RUN: any difference is a refusal (exit 2),
// so a renamed, mis-patterned or forgotten test file cannot be skipped silently.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_RUN, SMOKE, TESTS } from './test-list.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REFUSAL_EXIT = 2;

const posix = (p) => p.split('\\').join('/');
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every *.test.ts under <dir>/src, as 'src/...' paths in sorted order (node_modules is never entered). */
export function discoverTests(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.test.ts')) found.push(posix(relative(dir, p)));
    }
  };
  if (existsSync(join(dir, 'src'))) walk(join(dir, 'src'));
  return found.sort(byCodeUnit);
}

/** The problems that make the runner refuse; an empty array means the lists and the disk agree. */
export function checkLists({ dir, smoke, tests, notRun, discovered }) {
  const problems = [];
  const skipped = notRun.map(([f]) => f);
  const listed = [...tests, ...skipped];
  for (const f of new Set(listed.filter((x, i) => listed.indexOf(x) !== i))) problems.push(`${f} is listed more than once (TESTS / NOT_RUN)`);
  for (const f of listed) if (!existsSync(join(dir, f))) problems.push(`${f} is listed but missing from disk`);
  if (!existsSync(join(dir, smoke))) problems.push(`${smoke} (the smoke tests) is missing from disk`);
  for (const f of discovered) if (!listed.includes(f)) problems.push(`${f} exists but is in neither TESTS nor NOT_RUN`);
  const expectedCount = new Set(listed).size;
  if (discovered.length !== expectedCount) problems.push(`found ${discovered.length} *.test.ts files, the lists name ${expectedCount}`);
  for (const [f, why] of notRun) if (!why) problems.push(`${f} is in NOT_RUN without a reason`);
  return problems;
}

/** Runs the plan. Returns the exit code to use. `spawn(file)` runs one file and returns its exit code (default: local tsx). */
export function runAll({ dir, smoke = SMOKE, tests = TESTS, notRun = NOT_RUN, log = console.log, err = console.error, spawn, tsxCli = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs') } = {}) {
  const discovered = discoverTests(dir);
  const problems = checkLists({ dir, smoke, tests, notRun, discovered });
  if (problems.length) {
    err(`refusing to run: the test file lists and pipeline/src disagree (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) err(`  - ${p}`);
    err('Fix pipeline/scripts/test-list.mjs (add the file to TESTS or NOT_RUN, or correct the name).');
    return REFUSAL_EXIT;
  }
  const run = spawn ?? ((file) => {
    const r = spawnSync(process.execPath, [tsxCli, file], { cwd: dir, stdio: 'inherit', env: process.env });
    if (r.error) { err(`could not start ${file}: ${r.error.message}`); return 1; }
    return r.status ?? 1; // killed by a signal: status is null, report a failure
  });
  const plan = [smoke, ...[...tests].sort(byCodeUnit)];
  log(`pipeline tests: ${plan.length} files (${tests.length} listed + smoke); ${notRun.length} not part of npm test`);
  for (const [i, file] of plan.entries()) {
    log(`[${i + 1}/${plan.length}] ${file}`);
    const code = run(file);
    if (code !== 0) {
      err(`FAIL ${file} (exit code ${code}); stopping, ${plan.length - i - 1} file(s) not run`);
      return code;
    }
    log(`ok   ${file}`);
  }
  log(`pipeline tests: all ${plan.length} files passed`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runAll({ dir: resolve(here, '..') });
}
