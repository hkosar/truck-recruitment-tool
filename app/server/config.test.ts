import { describe, expect, it } from 'vitest';
import { ConfigError, parseServerEnv } from './config';
import { mapPgError } from './db/database';
import { NotFoundError, NotPermittedError, RefusedError, UnavailableError } from './core/types';

const k = (n: number) => Buffer.alloc(32, n).toString('base64url');
const base = { APP_ORIGIN: 'https://recruiter.example.test', KEY_LINKS: k(1), KEY_SESSIONS: k(2), KEY_RATE: k(3), DATABASE_URL: 'postgres://u@h/d', EMAIL_MODE: 'test' };

describe('server env', () => {
  it('accepts a valid environment', () => {
    expect(parseServerEnv(base)).toMatchObject({ appOrigin: 'https://recruiter.example.test', emailMode: 'test', port: 8788, host: '127.0.0.1' });
  });
  it('database connection wait: 5 s by default, configurable within 500-30000 ms', () => {
    expect(parseServerEnv(base).dbAcquireTimeoutMs).toBe(5_000);
    expect(parseServerEnv({ ...base, DB_ACQUIRE_TIMEOUT_MS: '8000' }).dbAcquireTimeoutMs).toBe(8_000);
    for (const v of ['250', '60000', 'abc', '1.5']) expect(() => parseServerEnv({ ...base, DB_ACQUIRE_TIMEOUT_MS: v })).toThrow(ConfigError);
  });
  it('names the variable and never echoes the value', () => {
    const secret = 'postgres-password-should-not-appear';
    for (const bad of [
      { ...base, APP_ORIGIN: 'http://recruiter.example.test' },
      { ...base, APP_ORIGIN: 'https://recruiter.example.test/' },
      { ...base, KEY_LINKS: 'short' },
      { ...base, KEY_RATE: base.KEY_LINKS },
      { ...base, DATABASE_URL: `mysql://${secret}` },
      { ...base, EMAIL_MODE: 'production' },
    ]) {
      try {
        parseServerEnv(bad);
        throw new Error('expected failure');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect(String((e as Error).message)).not.toContain(secret);
      }
    }
    expect(parseServerEnv({ ...base, APP_ORIGIN: 'http://localhost:8788' }).appOrigin).toBe('http://localhost:8788');
  });
});

describe('SQLSTATE mapping', () => {
  it('maps fixed codes and never passes database text through', () => {
    expect(mapPgError({ code: '42501' })).toBeInstanceOf(NotPermittedError);
    expect(mapPgError({ code: '23514' })).toEqual(new RefusedError('dnc_blocked'));
    expect(mapPgError({ code: 'P0002' })).toBeInstanceOf(NotFoundError);
    for (const c of ['57014', '55P03', '40P01', '08006', 'XX000', undefined]) expect(mapPgError({ code: c })).toBeInstanceOf(UnavailableError);
  });
});
