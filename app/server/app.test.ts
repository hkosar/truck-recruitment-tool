import { describe, expect, it } from 'vitest';
import { createApp, DEFAULT_TIMING, type AppConfig, type StaticFiles } from './app';
import { APP_CSRF_COOKIE, CONFIRM_COOKIE, CONFIRM_CSRF_COOKIE, SESSION_COOKIE } from './auth/cookies';
import { csrfTokenForCookie } from './auth/csrf';
import { keyedHash } from './auth/keys';
import { RPC_SPECS } from './core/rpc-spec';
import { Lifecycle } from './core/lifecycle';
import { NotPermittedError, OutcomeUnknownError, UnavailableError, type AppResponse } from './core/types';
import { FakeMailAdapter } from './mail/fake';
import { FakeAuthStore, FakeDataStore, fakeRequest } from './testing/fakes';

const ORIGIN = 'https://recruiter.example.test';
const keys = { links: Buffer.alloc(32, 1).toString('base64url'), sessions: Buffer.alloc(32, 2).toString('base64url'), rate: Buffer.alloc(32, 3).toString('base64url') };
const FORM = 'application/x-www-form-urlencoded';

const staticFiles: StaticFiles = {
  get: (p) => (p === '/assets/app-abc123.js' ? { body: Buffer.from('js'), contentType: 'text/javascript', immutable: true } : undefined),
  index: () => Buffer.from('<!doctype html><div id="root"></div>'),
};

function setup(overrides: Partial<AppConfig> = {}) {
  const auth = new FakeAuthStore();
  auth.people = [
    { id: '11111111-1111-4111-8111-111111111111', email: 'editor@example.test', fullName: 'Ed', role: 'edit', active: true },
    { id: '22222222-2222-4222-8222-222222222222', email: 'gone@example.test', fullName: 'Gone', role: 'view', active: false },
    { id: '33333333-3333-4333-8333-333333333333', email: 'boss@example.test', fullName: 'Boss', role: 'manager', active: true },
  ];
  const data = new FakeDataStore();
  const mail = new FakeMailAdapter();
  const lifecycle = new Lifecycle();
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const config: AppConfig = {
    appOrigin: ORIGIN,
    keys,
    stagingBanner: false,
    maintenance: false,
    webhookPublicKey: undefined,
    ...DEFAULT_TIMING,
    envelopeMs: 40,
    jitterMs: 5,
    ...overrides,
  };
  const handle = createApp({
    config, auth, data, mail, lifecycle, staticFiles,
    log: (event, fields) => logs.push({ event, fields }),
    now: () => Date.now(),
    monotonic: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: Math.random,
  });
  // As the Node adapter does: post-response work starts once the response is complete.
  const handleAndFinish = async (r: Parameters<typeof handle>[0]) => {
    const res = await handle(r);
    if (res.afterResponse) lifecycle.trackContinuation(res.afterResponse);
    return res;
  };
  return { handle: handleAndFinish, auth, data, mail, lifecycle, logs, config };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const location = (r: AppResponse) => r.headers.location;
const cookieValue = (r: AppResponse, name: string) => r.setCookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);

/** A signed-in browser: session + app CSRF cookie. */
function signedIn(env: ReturnType<typeof setup>, userId = '11111111-1111-4111-8111-111111111111', kind: 'link' | 'recovery' = 'link') {
  const raw = `session-raw-${userId.slice(0, 8)}-${kind}-padding-xyz`;
  const csrf = 'app-csrf-cookie-value-1234567890';
  env.auth.addSession(keyedHash(keys, 'sessions', raw), userId, kind);
  return {
    hash: keyedHash(keys, 'sessions', raw),
    cookie: `${SESSION_COOKIE}=${raw}; ${APP_CSRF_COOKIE}=${csrf}`,
    csrfToken: csrfTokenForCookie(keys.sessions, 'app', csrf),
  };
}

/** The SPA's activity ping: same-origin POST, CSRF header, empty body. */
function ping(env: ReturnType<typeof setup>, who: ReturnType<typeof signedIn>, headers: Record<string, string> = {}, body = '') {
  return env.handle(fakeRequest({
    method: 'POST', url: '/api/session/activity', body,
    headers: { cookie: who.cookie, origin: ORIGIN, 'x-csrf-token': who.csrfToken, ...headers },
  }));
}

