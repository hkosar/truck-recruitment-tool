const PRODUCTION_PROJECT_REF = 'ejrfobddnojbijzrjbii';
const STAGING_PROJECT_REF = 'yhyoxhtguyturgdhwywc';

export type PipelineEnvironment = 'prod' | 'dev';

export interface TargetGuardInput {
  environment: PipelineEnvironment;
  supabaseUrl: string;
  /** SUPABASE_DB_URL -- the bulk-write Postgres connection. Must resolve to the same ref. */
  supabaseDbUrl: string;
  allowedDevRefs?: readonly string[];
  /** PIPELINE_ALLOW_STAGING_WRITES. The staging project is refused unless this is true. */
  allowStagingWrites?: boolean;
}

export interface VerifiedTarget {
  projectRef: string;
  environment: PipelineEnvironment;
}

function projectRefFromUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) {
    throw new Error('SUPABASE_URL must be an https://<project-ref>.supabase.co URL');
  }
  const projectRef = url.hostname.slice(0, -'.supabase.co'.length);
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new Error(`SUPABASE_URL contains an invalid project ref: ${projectRef || '(empty)'}`);
  }
  return projectRef;
}

const PROJECT_REF_PATTERN = /^[a-z]{20}$/;

/** The exact connection target the Postgres pool is built from (never a connection string). */
export interface SupabaseDbTarget {
  projectRef: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Parse SUPABASE_DB_URL into explicit connection fields and resolve the Supabase project
 * ref they point at, without ever echoing the string (it carries the database password).
 * Supported shapes:
 *   - direct / dedicated pooler: host db.<ref>.supabase.co
 *   - shared Supavisor pooler:   host *.pooler.supabase.com, user <role>.<ref>
 * If both the host and the user name a ref they must agree. Anything else is refused.
 *
 * Query parameters and fragments are refused outright: pg's connection-string parser lets
 * ?host=, ?user=, ?port= (and friends) override the URL's own fields, so a staging-looking
 * URL could otherwise send the driver to another project. createPgPool() builds the pool
 * from the returned fields, not from the raw string, so what is checked is what is used.
 */
export function parseSupabaseDbTarget(rawDbUrl: string): SupabaseDbTarget {
  let url: URL;
  try {
    url = new URL(rawDbUrl);
  } catch {
    throw new Error('SUPABASE_DB_URL is not a parseable postgres:// connection string');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('SUPABASE_DB_URL must be a postgres:// connection string');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('SUPABASE_DB_URL must not contain query parameters or a fragment (they can override the connection target)');
  }
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new Error('SUPABASE_DB_URL host contains unexpected characters');
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = url.port === '' ? 5432 : Number(url.port);
  const database = url.pathname.length > 1 ? decodeURIComponent(url.pathname.slice(1)) : 'postgres';
  if (!user || !password) {
    throw new Error('SUPABASE_DB_URL must include a user name and password');
  }
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error('SUPABASE_DB_URL database name contains unexpected characters');
  }

  let hostRef: string | null = null;
  const directMatch = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (directMatch) {
    hostRef = directMatch[1] ?? null;
  } else if (!host.endsWith('.pooler.supabase.com')) {
    throw new Error('SUPABASE_DB_URL host is not a Supabase database or pooler host');
  }

  const userDot = user.lastIndexOf('.');
  const userRef = userDot >= 0 ? user.slice(userDot + 1) : null;

  if (hostRef === null && userRef === null) {
    throw new Error('SUPABASE_DB_URL pooler user name does not identify a project (<role>.<project-ref>)');
  }
  if (hostRef !== null && userRef !== null && hostRef !== userRef) {
    throw new Error('SUPABASE_DB_URL host and user name identify different projects');
  }
  const projectRef = (hostRef ?? userRef) as string;
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new Error('SUPABASE_DB_URL contains an invalid project ref');
  }
  return { projectRef, host, port, user, password, database };
}

/**
 * Fail closed before the pipeline opens a database or service-role client.
 * Production must resolve to the one recorded Carrier Recruiter ref. Dev must
 * resolve to an explicit allowlist and can never resolve to production. Both the
 * service-role API URL and the bulk-write database connection must resolve to that same
 * project; a mismatch would let run metadata land in one project while carrier rows are
 * written to another.
 */
export function verifyPipelineTarget(input: TargetGuardInput): VerifiedTarget {
  const projectRef = projectRefFromUrl(input.supabaseUrl);
  const dbProjectRef = parseSupabaseDbTarget(input.supabaseDbUrl).projectRef;
  if (dbProjectRef !== projectRef) {
    throw new Error(
      `SUPABASE_DB_URL project ${dbProjectRef} does not match SUPABASE_URL project ${projectRef}; refusing to open either client`
    );
  }
  if (input.environment === 'prod') {
    if (projectRef !== PRODUCTION_PROJECT_REF) {
      throw new Error(`PIPELINE_ENV=prod requires the production Carrier Recruiter ref ${PRODUCTION_PROJECT_REF}`);
    }
  } else {
    const allowed = new Set(input.allowedDevRefs ?? []);
    if (projectRef === PRODUCTION_PROJECT_REF) {
      throw new Error('PIPELINE_ENV=dev refuses the production Carrier Recruiter project');
    }
    if (!allowed.has(projectRef)) {
      throw new Error(`Dev project ref ${projectRef} is not in PIPELINE_ALLOWED_DEV_REFS`);
    }
    if (projectRef === STAGING_PROJECT_REF && input.allowStagingWrites !== true) {
      throw new Error(
        'PIPELINE_ENV=dev refuses the shared staging project (fictional fixture data only) unless PIPELINE_ALLOW_STAGING_WRITES=true'
      );
    }
  }
  return { projectRef, environment: input.environment };
}

export const RECORDED_PROJECT_REFS = {
  production: PRODUCTION_PROJECT_REF,
  staging: STAGING_PROJECT_REF,
} as const;
