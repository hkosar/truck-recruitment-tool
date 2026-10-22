// The sign-in server's request handler (doc 14 §2–§3, doc 15 §4). Framework-free: it maps an
// AppRequest to an AppResponse using the stores, the mail adapter and the lifecycle tracker.

import { chicagoDayUtcBounds } from './auth/chicago';
import {
  APP_CSRF_COOKIE,
  clearCookie,
  CONFIRM_COOKIE,
  CONFIRM_COOKIE_MAX_AGE_SECONDS,
  CONFIRM_CSRF_COOKIE,
  parseConfirmCookie,
  readOpaqueCookie,
  serializeConfirmCookie,
  serializeCookie,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from './auth/cookies';
import { checkOrigin, csrfTokenForCookie, issueCsrf, verifyCsrf } from './auth/csrf';
import { isSyntacticallyValidEmail, maskEmail, normalizeEmail, type UserRole } from './auth/identity';
import { keyedHash, randomSecret, type AuthKeys } from './auth/keys';
import { decideMint } from './auth/ladder';
import { admitRequest, INVALID_EMAIL_SENTINEL, ipBucketKey } from './auth/rate';
import type { AuthStore, DataStore, SessionInfo } from './core/stores';
import { RPC_SPECS, validateRpcArgs } from './core/rpc-spec';
import type { Lifecycle } from './core/lifecycle';
import {
  NotFoundError,
  NotPermittedError,
  OutcomeUnknownError,
  RefusedError,
  UnavailableError,
  type AppRequest,
  type AppResponse,
  type Logger,
} from './core/types';
import { isDeliberateNavigation, isPrefetch, PING_THROTTLE_MS, PingThrottle, renewalReason } from './http/activity';
import { BODY_LIMITS } from './http/body';
import { readFormFields } from './http/form';
import { operatorAlertFor, sendStatusFor, type MailAdapter } from './mail/adapter';
import { evidenceFor, parseEvents, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySendGridSignature } from './mail/webhook';
import { renderConfirm, renderSignInForm, renderSignInSent, renderSignOutFailed, renderStale, signInPageHeaders } from './pages/signin';
import { recoveryRouteAllowed } from './recovery/matrix';

export interface AppConfig {
  appOrigin: string;
  keys: AuthKeys;
  stagingBanner: boolean;
  maintenance: boolean;
  /** SendGrid Event Webhook public key (base64 DER); undefined disables the webhook route. */
  webhookPublicKey: string | undefined;
  envelopeMs: number;
  jitterMs: number;
  admissionDeadlineMs: number;
  continuationBudgetMs: number;
}

export const DEFAULT_TIMING = { envelopeMs: 1000, jitterMs: 100, admissionDeadlineMs: 600, continuationBudgetMs: 25_000 } as const;

export interface StaticFiles {
  /** A public file (assets, brand, fonts, sign-in stylesheet), or undefined. */
  get(path: string): { body: Buffer; contentType: string; immutable: boolean } | undefined;
  /** The SPA shell. */
  index(): Buffer;
}

export interface AppDeps {
  config: AppConfig;
  auth: AuthStore;
  data: DataStore;
  mail: MailAdapter;
  lifecycle: Lifecycle;
  log: Logger;
  staticFiles: StaticFiles;
  /** Wall clock (ms). */
  now: () => number;
  /** Monotonic clock (ms), same base as AppRequest.receivedAt. */
  monotonic: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  pingThrottle?: PingThrottle;
}

const LEGACY_PATHS = new Set(['/login', '/register', '/forgot', '/reset', '/pending']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9_-]{16,128}$/;

const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self' https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://maps.googleapis.com https://*.googleapis.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const COMMON_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export function createApp(deps: AppDeps): (req: AppRequest) => Promise<AppResponse> {
  const { config, auth, data, mail, lifecycle, log } = deps;
  const throttle = deps.pingThrottle ?? new PingThrottle(PING_THROTTLE_MS);
  const pageOptions = { stagingBanner: config.stagingBanner };

  // ---------------------------------------------------------------- helpers
  const url = (path: string) => `${config.appOrigin}${path}`;
  const redirect = (path: string, setCookies: string[] = [], extra: Record<string, string> = {}): AppResponse => ({
    status: 303,
    headers: { ...COMMON_HEADERS, location: url(path), 'cache-control': 'no-store', ...extra },
    setCookies,
    body: '',
  });
  const html = (body: string, setCookies: string[] = [], status = 200): AppResponse => ({
    status,
    headers: { ...COMMON_HEADERS, ...signInPageHeaders() },
    setCookies,
    body,
  });
  const json = (status: number, payload: unknown, setCookies: string[] = []): AppResponse => ({
    status,
    headers: { ...COMMON_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    setCookies,
    body: JSON.stringify(payload ?? null),
  });
  const sessionHashOf = (req: AppRequest): string | undefined => {
    const raw = readOpaqueCookie(req.cookies, SESSION_COOKIE);
    return raw ? keyedHash(config.keys, 'sessions', raw) : undefined;
  };
  const clearSessionCookies = [clearCookie(SESSION_COOKIE), clearCookie(APP_CSRF_COOKIE)];
  const withDeadline = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new UnavailableError()), ms))]);

  async function currentSession(req: AppRequest): Promise<{ hash: string; info: SessionInfo } | undefined> {
    const hash = sessionHashOf(req);
    if (!hash) return undefined;
    const info = await auth.sessionInfo(hash);
    return info ? { hash, info } : undefined;
  }

  function errorResponse(err: unknown, route: string): AppResponse {
    if (err instanceof NotPermittedError) return json(403, { error: 'forbidden' });
    if (err instanceof NotFoundError) return json(404, { error: 'not_found' });
    if (err instanceof RefusedError) return json(409, { error: err.code });
    if (err instanceof OutcomeUnknownError) return json(503, { error: 'outcome_unknown' });
    if (err instanceof UnavailableError) return json(503, { error: 'unavailable' });
    log('server_error', { route });
    return json(500, { error: 'internal' });
  }

  // ---------------------------------------------------------------- sign-in routes
  async function identityWork(email: string): Promise<void> {
    const token = randomSecret();
    const tokenHash = keyedHash(config.keys, 'links', token);
    const day = chicagoDayUtcBounds(new Date(deps.now()));
    const minted = await auth.mintIfAllowed(email, day, tokenHash, (state) => {
      if (state.blocked) return { mint: false };
      const decision = decideMint({
        nowMs: deps.now(),
        newest: state.newest ? { status: state.newest.status, createdAtMs: state.newest.createdAtMs } : undefined,
        lastMinute: state.lastMinute,
        lastHour: state.lastHour,
        chicagoDay: state.chicagoDay,
      });
      return decision.mint ? { mint: true, revokeLinkId: decision.revokeNewestAsSendFailed ? state.newest?.id : undefined } : { mint: false };
    });
    if (!minted) return;
    const outcome = await mail.sendSignInLink({ to: minted.recipient, linkUrl: url(`/auth/verify?token=${token}`), localId: minted.linkId });
    const alert = operatorAlertFor(outcome);
    if (alert) log('operator_alert', { category: alert });
    const status = sendStatusFor(outcome);
    await auth.recordSend(minted.linkId, status === 'pending' ? 'unknown' : status, outcome.errorCode, outcome.providerMessageId);
  }

  async function signInRequest(req: AppRequest): Promise<AppResponse> {
    const target = req.receivedAt + config.envelopeMs + Math.floor((deps.random() * 2 - 1) * config.jitterMs);
    const ip = ipBucketKey(req.clientIp);
    if (!ip.known) log('operator_alert', { category: 'client_ip_unavailable' });
    const body = await req.readBody(BODY_LIMITS.auth);
    const rawEmail = body.ok ? readFormFields(req.headers.get('content-type'), body.body, ['email']).email ?? '' : '';
    const email = isSyntacticallyValidEmail(rawEmail) ? normalizeEmail(rawEmail) : undefined;
    let admitted = false;
    try {
      const counts = await withDeadline(
        auth.bucketHit('request', keyedHash(config.keys, 'rate', ip.key), keyedHash(config.keys, 'rate', email ?? INVALID_EMAIL_SENTINEL), config.admissionDeadlineMs),
        config.admissionDeadlineMs,
      );
      admitted = admitRequest({ emailValid: email !== undefined, ipCount: counts.ipCount, emailCount: counts.emailCount });
    } catch {
      log('signin_admission_failed');
    }
    const wait = target - deps.monotonic();
    if (wait > 0) await deps.sleep(wait);
    if (admitted && email !== undefined) {
      // Registered before the response is returned (doc 15 §4.1).
      lifecycle.trackContinuation(() =>
        withDeadline(identityWork(email), config.continuationBudgetMs).catch(() => {
          log('signin_identity_work_failed');
        }),
      );
    }
    const response = redirect('/signin?sent=1');
    if (!body.ok) response.closeAfter = true;
    return response;
  }

  async function verifyLink(req: AppRequest): Promise<AppResponse> {
    const token = req.query.get('token');
    const nonce = randomSecret(16);
    let valid = false;
    if (token !== null && OPAQUE.test(token)) {
      try {
        valid = (await auth.linkCheck(keyedHash(config.keys, 'links', token))) !== null;
      } catch {
        valid = false;
      }
    }
    const cookies = valid && token !== null ? [serializeConfirmCookie(token, nonce)] : [];
    return redirect(`/auth/confirm?x=${nonce}`, cookies, { 'referrer-policy': 'no-referrer' });
  }

  async function confirmPage(req: AppRequest): Promise<AppResponse> {
    const parsed = parseConfirmCookie(req.cookies.get(CONFIRM_COOKIE));
    const x = req.query.get('x');
    if (!parsed || x === null || parsed.nonce !== x) return html(renderStale(pageOptions));
    let recipient: string | undefined;
    try {
      recipient = (await auth.linkCheck(keyedHash(config.keys, 'links', parsed.token)))?.recipient;
    } catch {
      recipient = undefined;
    }
    if (!recipient) return html(renderStale(pageOptions), [clearCookie(CONFIRM_COOKIE)]);
    const csrf = issueCsrf(config.keys.sessions, 'confirm');
    return html(renderConfirm(maskEmail(recipient), parsed.nonce, csrf.formToken, pageOptions), [
      serializeCookie(CONFIRM_CSRF_COOKIE, csrf.cookieValue, CONFIRM_COOKIE_MAX_AGE_SECONDS),
    ]);
  }

  async function confirmRedeem(req: AppRequest): Promise<AppResponse> {
    const clear = [clearCookie(CONFIRM_COOKIE), clearCookie(CONFIRM_CSRF_COOKIE)];
    const body = await req.readBody(BODY_LIMITS.auth);
    if (!body.ok) return { ...html(renderStale(pageOptions), clear), closeAfter: true };
    const fields = readFormFields(req.headers.get('content-type'), body.body, ['nonce', 'csrf_token']);
    const csrf = verifyCsrf({
      appOrigin: config.appOrigin,
      sessionsKey: config.keys.sessions,
      purpose: 'confirm',
      origin: req.headers.get('origin'),
      host: req.headers.get('host'),
      cookieValue: readOpaqueCookie(req.cookies, CONFIRM_CSRF_COOKIE),
      submittedToken: fields.csrf_token,
      strict: true, // exact Origin required; no Host fallback (Gate 2 finding 4)
    });
    const parsed = parseConfirmCookie(req.cookies.get(CONFIRM_COOKIE));
    if (!csrf.ok || !parsed || fields.nonce !== parsed.nonce) return html(renderStale(pageOptions), clear);
    const sessionRaw = randomSecret();
    let ok = false;
    try {
      ok = await auth.redeem(keyedHash(config.keys, 'links', parsed.token), keyedHash(config.keys, 'sessions', sessionRaw));
    } catch {
      ok = false;
    }
    if (!ok) return html(renderStale(pageOptions), clear);
    return redirect('/', [
      ...clear,
      serializeCookie(SESSION_COOKIE, sessionRaw, SESSION_COOKIE_MAX_AGE_SECONDS),
      serializeCookie(APP_CSRF_COOKIE, randomSecret(), SESSION_COOKIE_MAX_AGE_SECONDS),
    ]);
  }

  async function signOut(req: AppRequest): Promise<AppResponse> {
    const body = await req.readBody(BODY_LIMITS.auth);
    const token = body.ok ? readFormFields(req.headers.get('content-type'), body.body, ['csrf_token']).csrf_token : undefined;
    const csrf = verifyCsrf({
      appOrigin: config.appOrigin,
      sessionsKey: config.keys.sessions,
      purpose: 'app',
      origin: req.headers.get('origin'),
      host: req.headers.get('host'),
      cookieValue: readOpaqueCookie(req.cookies, APP_CSRF_COOKIE),
      submittedToken: token,
      strict: true, // exact Origin required; no Host fallback (Gate 2 finding 4)
    });
    if (!csrf.ok) return { status: 403, headers: { ...COMMON_HEADERS, 'content-type': 'text/plain', 'cache-control': 'no-store' }, setCookies: [], body: 'Forbidden', closeAfter: !body.ok };
    const hash = sessionHashOf(req);
    if (hash) {
      try {
        await auth.revoke(hash);
      } catch (err) {
        // Not confirmed (failed or outcome unknown): never claim success, keep the cookie so the
        // retry can finish the job; revoking twice is harmless (Gate 2 finding 3).
        log('signout_revoke_failed', { outcome: err instanceof OutcomeUnknownError ? 'unknown' : 'failed' });
        return { ...html(renderSignOutFailed(token!, pageOptions), [], 503), closeAfter: !body.ok };
      }
    }
    return redirect('/signin', clearSessionCookies);
  }

  async function signInPage(req: AppRequest): Promise<AppResponse> {
    try {
      if (await currentSession(req)) return redirect('/');
    } catch {
      // database unavailable: show the form; the request route fails closed on its own
    }
    if (req.query.get('sent') === '1') return html(renderSignInSent(pageOptions));
    return html(renderSignInForm(pageOptions, req.query.get('everyone') === '1' ? 'everyone_signed_out' : undefined));
  }

  // ---------------------------------------------------------------- webhook
  async function webhook(req: AppRequest): Promise<AppResponse> {
    if (!config.webhookPublicKey) return json(404, { error: 'not_found' });
    const body = await req.readBody(BODY_LIMITS.webhook);
    if (!body.ok) return { ...json(413, { error: 'too_large' }), closeAfter: true };
    if (!verifySendGridSignature(config.webhookPublicKey, req.headers.get(SIGNATURE_HEADER), req.headers.get(TIMESTAMP_HEADER), body.body)) {
      return json(401, { error: 'bad_signature' });
    }
    const events = parseEvents(body.body);
    if (!events) return json(400, { error: 'bad_body' });
    try {
      for (const e of events) {
        const ev = evidenceFor(e.mapped);
        await auth.applyEvidence({
          providerEventId: e.providerEventId,
          linkId: e.linkId,
          email: e.email,
          messageId: e.messageId,
          eventType: e.mapped,
          reason: e.reason,
          status: ev.status,
          delivered: ev.delivered,
          occurredAt: new Date(e.occurredAtMs),
        });
      }
    } catch {
      // Non-2xx makes SendGrid retry; replays are no-ops (unique event id).
      return json(503, { error: 'unavailable' });
    }
    return json(200, { ok: true });
  }

  // ---------------------------------------------------------------- data API
  async function readJson(req: AppRequest): Promise<unknown> {
    const body = await req.readBody(BODY_LIMITS.api);
    if (!body.ok) throw new RefusedError('invalid');
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new RefusedError('invalid');
    try {
      return JSON.parse(body.body.toString('utf8'));
    } catch {
      throw new RefusedError('invalid');
    }
  }
  const obj = (v: unknown): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new RefusedError('invalid');
    return v as Record<string, unknown>;
  };
  const uuid = (v: unknown): string => {
    if (typeof v !== 'string' || !UUID.test(v)) throw new RefusedError('invalid');
    return v;
  };
  const int = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new RefusedError('invalid');
    return v;
  };
  const text = (v: unknown, max = 10_000): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' || v.length > max) throw new RefusedError('invalid');
    return v;
  };
  const roleOrNull = (v: unknown): UserRole | null => {
    if (v === null || v === undefined) return null;
    if (v === 'manager' || v === 'edit' || v === 'view') return v;
    throw new RefusedError('invalid');
  };

  async function api(req: AppRequest): Promise<AppResponse> {
    let session: { hash: string; info: SessionInfo } | undefined;
    try {
      session = await currentSession(req);
    } catch (err) {
      return errorResponse(err, 'session');
    }
    if (!session) return json(401, { error: 'signed_out' }, clearSessionCookies);
    const { hash, info } = session;
    const { method, path } = req;

    if (method === 'POST') {
      const origin = checkOrigin(config.appOrigin, req.headers.get('origin'), req.headers.get('host'), true);
      const appCsrf = readOpaqueCookie(req.cookies, APP_CSRF_COOKIE);
      const header = req.headers.get('x-csrf-token');
      if (!origin.ok || !appCsrf || !header || header !== csrfTokenForCookie(config.keys.sessions, 'app', appCsrf)) {
        return json(403, { error: 'csrf' });
      }
    } else if (method !== 'GET') {
      return json(405, { error: 'method' });
    }
    if (info.kind === 'recovery' && !recoveryRouteAllowed(method, path, info.role, 'approved')) return json(403, { error: 'forbidden' });

    try {
      const result = await dispatch(req, hash, info, method, path);
      const reason = renewalReason(method, path, req.headers);
      if (reason === 'write' && result.status < 400) {
        await auth.touch(hash).catch(() => log('touch_failed'));
      }
      return result;
    } catch (err) {
      return errorResponse(err, path.replace(/[0-9a-f-]{36}|\d+/g, ':id'));
    }
  }

  async function dispatch(req: AppRequest, s: string, info: SessionInfo, method: string, path: string): Promise<AppResponse> {
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/api/session') {
      const appCsrf = readOpaqueCookie(req.cookies, APP_CSRF_COOKIE);
      const setCookies: string[] = [];
      let cookieValue = appCsrf;
      if (!cookieValue) {
        cookieValue = randomSecret();
        setCookies.push(serializeCookie(APP_CSRF_COOKIE, cookieValue, SESSION_COOKIE_MAX_AGE_SECONDS));
      }
      return json(200, {
        user: { id: info.userId, name: info.fullName, email: info.email, role: info.role },
        sessionKind: info.kind,
        expiresAt: info.expiresAt,
        csrfToken: csrfTokenForCookie(config.keys.sessions, 'app', cookieValue),
      }, setCookies);
    }
    if (method === 'POST' && path === '/api/session/activity') {
      // Refused pings are 403 and never touch (doc 14 §3.5; Gate 2 finding 5).
      if (isPrefetch(req.headers)) return json(403, { error: 'prefetch' });
      const ping = await req.readBody(64);
      if (!ping.ok || ping.body.length !== 0) return { ...json(403, { error: 'body' }), closeAfter: !ping.ok };
      if (throttle.allow(s, deps.now())) await auth.touch(s);
      return { status: 204, headers: { ...COMMON_HEADERS, 'cache-control': 'no-store' }, setCookies: [], body: '' };
    }
    if (method === 'POST' && (m = /^\/api\/rpc\/([a-z_]+)$/.exec(path))) {
      const name = m[1];
      if (!Object.prototype.hasOwnProperty.call(RPC_SPECS, name)) throw new NotFoundError();
      const args = validateRpcArgs(name, await readJson(req));
      if (!args) throw new RefusedError('invalid');
      return json(200, await data.rpc(s, name, args));
    }
    if (method === 'GET' && (m = /^\/api\/batches\/([0-9a-f-]{36})$/i.exec(path))) return json(200, await data.batchDetail(s, uuid(m[1])));
    if (method === 'GET' && (m = /^\/api\/batches\/([0-9a-f-]{36})\/activity$/i.exec(path))) {
      const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 3) || 3, 1), 50);
      return json(200, await data.batchActivity(s, uuid(m[1]), limit));
    }
    if (method === 'GET' && (m = /^\/api\/batches\/([0-9a-f-]{36})\/sheet-header$/i.exec(path))) return json(200, await data.sheetHeader(s, uuid(m[1])));
    if (method === 'POST' && (m = /^\/api\/batches\/([0-9a-f-]{36})\/comments$/i.exec(path))) {
      const body = obj(await readJson(req));
      const comment = text(body.comment, 5_000);
      if (!comment || comment.trim() === '') throw new RefusedError('invalid');
      await data.addComment(s, uuid(m[1]), comment);
      return json(200, { ok: true });
    }
    if (method === 'POST' && path === '/api/batch-carriers/status') {
      const body = obj(await readJson(req));
      const status = body.status;
      if (typeof status !== 'string' || !['new', 'attempted', 'contacted', 'interested', 'not_a_fit'].includes(status)) throw new RefusedError('invalid');
      if (!(await data.setMemberStatus(s, uuid(body.batch_id), int(body.dot_number), status))) throw new NotFoundError();
      return json(200, { ok: true });
    }
    if (method === 'POST' && path === '/api/batch-carriers/promote') {
      const body = obj(await readJson(req));
      if (!(await data.promote(s, uuid(body.batch_id), int(body.dot_number)))) throw new NotFoundError();
      return json(200, { ok: true });
    }
    if (method === 'POST' && path === '/api/contact-logs') {
      const body = obj(await readJson(req));
      await data.logContact(s, {
        dot_number: int(body.dot_number),
        batch_id: body.batch_id === null || body.batch_id === undefined ? null : uuid(body.batch_id),
        channel: text(body.channel, 20) ?? '',
        disposition: text(body.disposition, 40) ?? '',
        notes: text(body.notes),
        next_steps: text(body.next_steps),
      });
      return json(200, { ok: true });
    }
    if (method === 'GET' && (m = /^\/api\/carriers\/(\d{1,12})\/profile$/.exec(path))) return json(200, await data.carrierProfile(s, Number(m[1])));
    if (method === 'GET' && path === '/api/dashboard') return json(200, await data.dashboardBatches(s));
    if (method === 'POST' && path === '/api/dnc/lookup') {
      const body = obj(await readJson(req));
      if (!Array.isArray(body.dots) || body.dots.length > 1_000) throw new RefusedError('invalid');
      return json(200, await data.dncLookup(s, body.dots.map(int)));
    }
    if (method === 'GET' && path === '/api/team') return json(200, await data.teamList(s));
    if (method === 'POST' && path === '/api/team/edit') {
      const body = obj(await readJson(req));
      await data.teamUpdate(s, uuid(body.id), text(body.full_name, 200), roleOrNull(body.role), text(body.email, 320));
      return json(200, { ok: true });
    }
    if (method === 'POST' && (path === '/api/team/deactivate' || path === '/api/team/reactivate')) {
      const body = obj(await readJson(req));
      await data.teamSetActive(s, uuid(body.id), path.endsWith('reactivate'));
      return json(200, { ok: true });
    }
    if (method === 'POST' && path === '/api/team/sign-everyone-out') {
      const revoked = await data.teamSignEveryoneOut(s);
      return json(200, { revoked }, clearSessionCookies);
    }
    void info;
    throw new NotFoundError();
  }

  // ---------------------------------------------------------------- static and SPA
  async function spa(req: AppRequest): Promise<AppResponse> {
    const file = deps.staticFiles.get(req.path);
    if (file) {
      return {
        status: 200,
        headers: {
          ...COMMON_HEADERS,
          'content-type': file.contentType,
          'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
        setCookies: [],
        body: file.body,
      };
    }
    const wantsHtml = req.headers.get('sec-fetch-mode') === 'navigate' || (req.headers.get('accept') ?? '').includes('text/html');
    if (!wantsHtml || req.path.startsWith('/api/') || req.path.includes('.')) {
      return { status: 404, headers: { ...COMMON_HEADERS, 'content-type': 'text/plain', 'cache-control': 'no-store' }, setCookies: [], body: 'Not found' };
    }
    let session;
    try {
      session = await currentSession(req);
    } catch {
      return { status: 503, headers: { ...COMMON_HEADERS, 'content-type': 'text/plain', 'cache-control': 'no-store' }, setCookies: [], body: 'Temporarily unavailable' };
    }
    if (!session) return redirect('/signin', readOpaqueCookie(req.cookies, SESSION_COOKIE) ? clearSessionCookies : []);
    if (isDeliberateNavigation(req.method, req.headers)) await auth.touch(session.hash).catch(() => log('touch_failed'));
    return {
      status: 200,
      headers: { ...COMMON_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'content-security-policy': SPA_CSP, 'referrer-policy': 'strict-origin-when-cross-origin' },
      setCookies: [],
      body: deps.staticFiles.index(),
    };
  }

  // ---------------------------------------------------------------- router
  return async function handle(req: AppRequest): Promise<AppResponse> {
    if (config.maintenance) {
      return { status: 503, headers: { ...COMMON_HEADERS, 'content-type': 'text/plain', 'cache-control': 'no-store', 'retry-after': '120' }, setCookies: [], body: 'Back shortly.' };
    }
    const { method, path } = req;
    if (LEGACY_PATHS.has(path)) return redirect('/signin');
    if (path === '/signin' && method === 'GET') return signInPage(req);
    if (path === '/auth/request' && method === 'POST') return signInRequest(req);
    if (path === '/auth/verify' && method === 'GET') return verifyLink(req);
    if (path === '/auth/confirm' && method === 'GET') return confirmPage(req);
    if (path === '/auth/confirm' && method === 'POST') return confirmRedeem(req);
    if (path === '/auth/signout' && method === 'POST') return signOut(req);
    if (path === '/webhooks/sendgrid' && method === 'POST') return webhook(req);
    if (path.startsWith('/api/')) return api(req);
    if (method === 'GET' || method === 'HEAD') return spa(req);
    return { status: 405, headers: { ...COMMON_HEADERS, 'content-type': 'text/plain' }, setCookies: [], body: 'Method not allowed' };
  };
}
