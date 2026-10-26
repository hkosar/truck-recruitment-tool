// Nightly sign-in ledger retention step (doc 15 §23, doc 16 §4).
//
// - OFF unless MAINTENANCE_DATABASE_URL is set: then it only logs that it skipped.
// - Its OWN connection as the least-privilege `recruiter_maintenance` login (select/delete on the
//   five sign-in ledgers only). It never uses SUPABASE_DB_URL or the service-role client, so the
//   pipeline's own permissions are unchanged.
// - Fail closed on the target: the URL must parse with the pipeline's own guard (no query string
//   or fragment), use session port 5432 and TLS, name the SAME project the pipeline already verified, and log in as
//   recruiter_maintenance (checked again with current_user after connecting).
// - Never fails the pipeline: refusals and errors are logged (counts and reasons only, never the
//   URL) and alerted; the run continues. If no alert email can be sent, runRetentionForCron reports
//   it so run.ts exits non-zero AFTER ingestion is complete (Render's cron failure notification).

import pg from 'pg';
import type { Config } from './config.js';
import { runRetention, type Queryable, type RetentionResult } from './retention.js';
import { parseSupabaseDbTarget } from './target-guard.js';

export const MAINTENANCE_ROLE = 'recruiter_maintenance';

export type RefusalReason = 'unparseable' | 'other_project' | 'wrong_port' | 'wrong_role' | 'connected_as_other_role';

export type RetentionOutcome =
  | { status: 'skipped'; reason: 'not_configured' }
  | { status: 'refused'; reason: RefusalReason }
  | { status: 'done'; result: RetentionResult }
  | { status: 'failed'; reason: 'connect_or_query_error' };

export interface RetentionClient extends Queryable {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows?: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export interface RetentionStepDeps {
  log: { info(event: string, fields?: Record<string, unknown>): void; error(event: string, fields?: Record<string, unknown>): void };
  /** Called once when the step refuses or fails; must not throw. */
  alert: (message: string) => Promise<void>;
  /** Builds a client from explicit fields (never from the raw string). */
  createClient?: (fields: { host: string; port: number; user: string; password: string; database: string }) => RetentionClient;
}

/**
 * The driver default is NO TLS, and query-string SSL settings are refused by the target guard, so
 * TLS is set explicitly here. Same relaxed pooler certificate setting as db.ts (TODO(live-db)).
 */
export function retentionClientConfig(fields: { host: string; port: number; user: string; password: string; database: string }): pg.ClientConfig {
  return { ...fields, ssl: { rejectUnauthorized: false }, application_name: 'tnbs-retention', connectionTimeoutMillis: 10_000 };
}

const defaultClient: NonNullable<RetentionStepDeps['createClient']> = (fields) =>
  new pg.Client(retentionClientConfig(fields)) as unknown as RetentionClient;

/** The role part of a Supabase user name: `<role>.<ref>` on the shared pooler, `<role>` otherwise. */
export function roleOf(user: string): string {
  const dot = user.lastIndexOf('.');
  return dot >= 0 ? user.slice(0, dot) : user;
}

export async function runRetentionStep(
  config: Pick<Config, 'MAINTENANCE_DATABASE_URL'>,
  verifiedProjectRef: string,
  deps: RetentionStepDeps,
): Promise<RetentionOutcome> {
  const raw = config.MAINTENANCE_DATABASE_URL;
  if (!raw || raw.trim() === '') {
    deps.log.info('retention.skipped', { reason: 'not_configured' });
    return { status: 'skipped', reason: 'not_configured' };
  }
  const refuse = async (reason: RefusalReason): Promise<RetentionOutcome> => {
    deps.log.error('retention.refused', { reason });
    await deps.alert(`Retention refused to run: ${reason}`);
    return { status: 'refused', reason };
  };

  let target: ReturnType<typeof parseSupabaseDbTarget>;
  try {
    target = parseSupabaseDbTarget(raw);
  } catch {
    return refuse('unparseable');
  }
  if (target.projectRef !== verifiedProjectRef) return refuse('other_project');
  // The statement timeout is a session setting: the 6543 transaction pooler would not keep it.
  if (target.port !== 5432) return refuse('wrong_port');
  if (roleOf(target.user) !== MAINTENANCE_ROLE) return refuse('wrong_role');

  const client = (deps.createClient ?? defaultClient)({
    host: target.host, port: target.port, user: target.user, password: target.password, database: target.database,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const who = await client.query('select current_user as u');
    if (who.rows?.[0]?.u !== MAINTENANCE_ROLE) return await refuse('connected_as_other_role');
    const result = await runRetention(client);
    deps.log.info('retention.done', { deleted: result.deleted, failed: result.failed });
    if (result.failed.length > 0) await deps.alert(`Retention: ${result.failed.length} rule(s) failed: ${result.failed.join(', ')}`);
    return { status: 'done', result };
  } catch {
    deps.log.error('retention.failed', { reason: 'connect_or_query_error' });
    await deps.alert('Retention failed: connect or query error');
    return { status: 'failed', reason: 'connect_or_query_error' };
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}

export interface CronRetentionDeps extends Omit<RetentionStepDeps, 'alert'> {
  /** Sends the owner alert; resolves true only if it was actually sent, false if skipped (not configured). */
  sendAlert: (message: string) => Promise<boolean>;
}

/**
 * Runs the retention step for the nightly cron and reports whether a problem went UNALERTED.
 * Retention failure must never fail ingestion, but it must still reach the owner. Email is the
 * existing alert path; when it is not configured or cannot be sent, the caller sets a non-zero
 * exit code AFTER the whole chain has finished and been recorded, so Render's cron failure
 * notification (the existing fallback) fires while the ingested data and pipeline_runs rows stay
 * as they are. This function never throws.
 */
export async function runRetentionForCron(
  config: Pick<Config, 'MAINTENANCE_DATABASE_URL'>,
  verifiedProjectRef: string,
  deps: CronRetentionDeps,
): Promise<{ outcome: RetentionOutcome; unalerted: boolean }> {
  let problem = false;
  let delivered = false;
  const alert = async (message: string): Promise<void> => {
    problem = true;
    try {
      if (await deps.sendAlert(message)) delivered = true;
    } catch {
      deps.log.error('retention.alert_failed', {});
    }
  };
  let outcome: RetentionOutcome;
  try {
    outcome = await runRetentionStep(config, verifiedProjectRef, { ...deps, alert });
  } catch {
    deps.log.error('retention.failed', { reason: 'unexpected_error' });
    outcome = { status: 'failed', reason: 'connect_or_query_error' };
    await alert('Retention failed: unexpected error');
  }
  return { outcome, unalerted: problem && !delivered };
}
