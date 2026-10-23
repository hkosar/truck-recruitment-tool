// A3 DATABASE TESTS (approval A3): run only against the task-owned throwaway cluster, never a
// hosted database. Skipped unless both URLs are set:
//   A3_APP_URL   = postgres://recruiter_app:<throwaway>@127.0.0.1:<port>/tr_signin_test
//   A3_ADMIN_URL = postgres://tr_test_admin:<throwaway>@127.0.0.1:<port>/tr_signin_test
// The database is built by scripts/a3-build-test-db.mjs (Supabase shim, 20 migrations, fixtures, M1).
// This suite uses its OWN database per run (<base>_<run>_store; testing/test-db.ts): its
// emergency sign-out test revokes every staff session, so no other suite may share it.

import { createServer, connect, type Server, type Socket } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotPermittedError, OutcomeUnknownError, RefusedError, UnavailableError } from '../core/types';
import { Database } from './database';
import { PgAuthStore } from './pg-auth-store';
import { PgDataStore } from './pg-data-store';
import { claimSuiteDatabase, suiteDatabase } from '../testing/test-db';
// Loaded machines (manager decision): only TEST timeouts are raised; product limits are unchanged.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const SUITE_DB = suiteDatabase('store');
const APP_URL = SUITE_DB?.appUrl;
const ADMIN_URL = SUITE_DB?.adminUrl;
const enabled = Boolean(SUITE_DB);

const MANAGER = '71000000-0000-4000-8000-000000000001';
const EDITOR = '71000000-0000-4000-8000-000000000002';
const EDITOR2 = '71000000-0000-4000-8000-000000000003';
const VIEWER = '71000000-0000-4000-8000-000000000004';
const BATCH = 'a3b00000-0000-4000-8000-000000000001';

