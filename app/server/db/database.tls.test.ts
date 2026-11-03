// OFFLINE TESTS: the app's database pool follows the hosted-database policy (pipeline/src/db-tls.ts). The review reproduction
// (launcher r3, finding 1: a server on the path asks for a cleartext password) must now fail closed with no password sent.
// A fake PostgreSQL server on 127.0.0.1 and throwaway in-memory certificates; a hosted-looking host name is redirected to it
// (no DNS, no network). The password is synthetic.

import { afterEach, describe, expect, it } from 'vitest';
import { DbTlsRefusal } from '../../../pipeline/src/db-tls';
import { OTHER_HOST, TEST_HOST, makeTestPki, redirectHosts, smuggledPin, startFakePg, withRepoPins, type FakeAuth, type TestCert } from '../../../pipeline/src/db-tls-testkit';
import type { PinnedRootCa } from '../../../pipeline/src/supabase-root-ca';
import { ConfigError, parseServerEnv } from '../config';
import { UnavailableError } from '../core/types';
import { Database } from './database';

const PASSWORD = 'Fake-App-Tls-Pw-0077-not-real';
const pki = makeTestPki();
const rootPin = pki.pin(pki.root);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function run(opts: { tlsCert: TestCert | null; auth: FakeAuth; pins: readonly PinnedRootCa[]; host?: string }) {
  const server = await startFakePg({ tlsCert: opts.tlsCert, auth: opts.auth });
  cleanups.push(() => server.close());
  cleanups.push(redirectHosts([TEST_HOST, OTHER_HOST], server.port));
  const alerts: string[] = [];
  const db = new Database({
    connectionString: `postgresql://recruiter_app.testref:${PASSWORD}@${opts.host ?? TEST_HOST}:5432/postgres`,
    max: 1,
    connectionTimeoutMillis: 3_000,
    trustedRootCas: opts.pins,
    onAcquireFailure: (label) => alerts.push(label),
  });
  cleanups.push(() => db.close());
  const outcome = await db.transaction({}, async () => 'never').then(() => 'resolved', (e: unknown) => e);
  const sent = Buffer.concat(server.record.afterStartup);
  return { outcome, record: server.record, alerts, passwordSent: sent.includes(Buffer.from(PASSWORD, 'utf8')) };
}