function apiPost(env: ReturnType<typeof setup>, who: ReturnType<typeof signedIn>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return env.handle(fakeRequest({
    method: 'POST', url: path, body: JSON.stringify(body),
    headers: { cookie: who.cookie, origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': who.csrfToken, ...headers },
  }));
}

describe('sign-in request: one generic response for every outcome', () => {
  it('same status, location and body for known, unknown, inactive, invalid and malformed submissions', async () => {
    const env = setup();
    const bodies = ['email=editor%40example.test', 'email=nobody%40example.test', 'email=gone%40example.test', 'email=not-an-email', 'email=a&email=b'];
    const responses = await Promise.all(bodies.map((b) => env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: b, headers: { 'content-type': FORM } }))));
    const json = await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: '{"email":"editor@example.test"}', headers: { 'content-type': 'application/json' } }));
    for (const r of [...responses, json]) {
      expect(r.status).toBe(303);
      expect(location(r)).toBe(`${ORIGIN}/signin?sent=1`);
      expect(r.body).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.setCookies).toEqual([]);
    }
    await settle();
    expect(env.mail.count).toBe(1);
    expect(env.mail.lastLinkFor('editor@example.test')).toMatch(/^https:\/\/recruiter\.example\.test\/auth\/verify\?token=[A-Za-z0-9_-]{43}$/);
  });

  it('timing: every class lands inside 1000 ± 100 ms', async () => {
    const env = setup({ envelopeMs: 1000, jitterMs: 100 });
    const bodies = ['email=editor%40example.test', 'email=nobody%40example.test', 'email=gone%40example.test', 'email=x', ''];
    const times = await Promise.all(bodies.map(async (b) => {
      const t0 = performance.now();
      await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: b, headers: { 'content-type': FORM }, receivedAt: t0 }));
      return performance.now() - t0;
    }));
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(895);
      expect(t).toBeLessThanOrEqual(1150);
    }
  });

  it('an oversized body gets the same response and the connection is closed afterwards', async () => {
    const env = setup();
    const r = await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=' + 'a'.repeat(40_000), headers: { 'content-type': FORM } }));
    expect(r.status).toBe(303);
    expect(location(r)).toBe(`${ORIGIN}/signin?sent=1`);
    expect(r.closeAfter).toBe(true);
  });

  it('database failure or a slow admission: same response, no email, category logged', async () => {
    const env = setup();
    env.auth.failWith = new Error('connection refused');
    const r1 = await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    env.auth.failWith = undefined;
    const slow = setup({ admissionDeadlineMs: 20 });
    slow.auth.bucketDelayMs = 200;
    const r2 = await slow.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    await new Promise((r) => setTimeout(r, 250));
    for (const r of [r1, r2]) expect(location(r)).toBe(`${ORIGIN}/signin?sent=1`);
    expect(env.mail.count + slow.mail.count).toBe(0);
    expect(env.logs.some((l) => l.event === 'signin_admission_failed')).toBe(true);
    // Never silent (Gate 2 review N1): both kinds of admission failure raise an operator alert.
    for (const e of [env, slow]) expect(e.logs.filter((l) => l.event === 'operator_alert' && l.fields?.category === 'signin_admission_unavailable')).toHaveLength(1);
  });

  it('a failure in the post-response identity work raises an operator alert (never silent)', async () => {
    const env = setup();
    env.auth.failCalls.add('mintIfAllowed'); // admission works; the post-response mint fails
    const r = await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    expect(location(r)).toBe(`${ORIGIN}/signin?sent=1`);
    await new Promise((res) => setTimeout(res, 50));
    expect(env.auth.calls).toContain('mintIfAllowed');
    expect(env.mail.count).toBe(0);
    expect(env.logs.some((l) => l.event === 'operator_alert' && l.fields?.category === 'signin_identity_work_failed')).toBe(true);
  });

  it('20 per IP: the 21st request from one IP sends nothing', async () => {
    const env = setup({ envelopeMs: 1, jitterMs: 0 });
    for (let i = 0; i < 21; i++) {
      env.auth.people.push({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `p${i}@example.test`, fullName: 'P', role: 'view', active: true });
      await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: `email=p${i}%40example.test`, headers: { 'content-type': FORM }, clientIp: '198.51.100.9' }));
    }
    await settle();
    expect(env.mail.count).toBe(20);
  });

  it('unknown client IP: all such requests share one bucket (no bypass) and raise an operator alert', async () => {
    const env = setup({ envelopeMs: 1, jitterMs: 0 });
    for (let i = 0; i < 21; i++) {
      env.auth.people.push({ id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `q${i}@example.test`, fullName: 'Q', role: 'view', active: true });
      const req = fakeRequest({ method: 'POST', url: '/auth/request', body: `email=q${i}%40example.test`, headers: { 'content-type': FORM } });
      req.clientIp = undefined;
      await env.handle(req);
    }
    await settle();
    expect(env.mail.count).toBe(20);
    expect(env.logs.some((l) => l.event === 'operator_alert' && l.fields?.category === 'client_ip_unavailable')).toBe(true);
  });

  it('a provider 429 is not a recipient failure: no immediate retry, operator alerted', async () => {
    const env = setup({ envelopeMs: 1, jitterMs: 0 });
    env.mail.respondWith(async () => ({ outcomeClass: 'rate_limited', httpStatus: 429, errorCode: 'provider_rate_limited' }));
    await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    await settle();
    const link = [...env.auth.links.values()][0];
    expect(link.status).toBe('unknown');
    expect(env.logs.some((l) => l.event === 'operator_alert' && l.fields?.category === 'provider_rate_limited')).toBe(true);
    await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    await settle();
    expect(env.mail.count).toBe(1);
  });

  it('logs never contain the link token, the link URL or the address', async () => {
    const env = setup({ envelopeMs: 1, jitterMs: 0 });
    env.mail.respondWith(async () => ({ outcomeClass: 'configuration_permanent', errorCode: 'provider_config_401' }));
    await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    await settle();
    const token = env.mail.lastLinkFor('editor@example.test')!.split('token=')[1];
    const dump = JSON.stringify(env.logs);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain('editor@example.test');
    expect(dump).not.toContain('/auth/verify');
  });
});