describe.skipIf(!enabled)('A3 database: stores, permissions, concurrency, deadlines', () => {
  let admin: pg.Client;
  let db: Database;
  let auth: PgAuthStore;
  let data: PgDataStore;
  let seq = 0;

  const adminQuery = (sql: string, params?: unknown[]) => admin.query(sql, params);
  async function session(userId: string, kind: 'link' = 'link'): Promise<string> {
    const hash = `test-session-${++seq}-${Date.now()}`;
    await adminQuery(
      `insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at)
       select id, $2, $3, email, now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days' from public.profiles where id = $1`,
      [userId, hash, kind],
    );
    return hash;
  }
  async function appClient(sessionHash: string): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    await c.query('begin');
    await c.query("select set_config('app.session_hash', $1, true)", [sessionHash]);
    await c.query("set local lock_timeout = '10s'");
    return c;
  }
  /** Resolves true if the promise is still pending after `ms` (i.e. it is blocked on a lock). */
  const isBlocked = (p: Promise<unknown>, ms = 400) => Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);
  async function resetEditor() {
    await adminQuery(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await adminQuery(`update public.profiles set role = 'edit', status = 'approved' where id in ($1, $2)`, [EDITOR, EDITOR2]);
    await adminQuery(`update public.carriers set do_not_contact = false where dot_number between 1400001 and 1400005`);
    await adminQuery(`update public.contact_suppressions set expires_at = now() where expires_at is null`);
    // Each test starts from its own clean state, so consecutive runs are independent.
    await adminQuery(`update public.batch_carriers set status = 'new' where batch_id = $1`, [BATCH]);
    await adminQuery(`delete from internal.signin_links where user_id in ($1, $2)`, [EDITOR, EDITOR2]);
    await adminQuery(`delete from internal.blocked_email_addresses where normalized_email like '%@tnbs-recruiter.example.invalid'`);
  }

  let releaseClaim: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseClaim = await claimSuiteDatabase(ADMIN_URL!); // exclusive for this run, or fail loudly
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await adminQuery(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    db = new Database({ connectionString: APP_URL!, max: 6, connectionTimeoutMillis: 2_000 });
    auth = new PgAuthStore(db);
    data = new PgDataStore(db);
  });
  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await releaseClaim?.();
  });

  it('sign-in ledger end to end: mint (under lock, with counts), check, redeem once, session, touch, sign-out', async () => {
    await resetEditor();
    const day = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
    const states: unknown[] = [];
    const minted = await auth.mintIfAllowed('EDITOR@tnbs-recruiter.example.invalid', day, `link-${Date.now()}`, (s) => { states.push(s); return { mint: true }; });
    expect(minted).toMatchObject({ recipient: 'editor@tnbs-recruiter.example.invalid' });
    const second = await auth.mintIfAllowed('editor@tnbs-recruiter.example.invalid', day, `link-b-${Date.now()}`, (s) => { states.push(s); return { mint: false }; });
    expect(second).toBeNull();
    expect(states[1]).toMatchObject({ lastMinute: 1, newest: { status: 'pending' } });
    const tokenHash = (await adminQuery('select token_hash from internal.signin_links where id = $1', [minted!.linkId])).rows[0].token_hash;
    await auth.recordSend(minted!.linkId, 'accepted', undefined, 'req-1');
    expect(await auth.linkCheck(tokenHash)).toEqual({ recipient: 'editor@tnbs-recruiter.example.invalid' });
    const sessionHash = `redeemed-${Date.now()}`;
    expect(await auth.redeem(tokenHash, sessionHash)).toBe(true);
    expect(await auth.redeem(tokenHash, `${sessionHash}-2`)).toBe(false);
    expect(await auth.sessionInfo(sessionHash)).toMatchObject({ userId: EDITOR, role: 'edit', kind: 'link' });
    await auth.touch(sessionHash);
    await auth.revoke(sessionHash);
    expect(await auth.sessionInfo(sessionHash)).toBeNull();
    expect(await auth.mintIfAllowed('nobody@example.invalid', day, `x-${Date.now()}`, () => ({ mint: true }))).toBeNull();
  });

  it('delivery lattice: definite failure is terminal; a conflicting message id is rejected before any update', async () => {
    await resetEditor();
    const run = Date.now();
    const day = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
    const minted = await auth.mintIfAllowed('editor-two@tnbs-recruiter.example.invalid', day, `link-c-${Date.now()}`, () => ({ mint: true }));
    await auth.recordSend(minted!.linkId, 'accepted', undefined, 'req-2');
    const ev = (id: string, messageId: string, status: 'accepted' | 'definite_failure', eventType: string) => ({
      providerEventId: `${id}-${run}`, linkId: minted!.linkId, email: 'editor-two@tnbs-recruiter.example.invalid', messageId, eventType, reason: undefined, status, delivered: false, occurredAt: new Date(),
    });
    expect(await auth.applyEvidence(ev(`e1-${seq}`, 'msg-A', 'definite_failure', 'bounced'))).toBe(true);
    expect(await auth.applyEvidence(ev(`e2-${seq}`, 'msg-B', 'accepted', 'delivered'))).toBe(false);
    expect(await auth.applyEvidence(ev(`e1-${seq}`, 'msg-A', 'definite_failure', 'bounced'))).toBe(false);
    const row = (await adminQuery('select send_status, provider_message_id from internal.signin_links where id = $1', [minted!.linkId])).rows[0];
    expect(row).toEqual({ send_status: 'definite_failure', provider_message_id: 'msg-A' });
    await adminQuery("delete from internal.blocked_email_addresses where normalized_email = 'editor-two@tnbs-recruiter.example.invalid'");
  });

  it('permissions through the stores: editor writes, viewer refused, DNC guard, emergency sign-out by manager only', async () => {
    await resetEditor();
    const ed = await session(EDITOR);
    const vw = await session(VIEWER);
    const mg = await session(MANAGER);
    expect(await data.setMemberStatus(ed, BATCH, 1400002, 'attempted')).toBe(true);
    await expect(data.setMemberStatus(vw, BATCH, 1400002, 'contacted')).rejects.toBeInstanceOf(NotPermittedError);
    await data.logContact(ed, { dot_number: 1400002, batch_id: BATCH, channel: 'call', disposition: 'connected', notes: 'A3', next_steps: null });
    await data.rpc(ed, 'set_do_not_contact', { p_dot: 1400002, p_on: true, p_reason: 'A3' });
    await expect(data.logContact(ed, { dot_number: 1400002, batch_id: BATCH, channel: 'call', disposition: 'connected', notes: null, next_steps: null }))
      .rejects.toEqual(new RefusedError('dnc_blocked'));
    expect((await data.teamList(mg)).length).toBeGreaterThanOrEqual(7);
    await expect(data.teamList(ed)).rejects.toBeInstanceOf(NotPermittedError);
    await expect(data.teamSignEveryoneOut(ed)).rejects.toBeInstanceOf(NotPermittedError);
    const revoked = await data.teamSignEveryoneOut(mg);
    expect(revoked).toBeGreaterThanOrEqual(3);
    for (const s of [ed, vw, mg]) expect(await auth.sessionInfo(s)).toBeNull();
    const events = (await adminQuery("select count(*)::int as n from internal.auth_events where kind = 'emergency_sign_out' and user_id = $1", [MANAGER])).rows[0].n;
    expect(events).toBeGreaterThanOrEqual(1);
  });

  // Hunter decision 2026-10-21: emergency sign-out also cancels every unused sign-in link and
  // unused recovery credential, coordinated with mint/redeem/enroll/consume through I1.
  async function unusedLink(userId: string, hash: string) {
    await adminQuery(
      `insert into internal.signin_links (user_id, token_hash, recipient_email, created_at, expires_at, send_status, send_attempted_at)
       select id, $2, email, now(), now() + interval '15 minutes', 'accepted', now() from public.profiles where id = $1`,
      [userId, hash],
    );
  }
  const linkRow = async (hash: string) => (await adminQuery('select used_at, revoked_at, revoked_reason from internal.signin_links where token_hash = $1', [hash])).rows[0];

  it('emergency sign-out cancels every unused link and recovery credential; used records and the audit stay', async () => {
    await resetEditor();
    const t = Date.now();
    await adminQuery(`update internal.recovery_sets set revoked_at = now(), revoked_reason = 'test_reset' where revoked_at is null`);
    await unusedLink(EDITOR, `eso-unused-${t}`);
    await unusedLink(EDITOR2, `eso-used-${t}`);
    await adminQuery('update internal.signin_links set used_at = now() where token_hash = $1', [`eso-used-${t}`]);
    const set = (await adminQuery('insert into internal.recovery_sets (user_id) values ($1) returning id', [VIEWER])).rows[0].id;
    await adminQuery(
      `insert into internal.recovery_codes (set_id, user_id, code_hash, expires_at, used_at)
       values ($1, $2, $3, now() + interval '180 days', now()), ($1, $2, $4, now() + interval '180 days', null)`,
      [set, VIEWER, `eso-code-used-${t}`, `eso-code-unused-${t}`],
    );
    const usedCode = (await adminQuery('select id from internal.recovery_codes where code_hash = $1', [`eso-code-used-${t}`])).rows[0].id;
    const recoveryHash = `eso-recovery-session-${t}`;
    await adminQuery(
      `insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at, recovery_code_id)
       select id, $2, 'recovery', email, now(), now(), interval '1 hour', now() + interval '1 hour', now() + interval '12 hours', $3 from public.profiles where id = $1`,
      [VIEWER, recoveryHash, usedCode],
    );
    const mg = await session(MANAGER);
    // Non-staff (role guest: the legacy guest and pending fixtures) hold credentials here only
    // because the test inserts them directly; the app never issues them any. Staff scope
    // (Gate 2 review N3) must leave them exactly as they are. A disabled STAFF account is staff.
    const id = async (email: string) => (await adminQuery('select id from public.profiles where email = $1', [email])).rows[0].id as string;
    const GUEST = await id('guest@tnbs-recruiter.example.invalid');
    const PENDING = await id('pending@tnbs-recruiter.example.invalid');
    const DISABLED = await id('disabled@tnbs-recruiter.example.invalid');
    const guestSession = await session(GUEST);
    const pendingSession = await session(PENDING);
    await unusedLink(GUEST, `eso-guest-link-${t}`);
    await unusedLink(PENDING, `eso-pending-link-${t}`);
    await unusedLink(DISABLED, `eso-disabled-link-${t}`);
    const guestSet = (await adminQuery('insert into internal.recovery_sets (user_id) values ($1) returning id', [GUEST])).rows[0].id;
    await adminQuery(
      `insert into internal.recovery_codes (set_id, user_id, code_hash, expires_at) values ($1, $2, $3, now() + interval '180 days')`,
      [guestSet, GUEST, `eso-guest-code-${t}`],
    );

    expect(await data.teamSignEveryoneOut(mg)).toBeGreaterThanOrEqual(2);

    for (const hash of [guestSession, pendingSession]) {
      expect((await adminQuery('select revoked_at from internal.app_sessions where token_hash = $1', [hash])).rows[0].revoked_at).toBeNull();
    }
    for (const hash of [`eso-guest-link-${t}`, `eso-pending-link-${t}`]) expect(await linkRow(hash)).toMatchObject({ used_at: null, revoked_at: null });
    expect((await adminQuery('select revoked_at from internal.recovery_sets where id = $1', [guestSet])).rows[0].revoked_at).toBeNull();
    expect((await adminQuery('select revoked_at from internal.recovery_codes where code_hash = $1', [`eso-guest-code-${t}`])).rows[0].revoked_at).toBeNull();
    expect(await linkRow(`eso-disabled-link-${t}`)).toMatchObject({ used_at: null, revoked_reason: 'emergency_sign_out' });
    // Leave no live non-staff credentials behind for later tests.
    await adminQuery(`update internal.app_sessions set revoked_at = now(), revoked_reason = 'test_reset' where token_hash = any($1) and revoked_at is null`, [[guestSession, pendingSession]]);
    await adminQuery(`update internal.recovery_codes set revoked_at = now(), revoked_reason = 'test_reset' where set_id = $1 and used_at is null and revoked_at is null`, [guestSet]);
    await adminQuery(`update internal.recovery_sets set revoked_at = now(), revoked_reason = 'test_reset' where id = $1 and revoked_at is null`, [guestSet]);

    expect(await linkRow(`eso-unused-${t}`)).toMatchObject({ used_at: null, revoked_reason: 'emergency_sign_out' });
    const used = await linkRow(`eso-used-${t}`);
    expect(used.used_at).not.toBeNull();
    expect(used.revoked_at).toBeNull();
    expect((await adminQuery('select revoked_reason from internal.recovery_sets where id = $1', [set])).rows[0].revoked_reason).toBe('emergency_sign_out');
    const codes = (await adminQuery('select code_hash, used_at, revoked_reason from internal.recovery_codes where set_id = $1 order by code_hash', [set])).rows;
    expect(codes.find((c) => c.code_hash === `eso-code-unused-${t}`)).toMatchObject({ used_at: null, revoked_reason: 'emergency_sign_out' });
    expect(codes.find((c) => c.code_hash === `eso-code-used-${t}`)).toMatchObject({ revoked_reason: null });
    expect(codes.find((c) => c.code_hash === `eso-code-used-${t}`)!.used_at).not.toBeNull();
    expect(await auth.sessionInfo(recoveryHash)).toBeNull();
    expect(await auth.sessionInfo(mg)).toBeNull();
    const audit = (await adminQuery(
      "select detail from internal.auth_events where kind = 'emergency_sign_out' and user_id = $1 order by id desc limit 1", [MANAGER])).rows[0].detail;
    expect(audit.links_cancelled).toBeGreaterThanOrEqual(1);
    expect(audit.recovery_sets_cancelled).toBeGreaterThanOrEqual(1);
    expect(audit.recovery_codes_cancelled).toBeGreaterThanOrEqual(1);
  });

  it('emergency sign-out first: a concurrent redemption waits, then finds its link cancelled; no session survives', async () => {
    await resetEditor();
    const t = Date.now();
    await unusedLink(EDITOR, `eso-race-a-${t}`);
    const mg = await session(MANAGER);
    const out = await appClient(mg);
    await out.query('select public.team_sign_everyone_out()');
    const redeem = auth.redeem(`eso-race-a-${t}`, `eso-race-a-session-${t}`);
    expect(await isBlocked(redeem)).toBe(true);
    await out.query('commit');
    await out.end();
    expect(await redeem).toBe(false);
    expect(await auth.sessionInfo(`eso-race-a-session-${t}`)).toBeNull();
    expect(await linkRow(`eso-race-a-${t}`)).toMatchObject({ used_at: null, revoked_reason: 'emergency_sign_out' });
  });

  it('redemption first: emergency sign-out waits, then revokes the session the redemption created', async () => {
    await resetEditor();
    const t = Date.now();
    await unusedLink(EDITOR, `eso-race-b-${t}`);
    const mg = await session(MANAGER);
    const red = await appClient('none');
    expect((await red.query('select internal.auth_link_redeem($1, $2) as id', [`eso-race-b-${t}`, `eso-race-b-session-${t}`])).rows[0].id).not.toBeNull();
    const out = data.teamSignEveryoneOut(mg);
    expect(await isBlocked(out)).toBe(true);
    await red.query('commit');
    await red.end();
    expect(await out).toBeGreaterThanOrEqual(1);
    expect(await auth.sessionInfo(`eso-race-b-session-${t}`)).toBeNull();
    expect((await linkRow(`eso-race-b-${t}`)).used_at).not.toBeNull();
  });

  it('mint first: emergency sign-out waits, then cancels the link the mint created', async () => {
    await resetEditor();
    const t = Date.now();
    const mg = await session(MANAGER);
    const mint = await appClient('none');
    const day = [new Date(t - 86_400_000), new Date(t + 86_400_000)];
    const r = (await mint.query('select * from internal.auth_mint_lock($1, $2, $3)', ['editor@tnbs-recruiter.example.invalid', ...day])).rows[0];
    await mint.query('select internal.auth_mint_insert($1, $2, $3, null)', [r.user_id, `eso-race-c-${t}`, r.recipient]);
    const out = data.teamSignEveryoneOut(mg);
    expect(await isBlocked(out)).toBe(true);
    await mint.query('commit');
    await mint.end();
    await out;
    expect(await linkRow(`eso-race-c-${t}`)).toMatchObject({ used_at: null, revoked_reason: 'emergency_sign_out' });
  });

  // Gate 2 review finding 2: a session that expires while the write waits for a lock is refused
  // after the wait (wall clock), on the real store paths. Waits stay under DATA_TX's 2 s lock timeout.
  async function shortSession(userId: string, ms: number): Promise<string> {
    const hash = `short-session-${++seq}-${Date.now()}`;
    await adminQuery(
      `insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at)
       select id, $2, 'link', email, now(), now(), interval '30 days', clock_timestamp() + make_interval(secs => $3::float / 1000), now() + interval '90 days'
       from public.profiles where id = $1`,
      [userId, hash, ms],
    );
    return hash;
  }
  async function holdLock(sql: string, params: unknown[]): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query('begin');
    await c.query(sql, params);
    return c;
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('expiry during a wait, comment path: the batch-lock wait outlasts the session; the comment is refused, nothing written', async () => {
    await resetEditor();
    const marker = `expiry-comment-${Date.now()}`;
    const s = await shortSession(EDITOR, 800);
    const holder = await holdLock('select 1 from public.batches where id = $1 for update', [BATCH]);
    const write = data.addComment(s, BATCH, marker);
    expect(await isBlocked(write)).toBe(true);
    await sleep(1_000);
    await holder.query('commit');
    await holder.end();
    await expect(write).rejects.toBeInstanceOf(NotPermittedError);
    expect((await adminQuery('select count(*)::int as n from public.batch_activity where comment = $1', [marker])).rows[0].n).toBe(0);
  });

  it('expiry during a wait, export logging: the batch-lock wait outlasts the session; the export is refused, nothing written', async () => {
    await resetEditor();
    const rowCount = 40_000 + (Date.now() % 1_000);
    const s = await shortSession(EDITOR, 800);
    const holder = await holdLock('select 1 from public.batches where id = $1 for update', [BATCH]);
    const write = data.rpc(s, 'log_export', { p_batch_id: BATCH, p_kind: 'csv', p_row_count: rowCount });
    expect(await isBlocked(write)).toBe(true);
    await sleep(1_000);
    await holder.query('commit');
    await holder.end();
    await expect(write).rejects.toBeInstanceOf(NotPermittedError);
    expect((await adminQuery("select count(*)::int as n from public.batch_activity where activity_type = 'export' and (payload->>'row_count')::int = $1", [rowCount])).rows[0].n).toBe(0);
  });

  it('expiry during an implicit member-row wait: the status update is refused after the wait, row unchanged', async () => {
    await resetEditor();
    const s = await shortSession(EDITOR, 800);
    const holder = await holdLock('select 1 from public.batch_carriers where batch_id = $1 and dot_number = $2 for update', [BATCH, 1400003]);
    const write = data.setMemberStatus(s, BATCH, 1400003, 'contacted');
    expect(await isBlocked(write)).toBe(true);
    await sleep(1_000);
    await holder.query('commit');
    await holder.end();
    await expect(write).rejects.toBeInstanceOf(NotPermittedError);
    expect((await adminQuery('select status::text from public.batch_carriers where batch_id = $1 and dot_number = $2', [BATCH, 1400003])).rows[0].status).toBe('new');
  });

  it('expiry during a wait, link redemption: a link that expires while redemption waits is not redeemed', async () => {
    await resetEditor();
    const hash = `expiry-link-${Date.now()}`;
    await adminQuery(
      `insert into internal.signin_links (user_id, token_hash, recipient_email, created_at, expires_at, send_status, send_attempted_at)
       select id, $2, email, ts, ts + interval '15 minutes', 'accepted', now()
       from public.profiles, lateral (select clock_timestamp() - interval '15 minutes' + interval '800 milliseconds' as ts) t where id = $1`,
      [EDITOR, hash],
    );
    const holder = await holdLock('select 1 from public.profiles where id = $1 for update', [EDITOR]);
    const redeem = auth.redeem(hash, `expiry-link-session-${Date.now()}`);
    expect(await isBlocked(redeem)).toBe(true);
    await sleep(1_000);
    await holder.query('commit');
    await holder.end();
    expect(await redeem).toBe(false);
    expect(await linkRow(hash)).toMatchObject({ used_at: null });
  });

  // Task D (M1b, D8 approved 2026-10-22): a manager adds a person.
  const addInput = (email: string, role: 'manager' | 'edit' | 'view' = 'edit', mobile: string | null = null) => ({ fullName: 'Added Person', email, role, mobile });
  async function recoverySession(userId: string): Promise<string> {
    const t = `${Date.now()}-${++seq}`;
    await adminQuery(`update internal.recovery_sets set revoked_at = now(), revoked_reason = 'test_reset' where user_id = $1 and revoked_at is null`, [userId]);
    const set = (await adminQuery('insert into internal.recovery_sets (user_id) values ($1) returning id', [userId])).rows[0].id;
    const code = (await adminQuery(`insert into internal.recovery_codes (set_id, user_id, code_hash, expires_at, used_at) values ($1, $2, $3, now() + interval '180 days', now()) returning id`, [set, userId, `add-person-code-${t}`])).rows[0].id;
    const hash = `add-person-recovery-${t}`;
    await adminQuery(
      `insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at, recovery_code_id)
       select id, $2, 'recovery', email, now(), now(), interval '1 hour', now() + interval '1 hour', now() + interval '12 hours', $3 from public.profiles where id = $1`,
      [userId, hash, code],
    );
    return hash;
  }

  it('add person: a manager adds; the row is approved, normalized and audited; the mobile is internal and unverified', async () => {
    await resetEditor();
    const t = Date.now();
    const mg = await session(MANAGER);
    const id = await data.teamAddPerson(mg, addInput(`Added.Person.${t}@Example.Invalid`, 'view', '+15551234567'));
    const row = (await adminQuery('select email, full_name, role::text, status::text, approved_by from public.profiles where id = $1', [id])).rows[0];
    expect(row).toEqual({ email: `added.person.${t}@example.invalid`, full_name: 'Added Person', role: 'view', status: 'approved', approved_by: MANAGER });
    expect((await adminQuery('select count(*)::int as n from auth.users where id = $1', [id])).rows[0].n).toBe(0); // no old sign-in account
    expect((await adminQuery('select mobile, entered_by from internal.staff_mobile_unverified where user_id = $1', [id])).rows[0]).toEqual({ mobile: '+15551234567', entered_by: MANAGER });
    const audit = (await adminQuery("select detail from internal.auth_events where kind = 'team_add_person' and user_id = $1", [id])).rows[0].detail;
    expect(audit).toEqual({ by: MANAGER, role: 'view', mobile_entered: true });
    // The app role cannot read the mobile table at all.
    const app = await appClient(mg);
    await expect(app.query('select mobile from internal.staff_mobile_unverified')).rejects.toMatchObject({ code: '42501' });
    await app.query('rollback');
    await app.end();
  });

  it('add person: editor, viewer and a manager recovery session are refused; nothing is written', async () => {
    await resetEditor();
    const t = Date.now();
    const email = `refused.${t}@example.invalid`;
    for (const s of [await session(EDITOR), await session(VIEWER), await recoverySession(MANAGER)]) {
      await expect(data.teamAddPerson(s, addInput(email))).rejects.toBeInstanceOf(NotPermittedError);
    }
    expect((await adminQuery('select count(*)::int as n from public.profiles where lower(email) = $1', [email])).rows[0].n).toBe(0);
  });

  it('add person: any address already on the roster is refused (case-insensitive; disabled and legacy rows too)', async () => {
    await resetEditor();
    const t = Date.now();
    const mg = await session(MANAGER);
    await data.teamAddPerson(mg, addInput(`dup.${t}@example.invalid`));
    for (const email of [`DUP.${t}@Example.Invalid`, 'disabled@tnbs-recruiter.example.invalid', 'pending@tnbs-recruiter.example.invalid', 'editor@tnbs-recruiter.example.invalid']) {
      await expect(data.teamAddPerson(await session(MANAGER), addInput(email))).rejects.toEqual(new RefusedError('conflict'));
    }
    await expect(data.teamAddPerson(await session(MANAGER), { ...addInput(`guest.${t}@example.invalid`), role: 'guest' as never })).rejects.toEqual(new RefusedError('invalid'));
  });

  it('add person: the added person requests a link, signs in, and is included in an emergency sign-out', async () => {
    await resetEditor();
    const t = Date.now();
    const email = `newhire.${t}@example.invalid`;
    const id = await data.teamAddPerson(await session(MANAGER), addInput(email, 'edit'));
    const day = { start: new Date(t - 86_400_000), end: new Date(t + 86_400_000) };
    const minted = await auth.mintIfAllowed(email, day, `newhire-link-${t}`, () => ({ mint: true }));
    expect(minted).toMatchObject({ recipient: email });
    const sessionHash = `newhire-session-${t}`;
    expect(await auth.redeem(`newhire-link-${t}`, sessionHash)).toBe(true);
    expect(await auth.sessionInfo(sessionHash)).toMatchObject({ userId: id, role: 'edit', kind: 'link' });
    await data.teamSignEveryoneOut(await session(MANAGER));
    expect(await auth.sessionInfo(sessionHash)).toBeNull();
  });

  it('role loss, write first: the demotion waits; the write commits first and stands; then the session is revoked', async () => {
    await resetEditor();
    const ed = await session(EDITOR);
    const mg = await session(MANAGER);
    const w = await appClient(ed);
    await w.query("select internal.lock_and_validate(array['manager','edit']::user_role[], array['link'])");
    const t = await appClient(mg);
    const demote = t.query("select public.team_update($1, null, 'view', null)", [EDITOR]);
    expect(await isBlocked(demote)).toBe(true);
    await w.query('select 1 from public.batches where id = $1 for key share', [BATCH]);
    await w.query("update public.batch_carriers set status = 'interested' where batch_id = $1 and dot_number = 1400003", [BATCH]);
    await w.query('commit');
    await demote;
    await t.query('commit');
    await w.end();
    await t.end();
    expect((await adminQuery('select status from public.batch_carriers where batch_id = $1 and dot_number = 1400003', [BATCH])).rows[0].status).toBe('interested');
    expect(await auth.sessionInfo(ed)).toBeNull();
  });

  it('role loss, demotion first: the write waits, then is refused; nothing written', async () => {
    await resetEditor();
    const ed = await session(EDITOR);
    const mg = await session(MANAGER);
    const t = await appClient(mg);
    await t.query("select public.team_update($1, null, 'view', null)", [EDITOR]);
    const w = await appClient(ed);
    const write = w.query("select internal.lock_and_validate(array['manager','edit']::user_role[], array['link'])");
    expect(await isBlocked(write)).toBe(true);
    await t.query('commit');
    await expect(write).rejects.toMatchObject({ code: '42501' });
    await w.query('rollback');
    await w.end();
    await t.end();
  });

  it('self-repromotion after demotion is refused', async () => {
    await resetEditor();
    await adminQuery(`update public.profiles set role = 'manager' where id = $1`, [EDITOR2]);
    const ed2 = await session(EDITOR2);
    const mg = await session(MANAGER);
    await data.teamUpdate(mg, EDITOR2, null, 'view', null);
    await expect(data.teamUpdate(ed2, EDITOR2, null, 'manager', null)).rejects.toBeInstanceOf(NotPermittedError);
    const ed2b = await session(EDITOR2);
    await expect(data.teamUpdate(ed2b, EDITOR, null, 'manager', null)).rejects.toBeInstanceOf(NotPermittedError);
  });

  it('DNC vs contact log, both orders, decided by carrier-lock grant', async () => {
    await resetEditor();
    const ed = await session(EDITOR);
    const ed2 = await session(EDITOR2);
    // log first: DNC waits; log commits; then DNC applies.
    const logC = await appClient(ed);
    await logC.query(`insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition) values (1400004, $1, $2, 'call', 'connected')`, [BATCH, EDITOR]);
    const dncC = await appClient(ed2);
    const dnc = dncC.query("select public.set_do_not_contact(1400004, true, 'A3')");
    expect(await isBlocked(dnc)).toBe(true);
    await logC.query('commit');
    await dnc;
    await dncC.query('commit');
    // DNC first (now on): a new log waits on the carrier, then is refused.
    await adminQuery('update public.carriers set do_not_contact = false where dot_number = 1400005');
    const dnc2 = await appClient(ed2);
    await dnc2.query("select public.set_do_not_contact(1400005, true, 'A3')");
    const log2 = await appClient(ed);
    const late = log2.query(`insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition) values (1400005, $1, $2, 'call', 'connected')`, [BATCH, EDITOR]);
    expect(await isBlocked(late)).toBe(true);
    await dnc2.query('commit');
    await expect(late).rejects.toMatchObject({ code: '23514' });
    await log2.query('rollback');
    for (const c of [logC, dncC, dnc2, log2]) await c.end();
  });

  it('bulk status writes exactly its frozen set: a requested member inserted after the locks stays untouched', async () => {
    await resetEditor();
    await adminQuery(`delete from public.batch_carriers where batch_id = $1 and dot_number = 1400004`, [BATCH]);
    const ed = await session(EDITOR);
    const bulk = await appClient(ed);
    const count = await bulk.query(`select public.bulk_set_status($1, array[1400001, 1400004]::bigint[], 'contacted') as n`, [BATCH]);
    // Insert the requested-but-absent member from another connection while the bulk transaction is open.
    await adminQuery(`insert into public.batch_carriers (batch_id, dot_number) values ($1, 1400004)`, [BATCH]);
    await bulk.query('commit');
    await bulk.end();
    expect(count.rows[0].n).toEqual({ changed: 1, skipped: [] });
    expect((await adminQuery(`select status from public.batch_carriers where batch_id = $1 and dot_number = 1400004`, [BATCH])).rows[0].status).toBe('new');
  });

  const statusOf = async (dot: number) => (await adminQuery(`select status from public.batch_carriers where batch_id = $1 and dot_number = $2`, [BATCH, dot])).rows[0].status;

  it('bulk status skips global-DNC members (flag or carrier-wide suppression) and says which', async () => {
    await resetEditor();
    await adminQuery('update public.carriers set do_not_contact = true where dot_number = 1400002');
    await adminQuery(`insert into public.contact_suppressions (dot_number, channel, reason, source) values (1400003, 'all', 'A3 bulk', 'manual') on conflict (dot_number, channel) where value is null do update set expires_at = null`);
    const ed = await session(EDITOR);
    const vw = await session(VIEWER);
    const r = await data.rpc(ed, 'bulk_set_status', { p_batch_id: BATCH, p_dots: [1400001, 1400002, 1400003], p_status: 'contacted' });
    expect(r).toEqual({ changed: 1, skipped: [1400002, 1400003] });
    expect(await statusOf(1400001)).toBe('contacted');
    expect(await statusOf(1400002)).toBe('new');
    expect(await statusOf(1400003)).toBe('new');
    const skippedLog = (await adminQuery(`select payload from public.batch_activity where batch_id = $1 and payload ? 'skipped_dnc' order by id desc limit 1`, [BATCH])).rows[0].payload;
    expect(skippedLog.skipped_dnc).toEqual([1400002, 1400003]);
    // An expired suppression no longer blocks.
    await adminQuery(`update public.contact_suppressions set expires_at = now() - interval '1 minute' where dot_number = 1400003 and channel = 'all' and value is null`);
    expect(await data.rpc(ed, 'bulk_set_status', { p_batch_id: BATCH, p_dots: [1400003], p_status: 'interested' })).toEqual({ changed: 1, skipped: [] });
    await expect(data.rpc(vw, 'bulk_set_status', { p_batch_id: BATCH, p_dots: [1400001], p_status: 'new' })).rejects.toBeInstanceOf(NotPermittedError);
    await resetEditor();
  });

  it('bulk status vs a concurrent DNC set, both orders, decided by the carrier lock', async () => {
    await resetEditor();
    const ed = await session(EDITOR);
    const ed2 = await session(EDITOR2);
    // Bulk first: the DNC set waits for the bulk transaction; the status change already happened.
    const bulkC = await appClient(ed);
    const first = await bulkC.query(`select public.bulk_set_status($1, array[1400002]::bigint[], 'contacted') as n`, [BATCH]);
    expect(first.rows[0].n).toEqual({ changed: 1, skipped: [] });
    const dncC = await appClient(ed2);
    const dnc = dncC.query("select public.set_do_not_contact(1400002, true, 'A3 race')");
    expect(await isBlocked(dnc)).toBe(true);
    await bulkC.query('commit');
    await dnc;
    await dncC.query('commit');
    expect(await statusOf(1400002)).toBe('contacted');
    // DNC first: the bulk call waits for the DNC transaction, then skips the carrier.
    await adminQuery('update public.carriers set do_not_contact = false where dot_number = 1400003');
    const dnc2 = await appClient(ed2);
    await dnc2.query("select public.set_do_not_contact(1400003, true, 'A3 race')");
    const bulk2 = await appClient(ed);
    const late = bulk2.query(`select public.bulk_set_status($1, array[1400001, 1400003]::bigint[], 'interested') as n`, [BATCH]);
    expect(await isBlocked(late)).toBe(true);
    await dnc2.query('commit');
    expect((await late).rows[0].n).toEqual({ changed: 1, skipped: [1400003] });
    await bulk2.query('commit');
    expect(await statusOf(1400001)).toBe('interested');
    expect(await statusOf(1400003)).toBe('new');
    for (const c of [bulkC, dncC, dnc2, bulk2]) await c.end();
    await resetEditor();
  });

  it('batch list: insurance and distance extras; CSV leaves out global-DNC carriers in the database, logs the export, refuses viewers', async () => {
    await resetEditor();
    // The harness shim has no st_distance (real PostGIS does); add a metres stand-in for this database only.
    await adminQuery(`create or replace function public.st_distance(a geography, b geography) returns float8 language sql immutable as $$
      with pa as (select split_part(regexp_replace(a::text, '^POINT\\((.*)\\)$', '\\1'), ' ', 1)::float8 as x, split_part(regexp_replace(a::text, '^POINT\\((.*)\\)$', '\\1'), ' ', 2)::float8 as y),
           vb as (select split_part(btrim(v), ' ', 1)::float8 as x, split_part(btrim(v), ' ', 2)::float8 as y from unnest(string_to_array(regexp_replace(b::text, '^[A-Z]+\\((.*)\\)$', '\\1'), ',')) v)
      select min(6371000 * 2 * asin(sqrt(power(sin(radians(vb.y - pa.y) / 2), 2) + cos(radians(pa.y)) * cos(radians(vb.y)) * power(sin(radians(vb.x - pa.x) / 2), 2)))) from pa, vb $$`);
    const ed = await session(EDITOR);
    const vw = await session(VIEWER);
    const zone = (await adminQuery(
      `insert into public.batch_zones (batch_id, zone_type, label, params, geom, distance_miles)
       values ($1, 'radius', 'A3 list zone', '{"lng":-97.74,"lat":31.27,"radius_miles":50}'::jsonb, 'POINT(-97.74 31.27)'::geography, 50) returning id`,
      [BATCH],
    )).rows[0].id;
    await adminQuery(`insert into public.carrier_insurance (dot_number, bipd_required, bipd_on_file) values (1400001, 750000, 1000000) on conflict (dot_number) do update set bipd_on_file = 1000000`);
    try {
      const extras = await data.batchListExtras(ed, BATCH, [1400001, 1400002, 1400002]);
      expect(extras.map((e) => e.dot_number).sort()).toEqual([1400001, 1400002]);
      const one = extras.find((e) => e.dot_number === 1400001)!;
      expect(one).toMatchObject({ bipd_on_file: 1_000_000, bipd_required: 750_000 });
      expect(one.distance_mi).toBeGreaterThan(68);
      expect(one.distance_mi).toBeLessThan(70);
      expect(extras.find((e) => e.dot_number === 1400002)).toMatchObject({ bipd_on_file: null, bipd_required: null });
      expect(await data.batchListExtras(ed, BATCH, [])).toEqual([]);
      expect(await data.batchListExtras(ed, BATCH, [999])).toEqual([]);

      // 1400002 is DNC by flag, 1400003 by an unexpired carrier-wide suppression.
      await adminQuery('update public.carriers set do_not_contact = true where dot_number = 1400002');
      await adminQuery(`insert into public.contact_suppressions (dot_number, channel, reason, source) values (1400003, 'all', 'A3 list', 'manual') on conflict (dot_number, channel) where value is null do update set expires_at = null`);
      const exportsBefore = (await adminQuery(`select count(*)::int as n from public.batch_activity where batch_id = $1 and activity_type = 'export'`, [BATCH])).rows[0].n;
      const some = await data.batchCsvExport(ed, BATCH, [1400001, 1400002, 1400003]);
      expect(some.rowCount).toBe(1);
      expect(some.excluded).toBe(2);
      const lines = some.csv.trim().split('\r\n');
      expect(lines[0]).toBe('USDOT,Legal name,DBA,Contact name,Phone,Cell phone,Email,City,State,Status,Warnings,Last contact (UTC)');
      expect(lines).toHaveLength(2);
      expect(lines[1].startsWith('1400001,')).toBe(true);
      expect(some.csv).not.toContain('1400002');
      expect(some.csv).not.toContain('1400003');
      const whole = await data.batchCsvExport(ed, BATCH, null);
      expect(whole.csv).not.toMatch(/(^|\r\n)(1400002|1400003),/);
      expect(whole.rowCount + whole.excluded).toBe((await adminQuery('select count(*)::int as n from public.batch_carriers where batch_id = $1', [BATCH])).rows[0].n);
      const logged = (await adminQuery(`select payload from public.batch_activity where batch_id = $1 and activity_type = 'export' order by id desc limit 2`, [BATCH])).rows;
      expect(logged[1].payload).toEqual({ kind: 'csv', row_count: 1 });
      expect(logged[0].payload).toEqual({ kind: 'csv', row_count: whole.rowCount });
      expect((await adminQuery(`select count(*)::int as n from public.batch_activity where batch_id = $1 and activity_type = 'export'`, [BATCH])).rows[0].n).toBe(exportsBefore + 2);

      // Viewers are refused and nothing is logged; an unknown batch is reported, not exported.
      await expect(data.batchCsvExport(vw, BATCH, [1400001])).rejects.toBeInstanceOf(NotPermittedError);
      expect((await adminQuery(`select count(*)::int as n from public.batch_activity where batch_id = $1 and activity_type = 'export'`, [BATCH])).rows[0].n).toBe(exportsBefore + 2);
      expect((await data.batchCsvExport(ed, 'a3b00000-0000-4000-8000-0000000000ff', null)).rowCount).toBe(-1);
    } finally {
      await adminQuery('delete from public.batch_zones where id = $1', [zone]);
      await adminQuery('delete from public.carrier_insurance where dot_number = 1400001');
      await resetEditor();
    }
  });

  it('batch rename (editor, manager) and delete (manager only) go through the database rules', async () => {
    await resetEditor();
    const B2 = 'a3b00000-0000-4000-8000-0000000000b2';
    await adminQuery('delete from public.batches where id = $1', [B2]);
    await adminQuery(`insert into public.batches (id, name, created_by, search_definition) values ($1, 'A3 Rename Me', $2, '{}'::jsonb)`, [B2, MANAGER]);
    await adminQuery(`insert into public.batch_carriers (batch_id, dot_number) values ($1, 1400001), ($1, 1400002)`, [B2]);
    await adminQuery(`insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition) values (1400001, $1, $2, 'call', 'connected')`, [B2, EDITOR]);
    const ed = await session(EDITOR);
    const vw = await session(VIEWER);
    const mg = await session(MANAGER);
    const nameOf = async () => (await adminQuery('select name from public.batches where id = $1', [B2])).rows[0]?.name;
    try {
      await expect(data.batchRename(vw, B2, 'Viewer rename')).rejects.toBeInstanceOf(NotPermittedError);
      expect(await nameOf()).toBe('A3 Rename Me');
      expect(await data.batchRename(ed, B2, 'A3 Renamed')).toEqual({ found: true, from: 'A3 Rename Me' });
      expect(await nameOf()).toBe('A3 Renamed');
      const feed = (await adminQuery(`select comment, actor_id from public.batch_activity where batch_id = $1 and activity_type = 'comment'`, [B2])).rows;
      expect(feed).toEqual([{ comment: 'Renamed batch from "A3 Rename Me" to "A3 Renamed"', actor_id: EDITOR }]);
      expect((await data.batchRename(mg, B2, 'A3 Manager Name')).found).toBe(true);
      expect((await data.batchRename(ed, 'a3b00000-0000-4000-8000-0000000000ff', 'x')).found).toBe(false);

      await expect(data.batchDelete(ed, B2)).rejects.toBeInstanceOf(NotPermittedError);
      await expect(data.batchDelete(vw, B2)).rejects.toBeInstanceOf(NotPermittedError);
      expect(await nameOf()).toBe('A3 Manager Name');
      expect(await data.batchDelete(mg, 'a3b00000-0000-4000-8000-0000000000ff')).toBe(false);
      expect(await data.batchDelete(mg, B2)).toBe(true);
      expect(await nameOf()).toBeUndefined();
      expect((await adminQuery('select count(*)::int as n from public.batch_carriers where batch_id = $1', [B2])).rows[0].n).toBe(0);
      expect((await adminQuery('select batch_id from public.contact_logs where dot_number = 1400001 and notes is null and user_id = $1 and batch_id is null', [EDITOR])).rowCount).toBeGreaterThanOrEqual(1);
    } finally {
      await adminQuery('delete from public.batches where id = $1', [B2]);
      await adminQuery('delete from public.contact_logs where dot_number = 1400001 and batch_id is null and user_id = $1 and notes is null', [EDITOR]);
    }
  });

  it('deadlines: a slow statement is cut off and rolled back; a lock wait past the deadline is Unavailable', async () => {
    const ed = await session(EDITOR);
    const before = (await adminQuery('select count(*)::int as n from public.batch_activity')).rows[0].n;
    await expect(db.transaction({ sessionHash: ed, statementTimeoutMs: 100, deadlineMs: 2_000 }, async (tx) => {
      await tx.query(`insert into public.batch_activity (batch_id, actor_id, activity_type, comment) values ($1, $2, 'comment', 'A3 deadline')`, [BATCH, EDITOR]);
      await tx.query('select pg_sleep(1)');
    })).rejects.toBeInstanceOf(UnavailableError);
    const holder = new pg.Client({ connectionString: ADMIN_URL });
    await holder.connect();
    await holder.query('begin');
    await holder.query('select 1 from public.batches where id = $1 for update', [BATCH]);
    await expect(db.transaction({ sessionHash: ed, lockTimeoutMs: 5_000, deadlineMs: 300 }, (tx) => tx.query('select 1 from public.batches where id = $1 for key share', [BATCH]))).rejects.toBeInstanceOf(UnavailableError);
    await holder.query('rollback');
    await holder.end();
    expect((await adminQuery('select count(*)::int as n from public.batch_activity')).rows[0].n).toBe(before);
  });

  describe('lost COMMIT acknowledgement (in-process TCP relay)', () => {
    let relay: Server;
    let relayPort = 0;
    let dropAfterCommit = false;
    beforeAll(async () => {
      const target = new URL(APP_URL!);
      relay = createServer((client: Socket) => {
        const upstream = connect(Number(target.port), target.hostname);
        let commitSeen = false;
        client.on('data', (chunk) => {
          if (dropAfterCommit && chunk.includes(Buffer.from('COMMIT'))) commitSeen = true;
          upstream.write(chunk);
        });
        upstream.on('data', (chunk) => {
          if (!commitSeen) client.write(chunk);
        });
        const end = () => { client.destroy(); upstream.destroy(); };
        client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
      });
      await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
      relayPort = (relay.address() as { port: number }).port;
    });
    afterAll(async () => new Promise<void>((r) => relay.close(() => r())));

    it('reports OutcomeUnknown (never success, never retried) when COMMIT is sent but unanswered; the write did commit', async () => {
      const url = new URL(APP_URL!);
      url.port = String(relayPort);
      const relayed = new Database({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 2_000 });
      const ed = await session(EDITOR);
      const marker = `A3 lost ack ${Date.now()}`;
      dropAfterCommit = true;
      await expect(relayed.transaction({ sessionHash: ed, deadlineMs: 1_500 }, (tx) =>
        tx.query(`insert into public.batch_activity (batch_id, actor_id, activity_type, comment) values ($1, internal.current_staff_id(), 'comment', $2)`, [BATCH, marker]),
      )).rejects.toBeInstanceOf(OutcomeUnknownError);
      dropAfterCommit = false;
      await relayed.close().catch(() => undefined);
      expect((await adminQuery('select count(*)::int as n from public.batch_activity where comment = $1', [marker])).rows[0].n).toBe(1);
    });
  });
});
