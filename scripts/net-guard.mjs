// TEST TOOLING ONLY (never imported by product code). A preload that keeps a test process on loopback:
//   - blocks every Socket.connect to an address that is not loopback (127.x, ::1, ::ffff:127.x), and every name except localhost
//     unless the caller supplied its own resolver;
//   - checks the answers of every resolver, the system one (for localhost) and caller-supplied ones (test stubs): an answer that is
//     empty, not an address or not loopback is refused, and what net receives is a plain copy of the checked answer. A hook on
//     connect alone cannot do this, because net dials AFTER the lookup without coming back through connect.
// NOT covered: native handles (process.binding('tcp_wrap') and other internal bindings), dns.lookup / dns.resolve* called directly, UDP (dgram), and a caller-supplied resolver is run for whatever name net
// passes it (only its answers are checked). Anyone who needs "no name lookups at all" must not rely on this guard alone.
// A blocked connect fails the socket with "net-guard blocked ..." and adds one line to the log (stderr, or the file in NET_GUARD_LOG).
//
// How reviewers load it (from the repository root; nothing is installed):
//   node --import ./scripts/net-guard.mjs <script>                        (a plain node script)
//   NODE_OPTIONS="--import=file:///C:/path/to/repo/scripts/net-guard.mjs" npx vitest run   (child processes inherit it; Windows needs a file:// URL)
// It must load FIRST: put it before any other --import, and before a test stub that replaces Socket.prototype.connect (the stub
// then sits underneath the guard, which is what the guard's own test does).

import { lookup as systemLookup } from 'node:dns';
import { appendFileSync } from 'node:fs';
import { _normalizeArgs, isIP, Socket } from 'node:net';

const isLoopbackAddress = (a) => {
  if (typeof a !== 'string') return false;
  const kind = isIP(a);
  const v = a.toLowerCase();
  return (kind === 4 && v.startsWith('127.')) || (kind === 6 && (v === '::1' || v.startsWith('::ffff:127.')));
};

const record = (line) => {
  const text = `net-guard: ${line}\n`;
  if (process.env.NET_GUARD_LOG) appendFileSync(process.env.NET_GUARD_LOG, text); else process.stderr.write(text);
};

// Wraps a resolver (the system one or a caller's) so net only ever sees a checked plain copy of its answer.
const guardLookup = (resolve) => (name, opts, done) => {
  const callback = typeof opts === 'function' ? opts : done;
  const options = typeof opts === 'function' ? {} : opts;
  resolve(name, options, (err, address, family) => {
    if (err) { callback(err, address, family); return; }
    const answer = Array.isArray(address)
      ? Array.from(address, (a) => { const family = a?.family; return { address: String(a?.address), family: typeof family === 'number' ? family : undefined }; })
      : typeof address === 'string' ? address : undefined;
    const addresses = typeof answer === 'string' ? [answer] : answer?.map((a) => a.address);
    if (addresses === undefined || addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
      record(`blocked lookup answer for ${String(name)}: ${JSON.stringify(addresses ?? null)}`);
      callback(new Error(`net-guard blocked a non-loopback lookup answer for ${String(name)}`));
    } else callback(null, answer, typeof family === 'number' ? family : undefined);
  });
};

// Node's own mark on the [options, cb] array that net.connect/http hand to socket.connect (lib/net.js reads it as args[0][mark]).
const kNormalized = Object.getOwnPropertySymbols(_normalizeArgs([]))[0];

const realConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  // Decide exactly as Node does: an array is Node's own pre-normalised [options, cb] only when args[0][mark] is truthy (an inherited
  // mark counts); anything else (options, (port, host, cb), (path, cb), a plain array read as options) goes through Node's own rules.
  const norm = Array.isArray(args[0]) && args[0][kNormalized] ? args[0] : _normalizeArgs(args);
  const first = norm[0]; // each slot is read ONCE
  const callback = norm[1];
  // Whatever happens next, Node gets a fresh array built here with Node's mark; the caller's array is never written to or reused.
  const send = (options) => { const out = [options, callback]; out[kNormalized] = true; return realConnect.call(this, out); };
  if (first === null || (typeof first !== 'object' && typeof first !== 'function')) return send(first); // Node fails on this by itself
  // Read each option Node uses to choose a destination ONCE, and hand Node a copy holding exactly those values.
  const path = first.path;
  const rawHost = first.host;
  const rawLookup = first.lookup;
  const options = { ...first, path, host: rawHost, lookup: rawLookup };
  if (path) return send(options); // a pipe or Unix socket path: not the network
  const host = rawHost || 'localhost'; // the text Node uses: brackets are NOT stripped ("[::1]" is a name to Node, not an address)
  const supplied = typeof rawLookup === 'function';
  const allowed = typeof host !== 'string' ? true /* Node throws on a non-string host before any connect */ : isIP(host) ? isLoopbackAddress(host) : host.toLowerCase() === 'localhost' || supplied;
  if (!allowed) {
    record(`blocked connect to ${host}:${options.port}`);
    this.destroy(new Error(`net-guard blocked a connect to ${host}`));
    return this;
  }
  if (typeof host === 'string' && !isIP(host)) options.lookup = guardLookup(supplied ? rawLookup : systemLookup); // net looks a name up; an address it does not
  return send(options);
};
