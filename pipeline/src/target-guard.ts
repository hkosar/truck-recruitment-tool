const PRODUCTION_PROJECT_REF = 'ejrfobddnojbijzrjbii';
const STAGING_PROJECT_REF = 'yhyoxhtguyturgdhwywc';
/**
 * The rebuilt staging project (doc 16 section 1.3, R1 step 2): created by the owner, confirmed from the owner's
 * dashboard (region us-east-2, Micro compute, healthy). Its ref is recorded here by its own reviewed commit; every
 * rebuilt-project action is refused for any other ref (staging-rebuilt.ts).
 */
const REBUILT_STAGING_PROJECT_REF: string | null = 'ojqtsftfclhxauhjwott';

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
    if ((projectRef === STAGING_PROJECT_REF || projectRef === REBUILT_STAGING_PROJECT_REF) && input.allowStagingWrites !== true) {
      throw new Error(
        'PIPELINE_ENV=dev refuses the shared staging project (fictional fixture data only) unless PIPELINE_ALLOW_STAGING_WRITES=true'
      );
    }
  }
  return { projectRef, environment: input.environment };
}

/**
 * The ONLY database address accepted for the rebuilt staging project (staging-2): the shared Supavisor pooler in session
 * mode. The pinned root (supabase-root-ca.ts) was verified only against the staging-2 pooler chain *.pooler.supabase.com;
 * the direct host db.<ref>.supabase.co was never checked (and is IPv6-only without the add-on, doc 16 section 2.7). Session
 * mode is port 5432 (doc 16 section 2.6). The host must be one plain label followed by the suffix; the exact real label
 * (aws-<n>-<region>, as in this repository's fake test URLs) is (not verified) from the repository, so only its shape is
 * checked. Enforced before any connection by pg-secure.ts refuseStaging2UnlessPooler (refusal staging2_pooler_required).
 */
export const STAGING2_POOLER_ADDRESS = { hostSuffix: '.pooler.supabase.com', hostLabel: /^[a-z0-9-]+$/, port: 5432 } as const;

/** True when the fields point at staging-2: a parsed projectRef, a host that contains its ref, or a pooler user `<role>.<ref>`. */
export function namesRebuiltStaging(target: { host: string; user: string; projectRef?: string }): boolean {
  const ref = REBUILT_STAGING_PROJECT_REF;
  if (ref === null) return false;
  const user = String(target.user).toLowerCase();
  const dot = user.lastIndexOf('.');
  return target.projectRef === ref || String(target.host).toLowerCase().includes(ref) || (dot >= 0 && user.slice(dot + 1) === ref);
}

/** True only for the STAGING2_POOLER_ADDRESS shape: `<label>.pooler.supabase.com`, port 5432. */
export function isStaging2PoolerAddress(target: { host: string; port: number }): boolean {
  const host = String(target.host).toLowerCase();
  const { hostSuffix, hostLabel, port } = STAGING2_POOLER_ADDRESS;
  return host.endsWith(hostSuffix) && hostLabel.test(host.slice(0, -hostSuffix.length)) && target.port === port;
}

export const RECORDED_PROJECT_REFS = {
  production: PRODUCTION_PROJECT_REF,
  staging: STAGING_PROJECT_REF,
  stagingRebuilt: REBUILT_STAGING_PROJECT_REF,
} as const;
