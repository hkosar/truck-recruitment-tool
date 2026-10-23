// In-memory fakes for handler tests. They model the store CONTRACT (what the handler may rely
// on), not the SQL; the SQL itself is tested against the A3 database.

import type { SendStatus } from '../auth/ladder';
import type { UserRole } from '../auth/identity';
import type { AuthStore, ContactLogInput, DataStore, MintState, SendEvidence, SessionInfo, TeamMember } from '../core/stores';
import type { AppRequest } from '../core/types';
import { readBodyLimited } from '../http/body';
import { parseCookieHeader } from '../auth/cookies';
import type { AddPersonInput } from '../team/add-person';

export interface FakePerson {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  active: boolean;
}

export class FakeAuthStore implements AuthStore {
  people: FakePerson[] = [];
  buckets = new Map<string, number>();
  links = new Map<string, { id: string; userId: string; recipient: string; createdAtMs: number; used: boolean; revoked: boolean; status: SendStatus; errorCode?: string; requestId?: string }>();
  sessions = new Map<string, { userId: string; kind: 'link' | 'recovery'; revoked: boolean; touches: number }>();
  evidence: SendEvidence[] = [];
  calls: string[] = [];
  /** Make the next calls fail or hang. */
  failWith: Error | undefined;
  /** Make only these methods fail (by name). */
  failCalls = new Set<string>();
  bucketDelayMs = 0;
  nowMs = () => Date.now();
  private seq = 0;

  private guard(name: string) {
    this.calls.push(name);
    if (this.failWith) throw this.failWith;
    if (this.failCalls.has(name)) throw new Error(`injected failure: ${name}`);
  }

  async bucketHit(_kind: 'request', ipHash: string, emailHash: string): Promise<{ ipCount: number; emailCount: number }> {
    this.guard('bucketHit');
    if (this.bucketDelayMs) await new Promise((r) => setTimeout(r, this.bucketDelayMs));
    const ip = (this.buckets.get(`ip:${ipHash}`) ?? 0) + 1;
    const em = (this.buckets.get(`email:${emailHash}`) ?? 0) + 1;
    this.buckets.set(`ip:${ipHash}`, ip);
    this.buckets.set(`email:${emailHash}`, em);
    return { ipCount: ip, emailCount: em };
  }

  async mintIfAllowed(email: string, _day: { start: Date; end: Date }, tokenHash: string, decide: (s: MintState) => { mint: boolean; revokeLinkId?: string }) {
    this.guard('mintIfAllowed');
    const person = this.people.find((p) => p.active && p.email.toLowerCase() === email.toLowerCase());
    if (!person) return null;
    const mine = [...this.links.values()].filter((l) => l.userId === person.id).sort((a, b) => b.createdAtMs - a.createdAtMs);
    const now = this.nowMs();
    const newest = mine[0];
    const decision = decide({
      userId: person.id,
      recipient: person.email,
      blocked: false,
      newest: newest ? { id: newest.id, status: newest.status, createdAtMs: newest.createdAtMs } : undefined,
      lastMinute: mine.filter((l) => now - l.createdAtMs < 60_000).length,
      lastHour: mine.filter((l) => now - l.createdAtMs < 3_600_000).length,
      chicagoDay: mine.length,
    });
    if (!decision.mint) return null;
    if (decision.revokeLinkId) for (const l of this.links.values()) if (l.id === decision.revokeLinkId) l.revoked = true;
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
    this.links.set(tokenHash, { id, userId: person.id, recipient: person.email, createdAtMs: now, used: false, revoked: false, status: 'pending' });
    return { linkId: id, recipient: person.email };
  }

  async recordSend(linkId: string, status: Exclude<SendStatus, 'pending'>, errorCode: string | undefined, requestId: string | undefined) {
    this.guard('recordSend');
    for (const l of this.links.values()) if (l.id === linkId) Object.assign(l, { status, errorCode, requestId });
  }

  async linkCheck(tokenHash: string) {
    this.guard('linkCheck');
    const l = this.links.get(tokenHash);
    const person = l && this.people.find((p) => p.id === l.userId && p.active);
    return l && person && !l.used && !l.revoked && this.nowMs() - l.createdAtMs < 15 * 60_000 ? { recipient: l.recipient } : null;
  }

  async redeem(tokenHash: string, sessionHash: string) {
    this.guard('redeem');
    if (!(await this.linkCheck(tokenHash))) return false;
    const l = this.links.get(tokenHash)!;
    l.used = true;
    this.sessions.set(sessionHash, { userId: l.userId, kind: 'link', revoked: false, touches: 0 });
    return true;
  }

