// TEST TOOLING ONLY for retention-secure-a3.test.ts. Writes a throwaway root CA certificate and a server certificate/key for
// TEST_HOST (db-tls-testkit.ts, made in memory, ECDSA P-256) into an EMPTY directory you name, so a task-owned local PostgreSQL
// cluster can be started with ssl=on. Nothing here touches the repository or the network; the files belong to the throwaway cluster.
// Run: npx tsx src/retention-secure-a3-make-pki.ts <empty directory outside the repository>

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { REPOSITORY_ROOT } from './staging-rebuilt.js';
import { makeTestPki } from './db-tls-testkit.js';

const dir = process.argv[2];
if (!dir || !isAbsolute(dir)) throw new Error('usage: make-pki <absolute, empty directory outside the repository>');
const rel = relative(REPOSITORY_ROOT, resolve(dir));
if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('refusing: the key material must live outside the repository');
mkdirSync(dir, { recursive: true });
if (readdirSync(dir).length > 0) throw new Error('refusing: the directory is not empty');
const pki = makeTestPki();
writeFileSync(join(dir, 'root.crt'), pki.root.certPem, { flag: 'wx' });
writeFileSync(join(dir, 'server.crt'), pki.server.certPem, { flag: 'wx' });
writeFileSync(join(dir, 'server.key'), pki.server.keyPem, { flag: 'wx' });
console.log('wrote root.crt, server.crt, server.key');
