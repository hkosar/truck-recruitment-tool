// AuthStore over Postgres: every call is one bounded transaction calling the M1 definer
// functions (supabase/pending/M1_same_origin_signin.sql §8).

import type { SendStatus } from '../auth/ladder';
import type { AuthStore, MintState, SendEvidence, SessionInfo } from '../core/stores';
import type { Database } from './database';

const AUTH_TX = { lockTimeoutMs: 200, statementTimeoutMs: 400, deadlineMs: 600 };
/** The pre-response admission check's own connection-wait limit (D9/F-2); inside its 600 ms budget. */
export const ADMISSION_ACQUIRE_MS = 400;
const IDENTITY_TX = { lockTimeoutMs: 5_000, statementTimeoutMs: 5_000, deadlineMs: 8_000 };

export class PgAuthStore implements AuthStore {
  constructor(private readonly db: Database) {}

  async bucketHit(kind: 'request', ipHash: string, emailHash: string, deadlineMs: number) {
    return this.db.transaction({ ...AUTH_TX, deadlineMs, acquireTimeoutMs: ADMISSION_ACQUIRE_MS }, async (tx) => {
      const { rows } = await tx.query<{ ip_count: number; email_count: number }>('select * from internal.auth_bucket_hit($1, $2, $3)', [kind, ipHash, emailHash]);
      return { ipCount: rows[0].ip_count, emailCount: rows[0].email_count };
    });
  }

  async mintIfAllowed(email: string, day: { start: Date; end: Date }, tokenHash: string, decide: (s: MintState) => { mint: boolean; revokeLinkId?: string }) {
    return this.db.transaction(IDENTITY_TX, async (tx) => {
      const { rows } = await tx.query<{
        user_id: string; recipient: string; blocked: boolean; newest_id: string | null; newest_status: SendStatus | null;
        newest_created_at: Date | null; last_minute: number; last_hour: number; chicago_day: number;
      }>('select * from internal.auth_mint_lock($1, $2, $3)', [email, day.start, day.end]);
      const r = rows[0];
      if (!r) return null;
      const decision = decide({
        userId: r.user_id,
        recipient: r.recipient,
        blocked: r.blocked,
        newest: r.newest_id && r.newest_status && r.newest_created_at ? { id: r.newest_id, status: r.newest_status, createdAtMs: r.newest_created_at.getTime() } : undefined,
        lastMinute: r.last_minute,
        lastHour: r.last_hour,
        chicagoDay: r.chicago_day,
      });
      if (!decision.mint) return null;
      const ins = await tx.query<{ id: string }>('select internal.auth_mint_insert($1, $2, $3, $4) as id', [r.user_id, tokenHash, r.recipient, decision.revokeLinkId ?? null]);
      return { linkId: ins.rows[0].id, recipient: r.recipient };
    });
  }

  async recordSend(linkId: string, status: Exclude<SendStatus, 'pending'>, errorCode: string | undefined, providerRequestId: string | undefined) {
    await this.db.transaction(IDENTITY_TX, (tx) =>
      tx.query('select internal.auth_link_record_send($1, $2, $3, $4)', [linkId, status, errorCode ?? null, providerRequestId ?? null]),
    );
  }

  async linkCheck(tokenHash: string) {
    return this.db.transaction(AUTH_TX, async (tx) => {
      const { rows } = await tx.query<{ recipient_email: string }>('select recipient_email from internal.auth_link_check($1)', [tokenHash]);
      return rows[0] ? { recipient: rows[0].recipient_email } : null;
    });
  }

  async redeem(tokenHash: string, sessionHash: string) {
    return this.db.transaction(IDENTITY_TX, async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>('select internal.auth_link_redeem($1, $2) as id', [tokenHash, sessionHash]);
      return rows[0]?.id != null;
    });
  }

  async sessionInfo(sessionHash: string): Promise<SessionInfo | null> {
    return this.db.transaction({ ...AUTH_TX, deadlineMs: 2_000, sessionHash }, async (tx) => {
      const { rows } = await tx.query<{ user_id: string; full_name: string; email: string; role: SessionInfo['role']; kind: SessionInfo['kind']; expires_at: Date; absolute_expires_at: Date }>(
        'select * from internal.auth_session_info()',
      );
      const r = rows[0];
      return r ? { userId: r.user_id, fullName: r.full_name, email: r.email, role: r.role, kind: r.kind, expiresAt: r.expires_at.toISOString(), absoluteExpiresAt: r.absolute_expires_at.toISOString() } : null;
    });
  }

  async touch(sessionHash: string) {
    await this.db.transaction({ ...AUTH_TX, deadlineMs: 2_000, sessionHash }, (tx) => tx.query('select internal.auth_session_touch()'));
  }

  async revoke(sessionHash: string) {
    await this.db.transaction({ ...AUTH_TX, deadlineMs: 2_000, sessionHash }, (tx) => tx.query('select internal.auth_session_revoke()'));
  }

  async applyEvidence(e: SendEvidence) {
    return this.db.transaction(IDENTITY_TX, async (tx) => {
      const { rows } = await tx.query<{ applied: boolean }>(
        'select internal.auth_apply_send_evidence($1, $2, $3, $4, $5, $6, $7, $8, $9) as applied',
        [e.providerEventId, e.linkId, e.email, e.messageId ?? null, e.eventType, e.reason ?? null, e.status, e.delivered, e.occurredAt],
      );
      return rows[0]?.applied === true;
    });
  }
}
