// Environment configuration, validated at boot (Quote-Queue lib/env.ts pattern). Error messages
// name the variable and the rule only; values are never echoed (QQ gap D3).

export interface ServerEnv {
  appOrigin: string;
  keys: { links: string; sessions: string; rate: string };
  databaseUrl: string;
  emailMode: 'test' | 'production';
  sendgrid: { apiKey: string; fromAddress: string; fromName: string } | undefined;
  webhookPublicKey: string | undefined;
  maintenance: boolean;
  stagingBanner: boolean;
  trustedProxyHops: number;
  host: string;
  port: number;
  staticDir: string;
}

export class ConfigError extends Error {
  constructor(readonly variable: string, rule: string) {
    super(`${variable}: ${rule}`);
  }
}

const KEY = /^[A-Za-z0-9_-]{43,}$/;

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(name, 'is required');
  return v;
}

export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const appOrigin = required(env, 'APP_ORIGIN');
  let origin: URL;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new ConfigError('APP_ORIGIN', 'must be an exact origin');
  }
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
  if (origin.origin !== appOrigin || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) {
    throw new ConfigError('APP_ORIGIN', 'must be an exact https origin (http only for localhost), no path or trailing slash');
  }
  const key = (name: string) => {
    const v = required(env, name);
    if (!KEY.test(v)) throw new ConfigError(name, 'must be at least 43 base64url characters (256-bit key)');
    return v;
  };
  const keys = { links: key('KEY_LINKS'), sessions: key('KEY_SESSIONS'), rate: key('KEY_RATE') };
  if (new Set(Object.values(keys)).size !== 3) throw new ConfigError('KEY_LINKS', 'the three keys must differ');
  const databaseUrl = required(env, 'DATABASE_URL');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new ConfigError('DATABASE_URL', 'must be a postgres:// URL');
  const emailMode = env.EMAIL_MODE === 'production' ? 'production' : env.EMAIL_MODE === 'test' ? 'test' : undefined;
  if (!emailMode) throw new ConfigError('EMAIL_MODE', "must be 'test' or 'production'");
  const sendgrid = emailMode === 'production'
    ? { apiKey: required(env, 'SENDGRID_API_KEY'), fromAddress: required(env, 'SENDGRID_FROM_ADDRESS'), fromName: env.SENDGRID_FROM_NAME ?? 'Carrier Recruiter' }
    : undefined;
  const hops = Number(env.TRUSTED_PROXY_HOPS ?? '1');
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new ConfigError('TRUSTED_PROXY_HOPS', 'must be an integer 0-5');
  const port = Number(env.PORT ?? '8788');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('PORT', 'must be a port number');
  return {
    appOrigin,
    keys,
    databaseUrl,
    emailMode,
    sendgrid,
    webhookPublicKey: env.SENDGRID_WEBHOOK_VERIFICATION_KEY || undefined,
    maintenance: env.MAINTENANCE_MODE === 'true',
    stagingBanner: env.STAGING_BANNER === 'true',
    trustedProxyHops: hops,
    host: env.HOST ?? '127.0.0.1',
    port,
    staticDir: env.STATIC_DIR ?? 'dist',
  };
}
