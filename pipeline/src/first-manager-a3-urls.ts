/**
 * Offline validation of the two connection strings the first-manager A3 test (first-manager-bootstrap-a3.test.ts) is given. Pure:
 * it parses text and opens nothing. The A3 test calls it BEFORE it creates any client, so a hosted, mismatched or override-carrying URL
 * is refused without a socket. The pair must point at the same owned local cluster and database; the second URL is the app role.
 */

export const A3_APP_ROLE = 'recruiter_app';
const LOOPBACK = ['127.0.0.1', 'localhost'];

export interface A3Urls { adminDatabase: string; port: string; hasApp: boolean }

function parseLocal(label: string, raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`refusing: ${label} is not a valid URL`); }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new Error(`refusing: ${label} must be a postgresql URL`);
  if (u.search || u.hash) throw new Error(`refusing: ${label} must have no query parameters and no fragment (no connection overrides)`);
  if (!LOOPBACK.includes(u.hostname)) throw new Error(`refusing: ${label} must be loopback (127.0.0.1 or localhost)`);
  if (!u.port || u.port === '5432' || u.port === '6543') throw new Error(`refusing: ${label} must name the owned cluster's own port (not empty, not 5432 or 6543)`);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/^tr_[a-z0-9_]+$/.test(db)) throw new Error(`refusing: ${label} database name must start with tr_ and hold only lower-case letters, digits and underscores`);
  return u;
}

/** Throws (message carries no value) unless admin and app are loopback, override-free and aim at the same port and database; the app user must be recruiter_app. */
export function validateA3Urls(adminUrl: string, appUrl: string | undefined): A3Urls {
  const admin = parseLocal('FIRST_MANAGER_A3_ADMIN_URL', adminUrl);
  const port = admin.port;
  const adminDatabase = decodeURIComponent(admin.pathname.replace(/^\//, ''));
  if (appUrl !== undefined && appUrl !== '') {
    const app = parseLocal('FIRST_MANAGER_A3_APP_URL', appUrl);
    if (app.port !== port) throw new Error('refusing: FIRST_MANAGER_A3_APP_URL must use the same port as the admin URL (the same owned cluster)');
    if (decodeURIComponent(app.pathname.replace(/^\//, '')) !== adminDatabase) throw new Error('refusing: FIRST_MANAGER_A3_APP_URL must name the same database as the admin URL');
    if (decodeURIComponent(app.username) !== A3_APP_ROLE) throw new Error(`refusing: FIRST_MANAGER_A3_APP_URL must log in as ${A3_APP_ROLE}`);
    if (app.hostname !== admin.hostname) throw new Error('refusing: FIRST_MANAGER_A3_APP_URL must use the same host spelling as the admin URL');
  }
  return { adminDatabase, port, hasApp: appUrl !== undefined && appUrl !== '' };
}
