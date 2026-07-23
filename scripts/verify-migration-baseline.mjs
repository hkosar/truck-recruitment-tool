#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const migrationsDir = join(repositoryRoot, 'supabase', 'migrations');
const checksumManifestPath = join(repositoryRoot, 'docs', 'build-plan', 'migration-checksums.sha256');
const expectedVersions = [
  '20260720000100',
  '20260720000200',
  '20260720000300',
  '20260720000400',
  '20260720000500',
  '20260720000600',
  '20260720000700',
  '20260720000800',
  '20260720000900',
  '20260720001000',
  '20260720001100',
  '20260720001200',
  '20260720001300',
  '20260720001400',
  '20260720001500',
  '20260722042539',
  '20260722223300',
  '20260723004500',
];

const files = readdirSync(migrationsDir)
  .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const versions = files.map((name) => name.slice(0, 14));

if (files.length !== expectedVersions.length) {
  throw new Error(`Expected ${expectedVersions.length} migration files; found ${files.length}`);
}
if (new Set(versions).size !== versions.length) throw new Error('Migration versions are not unique');
if (JSON.stringify(versions) !== JSON.stringify(expectedVersions)) {
  throw new Error(`Unexpected migration order:\n${files.join('\n')}`);
}

const actualLines = files.map((file) => {
  const content = readFileSync(join(migrationsDir, file));
  if (content.length === 0) throw new Error(`${file} is empty`);
  const digest = createHash('sha256').update(content).digest('hex');
  return `${file}\t${digest}`;
});
const manifestLines = readFileSync(checksumManifestPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
if (JSON.stringify(actualLines) !== JSON.stringify(manifestLines)) {
  throw new Error(
    'Migration checksum manifest is stale or a historical migration changed. ' +
      'Review the diff and update the manifest only as an explicit baseline decision.'
  );
}
for (const line of actualLines) console.log(line);

console.log(`PASS ${files.length} unique, ordered, checksum-pinned migrations; live geocode version 20260722042539 is preserved`);
