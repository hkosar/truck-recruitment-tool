// Offline tests for the hosted-database policy (db-tls.ts, pg-secure.ts). Everything runs against a fake PostgreSQL server on
// 127.0.0.1 with throwaway in-memory certificates; a hosted-looking host name is redirected to it (no DNS, no network). The
// password is synthetic. Every negative case must fail closed with the password never sent.
//   npx tsx src/db-tls.test.ts

import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import pg from 'pg';
import { DbTlsRefusal, dbConnectionFieldsFromUrl, dbSecurityFields, dbTlsOptions, isDbSecurityFailure, isLoopbackHost, scramOnlyClient, verifiedRootCaPems } from './db-tls.js';
import { OTHER_HOST, TEST_HOST, makeTestPki, redirectHosts, smuggledPin, startFakePg, withRepoPins, type FakeAuth, type FakePgRecord, type TestCert } from './db-tls-testkit.js';
import { newSecurePgClient, newSecurePgPool, securePgConfig } from './pg-secure.js';
import { classifyRunnerFailure } from './refusals.js';
import { retentionClientConfig } from './retention-step.js';
import { SUPABASE_ROOT_CAS, type PinnedRootCa } from './supabase-root-ca.js';

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
  // With the repository pin list emptied, every hosted client the pipeline builds is refused the same way.
  withRepoPins([], () => {
    assert.throws(() => securePgConfig({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, user: 'u.x', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
    assert.throws(() => newSecurePgClient({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, user: 'u.x', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
    assert.throws(() => newSecurePgPool({ host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432, user: 'u', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
    assert.throws(() => retentionClientConfig({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, user: 'recruiter_maintenance.x', password: PASSWORD, database: 'postgres' }), refusal('no_trusted_ca'));
  });
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

await check('the repository pin: Supabase Root 2021 CA, DER SHA-256 matches, self-signed CA, expected validity, passes the load check', () => {
  const EXPECTED = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';
  assert.equal(SUPABASE_ROOT_CAS.length, 1);
  const pin = SUPABASE_ROOT_CAS[0]!;
  assert.equal(pin.sha256, EXPECTED);
  const cert = new X509Certificate(pin.pem);
  const independent = createHash('sha256').update(cert.raw).digest('hex').toUpperCase().match(/../g)!.join(':');
  assert.equal(independent, EXPECTED, 'hash of the DER bytes computed here, not the fingerprint field');
  assert.equal(cert.fingerprint256, EXPECTED);
  assert.equal(cert.subject, cert.issuer);
  assert.match(cert.subject, /CN=Supabase Root 2021 CA/);
  assert.equal(cert.ca, true);
  assert.equal(cert.checkIssued(cert), true);
  assert.equal(new Date(cert.validFrom).toISOString().slice(0, 10), '2021-04-28');
  assert.equal(new Date(cert.validTo).toISOString().slice(0, 10), '2031-04-26');
  assert.deepEqual(verifiedRootCaPems(), [pin.pem], 'the default list passes its own check');
  const hosted = dbTlsOptions('aws-0-us-east-2.pooler.supabase.com');
  assert.ok(hosted);
  assert.deepEqual(hosted.ca, [pin.pem]);
  assert.equal(hosted.rejectUnauthorized, true);
});

await check('the repository pin fails closed if its certificate or fingerprint is altered', () => {
  const pin = SUPABASE_ROOT_CAS[0]!;
  const flipped = pin.sha256.replace(/^80/, '81');
  assert.throws(() => verifiedRootCaPems([{ ...pin, sha256: flipped }]), refusal('invalid_trusted_ca'));
  const lines = pin.pem.split('\n');
  lines[3] = lines[3]!.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'));
  assert.throws(() => verifiedRootCaPems([{ ...pin, pem: lines.join('\n') }]), refusal('invalid_trusted_ca'));
  withRepoPins([{ ...pin, sha256: flipped }], () => {
    assert.throws(() => dbTlsOptions('aws-0-us-east-2.pooler.supabase.com'), refusal('invalid_trusted_ca'));
    assert.throws(() => newSecurePgClient({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432, user: 'u.x', password: PASSWORD, database: 'postgres' }), refusal('invalid_trusted_ca'));
  });
});

await check('a fake server whose certificate chains to a different CA than the repository pin is refused before the password', async () => {
  const { error, record } = await attempt({ tlsCert: pki.server, auth: 'trust', pins: SUPABASE_ROOT_CAS });
  assert.ok(isDbSecurityFailure(error), String(error));
  assert.equal(passwordSeen(record), false);
});

for (const label of ['TRUSTED CERTIFICATE', 'X509 CERTIFICATE'] as const) {
  await check(`disguised second root (${label} block next to the pinned root): the entry is refused, and an attacker-signed server is never reached by the pipeline client or pool`, async () => {
    const bad = smuggledPin(pki.root, pki.otherRoot, label);
    assert.throws(() => verifiedRootCaPems([bad]), refusal('invalid_trusted_ca'));
    assert.throws(() => dbTlsOptions('aws-0-us-east-2.pooler.supabase.com', [bad]), refusal('invalid_trusted_ca'));
    const server = await startFakePg({ tlsCert: pki.attackerServer, auth: 'trust' });
    const undo = redirectHosts([TEST_HOST, OTHER_HOST], server.port);
    try {
      withRepoPins([bad], () => {
        const target = { host: TEST_HOST, port: 5432, user: 'recruiter_app.testref', password: PASSWORD, database: 'postgres' };
        assert.throws(() => newSecurePgClient(target, { connectionTimeoutMillis: 3_000 }), refusal('invalid_trusted_ca'));
        assert.throws(() => newSecurePgPool(target, { connectionTimeoutMillis: 3_000 }), refusal('invalid_trusted_ca'));
      });
      // Control: with only the real pinned root, the attacker-signed server is refused by TLS itself.
      const { error, record } = await attempt({ tlsCert: pki.attackerServer, auth: 'trust', pins: [rootPin] });
      assert.ok(isDbSecurityFailure(error), String(error));
      assert.equal(passwordSeen(record), false);
    } finally {
      undo();
      await server.close();
    }
    assert.equal(server.record.connections, 0, 'nothing may be dialled with an invalid pin');
  });
}

await check('the CA handed to TLS is the re-encoded checked certificate only: one CERTIFICATE block; any other PEM block, key block or trailing text is refused', () => {
  const good = verifiedRootCaPems([rootPin]);
  assert.equal(good.length, 1);
  assert.equal(good[0]!.match(/-----BEGIN /g)!.length, 1);
  assert.equal(new X509Certificate(good[0]!).fingerprint256, new X509Certificate(pki.root.certPem).fingerprint256);
  assert.equal(verifiedRootCaPems([{ ...rootPin, pem: rootPin.pem + '\n# a note\n' }]).length, 1, 'a comment after the block is not a PEM block, and is dropped');
  assert.ok(!verifiedRootCaPems([{ ...rootPin, pem: rootPin.pem + '\n# a note\n' }])[0]!.includes('a note'));
  assert.throws(() => verifiedRootCaPems([{ ...rootPin, pem: rootPin.pem + '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }]), refusal('invalid_trusted_ca'));
  assert.throws(() => verifiedRootCaPems([{ ...rootPin, pem: rootPin.pem + pki.otherRoot.certPem }]), refusal('invalid_trusted_ca'));
  assert.throws(() => verifiedRootCaPems([{ ...rootPin, pem: rootPin.pem.replace('BEGIN CERTIFICATE', 'BEGIN TRUSTED CERTIFICATE').replace('END CERTIFICATE', 'END TRUSTED CERTIFICATE') }]), refusal('invalid_trusted_ca'));
});

await check('the repository pin list and its entry are frozen', () => {
  assert.equal(Object.isFrozen(SUPABASE_ROOT_CAS), true);
  assert.equal(Object.isFrozen(SUPABASE_ROOT_CAS[0]), true);
  assert.throws(() => (SUPABASE_ROOT_CAS as PinnedRootCa[]).push(rootPin), TypeError);
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

await check('a caller option that can replace the connection target or TLS settings is refused before anything is dialled', async () => {
  const target = { host: TEST_HOST, port: 5432, user: 'recruiter_app.testref', password: PASSWORD, database: 'postgres' };
  const server = await startFakePg({ tlsCert: pki.server, auth: 'trust' });
  const undo = redirectHosts([TEST_HOST, OTHER_HOST], server.port);
  try {
    withRepoPins([rootPin], () => {
      const overrides: Record<string, unknown>[] = [
        { connectionString: `postgres://u:p@${OTHER_HOST}/db?sslmode=disable` },
        { connectionString: 'postgres://u:p@127.0.0.1/db' },
        { ssl: false }, { ssl: { rejectUnauthorized: false } }, { host: OTHER_HOST }, { port: 1 }, { user: 'x' }, { password: 'x' }, { database: 'x' },
        { stream: () => null }, { Client: class {} }, { enableChannelBinding: false }, { lookup: () => null },
        { max: 1, ssl: false },
      ];
      for (const extra of overrides) {
        assert.throws(() => newSecurePgClient(target, extra as never), refusal('connection_override'), Object.keys(extra).join());
        assert.throws(() => newSecurePgPool(target, extra as never), refusal('connection_override'), Object.keys(extra).join());
      }
      assert.throws(() => newSecurePgClient(target, { [Symbol('x')]: 1 } as never), refusal('connection_override'));
      assert.throws(() => newSecurePgClient(target, Object.create({ ssl: false }) as never), refusal('connection_override'));
      // The refusal is the one fixed runner id and carries no host, user or password.
      try { newSecurePgClient(target, { connectionString: `postgres://u:${PASSWORD}@${OTHER_HOST}/db` } as never); assert.fail('must refuse'); } catch (err) {
        assert.deepEqual(classifyRunnerFailure(err), { refusal: 'db_tls_refused' });
        assert.ok(!String((err as Error).message).includes(PASSWORD) && !String((err as Error).message).includes(OTHER_HOST));
      }
      // Control: the permitted tuning options still work, and the checked fields win.
      const ok = newSecurePgClient(target, { connectionTimeoutMillis: 3_000 });
      assert.equal((ok as unknown as { connectionParameters: { host: string; ssl: unknown } }).connectionParameters.host, TEST_HOST);
      assert.ok((ok as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl);
      void newSecurePgPool(target, { max: 1, idleTimeoutMillis: 1_000 }).end();
    });
  } finally {
    undo();
    await server.close();
  }
  assert.equal(server.record.connections, 0, 'nothing may be dialled');
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
