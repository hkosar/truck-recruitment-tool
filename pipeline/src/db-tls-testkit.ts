// TEST ONLY (db-tls.test.ts, app/server/db/database.tls.test.ts). Throwaway certificates made in memory at test time (no key
// is ever written to the repository), a fake PostgreSQL server that records what a client sends, and a socket redirect so a
// hosted-looking host name reaches the local fake server without DNS or network.

import { createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { PinnedRootCa } from './supabase-root-ca.js';
import { X509Certificate } from 'node:crypto';

// --- minimal DER writer -------------------------------------------------------------------------------------------------
const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a! + b!];
  for (const n of rest) {
    const parts: number[] = [];
    let v = n;
    do { parts.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let i = 0; i < parts.length - 1; i += 1) parts[i]! |= 0x80;
    out.push(...parts);
  }
  return tlv(0x06, Buffer.from(out));
};
const int = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));
const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), utf8(cn))));
const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

export interface TestCert {
  certPem: string;
  keyPem: string;
  key: KeyObject;
  subject: string;
}

function makeCert(subject: string, issuer: { subject: string; key: KeyObject } | null, opts: { ca: boolean; dnsNames?: string[] }): TestCert {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const now = Date.now();
  const exts = [
    ext('2.5.29.19', true, opts.ca ? seq(bool(true)) : seq()),
    ext('2.5.29.15', true, opts.ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)),
  ];
  if (opts.dnsNames?.length) exts.push(ext('2.5.29.17', false, seq(...opts.dnsNames.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))))));
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(serial),
    ecdsaSha256,
    name(issuer ? issuer.subject : subject),
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...exts)),
  );
  const signature = sign('sha256', tbs, issuer ? issuer.key : privateKey);
  const der = seq(tbs, ecdsaSha256, bits(signature));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { certPem, keyPem, key: createPrivateKey(keyPem), subject };
}

export const TEST_HOST = 'db.tls-test.invalid';
export const OTHER_HOST = 'other.tls-test.invalid';

/** A test root, a server certificate for TEST_HOST signed by it, and a second unrelated root (the "wrong CA"). */
export function makeTestPki(): { root: TestCert; server: TestCert; otherRoot: TestCert; pin: (c: TestCert) => PinnedRootCa } {
  const root = makeCert('db-tls test root', null, { ca: true });
  const otherRoot = makeCert('db-tls other root', null, { ca: true });
  const server = makeCert(TEST_HOST, root, { ca: false, dnsNames: [TEST_HOST] });
  const pin = (c: TestCert): PinnedRootCa => ({ name: c.subject, sha256: new X509Certificate(c.certPem).fingerprint256, source: 'test', pem: c.certPem });
  return { root, server, otherRoot, pin };
}

// --- fake PostgreSQL server ---------------------------------------------------------------------------------------------
export type FakeAuth = 'cleartext' | 'md5' | 'scram-no-final' | 'trust';

export interface FakePgRecord {
  connections: number;
  sslRequests: number;
  tlsHandshakes: number;
  /** Startup messages that arrived WITHOUT TLS (they carry the login name). */
  plaintextStartups: number;
  /** Every byte the client sent after its startup message. */
  afterStartup: Buffer[];
  /** PasswordMessage / SASL responses ('p') received. */
  passwordMessages: number;
}

const authRequest = (code: number, extra: Buffer = Buffer.alloc(0)) => {
  const b = Buffer.alloc(9 + extra.length);
  b.write('R', 0);
  b.writeInt32BE(8 + extra.length, 1);
  b.writeInt32BE(code, 5);
  extra.copy(b, 9);
  return b;
};
const READY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);

/** Starts a fake server on 127.0.0.1. `tlsCert` null = answers 'N' to SSLRequest. */
export async function startFakePg(opts: { tlsCert: TestCert | null; auth: FakeAuth }): Promise<{ port: number; record: FakePgRecord; close(): Promise<void> }> {
  const record: FakePgRecord = { connections: 0, sslRequests: 0, tlsHandshakes: 0, plaintextStartups: 0, afterStartup: [], passwordMessages: 0 };
  const sockets = new Set<net.Socket>();
  const serve = (sock: net.Socket, overTls: boolean) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let scramStep = 0;
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const l = buf.readInt32BE(0);
          if (buf.length < l) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(l);
          if (l === 8 && code === 80877103) {
            record.sslRequests += 1;
            if (!opts.tlsCert || overTls) { sock.write('N'); continue; }
            sock.removeAllListeners('data');
            sock.write('S');
            const secure = new tls.TLSSocket(sock, { isServer: true, key: opts.tlsCert.keyPem, cert: opts.tlsCert.certPem });
            secure.on('secure', () => { record.tlsHandshakes += 1; });
            secure.on('error', () => undefined);
            serve(secure, true);
            return;
          }
          started = true;
          if (!overTls) record.plaintextStartups += 1;
          if (opts.auth === 'cleartext') sock.write(authRequest(3));
          else if (opts.auth === 'md5') sock.write(authRequest(5, Buffer.from([1, 2, 3, 4])));
          else if (opts.auth === 'scram-no-final') sock.write(authRequest(10, Buffer.from('SCRAM-SHA-256\0\0', 'utf8')));
          else sock.write(Buffer.concat([authRequest(0), READY]));
          continue;
        }
        if (buf.length < 5) return;
        const l = buf.readInt32BE(1);
        if (buf.length < l + 1) return;
        const msg = buf.subarray(0, l + 1);
        buf = buf.subarray(l + 1);
        record.afterStartup.push(Buffer.from(msg));
        if (msg[0] !== 0x70) continue;
        record.passwordMessages += 1;
        if (opts.auth === 'scram-no-final') {
          if (scramStep === 0) {
            const text = msg.toString('utf8');
            const nonce = /r=([^,\0]+)/.exec(text)?.[1] ?? '';
            const data = Buffer.from(`r=${nonce}srv,s=${randomBytes(16).toString('base64')},i=4096`, 'utf8');
            sock.write(authRequest(11, data));
            scramStep = 1;
          } else {
            sock.write(Buffer.concat([authRequest(0), READY])); // AuthenticationOk WITHOUT AuthenticationSASLFinal
          }
        }
      }
    });
    sock.on('error', () => undefined);
  };
  const server = net.createServer((sock) => {
    record.connections += 1;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    serve(sock, false);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    record,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

/** Sends every TCP connect for `hosts` to 127.0.0.1:`port` (no DNS); the TLS layer still sees the dialled host name. Returns undo. */
export function redirectHosts(hosts: readonly string[], port: number): () => void {
  const original = net.Socket.prototype.connect;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const first = args[0];
    const host = typeof first === 'object' && first !== null ? first.host : args[1];
    if (typeof host === 'string' && hosts.includes(host)) {
      const cb = args.find((a) => typeof a === 'function');
      return Reflect.apply(original, this, cb ? [{ host: '127.0.0.1', port }, cb] : [{ host: '127.0.0.1', port }]);
    }
    return Reflect.apply(original, this, args);
  } as typeof original;
  return () => { net.Socket.prototype.connect = original; };
}
