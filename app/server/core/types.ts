// Framework-free request/response shapes for the sign-in server (doc 15 §4). The Node adapter
// (server/http/node-adapter.ts) converts real HTTP to these; tests drive them directly.

import type { BodyResult } from '../http/body';

export interface AppRequest {
  method: string;
  /** Path without query string. */
  path: string;
  query: URLSearchParams;
  headers: { get(name: string): string | null };
  cookies: Map<string, string>;
  /** Reads the body under the given byte limit (never destroys the socket). */
  readBody(maxBytes: number): Promise<BodyResult>;
  /** Client IP from the trusted proxy hop, or undefined. */
  clientIp: string | undefined;
  /** Monotonic receipt time in ms (performance.now()). */
  receivedAt: number;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  body: string | Buffer;
  /** Close the connection after sending (rejected bodies). */
  closeAfter?: boolean;
  /** Work to start only after this response has finished (the Node adapter runs it as a tracked continuation). */
  afterResponse?: () => Promise<void>;
}

export type Logger = (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;

/** Errors the stores raise, mapped to HTTP by the handler. Messages are fixed, never data. */
export class NotPermittedError extends Error {
  constructor() {
    super('not permitted');
  }
}
export class NotFoundError extends Error {
  constructor() {
    super('not found');
  }
}
/** A business rule refused the write (e.g. the do-not-contact guard). `code` is a fixed slug. */
export class RefusedError extends Error {
  constructor(readonly code: 'dnc_blocked' | 'last_manager' | 'self_change' | 'invalid' | 'conflict' | 'disabled') {
    super(code);
  }
}
/** The database could not be reached, or a bounded wait expired before COMMIT was sent. */
export class UnavailableError extends Error {
  constructor() {
    super('unavailable');
  }
}
/** COMMIT was sent but not acknowledged: the outcome is unknown. Never retried automatically. */
export class OutcomeUnknownError extends Error {
  constructor() {
    super('outcome unknown');
  }
}
