// Send a bounded response, then close the connection. Used after a rejected body (doc 15
// §4.3) and for refusals during shutdown.
//
// Node closes a `Connection: close` socket itself as soon as the response FINISHES (its
// finish handler calls destroySoon). If upload bytes are still arriving then, the peer gets a
// TCP reset and may lose the response (Gate 2 review N2). So the whole response is written
// first (the client can read all of it, Content-Length is exact), but `end()` waits until the
// rejected upload has been drained and discarded (body.ts), bounded by a grace period. Only
// then does Node finish and close. The returned promise settles when the connection is closed.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const CLOSE_GRACE_MS = 5_000;

export function respondThenClose(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      resolve();
    };
    res.once('close', settle);
    res.shouldKeepAlive = false;
    res.writeHead(status, { ...headers, connection: 'close', 'content-length': String(Buffer.byteLength(body)) });
    res.write(req.method === 'HEAD' ? '' : body);

    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      res.end();
      // Node closes the socket after finish; this is only a backstop for a stuck peer.
      setTimeout(() => req.socket.destroy(), 1_000).unref();
    };
    const grace = setTimeout(end, CLOSE_GRACE_MS);
    grace.unref();
    if (req.complete || req.readableEnded) {
      end();
    } else {
      req.once('end', end);
      req.once('error', end);
      req.once('close', end);
    }
  });
}