describe('opening the link, confirming, signing out', () => {
  async function mintLink(env: ReturnType<typeof setup>) {
    await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    await settle();
    return env.mail.lastLinkFor('editor@example.test')!;
  }

  it('verify: valid link sets the landing cookie and moves the token out of the URL; invalid sets nothing', async () => {
    const env = setup();
    const link = await mintLink(env);
    const r = await env.handle(fakeRequest({ url: link.replace(ORIGIN, '') }));
    expect(r.status).toBe(303);
    expect(location(r)).toMatch(new RegExp(`^${ORIGIN}/auth/confirm\\?x=[A-Za-z0-9_-]{22}$`));
    expect(location(r)).not.toContain('token');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.setCookies[0]).toMatch(/^__Host-tr_confirm=.+; Path=\/; Max-Age=300; Secure; HttpOnly; SameSite=Lax$/);
    const bad = await env.handle(fakeRequest({ url: '/auth/verify?token=not-a-real-token-value-xyz' }));
    expect(bad.setCookies).toEqual([]);
    expect(location(bad)).toMatch(/\/auth\/confirm\?x=/);
  });

  it('opening the link does not consume it; confirm shows the masked address; one press signs in; a second press fails closed', async () => {
    const env = setup();
    const link = await mintLink(env);
    const land = await env.handle(fakeRequest({ url: link.replace(ORIGIN, '') }));
    const confirmCookie = land.setCookies[0].split(';')[0];
    const x = new URL(location(land)).searchParams.get('x')!;
    const page = await env.handle(fakeRequest({ url: `/auth/confirm?x=${x}`, headers: { cookie: confirmCookie } }));
    expect(page.body).toContain('Finish signing in as <strong>e•••@example.test</strong>.');
    const csrfCookie = cookieValue(page, CONFIRM_CSRF_COOKIE)!;
    const formToken = /name="csrf_token" value="([^"]+)"/.exec(String(page.body))![1];
    const press = () => env.handle(fakeRequest({
      method: 'POST', url: '/auth/confirm', body: `nonce=${x}&csrf_token=${formToken}`,
      headers: { 'content-type': FORM, origin: ORIGIN, cookie: `${confirmCookie}; ${CONFIRM_CSRF_COOKIE}=${csrfCookie}` },
    }));
    const first = await press();
    expect(first.status).toBe(303);
    expect(location(first)).toBe(`${ORIGIN}/`);
    const session = first.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(session).toMatch(/^__Host-tr_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/);
    expect(first.setCookies.some((c) => c.startsWith(`${CONFIRM_COOKIE}=;`))).toBe(true);
    const second = await press();
    expect(second.status).toBe(200);
    expect(second.body).toContain('This link was already used or has expired.');
  });

  it('a stale or mismatched landing fails closed, and so does a foreign-origin press', async () => {
    const env = setup();
    const link = await mintLink(env);
    const land = await env.handle(fakeRequest({ url: link.replace(ORIGIN, '') }));
    const confirmCookie = land.setCookies[0].split(';')[0];
    const stale = await env.handle(fakeRequest({ url: '/auth/confirm?x=someoneelsesnonce', headers: { cookie: confirmCookie } }));
    expect(stale.body).toContain('This link was already used or has expired.');
    const noCookie = await env.handle(fakeRequest({ url: `/auth/confirm?x=${new URL(location(land)).searchParams.get('x')}` }));
    expect(noCookie.body).toContain('Get a new link');
    const x = new URL(location(land)).searchParams.get('x')!;
    const page = await env.handle(fakeRequest({ url: `/auth/confirm?x=${x}`, headers: { cookie: confirmCookie } }));
    const csrfCookie = cookieValue(page, CONFIRM_CSRF_COOKIE)!;
    const formToken = /name="csrf_token" value="([^"]+)"/.exec(String(page.body))![1];
    const foreign = await env.handle(fakeRequest({
      method: 'POST', url: '/auth/confirm', body: `nonce=${x}&csrf_token=${formToken}`,
      headers: { 'content-type': FORM, origin: 'https://evil.example', cookie: `${confirmCookie}; ${CONFIRM_CSRF_COOKIE}=${csrfCookie}` },
    }));
    expect(foreign.body).toContain('This link was already used or has expired.');
    expect(env.auth.calls).not.toContain('redeem');
  });

  it('confirm requires the exact Origin: missing, empty, "null" and foreign are refused even with valid cookies and token (no Host fallback)', async () => {
    for (const origin of [undefined, '', 'null', 'https://evil.example', `${ORIGIN}.evil.example`]) {
      const env = setup();
      const link = await mintLink(env);
      const land = await env.handle(fakeRequest({ url: link.replace(ORIGIN, '') }));
      const confirmCookie = land.setCookies[0].split(';')[0];
      const x = new URL(location(land)).searchParams.get('x')!;
      const page = await env.handle(fakeRequest({ url: `/auth/confirm?x=${x}`, headers: { cookie: confirmCookie } }));
      const csrfCookie = cookieValue(page, CONFIRM_CSRF_COOKIE)!;
      const formToken = /name="csrf_token" value="([^"]+)"/.exec(String(page.body))![1];
      const headers: Record<string, string> = { 'content-type': FORM, host: new URL(ORIGIN).host, cookie: `${confirmCookie}; ${CONFIRM_CSRF_COOKIE}=${csrfCookie}` };
      if (origin !== undefined) headers.origin = origin;
      const r = await env.handle(fakeRequest({ method: 'POST', url: '/auth/confirm', body: `nonce=${x}&csrf_token=${formToken}`, headers }));
      expect(r.body).toContain('This link was already used or has expired.');
      expect(r.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/.test(c))).toBe(false);
      expect(env.auth.calls).not.toContain('redeem');
    }
  });

  it('sign-out needs the app CSRF token; it revokes the session, clears cookies and navigates fully', async () => {
    const env = setup();
    const who = signedIn(env);
    const bad = await env.handle(fakeRequest({ method: 'POST', url: '/auth/signout', body: 'csrf_token=wrong', headers: { 'content-type': FORM, origin: ORIGIN, cookie: who.cookie } }));
    expect(bad.status).toBe(403);
    const malformed = await env.handle(fakeRequest({ method: 'POST', url: '/auth/signout', body: '%%%', headers: { 'content-type': 'text/plain', origin: ORIGIN, cookie: who.cookie } }));
    expect(malformed.status).toBe(403);
    const ok = await env.handle(fakeRequest({ method: 'POST', url: '/auth/signout', body: `csrf_token=${who.csrfToken}`, headers: { 'content-type': FORM, origin: ORIGIN, cookie: who.cookie } }));
    expect(ok.status).toBe(303);
    expect(location(ok)).toBe(`${ORIGIN}/signin`);
    expect(ok.setCookies).toEqual(expect.arrayContaining([expect.stringMatching(/^__Host-tr_session=; .*Max-Age=0/)]));
    expect(env.auth.sessions.get(who.hash)!.revoked).toBe(true);
  });

  it('sign-out requires the exact Origin: missing, empty, "null" and foreign are refused with a valid token (no Host fallback)', async () => {
    for (const origin of [undefined, '', 'null', 'https://evil.example']) {
      const env = setup();
      const who = signedIn(env);
      const headers: Record<string, string> = { 'content-type': FORM, host: new URL(ORIGIN).host, cookie: who.cookie };
      if (origin !== undefined) headers.origin = origin;
      const r = await env.handle(fakeRequest({ method: 'POST', url: '/auth/signout', body: `csrf_token=${who.csrfToken}`, headers }));
      expect(r.status).toBe(403);
      expect(env.auth.sessions.get(who.hash)!.revoked).toBe(false);
    }
  });

  it('sign-out whose revocation fails or is unknown says so, keeps the session cookie and offers a retry that then succeeds', async () => {
    for (const failure of [new UnavailableError(), new OutcomeUnknownError()]) {
      const env = setup();
      const who = signedIn(env);
      const send = () => env.handle(fakeRequest({ method: 'POST', url: '/auth/signout', body: `csrf_token=${who.csrfToken}`, headers: { 'content-type': FORM, origin: ORIGIN, cookie: who.cookie } }));
      env.auth.failWith = failure;
      const failed = await send();
      expect(failed.status).toBe(503);
      expect(String(failed.body)).toContain('Sign-out did not finish.');
      expect(String(failed.body)).toContain('Try signing out again');
      expect(String(failed.body)).toContain(`name="csrf_token" value="${who.csrfToken}"`);
      expect(failed.setCookies).toEqual([]);
      expect(env.auth.sessions.get(who.hash)!.revoked).toBe(false);
      env.auth.failWith = undefined;
      const retry = await send();
      expect(retry.status).toBe(303);
      expect(location(retry)).toBe(`${ORIGIN}/signin`);
      expect(env.auth.sessions.get(who.hash)!.revoked).toBe(true);
    }
  });
});

