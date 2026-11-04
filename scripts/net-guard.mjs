// TEST TOOLING ONLY (never imported by product code). A preload that keeps a test process on loopback:
//   - blocks every Socket.connect to an address that is not loopback (127.x, ::1, ::ffff:127.x), and every name except localhost
//     unless the caller supplied its own resolver;
//   - checks the answers of every resolver, the system one (for localhost) and caller-supplied ones (test stubs): an answer that is
//     empty, not an address or not loopback is refused, and what net receives is a plain copy of the checked answer. A hook on
//     connect alone cannot do this, because net dials AFTER the lookup without coming back through connect.
// A blocked connect fails the socket with "net-guard blocked ..." and adds one line to the log (stderr, or the file in NET_GUARD_LOG).
//
// How reviewers load it (from the repository root; nothing is installed):
//   node --import ./scripts/net-guard.mjs <script>                        (a plain node script)
//   NODE_OPTIONS="--import=file:///C:/path/to/repo/scripts/net-guard.mjs" npx vitest run   (child processes inherit it; Windows needs a file:// URL)
// It must load FIRST: put it before any other --import, and before a test stub that replaces Socket.prototype.connect (the stub
// then sits underneath the guard, which is what the guard's own test does).

import { lookup as systemLookup } from 'node:dns';
import { appendFileSync } from 'node:fs';
import { isIP, Socket } from 'node:net';

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
      ? Array.from(address, (a) => ({ address: String(a?.address), family: typeof a?.family === 'number' ? a.family : undefined }))
      : typeof address === 'string' ? address : undefined;
    const addresses = typeof answer === 'string' ? [answer] : answer?.map((a) => a.address);
    if (addresses === undefined || addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
      record(`blocked lookup answer for ${String(name)}: ${JSON.stringify(addresses ?? null)}`);
      callback(new Error(`net-guard blocked a non-loopback lookup answer for ${String(name)}`));
    } else callback(null, answer, typeof family === 'number' ? family : undefined);
  });
};

const realConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  // Same argument shapes as net: ([options, cb]), (options, cb), (port, host, cb), (path, cb).
  const wrapped = Array.isArray(args[0]);
  const first = wrapped ? args[0][0] : args[0];
  let options;
  if (first !== null && typeof first === 'object') options = first;
  else if (typeof first === 'string' && !/^\d+$/.test(first)) return realConnect.apply(this, args); // a pipe or Unix socket path: not the network
  else options = { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  if (options.path) return realConnect.apply(this, args);
  const host = String(options.host ?? options.hostname ?? 'localhost').replace(/^\[|\]$/g, '');
  const supplied = typeof options.lookup === 'function';
  const allowed = isIP(host) ? isLoopbackAddress(host) : host.toLowerCase() === 'localhost' || supplied;
  if (!allowed) {
    record(`blocked connect to ${host}:${options.port}`);
    this.destroy(new Error(`net-guard blocked a connect to ${host}`));
    return this;
  }
  if (isIP(host)) return realConnect.apply(this, args); // net does not look an address up
  const guarded = { ...options, lookup: guardLookup(supplied ? options.lookup : systemLookup) };
  if (wrapped) return realConnect.call(this, [guarded, ...args[0].slice(1)], ...args.slice(1));
  const callback = args.find((a) => typeof a === 'function');
  return callback ? realConnect.call(this, guarded, callback) : realConnect.call(this, guarded);
};
