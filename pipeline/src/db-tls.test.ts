// Offline tests for the hosted-database policy (db-tls.ts, pg-secure.ts). Everything runs against a fake PostgreSQL server on
// 127.0.0.1 with throwaway in-memory certificates; a hosted-looking host name is redirected to it (no DNS, no network). The
// password is synthetic. Every negative case must fail closed with the password never sent.
//   npx tsx src/db-tls.test.ts

import assert from 'node:assert/strict';
import pg from 'pg';
import { DbTlsRefusal, dbConnectionFieldsFromUrl, dbSecurityFields, dbTlsOptions, isDbSecurityFailure, isLoopbackHost, scramOnlyClient, verifiedRootCaPems } from './db-tls.js';
import { OTHER_HOST, TEST_HOST, makeTestPki, redirectHosts, startFakePg, type FakeAuth, type FakePgRecord, type TestCert } from './db-tls-testkit.js';
import { newSecurePgClient, newSecurePgPool, securePgConfig } from './pg-secure.js';
import { classifyRunnerFailure } from './refusals.js';
import { retentionClientConfig } from './retention-step.js';
import type { PinnedRootCa } from './supabase-root-ca.js';

const PASSWORD = 'Fake-Tls-Pw-0042-not-real';
const failures: string[] = [];
const check = async (title: string, body: () => void | Promise<void>) => {
  try {
    await body();
    console.log(`PASS ${title}`);
  } catch (err) {
    failures.push(title);
    console.error(`FAIL ${title}\n${err instanceof Error ? err.stack : String(err)}`);
  }
};
const refusal = (reason: string) => (err: unknown) => err instanceof DbTlsRefusal && err.reason === reason;
const passwordSeen = (r: FakePgRecord) => r.afterStartup.some((b) => b.includes(Buffer.from(PASSWORD, 'utf8')));

const pki = makeTestPki();
const rootPin = pki.pin(pki.root);

/** One connection attempt with the same composition pg-secure.ts uses, but with test roots. */
async function attempt(opts: { tlsCert: TestCert | null; auth: FakeAuth; pins: readonly PinnedRootCa[]; host?: string }): Promise<{ error: unknown; record: FakePgRecord }> {
  const server = await startFakePg({ tlsCert: opts.tlsCert, auth: opts.auth });
  const host = opts.host ?? TEST_HOST;
  const undo = redirectHosts([TEST_HOST, OTHER_HOST], server.port);
  let error: unknown;
  try {
    const Client = scramOnlyClient(pg.Client);
    const client = new Client({ host, port: 5432, user: 'recruiter_app.testref', password: PASSWORD, database: 'postgres', connectionTimeoutMillis: 5_000, ...dbSecurityFields(host, opts.pins) } as pg.ClientConfig);
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      error = err;
    }
    await client.end().catch(() => undefined);
  } catch (err) {
    error = err;
  } finally {
    undo();
    await new Promise((r) => setTimeout(r, 50));
    await server.close();
  }
  return { error, record: server.record };
}

await check('loopback hosts are exactly localhost, 127.0.0.0/8 and ::1', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.9.9.9', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['10.0.0.1', '192.168.1.5', 'localhost.example.com', 'aws-0-us-east-2.pooler.supabase.com', '0.0.0.0', '::', '128.0.0.1', '']) assert.equal(isLoopbackHost(h), false, h);
});

await check('a loopback target gets no TLS; a hosted target gets verify-full against the pinned roots only', () => {
  assert.equal(dbTlsOptions('127.0.0.1', [rootPin]), false);
  assert.deepEqual(dbSecurityFields('localhost', []), { ssl: false, enableChannelBinding: false });
  const hosted = dbTlsOptions('Aws-0-us-east-2.pooler.supabase.com', [rootPin]);
  assert.ok(hosted);
  assert.equal(hosted.rejectUnauthorized, true);
  assert.deepEqual(hosted.ca, [pki.root.certPem]);
  assert.equal(hosted.servername, 'aws-0-us-east-2.pooler.supabase.com');
  assert.equal(hosted.minVersion, 'TLSv1.2');
  assert.equal(typeof hosted.checkServerIdentity, 'function');
  assert.equal(dbSecurityFields('db.example.test', [rootPin]).enableChannelBinding, true);
});

