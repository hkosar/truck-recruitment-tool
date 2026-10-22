// Streaming request-body limit (doc 15 §4.3). Replaces the framework-level cap Quote-Queue
// gets from Next.js: the limit is enforced WHILE bytes arrive, before anything is collected
// or parsed, so an oversized chunked body (no Content-Length) cannot consume memory.
//
// This reader never destroys the request: destroying a Node IncomingMessage destroys the
// socket, and the handler could then not send its bounded generic or 413 response. When a body
// is too large it keeps reading and DISCARDING (never buffering) up to DRAIN_CAP_BYTES more, so
// the client is not reset mid-upload and can read the response; the handler responds with
// `Connection: close` and closes after the response is flushed (respond.ts). A slow-drip body
// (deadline) is not drained.

export const BODY_LIMITS = {
  auth: 32 * 1024,
  api: 256 * 1024,
  webhook: 1024 * 1024,
} as const;

export const BODY_READ_DEADLINE_MS = 10_000;
/** After an over-limit body, at most this many further bytes are read and thrown away. */
export const DRAIN_CAP_BYTES = 8 * 1024 * 1024;
const DRAIN_DEADLINE_MS = 5_000;

export type BodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'declared_too_large' | 'declared_invalid' | 'too_large' | 'timeout' | 'aborted' };

export type BodySource = AsyncIterable<Uint8Array | string>;

function drain(iterator: AsyncIterator<Uint8Array | string>): void {
  let discarded = 0;
  const stopAt = Date.now() + DRAIN_DEADLINE_MS;
  void (async () => {
    try {
      while (discarded < DRAIN_CAP_BYTES && Date.now() < stopAt) {
        const next = await iterator.next();
        if (next.done) return;
        discarded += typeof next.value === 'string' ? Buffer.byteLength(next.value) : next.value.length;
      }
    } catch {
      // the client went away; nothing to do
    }
  })();
}

export async function readBodyLimited(
  source: BodySource,
  options: { maxBytes: number; declaredLength?: string | null; deadlineMs?: number },
): Promise<BodyResult> {
  const { maxBytes } = options;
  // Manual next() calls: leaving a for-await loop early would call return(), which destroys
  // a Node stream (and its socket).
  const iterator = source[Symbol.asyncIterator]();
  if (options.declaredLength !== undefined && options.declaredLength !== null) {
    const declared = options.declaredLength.trim();
    if (!/^\d+$/.test(declared)) return { ok: false, reason: 'declared_invalid' };
    if (Number(declared) > maxBytes) {
      if (Number(declared) <= maxBytes + DRAIN_CAP_BYTES) drain(iterator);
      return { ok: false, reason: 'declared_too_large' };
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.deadlineMs ?? BODY_READ_DEADLINE_MS);
  });

  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next === 'timeout') return { ok: false, reason: 'timeout' };
      if (next.done) break;
      const chunk = typeof next.value === 'string' ? Buffer.from(next.value, 'utf8') : Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        drain(iterator);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, reason: 'aborted' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { ok: true, body: Buffer.concat(chunks, total) };
}
