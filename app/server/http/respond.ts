// Send a bounded response, then close the connection. Used after a rejected body (doc 15
// §4.3): the generic sign-in response or a 413 is written first, and the socket is closed only
// once the response has been flushed, so the client always receives it.

import type { IncomingMessage, ServerResponse } from 'node:http';

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
    // Unread request bytes are discarded with the socket, never buffered.
    req.socket.end();
    setTimeout(() => req.socket.destroy(), 1_000).unref();
  });
}
