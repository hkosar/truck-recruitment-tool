const PRODUCTION_PROJECT_REF = 'ejrfobddnojbijzrjbii';
const STAGING_PROJECT_REF = 'yhyoxhtguyturgdhwywc';

export type PipelineEnvironment = 'prod' | 'dev';

export interface TargetGuardInput {
  environment: PipelineEnvironment;
  supabaseUrl: string;
  /** SUPABASE_DB_URL -- the bulk-write Postgres connection. Must resolve to the same ref. */
  supabaseDbUrl: string;
  allowedDevRefs?: readonly string[];
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

/**
 * Resolve the Supabase project ref a Postgres connection string points at, without ever
 * echoing the string (it carries the database password). Supported shapes:
 *   - direct / dedicated pooler: host db.<ref>.supabase.co
 *   - shared Supavisor pooler:   host *.pooler.supabase.com, user <role>.<ref>
 * If both the host and the user name a ref they must agree. Anything else is refused.
 */
function projectRefFromDbUrl(rawDbUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawDbUrl);
  } catch {
    throw new Error('SUPABASE_DB_URL is not a parseable postgres:// connection string');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('SUPABASE_DB_URL must be a postgres:// connection string');
  }
  const host = url.hostname.toLowerCase();
  const user = decodeURIComponent(url.username);

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
  return projectRef;
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
  const dbProjectRef = projectRefFromDbUrl(input.supabaseDbUrl);
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
  }
  return { projectRef, environment: input.environment };
}

export const RECORDED_PROJECT_REFS = {
  production: PRODUCTION_PROJECT_REF,
  staging: STAGING_PROJECT_REF,
} as const;
