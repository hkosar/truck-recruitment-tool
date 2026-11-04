// Offline test (no database, no network) of the server major version line the environment preflight prints (TRUCKRECRU-108).
// Run: tsx src/server-major.test.ts

import assert from 'node:assert/strict';
import { reportEnvironmentPreflight, serverMajor, type EnvironmentReport } from './environment-preflight.js';

let n = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };

check('150000 is 15', serverMajor('150000') === '15');
check('160006 is 16', serverMajor('160006') === '16');
check('170002 is 17', serverMajor('170002') === '17');
check('numbers work too', serverMajor(160006) === '16');
check('999999 is other', serverMajor('999999') === 'other');
check('140012 (PG14) is other', serverMajor('140012') === 'other');
check('180000 (PG18) is other', serverMajor('180000') === 'other');
for (const bad of ['garbage', '', '16', '1600060', '16000', '16.6', ' 160006', '160006\n', '16000a', 'PostgreSQL 16.6 on host.example.com', null, undefined, {}, [], true, NaN, 1.6e5 + 0.5, -160006]) {
  check(`garbage ${JSON.stringify(bad) ?? String(bad)} is other`, serverMajor(bad) === 'other');
}

const report = (v: unknown): EnvironmentReport => ({ serverVersionNum: v, eventTriggers: { total: 0, listed: [] }, rolesPresent: [], defaults: { rows: [] }, authenticator: { authenticator_exists: false, role_wide_entries: 0, this_database_entries: 0, names_public_if_single: null } });
const printed = (v: unknown): string[] => {
  const out: string[] = [];
  const l = console.log;
  console.log = (...a: unknown[]) => { out.push(String(a[0])); };
  try { reportEnvironmentPreflight(report(v)); } finally { console.log = l; }
  return out;
};
for (const [input, major] of [['150000', '15'], ['160006', '16'], ['170002', '17'], ['999999', 'other'], ['garbage', 'other'], [undefined, 'other']] as const) {
  const lines = printed(input).filter((x) => x.includes('staging-sql.server_major'));
  check(`report prints exactly one fixed line for ${String(input)}`, lines.length === 1 && lines[0] === JSON.stringify({ msg: 'staging-sql.server_major', major }));
}
check('a hostile value never reaches the output', !printed('PostgreSQL 16.6 on db.example.com').join('\n').includes('example.com'));
console.log(`PASS ${n} server-major checks`);
