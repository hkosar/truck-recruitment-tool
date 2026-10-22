// A4 REAL-HTTP TESTS (approval A4: local Node server on loopback, fake mailer, no external
// services) against the A3 database. Skipped unless RUN_HTTP_TESTS=1 and A3_APP_URL are set and
// the build exists (npm run build). Port: E2E_PORT (recorded in the A3/A4 ownership file).

import { existsSync } from 'node:fs';
import { request } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseServerEnv } from './config';
import { FakeMailAdapter } from './mail/fake';
import { startServer, type RunningServer } from './main';

const enabled = process.env.RUN_HTTP_TESTS === '1' && Boolean(process.env.A3_APP_URL) && Boolean(process.env.A3_ADMIN_URL) && existsSync('dist/index.html');
const PORT = Number(process.env.E2E_PORT ?? '55474');
const ORIGIN = `http://localhost:${PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const key = (n: number) => Buffer.alloc(32, n).toString('base64url');

type Jar = Map<string, string>;
function absorb(jar: Jar, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
    if (value === '' || /Max-Age=0/.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

describe.skipIf(!enabled)('A4 real HTTP: sign-in end to end, timing, bodies, shutdown', () => {
  let running: RunningServer;
  const mail = new FakeMailAdapter();
  const logs: string[] = [];

  beforeAll(async () => {
    // Clean sign-in ledger for the fixture people, so consecutive runs never hit the courtesy
    // window or the flood buckets of a previous run (task-owned test database only).
    if (process.env.A3_ADMIN_URL) {
      const admin = new pg.Client({ connectionString: process.env.A3_ADMIN_URL });
      await admin.connect();
      await admin.query(`delete from internal.signin_links where user_id::text like '71000000-0000-4000-8000-%'`);
      await admin.query('delete from internal.auth_request_buckets');
      await admin.end();
    }
    const env = parseServerEnv({
      APP_ORIGIN: ORIGIN, KEY_LINKS: key(11), KEY_SESSIONS: key(12), KEY_RATE: key(13),
      DATABASE_URL: process.env.A3_APP_URL!, EMAIL_MODE: 'test', PORT: String(PORT), HOST: '127.0.0.1', TRUSTED_PROXY_HOPS: '0', STATIC_DIR: 'dist',
    });
    running = await startServer(env, { mail, log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) });
  });
  afterAll(async () => {
    if (running?.lifecycle.isAccepting) await running.shutdown(5_000);
  });

  const post = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`${BASE}${path}`, { method: 'POST', redirect: 'manual', headers: { origin: ORIGIN, ...headers }, body });

  it('request → email link → landing → confirm → signed-in API and app shell → sign out', async () => {
    const t0 = performance.now();
    const req = await post('/auth/request', 'email=editor%40tnbs-recruiter.example.invalid', { 'content-type': 'application/x-www-form-urlencoded' });
    const elapsed = performance.now() - t0;
    expect(req.status).toBe(303);
    expect(req.headers.get('location')).toBe(`${ORIGIN}/signin?sent=1`);
    expect(elapsed).toBeGreaterThanOrEqual(880);
    expect(elapsed).toBeLessThan(1_300);
    for (let i = 0; i < 50 && !mail.lastLinkFor('editor@tnbs-recruiter.example.invalid'); i++) await new Promise((r) => setTimeout(r, 100));
    const link = mail.lastLinkFor('editor@tnbs-recruiter.example.invalid')!;
    expect(link).toMatch(new RegExp(`^${ORIGIN}/auth/verify\\?token=`));

    const jar: Jar = new Map();
    const land = await fetch(link.replace(ORIGIN, BASE), { redirect: 'manual' });
    expect(land.status).toBe(303);
    expect(land.headers.get('location')).not.toContain('token');
    absorb(jar, land);
    expect(jar.has('__Host-tr_confirm')).toBe(true);
    const confirmUrl = land.headers.get('location')!.replace(ORIGIN, BASE);
    const page = await fetch(confirmUrl, { headers: { cookie: cookieHeader(jar) } });
    const html = await page.text();
    expect(html).toContain('Finish signing in as <strong>e•••@tnbs-recruiter.example.invalid</strong>.');
    absorb(jar, page);
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)![1];
    const done = await post('/auth/confirm', `nonce=${nonce}&csrf_token=${csrf}`, { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) });
    expect(done.status).toBe(303);
    expect(done.headers.getSetCookie().some((c) => /^__Host-tr_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/.test(c))).toBe(true);
    absorb(jar, done);

    const me = await fetch(`${BASE}/api/session`, { headers: { cookie: cookieHeader(jar) } });
    const session = await me.json();
    expect(session).toMatchObject({ user: { email: 'editor@tnbs-recruiter.example.invalid', role: 'edit' }, sessionKind: 'link' });
    absorb(jar, me);
    const totals = await fetch(`${BASE}/api/rpc/dashboard_totals`, { method: 'POST', headers: { origin: ORIGIN, cookie: cookieHeader(jar), 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: '{}' });
    expect(totals.status).toBe(200);
    const dash = await fetch(`${BASE}/api/dashboard`, { headers: { cookie: cookieHeader(jar) } });
    expect(Array.isArray(await dash.json())).toBe(true);
    const profile = await fetch(`${BASE}/api/carriers/1400001/profile`, { headers: { cookie: cookieHeader(jar) } });
    expect((await profile.json()).carrier.dot_number).toBe(1400001);
    const shell = await fetch(`${BASE}/dashboard`, { headers: { cookie: cookieHeader(jar), 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' } });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<div id="root">');

    const out = await post('/auth/signout', `csrf_token=${session.csrfToken}`, { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) });
    expect(out.status).toBe(303);
    expect((await fetch(`${BASE}/api/session`, { headers: { cookie: cookieHeader(jar) } })).status).toBe(401);
    const reuse = await post('/auth/confirm', `nonce=${nonce}&csrf_token=${csrf}`, { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) });
    expect(await reuse.text()).toContain('This link was already used or has expired.');
    expect(logs.join('\n')).not.toContain(link.split('token=')[1]);
  });

  it('timing over HTTP: known, unknown, inactive and invalid all land in the same envelope', async () => {
    const bodies = ['email=viewer%40tnbs-recruiter.example.invalid', 'email=nobody%40example.invalid', 'email=disabled%40tnbs-recruiter.example.invalid', 'email=bad'];
    const times = await Promise.all(bodies.map(async (b) => {
      const t0 = performance.now();
      const r = await post('/auth/request', b, { 'content-type': 'application/x-www-form-urlencoded' });
      expect(r.status).toBe(303);
      return performance.now() - t0;
    }));
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(880);
      expect(t).toBeLessThan(1_300);
    }
  });

  it('an oversized chunked body still gets the generic response, then the connection closes', async () => {
    const result = await new Promise<{ status: number; location: string | undefined; connection: string | undefined }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/auth/request', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked', origin: ORIGIN } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, connection: res.headers.connection }));
      });
      r.on('error', reject);
      for (let i = 0; i < 16; i++) r.write(Buffer.alloc(8 * 1024, 97));
      r.end();
    });
    expect(result).toEqual({ status: 303, location: `${ORIGIN}/signin?sent=1`, connection: 'close' });
  });

  it('shutdown during the response envelope: the response is delivered, the continuation finishes, new connections are refused', async () => {
    const before = mail.count;
    const pending = post('/auth/request', 'email=manager%40tnbs-recruiter.example.invalid', { 'content-type': 'application/x-www-form-urlencoded' });
    await new Promise((r) => setTimeout(r, 300));
    const abandoned = running.shutdown(10_000);
    const res = await pending;
    expect(res.status).toBe(303);
    expect(await abandoned).toBe(0);
    expect(mail.count).toBe(before + 1);
    // Admission has stopped: a request on a reused keep-alive connection gets 503 + Retry-After
    // (doc 15 §4.1); a new connection is refused because the listener is closed.
    const late = await fetch(`${BASE}/signin`).then((r) => ({ status: r.status, retry: r.headers.get('retry-after') }), () => ({ status: 0, retry: null }));
    expect([0, 503]).toContain(late.status);
    if (late.status === 503) expect(late.retry).toBe('5');
  });
});
