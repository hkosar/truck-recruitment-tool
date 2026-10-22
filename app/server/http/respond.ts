// Send a bounded response, then close the connection. Used after a rejected body (doc 15
// §4.3): the generic sign-in response or a 413 is written first; the connection is closed only
// after the response is flushed AND the (drained, discarded) upload has ended, or after a short
// grace period. Closing with unread upload bytes would make the client see a reset instead of
// the response.

import type { IncomingMessage, ServerResponse } from 'node:http';

const CLOSE_GRACE_MS = 5_000;

export function respondThenClose(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  res.shouldKeepAlive = false;
  res.writeHead(status, { ...headers, connection: 'close', 'content-length': String(Buffer.byteLength(body)) });
  res.end(body, () => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      req.socket.end();
      setTimeout(() => req.socket.destroy(), 1_000).unref();
    };
    if (req.readableEnded || req.complete) close();
    else {
      req.once('end', close);
      req.once('error', close);
      setTimeout(close, CLOSE_GRACE_MS).unref();
    }
  });
}