await check('no pinned root: a hosted target is refused before anything is dialled (missing CA)', async () => {
  assert.throws(() => dbTlsOptions('aws-0-us-east-2.pooler.supabase.com', []), refusal('no_trusted_ca'));
  // The repository pin list is empty today, so every hosted client the pipeline builds is refused the same way.
  assert.throws(() => securePgConfig({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, user: 'u.x', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
  assert.throws(() => newSecurePgClient({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, user: 'u.x', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
  assert.throws(() => newSecurePgPool({ host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432, user: 'u', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
  assert.throws(() => retentionClientConfig({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, user: 'recruiter_maintenance.x', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
  const { error, record } = await attempt({ tlsCert: pki.server, auth: 'trust', pins: [] });
  assert.ok(refusal('no_trusted_ca')(error), String(error));
  assert.equal(record.connections, 0, 'nothing may be dialled');
});

await check('a pinned entry is refused unless it is exactly one CA certificate matching its SHA-256', () => {
  assert.deepEqual(verifiedRootCaPems([rootPin]), [pki.root.certPem]);
  assert.throws(() => verifiedRootCaPems([{ ...rootPin, sha256: pki.pin(pki.otherRoot).sha256 }]), refusal('invalid_trusted_ca'));
  assert.throws(() => verifiedRootCaPems([pki.pin(pki.server)]), refusal('invalid_trusted_ca'), 'a leaf (non-CA) certificate');
  assert.throws(() => verifiedRootCaPems([{ ...rootPin, pem: pki.root.certPem + pki.otherRoot.certPem }]), refusal('invalid_trusted_ca'), 'two certificates in one entry');
  assert.throws(() => verifiedRootCaPems([{ ...rootPin, pem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n' }]), refusal('invalid_trusted_ca'));
  assert.equal(verifiedRootCaPems([{ ...rootPin, sha256: rootPin.sha256.toLowerCase() }]).length, 1);
});

await check('database URLs: query parameters and fragments are refused (they could override host or TLS)', () => {
  assert.deepEqual(dbConnectionFieldsFromUrl('postgres://u:p%40ss@127.0.0.1:6543/db_1'), { host: '127.0.0.1', port: 6543, user: 'u', password: 'p@ss', database: 'db_1' });
  assert.equal(dbConnectionFieldsFromUrl('postgresql://u:p@[::1]/x').host, '::1');
  for (const bad of ['postgres://u:p@localhost/db?sslmode=disable', 'postgres://u:p@localhost/db?host=evil.example', 'postgres://u:p@localhost/db#x', 'http://u:p@localhost/db', 'not a url', 'postgres:///db']) {
    assert.throws(() => dbConnectionFieldsFromUrl(bad), refusal('invalid_url'), bad);
  }
});

await check('positive control: valid pinned root, matching host name, trust auth: connects over TLS', async () => {
  const { error, record } = await attempt({ tlsCert: pki.server, auth: 'trust', pins: [rootPin] });
  assert.equal(error, undefined, String(error));
  assert.equal(record.tlsHandshakes, 1);
  assert.equal(record.plaintextStartups, 0);
});

await check('no TLS: a server that refuses TLS gets no startup message and no password', async () => {
  const { error, record } = await attempt({ tlsCert: null, auth: 'trust', pins: [rootPin] });
  assert.ok(error instanceof Error && !(error instanceof DbTlsRefusal) && isDbSecurityFailure(error), String(error));
  assert.equal(record.sslRequests, 1);
  assert.equal(record.plaintextStartups, 0);
  assert.equal(record.passwordMessages, 0);
  assert.equal(passwordSeen(record), false);
});

await check('wrong CA: a certificate from another root is refused by TLS itself, before the startup message', async () => {
  // trust auth: if TLS verification let it through, the connection would succeed (the SCRAM layer cannot hide a gap here).
  const { error, record } = await attempt({ tlsCert: pki.server, auth: 'trust', pins: [pki.pin(pki.otherRoot)] });
  assert.ok(error instanceof Error && !(error instanceof DbTlsRefusal) && isDbSecurityFailure(error), `${String(error)} ${(error as { code?: string })?.code}`);
  assert.equal(record.plaintextStartups, 0);
  assert.equal(record.afterStartup.length, 0);
  assert.equal(passwordSeen(record), false);
});

await check('wrong host name: a valid certificate for another name is refused before the startup message', async () => {
  const { error, record } = await attempt({ tlsCert: pki.server, auth: 'trust', pins: [rootPin], host: OTHER_HOST });
  assert.equal((error as { code?: string })?.code, 'ERR_TLS_CERT_ALTNAME_INVALID', String(error));
  assert.ok(isDbSecurityFailure(error));
  assert.equal(record.plaintextStartups, 0);
  assert.equal(record.afterStartup.length, 0);
});

for (const auth of ['cleartext', 'md5'] as const) {
  await check(`${auth} password request over valid TLS: refused, no password message sent`, async () => {
    const { error, record } = await attempt({ tlsCert: pki.server, auth, pins: [rootPin] });
    assert.ok(refusal('auth_method_refused')(error), String(error));
    assert.equal(record.tlsHandshakes, 1);
    assert.equal(record.passwordMessages, 0);
    assert.equal(passwordSeen(record), false);
  });
}

await check('cleartext password request on a loopback test database: refused too (SCRAM-only everywhere)', async () => {
  const server = await startFakePg({ tlsCert: null, auth: 'cleartext' });
  const Client = scramOnlyClient(pg.Client);
  const client = new Client({ host: '127.0.0.1', port: server.port, user: 'u', password: PASSWORD, database: 'x', connectionTimeoutMillis: 5_000, ...dbSecurityFields('127.0.0.1', []) } as pg.ClientConfig);
  client.on('error', () => undefined);
  const error = await client.connect().then(() => undefined, (e: unknown) => e);
  await client.end().catch(() => undefined);
  await server.close();
  assert.ok(refusal('auth_method_refused')(error), String(error));
  assert.equal(server.record.sslRequests, 0, 'loopback: no TLS');
  assert.equal(server.record.passwordMessages, 0);
  assert.equal(passwordSeen(server.record), false);
});

await check('SCRAM the server does not finish (no server signature): refused; the password itself never sent', async () => {
  const { error, record } = await attempt({ tlsCert: pki.server, auth: 'scram-no-final', pins: [rootPin] });
  assert.ok(refusal('scram_incomplete')(error), String(error));
  assert.equal(passwordSeen(record), false);
});

await check('runner reports: every refusal and TLS verification failure maps to the one fixed id db_tls_refused', () => {
  assert.deepEqual(classifyRunnerFailure(new DbTlsRefusal('no_trusted_ca', 'x')), { refusal: 'db_tls_refused' });
  assert.deepEqual(classifyRunnerFailure(Object.assign(new Error('Hostname/IP does not match'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })), { refusal: 'db_tls_refused' });
  assert.deepEqual(classifyRunnerFailure(new Error('The server does not support SSL connections')), { refusal: 'db_tls_refused' });
  assert.deepEqual(classifyRunnerFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), { refusal: 'server_or_driver_error', err_code: 'ECONNREFUSED' });
});

await check('a pg build without the auth handlers is refused (no silent downgrade)', () => {
  class Bare {}
  assert.throws(() => scramOnlyClient(Bare), refusal('unsupported_driver'));
});

if (failures.length > 0) {
  console.error(`db-tls: ${failures.length} failed`);
  process.exit(1);
}
console.log('db-tls: all passed');
