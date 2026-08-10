/**
 * Extended Prisma client with dynamic field-level encryption — Task T04.
 *
 * Wraps `PrismaClient` with a `$extends` query middleware that transparently
 * AES-256-GCM encrypts sensitive PII (`ssn`, `phone`, `address`) on the way
 * into the database and decrypts it on the way out — but only when
 * `podConfig.security.encryptSensitiveData === true`. In modes where that flag
 * is off (e.g. GENERIC), values pass through untouched.
 *
 * Design notes:
 *  - Client construction is lazy (`getPrisma()`); importing this module never
 *    instantiates PrismaClient, so pure crypto logic stays unit-testable
 *    without a database or a generated client.
 *  - The crypto helpers and record transforms are exported directly so they
 *    can be tested in isolation (see tests/shared/prisma-crypto.test.ts).
 *
 * Acceptance (matrix T04): encrypts SSN/phone on create; decrypts on read when
 * `encryptSensitiveData === true`.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { podConfig } from '@/config/pod.config';

// -----------------------------------------------------------------------------
// Sensitive-field registry
// -----------------------------------------------------------------------------

/**
 * Map of Prisma delegate name -> encrypted field names. Delegate names are the
 * lowercase model names used by `$extends({ query: { <delegate>: ... } })`.
 */
export const SENSITIVE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  customer: ['ssn', 'phone', 'address'] as const,
});

// -----------------------------------------------------------------------------
// AES-256-GCM primitives
// -----------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, recommended for GCM
const KEY_BYTES = 32; // AES-256
const PREFIX = 'enc:v1'; // marker => "this string is ciphertext we produced"

/**
 * Resolve the 32-byte encryption key from `ENCRYPTION_KEY` (64 hex chars).
 * Read at call time (not import) so tests can set the env before use.
 */
function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'ENCRYPTION_KEY must be set to 64 hex characters (32 bytes) for field encryption',
    );
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

/** True when `value` is a ciphertext token previously produced by `encrypt`. */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

/**
 * Encrypt a plaintext string. Idempotent: an already-encrypted token is
 * returned unchanged, so re-saving a decrypted-then-untouched record is safe.
 * Format: `enc:v1:<ivHex>:<authTagHex>:<cipherB64>`.
 */
export function encrypt(plaintext: string): string {
  if (isEncrypted(plaintext)) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('base64')}`;
}

/**
 * Decrypt a ciphertext token produced by `encrypt`. A value that is not in our
 * token format is returned unchanged (defensive against legacy/plaintext rows).
 * Throws if the token is malformed or fails GCM authentication (tampering).
 */
export function decrypt(token: string): string {
  if (!isEncrypted(token)) return token;
  const parts = token.split(':');
  // ['enc','v1',ivHex,tagHex,cipherB64]
  if (parts.length !== 5) {
    throw new Error('Malformed ciphertext token');
  }
  const [, , ivHex, tagHex, dataB64] = parts as [string, string, string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error('Malformed ciphertext token');
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/** Constant-time string comparison helper (e.g. for hashed lookups). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// -----------------------------------------------------------------------------
// Record-level transforms
// -----------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function fieldsFor(model: string): readonly string[] {
  return SENSITIVE_FIELDS[model.toLowerCase()] ?? [];
}

/**
 * Return a shallow copy of `data` with this model's sensitive string fields
 * encrypted. Non-string / null / already-encrypted values are left as-is.
 */
export function encryptRecord<T extends Rec>(model: string, data: T): T {
  const fields = fieldsFor(model);
  if (fields.length === 0 || data == null) return data;
  const out: Rec = { ...data };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === 'string' && v.length > 0) {
      out[field] = encrypt(v);
    }
  }
  return out as T;
}

/**
 * Return a shallow copy of `record` with this model's sensitive fields
 * decrypted. Safe to call on rows that were never encrypted.
 */
export function decryptRecord<T extends Rec>(model: string, record: T): T {
  const fields = fieldsFor(model);
  if (fields.length === 0 || record == null) return record;
  const out: Rec = { ...record };
  for (const field of fields) {
    const v = out[field];
    if (isEncrypted(v)) {
      out[field] = decrypt(v);
    }
  }
  return out as T;
}

/** Decrypt a single record or an array of records (read-result shapes). */
export function decryptResult<T>(model: string, result: T): T {
  if (Array.isArray(result)) {
    return result.map((r) =>
      r && typeof r === 'object' ? decryptRecord(model, r as Rec) : r,
    ) as unknown as T;
  }
  if (result && typeof result === 'object') {
    return decryptRecord(model, result as Rec) as unknown as T;
  }
  return result;
}

// -----------------------------------------------------------------------------
// Prisma $extends encryption extension
// -----------------------------------------------------------------------------

type QueryFn = (args: unknown) => Promise<unknown>;
interface QueryCtx {
  model?: string;
  operation: string;
  args: Rec;
  query: QueryFn;
}

const WRITE_OPS = new Set([
  'create',
  'update',
  'upsert',
  'createMany',
  'updateMany',
  'createManyAndReturn',
]);
const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
]);

/**
 * Encrypt the write payload(s) inside a Prisma operation's `args`
 * (`data`, `create`, `update` for upsert), returning a new args object.
 */
export function encryptArgs(model: string, args: Rec): Rec {
  const next: Rec = { ...args };
  for (const key of ['data', 'create', 'update'] as const) {
    const payload = next[key];
    if (Array.isArray(payload)) {
      next[key] = payload.map((p) =>
        p && typeof p === 'object' ? encryptRecord(model, p as Rec) : p,
      );
    } else if (payload && typeof payload === 'object') {
      next[key] = encryptRecord(model, payload as Rec);
    }
  }
  return next;
}

/**
 * Build the `$extends` query-middleware object that applies field encryption to
 * every registered sensitive model. Pass `{ enabled }` to override the
 * pod-config gate (used by tests to exercise both branches).
 */
export function createFieldEncryptionExtension(
  options: { enabled?: boolean } = {},
): { query: { $allModels: { $allOperations(ctx: QueryCtx): Promise<unknown> } } } {
  const enabled = options.enabled ?? podConfig.security.encryptSensitiveData;

  return {
    query: {
      $allModels: {
        async $allOperations(ctx: QueryCtx) {
          const { model, operation, args, query } = ctx;
          if (!enabled || !model || fieldsFor(model).length === 0) {
            return query(args);
          }
          if (WRITE_OPS.has(operation)) {
            const encryptedArgs = encryptArgs(model, args);
            const result = await query(encryptedArgs);
            return decryptResult(model, result);
          }
          if (READ_OPS.has(operation)) {
            const result = await query(args);
            return decryptResult(model, result);
          }
          return query(args);
        },
      },
    },
  };
}

// -----------------------------------------------------------------------------
// Lazy singleton client
// -----------------------------------------------------------------------------

export type ExtendedPrismaClient = ReturnType<PrismaClient['$extends']>;

let client: ExtendedPrismaClient | undefined;

/**
 * Lazily construct and memoize the encryption-extended Prisma client.
 * Constructed on first call so importing this module has no side effects.
 */
export function getPrisma(): ExtendedPrismaClient {
  if (!client) {
    const base = new PrismaClient();
    client = base.$extends(createFieldEncryptionExtension()) as ExtendedPrismaClient;
  }
  return client;
}

/** Disconnect and clear the memoized client — for graceful shutdown / tests. */
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await (client as unknown as { $disconnect(): Promise<void> }).$disconnect();
    client = undefined;
  }
}
