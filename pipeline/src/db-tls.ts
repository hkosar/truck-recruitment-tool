// One hosted-database security policy for every Postgres client in this repo (the app server and the pipeline runners).
//
//  - A hosted (non-loopback) target ALWAYS uses TLS, verify-full: the server certificate must chain to a pinned root
//    (supabase-root-ca.ts; Node's built-in store is NOT used) and its name must match the host we dialled. With no pinned
//    root, or a pinned entry that fails its own checks, the connection is refused before anything is dialled. There is no
//    `rejectUnauthorized: false` path for a hosted target.
//  - Authentication is SCRAM-SHA-256 only, for every target: a server asking for a cleartext or MD5 password gets no
//    password; the connection is refused. A SCRAM exchange the server does not finish (no server signature) is refused too.
//    SCRAM channel binding (SCRAM-SHA-256-PLUS, pg `enableChannelBinding`, present in pg 8.22.0 and 8.23.1) is switched on
//    with TLS; it is used when the server offers it.
//  - Loopback targets (localhost, 127.0.0.0/8, ::1) are local test databases: no TLS, still SCRAM-only (trust auth, which
//    sends no password, keeps working).
//
// This file imports only Node built-ins, so both packages can use it with their own copy of pg.

import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import { SUPABASE_ROOT_CAS, type PinnedRootCa } from './supabase-root-ca.js';

export type DbTlsRefusalReason = 'no_trusted_ca' | 'invalid_trusted_ca' | 'auth_method_refused' | 'scram_incomplete' | 'unsupported_driver' | 'invalid_url';

/** A fixed-text refusal (never carries a host, user or password). Deliberately has no `code` property. */
export class DbTlsRefusal extends Error {
  constructor(readonly reason: DbTlsRefusalReason, message: string) {
    super(message);
    this.name = 'DbTlsRefusal';
  }
}

/** Node TLS / OpenSSL verification codes and the driver's no-TLS messages: a hosted connection that failed these checks. */
const TLS_FAILURE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED', 'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const NO_TLS_MESSAGES = new Set(['The server does not support SSL connections', 'There was an error establishing an SSL connection']);

/** True for this module's refusals and for a TLS verification / no-TLS failure (so callers can report one fixed reason). */
export function isDbSecurityFailure(err: unknown): boolean {
  if (err instanceof DbTlsRefusal) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (typeof code === 'string' && TLS_FAILURE_CODES.has(code)) || NO_TLS_MESSAGES.has(err.message);
}

/** localhost, 127.0.0.0/8 and ::1 only (no other name, no private network address). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

/** The pin list the defaults use. Only the test hook below can change it; the exported list itself is frozen. */
let defaultPins: readonly PinnedRootCa[] = SUPABASE_ROOT_CAS;

/** TEST ONLY: replaces the default pin list; returns a function that restores the previous one. */
export function setDefaultPinsForTests(pins: readonly PinnedRootCa[]): () => void {
  const saved = defaultPins;
  defaultPins = pins;
  return () => {
    defaultPins = saved;
  };
}

/** Any PEM block label in the text (CERTIFICATE, TRUSTED CERTIFICATE, X509 CERTIFICATE, keys, ...). */
const PEM_BEGIN = /-----BEGIN [^-\r\n]*-----/g;

/**
 * The pinned roots, each checked: the text holds exactly one PEM block and it is a plain CERTIFICATE block (OpenSSL also loads
 * TRUSTED CERTIFICATE and X509 CERTIFICATE blocks, so a second root could hide under another label), it is a CA certificate,
 * and its SHA-256 equals the recorded one. What is returned (and so what TLS trusts) is the checked certificate re-encoded
 * from the parsed object, never the raw text.
 */
export function verifiedRootCaPems(pins: readonly PinnedRootCa[] = defaultPins): string[] {
  if (pins.length === 0) {
    throw new DbTlsRefusal('no_trusted_ca', 'refusing: no pinned database root certificate (pipeline/src/supabase-root-ca.ts); a hosted database needs verify-full TLS');
  }
  return pins.map((pin) => {
    const invalid = new DbTlsRefusal('invalid_trusted_ca', 'refusing: a pinned database root certificate is not one valid CA certificate matching its recorded SHA-256');
    const blocks = pin.pem.match(PEM_BEGIN) ?? [];
    if (blocks.length !== 1 || blocks[0] !== '-----BEGIN CERTIFICATE-----') throw invalid;
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pin.pem);
    } catch {
      throw invalid;
    }
    if (!cert.ca || cert.fingerprint256 !== pin.sha256.toUpperCase()) throw invalid;
    const pem = cert.toString();
    if ((pem.match(PEM_BEGIN) ?? []).length !== 1 || new X509Certificate(pem).fingerprint256 !== cert.fingerprint256) throw invalid;
    return pem;
  });
}