describe('signed-in data API', () => {
  it('no session → 401; session → identity and CSRF token', async () => {
    const env = setup();
    expect((await env.handle(fakeRequest({ url: '/api/session' }))).status).toBe(401);
    const who = signedIn(env);
    const r = await env.handle(fakeRequest({ url: '/api/session', headers: { cookie: who.cookie } }));
    expect(JSON.parse(String(r.body))).toMatchObject({ user: { email: 'editor@example.test', role: 'edit' }, sessionKind: 'link', csrfToken: who.csrfToken });
  });

  it('mutations need strict Origin and the CSRF header', async () => {
    const env = setup();
    const who = signedIn(env);
    const body = { batch_id: '44444444-4444-4444-8444-444444444444', dot_number: 1, status: 'contacted' };
    expect((await apiPost(env, who, '/api/batch-carriers/status', body, { 'x-csrf-token': 'nope' })).status).toBe(403);
    expect((await apiPost(env, who, '/api/batch-carriers/status', body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await apiPost(env, who, '/api/batch-carriers/status', body, { origin: '' })).status).toBe(403);
    expect((await apiPost(env, who, '/api/batch-carriers/status', body)).status).toBe(200);
  });

  it('all 17 RPCs are routable by name; anything else is refused before the database', async () => {
    const env = setup();
    const who = signedIn(env);
    expect(Object.keys(RPC_SPECS)).toHaveLength(17);
    for (const name of Object.keys(RPC_SPECS)) {
      const r = await apiPost(env, who, `/api/rpc/${name}`, {});
      expect(r.status).toBe(200);
    }
    expect(env.data.calls.filter((c) => c.op === 'rpc').map((c) => c.args[0])).toEqual(Object.keys(RPC_SPECS));
    expect((await apiPost(env, who, '/api/rpc/pg_sleep', {})).status).toBe(404);
    expect((await apiPost(env, who, '/api/rpc/search_carriers', { p_definition: {}, p_evil: 1 })).status).toBe(409);
    expect((await apiPost(env, who, '/api/rpc/bulk_set_status', { p_batch_id: 'x', p_dots: [1], p_status: 'new' })).status).toBe(409);
  });

  it('every table call has its route, carrying the session hash', async () => {
    const env = setup();
    const who = signedIn(env);
    const b = '44444444-4444-4444-8444-444444444444';
    const gets = ['/api/batches/' + b, `/api/batches/${b}/activity?limit=3`, `/api/batches/${b}/sheet-header`, '/api/carriers/1400001/profile', '/api/dashboard', '/api/team'];
    for (const g of gets) expect((await env.handle(fakeRequest({ url: g, headers: { cookie: who.cookie } }))).status).toBe(200);
    expect((await apiPost(env, who, `/api/batches/${b}/comments`, { comment: 'hi' })).status).toBe(200);
    expect((await apiPost(env, who, '/api/batch-carriers/promote', { batch_id: b, dot_number: 1 })).status).toBe(200);
    expect((await apiPost(env, who, '/api/contact-logs', { dot_number: 1, batch_id: b, channel: 'call', disposition: 'connected', notes: null, next_steps: null })).status).toBe(200);
    expect((await apiPost(env, who, '/api/dnc/lookup', { dots: [1, 2] })).status).toBe(200);
    expect((await apiPost(env, who, '/api/team/edit', { id: b, full_name: 'N', role: 'view', email: null })).status).toBe(200);
    expect((await apiPost(env, who, '/api/team/deactivate', { id: b })).status).toBe(200);
    expect((await apiPost(env, who, '/api/team/reactivate', { id: b })).status).toBe(200);
    expect((await apiPost(env, who, '/api/team/sign-everyone-out', {})).status).toBe(200);
    const ops = env.data.calls.map((c) => c.op);
    expect(ops).toEqual(['batchDetail', 'batchActivity', 'sheetHeader', 'carrierProfile', 'dashboardBatches', 'teamList', 'addComment', 'promote', 'logContact', 'dncLookup', 'teamUpdate', 'teamSetActive', 'teamSetActive', 'teamSignEveryoneOut']);
    expect(env.data.calls.every((c) => c.s === who.hash)).toBe(true);
  });

  it('renewal: background reads and read-only RPC POSTs never renew; writes, pings and navigations do', async () => {
    const env = setup();
    const who = signedIn(env);
    const touches = () => env.auth.sessions.get(who.hash)!.touches;
    await env.handle(fakeRequest({ url: '/api/dashboard', headers: { cookie: who.cookie } }));
    await apiPost(env, who, '/api/rpc/search_carriers', { p_definition: {} });
    await apiPost(env, who, '/api/dnc/lookup', { dots: [1] });
    expect(touches()).toBe(0);
    await apiPost(env, who, '/api/rpc/log_export', { p_batch_id: '44444444-4444-4444-8444-444444444444', p_kind: 'csv', p_row_count: 1 });
    expect(touches()).toBe(1);
    expect((await ping(env, who)).status).toBe(204);
    await ping(env, who);
    expect(touches()).toBe(2);
    await env.handle(fakeRequest({ url: '/batches/x', headers: { cookie: who.cookie, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' } }));
    expect(touches()).toBe(3);
    await env.handle(fakeRequest({ url: '/batches/x', headers: { cookie: who.cookie, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch', accept: 'text/html' } }));
    expect(touches()).toBe(3);
    const forged = await ping(env, who, { 'x-csrf-token': 'forged' });
    expect(forged.status).toBe(403);
  });

  it('activity ping: a prefetch header or a non-empty body is refused (403) BEFORE the throttle and the touch', async () => {
    const env = setup();
    const who = signedIn(env);
    const touches = () => env.auth.sessions.get(who.hash)!.touches;
    expect((await ping(env, who, { 'sec-purpose': 'prefetch' })).status).toBe(403);
    expect((await ping(env, who, { purpose: 'prefetch' })).status).toBe(403);
    expect((await ping(env, who, { 'content-type': 'application/json' }, '{}')).status).toBe(403);
    expect((await ping(env, who, {}, 'x')).status).toBe(403);
    expect(touches()).toBe(0);
    expect(env.auth.calls).not.toContain('touch');
    // The throttle was not consumed by the refused pings: the first valid ping still counts.
    expect((await ping(env, who)).status).toBe(204);
    expect(touches()).toBe(1);
  });

  it('a recovery session reaches only its matrix', async () => {
    const env = setup();
    const who = signedIn(env, '11111111-1111-4111-8111-111111111111', 'recovery');
    expect((await apiPost(env, who, '/api/rpc/search_carriers', { p_definition: {} })).status).toBe(403);
    expect((await env.handle(fakeRequest({ url: '/api/team', headers: { cookie: who.cookie } }))).status).toBe(403);
    expect((await env.handle(fakeRequest({ url: '/api/session', headers: { cookie: who.cookie } }))).status).toBe(200);
  });

  it('store errors map to fixed responses', async () => {
    const env = setup();
    const who = signedIn(env);
    for (const [err, status, code] of [[new NotPermittedError(), 403, 'forbidden'], [new OutcomeUnknownError(), 503, 'outcome_unknown'], [new UnavailableError(), 503, 'unavailable']] as const) {
      env.data.failWith = err;
      const r = await env.handle(fakeRequest({ url: '/api/dashboard', headers: { cookie: who.cookie } }));
      expect([r.status, JSON.parse(String(r.body)).error]).toEqual([status, code]);
    }
  });
});

describe('pages, legacy routes, SPA, maintenance', () => {
  it('sign-in page, redirect when signed in, legacy routes, SPA shell only with a session', async () => {
    const env = setup();
    const form = await env.handle(fakeRequest({ url: '/signin' }));
    expect(form.body).toContain('Email me a sign-in link');
    expect(form.body).not.toContain('Everyone has been signed out');
    expect((await env.handle(fakeRequest({ url: '/signin?everyone=1' }))).body).toContain('Everyone has been signed out, including you.');
    for (const p of ['/login', '/register', '/forgot', '/reset', '/pending']) expect(location(await env.handle(fakeRequest({ url: p })))).toBe(`${ORIGIN}/signin`);
    const anon = await env.handle(fakeRequest({ url: '/batches/1', headers: { accept: 'text/html' } }));
    expect(location(anon)).toBe(`${ORIGIN}/signin`);
    const who = signedIn(env);
    expect(location(await env.handle(fakeRequest({ url: '/signin', headers: { cookie: who.cookie } })))).toBe(`${ORIGIN}/`);
    const shell = await env.handle(fakeRequest({ url: '/batches/1', headers: { cookie: who.cookie, accept: 'text/html' } }));
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const asset = await env.handle(fakeRequest({ url: '/assets/app-abc123.js' }));
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('maintenance mode serves only the notice', async () => {
    const env = setup({ maintenance: true });
    expect((await env.handle(fakeRequest({ url: '/signin' }))).status).toBe(503);
  });
});

describe('continuations and shutdown (doc 15 §4.1, unit level)', () => {
  it('a continuation registered by a request is drained before the database closes', async () => {
    const env = setup({ envelopeMs: 1, jitterMs: 0 });
    let release!: () => void;
    env.mail.respondWith(() => new Promise((r) => { release = () => r({ outcomeClass: 'accepted', providerMessageId: 'm' }); }));
    await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(env.lifecycle.counts.continuations).toBe(1);
    let closed = false;
    const done = env.lifecycle.shutdown(1_000, async () => { closed = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    release();
    expect(await done).toBe(0);
    expect(closed).toBe(true);
    expect([...env.auth.links.values()][0].status).toBe('accepted');
  });

  it('a hanging continuation is abandoned at the budget; the database still closes; admission stops', async () => {
    const env = setup({ envelopeMs: 1, jitterMs: 0 });
    env.mail.respondWith(() => new Promise(() => {}));
    await env.handle(fakeRequest({ method: 'POST', url: '/auth/request', body: 'email=editor%40example.test', headers: { 'content-type': FORM } }));
    await new Promise((r) => setTimeout(r, 20));
    let closed = false;
    const abandoned = await env.lifecycle.shutdown(50, async () => { closed = true; });
    expect(abandoned).toBe(1);
    expect(closed).toBe(true);
    expect(env.lifecycle.trackRequest(async () => 1)).toBeUndefined();
    expect([...env.auth.links.values()][0].status).toBe('pending');
  });
});
