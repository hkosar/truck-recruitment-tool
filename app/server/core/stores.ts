// The database boundary as two narrow interfaces. Real implementations (server/db/pg-*.ts)
// hold all SQL and run each operation in one transaction with `app.session_hash` set
// transaction-locally; tests use in-memory fakes (server/testing/fakes.ts).

import type { SendStatus } from '../auth/ladder';
import type { SessionKind, UserRole, UserStatus } from '../auth/identity';
import type { CsvExport, MemberExtra } from '../batch/batch-list';

export interface MintState {
  userId: string;
  recipient: string;
  blocked: boolean;
  newest: { id: string; status: SendStatus; createdAtMs: number } | undefined;
  lastMinute: number;
  lastHour: number;
  chicagoDay: number;
}

export interface SessionInfo {
  userId: string;
  fullName: string;
  email: string;
  role: UserRole;
  kind: SessionKind;
  expiresAt: string;
  absoluteExpiresAt: string;
}

export interface SendEvidence {
  providerEventId: string;
  linkId: string;
  email: string;
  messageId: string | undefined;
  eventType: string;
  reason: string | undefined;
  status: SendStatus;
  delivered: boolean;
  occurredAt: Date;
}

export interface AuthStore {
  /** Anonymous flood buckets; bounded by the caller's deadline. */
  bucketHit(kind: 'request', ipHash: string, emailHash: string, deadlineMs: number): Promise<{ ipCount: number; emailCount: number }>;
  /**
   * One transaction: lock the active person by address, call `decide` with the counts read under
   * that lock, and if it says mint, insert the link with `tokenHash`. Returns the new link id.
   */
  mintIfAllowed(
    email: string,
    day: { start: Date; end: Date },
    tokenHash: string,
    decide: (state: MintState) => { mint: boolean; revokeLinkId?: string },
  ): Promise<{ linkId: string; recipient: string } | null>;
  recordSend(linkId: string, status: Exclude<SendStatus, 'pending'>, errorCode: string | undefined, providerRequestId: string | undefined): Promise<void>;
  linkCheck(tokenHash: string): Promise<{ recipient: string } | null>;
  redeem(tokenHash: string, sessionHash: string): Promise<boolean>;
  sessionInfo(sessionHash: string): Promise<SessionInfo | null>;
  touch(sessionHash: string): Promise<void>;
  revoke(sessionHash: string): Promise<void>;
  applyEvidence(evidence: SendEvidence): Promise<boolean>;
}

export interface TeamMember {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
}

export interface ContactLogInput {
  dot_number: number;
  batch_id: string | null;
  channel: string;
  disposition: string;
  notes: string | null;
  next_steps: string | null;
}

/** Every signed-in data operation. `s` is the session hash for the transaction. */
export interface DataStore {
  rpc(s: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  batchDetail(s: string, batchId: string): Promise<unknown>;
  batchActivity(s: string, batchId: string, limit: number): Promise<unknown[]>;
  addComment(s: string, batchId: string, comment: string): Promise<void>;
  setMemberStatus(s: string, batchId: string, dot: number, status: string): Promise<boolean>;
  promote(s: string, batchId: string, dot: number): Promise<boolean>;
  logContact(s: string, input: ContactLogInput): Promise<void>;
  sheetHeader(s: string, batchId: string): Promise<unknown>;
  carrierProfile(s: string, dot: number): Promise<unknown>;
  dashboardBatches(s: string): Promise<unknown[]>;
  dncLookup(s: string, dots: number[]): Promise<{ carriers: unknown[]; suppressions: unknown[] }>;
  teamList(s: string): Promise<TeamMember[]>;
  teamUpdate(s: string, target: string, fullName: string | null, role: UserRole | null, email: string | null): Promise<void>;
  teamSetActive(s: string, target: string, active: boolean): Promise<void>;
  teamSignEveryoneOut(s: string): Promise<number>;
  batchListExtras(s: string, batchId: string, dots: number[]): Promise<MemberExtra[]>;
  batchCsvExport(s: string, batchId: string, dots: number[] | null): Promise<CsvExport>;
}