describe('Database: hosted connections are verify-full TLS and SCRAM-only', () => {
  it('review reproduction (fake server asks for a cleartext password): refused over TLS, no password sent', async () => {
    const r = await run({ tlsCert: pki.server, auth: 'cleartext', pins: [rootPin] });
    expect(r.outcome).toBeInstanceOf(UnavailableError);
    expect(r.alerts).toEqual(['db']);
    expect(r.record.tlsHandshakes).toBe(1);
    expect(r.record.plaintextStartups).toBe(0);
    expect(r.record.passwordMessages).toBe(0);
    expect(r.passwordSent).toBe(false);
  });

  it('md5 password request: refused, no password message', async () => {
    const r = await run({ tlsCert: pki.server, auth: 'md5', pins: [rootPin] });
    expect(r.outcome).toBeInstanceOf(UnavailableError);
    expect(r.record.passwordMessages).toBe(0);
    expect(r.passwordSent).toBe(false);
  });

  it('a server without TLS: no startup message (login name) and no password', async () => {
    const r = await run({ tlsCert: null, auth: 'trust', pins: [rootPin] });
    expect(r.outcome).toBeInstanceOf(UnavailableError);
    expect(r.record.sslRequests).toBe(1);
    expect(r.record.plaintextStartups).toBe(0);
    expect(r.passwordSent).toBe(false);
  });

  it('wrong CA and wrong host name: refused during the TLS handshake, before the startup message', async () => {
    // trust auth: only TLS verification can stop these two.
    const wrongCa = await run({ tlsCert: pki.server, auth: 'trust', pins: [pki.pin(pki.otherRoot)] });
    expect(wrongCa.outcome).toBeInstanceOf(UnavailableError);
    expect(wrongCa.record.afterStartup).toHaveLength(0);
    const wrongName = await run({ tlsCert: pki.server, auth: 'trust', pins: [rootPin], host: OTHER_HOST });
    expect(wrongName.outcome).toBeInstanceOf(UnavailableError);
    expect(wrongName.record.afterStartup).toHaveLength(0);
  });

  for (const label of ['TRUSTED CERTIFICATE', 'X509 CERTIFICATE'] as const) {
    it(`disguised second root (${label} block next to the pinned root): the app pool is refused at construction, nothing dialled`, async () => {
      const server = await startFakePg({ tlsCert: pki.attackerServer, auth: 'trust' });
      cleanups.push(() => server.close());
      cleanups.push(redirectHosts([TEST_HOST, OTHER_HOST], server.port));
      const bad = smuggledPin(pki.root, pki.otherRoot, label);
      const url = `postgresql://recruiter_app.testref:${PASSWORD}@${TEST_HOST}:5432/postgres`;
      expect(() => new Database({ connectionString: url, trustedRootCas: [bad] })).toThrow(DbTlsRefusal);
      withRepoPins([bad], () => expect(() => new Database({ connectionString: url })).toThrow(DbTlsRefusal));
      expect(server.record.connections).toBe(0);
    });
  }

  it('missing CA (the repository pin list emptied for this check): the pool is refused at construction, nothing dialled', () => {
    withRepoPins([], () => expect(() => new Database({ connectionString: `postgresql://recruiter_app.testref:${PASSWORD}@aws-0-us-east-2.pooler.supabase.com:5432/postgres` }))
      .toThrow(DbTlsRefusal));
    expect(() => new Database({ connectionString: `postgresql://u:${PASSWORD}@${TEST_HOST}:5432/postgres`, trustedRootCas: [] })).toThrow(/no pinned database root certificate/);
  });

  it('query parameters that could turn TLS off or move the host are refused', () => {
    for (const q of ['?sslmode=disable', '?host=evil.example', '?ssl=false', '#x']) {
      expect(() => new Database({ connectionString: `postgresql://u:${PASSWORD}@127.0.0.1:5432/postgres${q}` })).toThrow(/query parameters or a fragment/);
    }
  });
});

describe('parseServerEnv: the database policy is checked at boot with fixed messages', () => {
  const base = { APP_ORIGIN: 'http://localhost:8788', KEY_LINKS: 'A'.repeat(43), KEY_SESSIONS: 'B'.repeat(43), KEY_RATE: 'C'.repeat(43), EMAIL_MODE: 'test' };
  const message = (url: string) => {
    try {
      parseServerEnv({ ...base, DATABASE_URL: url });
      return 'accepted';
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as Error).message;
    }
  };
  it('a hosted database with no pinned root is refused; a loopback test database is accepted', () => {
    expect(withRepoPins([], () => message(`postgresql://recruiter_app.x:${PASSWORD}@aws-0-us-east-2.pooler.supabase.com:5432/postgres`))).toBe(
      'DATABASE_URL: a hosted database needs verify-full TLS, and no root certificate is pinned (pipeline/src/supabase-root-ca.ts)',
    );
    // With the real pinned root a hosted URL is accepted.
    expect(message(`postgresql://recruiter_app.x:${PASSWORD}@aws-0-us-east-2.pooler.supabase.com:5432/postgres`)).toBe('accepted');
    expect(message(`postgresql://u:${PASSWORD}@127.0.0.1:5432/tr_x`)).toBe('accepted');
  });
  it('query parameters are refused, and the message never contains the URL', () => {
    const m = message(`postgresql://u:${PASSWORD}@127.0.0.1:5432/x?sslmode=disable`);
    expect(m).toBe('DATABASE_URL: must be a postgres:// URL with a host and no query parameters or fragment');
    expect(m).not.toContain(PASSWORD);
  });
});
