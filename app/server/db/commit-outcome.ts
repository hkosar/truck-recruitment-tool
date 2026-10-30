// How a COMMIT answer is classified. This file is kept BYTE-IDENTICAL in
//   app/server/db/commit-outcome.ts   and   pipeline/src/commit-outcome.ts
// (two separate packages, no shared import path); scripts/verify-commit-outcome-contract.mjs fails
// if they differ. It has no imports on purpose.

/**
 * The ONLY errors that, after COMMIT was sent, count as a definite refusal. Each is an error the
 * server raises while COMMIT runs its pre-commit work (deferred constraints and constraint triggers
 * fire, then the serializable-isolation check), before the commit record exists, so PostgreSQL has
 * rolled the transaction back. Evidence per code (PostgreSQL 16 docs, local file, plus a local
 * PostgreSQL 16 repro that shows the row absent afterwards) is in the task report:
 *   23505 unique_violation        - a DEFERRABLE INITIALLY DEFERRED unique constraint, checked at COMMIT
 *   23503 foreign_key_violation   - a DEFERRABLE INITIALLY DEFERRED foreign key, checked at COMMIT
 *   40001 serialization_failure   - SERIALIZABLE read/write dependency cancelled at COMMIT
 * Everything else (an unlisted SQLSTATE, a server shutdown or any FATAL, a transport error, no code
 * at all) is an UNKNOWN outcome. The severity text is never consulted: pg-protocol (parser.js:307)
 * exposes only the localized severity field (S), so it proves nothing on a translated server.
 */
const DEFINITE_COMMIT_REFUSALS: ReadonlySet<string> = new Set(['23505', '23503', '40001']);

/** True only for an allowlisted SQLSTATE; the caller must still confirm the connection is healthy. */
export function isDefiniteCommitRefusal(err: unknown): boolean {
  if (!(err instanceof Error) || !('code' in err)) return false;
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' && DEFINITE_COMMIT_REFUSALS.has(code);
}

/** The client has not reported a connection error and pg still considers it usable. */
export function clientUsable(client: object): boolean {
  const c = client as { _queryable?: boolean; _ending?: boolean };
  return c._queryable !== false && c._ending !== true;
}

/**
 * True when COMMIT was ANSWERED with the command tag ROLLBACK. PostgreSQL does that, without any
 * error, when the transaction had already failed (for example a query error the work caught and
 * ignored): the server rolled everything back. That is affirmative evidence the write is absent,
 * so it is a definite failure (never success, and not an unknown outcome).
 */
export function isRollbackTag(result: unknown): boolean {
  const command = typeof result === 'object' && result !== null ? (result as { command?: unknown }).command : undefined;
  return typeof command === 'string' && command.toUpperCase() === 'ROLLBACK';
}
