/**
 * Environment configuration — Task T02.
 *
 * Zod-validated, dotenv-loaded parser for the secrets the platform needs at
 * boot. Required variables (`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`,
 * `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) MUST be present and well-formed or the
 * process fails fast — PHI-handling code must never run with a half-configured
 * environment.
 *
 * Acceptance (matrix T02): throws an error on missing required env vars.
 */
import 'dotenv/config';
import { z } from 'zod';

/**
 * 32-byte AES-256 key encoded as 64 lowercase/uppercase hex characters.
 * Generate with: `openssl rand -hex 32`.
 */
const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)');

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Database (PostgreSQL + pgvector)
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL connection string',
    ),

  // Auth
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters'),

  // At-rest field encryption
  ENCRYPTION_KEY: hex64,

  // External AI providers
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validate a raw environment record and return a typed, frozen config.
 * Throws a formatted `Error` (not a bare ZodError) listing every problem.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}

let cached: Env | undefined;

/**
 * Lazily-validated singleton for application code. Validation happens on first
 * access (not at import), so test modules can import this file without a fully
 * populated environment.
 */
export function getEnv(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}

/** Reset the memoized env — test-only helper. */
export function resetEnvCache(): void {
  cached = undefined;
}
