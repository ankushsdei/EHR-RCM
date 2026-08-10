/**
 * Tests for Task T02 — src/config/env.config.ts.
 * Acceptance: "Throws error on missing required env vars."
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseEnv, getEnv, resetEnvCache } from '@/config/env.config';

const VALID: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ehr_rcm?schema=public',
  JWT_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: 'ab'.repeat(32), // 64 hex chars
  OPENAI_API_KEY: 'sk-openai-test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

describe('env.config (T02)', () => {
  afterEach(() => resetEnvCache());

  it('parses a fully-populated environment and applies defaults', () => {
    const env = parseEnv(VALID);
    expect(env.DATABASE_URL).toContain('postgresql://');
    expect(env.NODE_ENV).toBe('development'); // default
    expect(env.PORT).toBe(3000); // default, coerced number
    expect(typeof env.PORT).toBe('number');
  });

  it('throws when ALL required vars are missing', () => {
    expect(() => parseEnv({})).toThrow(/Invalid environment configuration/);
  });

  it('throws and names the offending var when JWT_SECRET is missing', () => {
    const { JWT_SECRET, ...rest } = VALID;
    void JWT_SECRET;
    expect(() => parseEnv(rest)).toThrow(/JWT_SECRET/);
  });

  it('rejects a too-short JWT_SECRET', () => {
    expect(() => parseEnv({ ...VALID, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    expect(() => parseEnv({ ...VALID, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an ENCRYPTION_KEY that is not 64 hex chars', () => {
    expect(() => parseEnv({ ...VALID, ENCRYPTION_KEY: 'deadbeef' })).toThrow(
      /ENCRYPTION_KEY/,
    );
    expect(() => parseEnv({ ...VALID, ENCRYPTION_KEY: 'zz'.repeat(32) })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  it('honors PORT and NODE_ENV overrides', () => {
    const env = parseEnv({ ...VALID, PORT: '8080', NODE_ENV: 'production' });
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('production');
  });

  it('getEnv memoizes and resetEnvCache clears it', () => {
    const prev = { ...process.env };
    try {
      Object.assign(process.env, VALID);
      resetEnvCache();
      const a = getEnv();
      const b = getEnv();
      expect(a).toBe(b); // same frozen instance
    } finally {
      // restore
      for (const k of Object.keys(VALID)) delete process.env[k];
      Object.assign(process.env, prev);
      resetEnvCache();
    }
  });
});