  async sessionInfo(sessionHash: string): Promise<SessionInfo | null> {
    this.guard('sessionInfo');
    const s = this.sessions.get(sessionHash);
    const p = s && this.people.find((x) => x.id === s.userId && x.active);
    if (!s || s.revoked || !p) return null;
    return { userId: p.id, fullName: p.fullName, email: p.email, role: p.role, kind: s.kind, expiresAt: new Date(this.nowMs() + 86_400_000).toISOString(), absoluteExpiresAt: new Date(this.nowMs() + 90 * 86_400_000).toISOString() };
  }

  async touch(sessionHash: string) {
    this.guard('touch');
    const s = this.sessions.get(sessionHash);
    if (s) s.touches += 1;
  }

  async revoke(sessionHash: string) {
    this.guard('revoke');
    const s = this.sessions.get(sessionHash);
    if (s) s.revoked = true;
  }

  async applyEvidence(e: SendEvidence) {
    this.guard('applyEvidence');
    this.evidence.push(e);
    return true;
  }

  /** Test helper: a valid session for a person. */
  addSession(sessionHash: string, userId: string, kind: 'link' | 'recovery' = 'link') {
    this.sessions.set(sessionHash, { userId, kind, revoked: false, touches: 0 });
  }
}

export class FakeDataStore implements DataStore {
  calls: Array<{ op: string; s: string; args: unknown[] }> = [];
  failWith: Error | undefined;
  team: TeamMember[] = [];
  private rec(op: string, s: string, ...args: unknown[]) {
    this.calls.push({ op, s, args });
    if (this.failWith) throw this.failWith;
  }
  async rpc(s: string, name: string, args: Record<string, unknown>) { this.rec('rpc', s, name, args); return [{ name }]; }
  async batchDetail(s: string, id: string) { this.rec('batchDetail', s, id); return { id }; }
  async batchActivity(s: string, id: string, limit: number) { this.rec('batchActivity', s, id, limit); return []; }
  async addComment(s: string, id: string, c: string) { this.rec('addComment', s, id, c); }
  async setMemberStatus(s: string, id: string, dot: number, st: string) { this.rec('setMemberStatus', s, id, dot, st); return true; }
  async promote(s: string, id: string, dot: number) { this.rec('promote', s, id, dot); return true; }
  async logContact(s: string, input: ContactLogInput) { this.rec('logContact', s, input); }
  async sheetHeader(s: string, id: string) { this.rec('sheetHeader', s, id); return { name: 'B' }; }
  async carrierProfile(s: string, dot: number) { this.rec('carrierProfile', s, dot); return { carrier: { dot_number: dot } }; }
  async dashboardBatches(s: string) { this.rec('dashboardBatches', s); return []; }
  async dncLookup(s: string, dots: number[]) { this.rec('dncLookup', s, dots); return { carriers: [], suppressions: [] }; }
  async teamList(s: string) { this.rec('teamList', s); return this.team; }
  async teamUpdate(s: string, t: string, n: string | null, r: UserRole | null, e: string | null) { this.rec('teamUpdate', s, t, n, r, e); }
  async teamSetActive(s: string, t: string, a: boolean) { this.rec('teamSetActive', s, t, a); }
  async teamSignEveryoneOut(s: string) { this.rec('teamSignEveryoneOut', s); return 3; }
  async teamAddPerson(s: string, input: AddPersonInput) { this.rec('teamAddPerson', s, input); return '99999999-9999-4999-8999-999999999999'; }
  async batchRename(s: string, id: string, name: string) { this.rec('batchRename', s, id, name); return { found: true, from: 'Old' }; }
  async batchDelete(s: string, id: string) { this.rec('batchDelete', s, id); return true; }
  async batchListExtras(s: string, id: string, dots: number[]) { this.rec('batchListExtras', s, id, dots); return []; }
  async batchCsvExport(s: string, id: string, dots: number[] | null) { this.rec('batchCsvExport', s, id, dots); return { csv: 'USDOT', rowCount: 0, excluded: 0 }; }
}

/** Builds an AppRequest without any network. */
export function fakeRequest(input: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer | AsyncIterable<Uint8Array>;
  clientIp?: string;
  receivedAt?: number;
}): AppRequest {
  const parsed = new URL(input.url, 'https://recruiter.example.test');
  const headers = new Headers(input.headers ?? {});
  const body = input.body;
  return {
    method: input.method ?? 'GET',
    path: parsed.pathname,
    query: parsed.searchParams,
    headers: { get: (n) => headers.get(n) },
    cookies: parseCookieHeader(headers.get('cookie')),
    clientIp: input.clientIp ?? '203.0.113.7',
    receivedAt: input.receivedAt ?? performance.now(),
    readBody: (max) => {
      const source = body === undefined ? (async function* () {})() : typeof body === 'string' || Buffer.isBuffer(body) ? (async function* () { yield Buffer.from(body); })() : body;
      return readBodyLimited(source, { maxBytes: max, declaredLength: headers.get('content-length') });
    },
  };
}
