const PRODUCTION_PROJECT_REF = 'ejrfobddnojbijzrjbii';
const STAGING_PROJECT_REF = 'yhyoxhtguyturgdhwywc';

export type PipelineEnvironment = 'prod' | 'dev';

export interface TargetGuardInput {
  environment: PipelineEnvironment;
  supabaseUrl: string;
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
  if (!/^[a-z]{20}$/.test(projectRef)) {
    throw new Error(`SUPABASE_URL contains an invalid project ref: ${projectRef || '(empty)'}`);
  }
  return projectRef;
}

/**
 * Fail closed before the pipeline opens a database or service-role client.
 * Production must resolve to the one recorded Carrier Recruiter ref. Dev must
 * resolve to an explicit allowlist and can never resolve to production.
 */
export function verifyPipelineTarget(input: TargetGuardInput): VerifiedTarget {
  const projectRef = projectRefFromUrl(input.supabaseUrl);
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
