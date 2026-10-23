// Server entry: wires config, database, stores, mail and the HTTP binding; drains on SIGTERM
// (doc 15 §4.1: stop admission, drain requests and continuations, close the pool, exit).

import type { Server } from 'node:http';
import { createApp, DEFAULT_TIMING } from './app';
import { parseServerEnv, type ServerEnv } from './config';
import { Lifecycle } from './core/lifecycle';
import type { Logger } from './core/types';
import { Database } from './db/database';
import { PgAuthStore } from './db/pg-auth-store';
import { PgDataStore } from './db/pg-data-store';
import { createNodeServer } from './http/node-adapter';
import { loadStaticFiles } from './http/static-files';
import type { MailAdapter } from './mail/adapter';
import { FakeMailAdapter } from './mail/fake';
import { SendGridAdapter } from './mail/sendgrid';

/** Structured, value-free log lines (category + counts only). */
export const consoleLogger: Logger = (event, fields) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...(fields ?? {}) })}\n`);
};

export interface RunningServer {
  server: Server;
  port: number;
  lifecycle: Lifecycle;
  mail: MailAdapter;
  shutdown(budgetMs?: number): Promise<number>;
}

export async function startServer(env: ServerEnv, options: { log?: Logger; mail?: MailAdapter; timing?: Partial<typeof DEFAULT_TIMING> } = {}): Promise<RunningServer> {
  const log = options.log ?? consoleLogger;
  // Two pools (Gate 2 review N1): sign-in work (admission, mint, redeem, session checks) has its
  // own small pool, kept warm, so long data transactions can never take the connection the
  // 600 ms admission check needs; the data pool serves everything else.
  // Waiting for a connection: ordinary requests (both pools) up to DB_ACQUIRE_TIMEOUT_MS
  // (default 5 s); only the sign-in admission check keeps its tight 400 ms limit (PgAuthStore
  // bucketHit). Exceeding either fails closed (503 / the uniform sign-in response) with an alert.
  const acquireAlert = (pool: string) => log('operator_alert', { category: 'db_pool_acquire_failed', pool });
  const authDb = new Database({ connectionString: env.databaseUrl, max: 4, connectionTimeoutMillis: env.dbAcquireTimeoutMs, minWarm: 2, label: 'auth', onAcquireFailure: acquireAlert });
  const db = new Database({ connectionString: env.databaseUrl, max: 10, connectionTimeoutMillis: env.dbAcquireTimeoutMs, label: 'data', onAcquireFailure: acquireAlert });
  const lifecycle = new Lifecycle();
  const mail = options.mail ?? (env.emailMode === 'production' && env.sendgrid
    ? new SendGridAdapter({ ...env.sendgrid, fetch: (url, init) => fetch(url, init) })
    : new FakeMailAdapter());
  const handle = createApp({
    config: {
      appOrigin: env.appOrigin,
      keys: env.keys,
      stagingBanner: env.stagingBanner,
      maintenance: env.maintenance,
      webhookPublicKey: env.webhookPublicKey,
      ...DEFAULT_TIMING,
      ...options.timing,
    },
    auth: new PgAuthStore(authDb),
    data: new PgDataStore(db),
    mail,
    lifecycle,
    log,
    staticFiles: loadStaticFiles(env.staticDir),
    now: () => Date.now(),
    monotonic: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: Math.random,
  });
  const warmStarted = Date.now();
  try {
    const open = await authDb.warm();
    log('db_warmup', { pool: 'auth', open, ms: Date.now() - warmStarted });
  } catch {
    // Serve anyway: every sign-in path fails closed and alerts; the keep-warm timer retries.
    log('operator_alert', { category: 'db_unavailable_at_start' });
  }
  const server = createNodeServer(handle, lifecycle, env.trustedProxyHops, log);
  await new Promise<void>((resolve) => server.listen(env.port, env.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : env.port;
  return {
    server,
    port,
    lifecycle,
    mail,
    async shutdown(budgetMs = 45_000) {
      // Work still in flight when shutdown begins (doc 16 T-SHUTDOWN: proves work was pending at
      // SIGTERM). Counts only: accepted requests and post-response continuations not yet done.
      const pending = lifecycle.counts;
      log('shutdown_started', { accepted: pending.accepted, continuations: pending.continuations, budgetMs });
      server.close();
      server.closeIdleConnections?.();
      const abandoned = await lifecycle.shutdown(budgetMs, async () => {
        await Promise.all([db.close(), authDb.close()]);
      });
      log('shutdown', { abandoned });
      return abandoned;
    },
  };
}

// Run directly: node dist-server/main.js (built with `npm run build:server`).
if (process.argv[1] && /main\.(js|mjs)$/.test(process.argv[1])) {
  const env = parseServerEnv(process.env);
  startServer(env).then((running) => {
    consoleLogger('listening', { port: running.port });
    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(1);
      stopping = true;
      running.shutdown().then((abandoned) => process.exit(abandoned === 0 ? 0 : 1));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}
