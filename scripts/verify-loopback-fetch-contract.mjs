#!/usr/bin/env node
// The loopback-only HTTP test helpers exist twice (app and pipeline are separate packages): the fetch
// replacement and the source guard. The copies must be byte-identical, and the tests that promise
// "loopback only" must use them (private keep-alive agent, not agent: false, not the global fetch).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const failures = [];

for (const name of ['loopback-fetch.ts', 'loopback-guard.ts']) {
  const appCopy = read(`app/server/testing/${name}`);
  const pipelineCopy = read(`pipeline/src/${name}`);
  if (appCopy !== pipelineCopy) failures.push(`app/server/testing/${name} and pipeline/src/${name} differ`);
  if (appCopy.charCodeAt(0) === 0xfeff) failures.push(`${name} starts with a byte order mark`);
  if (/\r/.test(appCopy)) failures.push(`${name} has CR line endings`);
}
const helper = read('app/server/testing/loopback-fetch.ts');
for (const needle of ['new Agent({ keepAlive: true })', 'export function closeLoopbackAgent', "redirect === 'error'", "redirect === 'manual'", 'checkLoopback(new URL(location, target))']) {
  if (!helper.includes(needle)) failures.push(`loopback-fetch.ts lost: ${needle}`);
}
if (/agent:\s*false/.test(helper.replace(/\/\/[^\n]*/g, ''))) failures.push('loopback-fetch.ts must not use agent: false (it hides whether the server closes the connection)');

const users = [
  ['app/server/e2e.http.test.ts', ["from './testing/loopback-fetch'", 'loopbackFetch(', 'agent: loopbackAgent()', 'closeLoopbackAgent()']],
  ['app/server/http/node-adapter.http.test.ts', ["from '../testing/loopback-fetch'", 'agent: loopbackAgent()', 'closeLoopbackAgent()']],
  ['app/server/http/respond.http.test.ts', ["from '../testing/loopback-fetch'", 'agent: loopbackAgent()', 'closeLoopbackAgent()']],
  ['app/server/testing/loopback-fetch.test.ts', ["from './loopback-guard'", 'findLoopbackViolations(']],
  ['pipeline/src/smoke-tests.ts', ["from './loopback-fetch.js'", 'loopbackFetch(', "redirects.at(-1), 'error'", 'closeLoopbackAgent()']],
  ['pipeline/src/loopback-fetch.test.ts', ["from './loopback-fetch.js'", 'findLoopbackViolations(']],
];
for (const [file, needles] of users) {
  const text = readFileSync(resolve(root, file), 'latin1');
  for (const needle of needles) if (!text.includes(needle)) failures.push(`${file} does not contain ${needle}`);
  if (/agent:\s*false/.test(text.replace(/\/\/[^\n]*/g, '').replace(/'[^'\n]*agent: false[^'\n]*'/g, ''))) failures.push(`${file} uses agent: false`);
}
const pipelineList = await import(pathToFileURL(resolve(root, 'pipeline/scripts/test-list.mjs')).href);
if (!pipelineList.TESTS.includes('src/loopback-fetch.test.ts') || !read('pipeline/package.json').includes('"test": "node scripts/run-tests.mjs"')) failures.push('pipeline npm test does not run loopback-fetch.test.ts');

if (failures.length > 0) {
  console.error('FAIL loopback fetch contract');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASS loopback fetch: helper and guard copies identical; keep-alive agent, redirect handling and the guard are wired into the loopback tests');
