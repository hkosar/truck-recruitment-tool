#!/usr/bin/env node
// The COMMIT classifier exists twice (app and pipeline are separate packages). The copies must be
// byte-identical, and each helper that sends COMMIT must use it: inspect the answer's command tag
// (a ROLLBACK tag is a definite failure), and apply the unknown-outcome rules.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const failures = [];

const appCopy = read('app/server/db/commit-outcome.ts');
const pipelineCopy = read('pipeline/src/commit-outcome.ts');
if (appCopy !== pipelineCopy) failures.push('app/server/db/commit-outcome.ts and pipeline/src/commit-outcome.ts differ');
if (/^\s*import\s/m.test(appCopy)) failures.push('commit-outcome.ts must have no imports (it is copied between packages)');

const users = [
  ['app/server/db/database.ts', ["from './commit-outcome'", 'isRollbackTag(', 'isDefiniteCommitRefusal(', 'clientUsable(']],
  ['pipeline/src/db.ts', ["from './commit-outcome.js'", 'isRollbackTag(', 'isDefiniteCommitRefusal(', 'clientUsable(']],
  ['pipeline/src/load-location-tables.ts', ["from './commit-outcome.js'", 'isRollbackTag(', 'isDefiniteCommitRefusal(', 'clientUsable(']],
];
for (const [file, needles] of users) {
  const text = read(file);
  for (const needle of needles) if (!text.includes(needle)) failures.push(`${file} does not use ${needle}`);
  if (/DEFINITE_COMMIT_REFUSALS\s*[:=]/.test(text)) failures.push(`${file} defines its own refusal list`);
}

if (failures.length > 0) {
  console.error('FAIL commit outcome contract');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASS commit outcome classifier: app and pipeline copies identical; every COMMIT helper uses it (ROLLBACK tag, allowlist, usability)');