/** pg `ssl` for a target: false for loopback; otherwise verify-full against the pinned roots only (throws if none). */
export function dbTlsOptions(host: string, pins: readonly PinnedRootCa[] = defaultPins): false | ConnectionOptions {
  if (isLoopbackHost(host)) return false;
  const ca = verifiedRootCaPems(pins);
  const name = host.toLowerCase();
  return {
    ca, // replaces Node's default roots: only the pinned certificate(s) are trusted
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ...(isIP(name) === 0 ? { servername: name } : {}),
    // The name is checked against the host we dialled, whatever the driver passes as servername.
    checkServerIdentity: (_servername, cert) => checkServerIdentity(name, cert),
  };
}

/** The TLS and channel-binding fields to spread into a pg Client/Pool config for `host`. */
export function dbSecurityFields(host: string, pins: readonly PinnedRootCa[] = defaultPins): { ssl: false | ConnectionOptions; enableChannelBinding: boolean } {
  const ssl = dbTlsOptions(host, pins);
  return { ssl, enableChannelBinding: ssl !== false };
}

export interface DbConnectionFields {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | undefined;
}

/**
 * Explicit connection fields from a postgres:// URL. Query parameters and fragments are refused: pg's parser would let
 * ?host=, ?sslmode= and friends override the host and the TLS settings checked here. Fixed messages only.
 */
export function dbConnectionFieldsFromUrl(raw: string): DbConnectionFields {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DbTlsRefusal('invalid_url', 'refusing: the database URL is not a parseable postgres:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new DbTlsRefusal('invalid_url', 'refusing: the database URL is not a postgres:// URL');
  if (url.search !== '' || url.hash !== '') throw new DbTlsRefusal('invalid_url', 'refusing: the database URL must not contain query parameters or a fragment');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') throw new DbTlsRefusal('invalid_url', 'refusing: the database URL has no host');
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new DbTlsRefusal('invalid_url', 'refusing: the database URL has a malformed escape');
    }
  };
  return {
    host,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decode(url.username),
    password: decode(url.password),
    database: url.pathname.length > 1 ? decode(url.pathname.slice(1)) : undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientConstructor = new (...args: any[]) => object;

interface PgClientInternals {
  connection: { emit(event: 'error', err: Error): boolean; stream?: { destroy?(): void } };
  saslSession?: unknown;
  _connecting?: boolean;
}

const PG_HOOKS = ['_handleAuthCleartextPassword', '_handleAuthMD5Password', '_handleAuthSASL', '_handleReadyForQuery'] as const;

/**
 * A subclass of the given pg Client that refuses cleartext and MD5 password requests (no password is sent) and refuses a
 * SCRAM exchange the server did not finish with its signature. pg has no option for this, so it overrides pg's own
 * auth handlers (present in pg 8.22.0 and 8.23.1); if a pg upgrade renames them this throws instead of silently allowing.
 */
export function scramOnlyClient<C extends ClientConstructor>(Base: C): C {
  const proto = Base.prototype as Record<string, unknown>;
  if (PG_HOOKS.some((hook) => typeof proto[hook] !== 'function')) {
    throw new DbTlsRefusal('unsupported_driver', 'refusing: this pg version has no auth handlers to enforce SCRAM-only authentication');
  }
  const call = (hook: (typeof PG_HOOKS)[number], self: object, args: unknown[]) => (proto[hook] as (...a: unknown[]) => unknown).apply(self, args);
  const refuse = (self: object, err: DbTlsRefusal) => {
    const c = self as PgClientInternals;
    c.connection.emit('error', err);
    c.connection.stream?.destroy?.();
  };
  const sasl = new WeakSet<object>();
  class ScramOnlyClient extends Base {
    _handleAuthCleartextPassword(): void {
      refuse(this, new DbTlsRefusal('auth_method_refused', 'refusing: the database asked for a cleartext password; only SCRAM-SHA-256 is allowed (no password sent)'));
    }
    _handleAuthMD5Password(): void {
      refuse(this, new DbTlsRefusal('auth_method_refused', 'refusing: the database asked for an MD5 password; only SCRAM-SHA-256 is allowed (no password sent)'));
    }
    _handleAuthSASL(...args: unknown[]): unknown {
      sasl.add(this);
      return call('_handleAuthSASL', this, args);
    }
    _handleReadyForQuery(...args: unknown[]): unknown {
      const c = this as unknown as PgClientInternals;
      if (c._connecting && sasl.has(this) && c.saslSession !== null) {
        refuse(this, new DbTlsRefusal('scram_incomplete', 'refusing: the database ended SCRAM authentication without proving it knows the password'));
        return undefined;
      }
      return call('_handleReadyForQuery', this, args);
    }
  }
  return ScramOnlyClient;
}
