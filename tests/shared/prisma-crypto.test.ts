/**
 * Tests for Task T04 — src/shared/db/prisma.ts (field encryption layer).
 * Acceptance: "Encrypts SSN/Phone on create; Decrypts on read when
 * encryptSensitiveData=true."
 *
 * These tests exercise the crypto primitives, the record/args transforms, and
 * the $extends middleware behavior against a mocked `query` function — no live
 * database or generated Prisma client required.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Must be set before importing the module's crypto helpers use it (read lazily,
// but set here defensively for the whole suite).
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32); // 64 hex chars => 32 bytes
});

const mod = await import('@/shared/db/prisma');
const {
  encrypt,
  decrypt,
  isEncrypted,
  encryptRecord,
  decryptRecord,
  encryptArgs,
  decryptResult,
  createFieldEncryptionExtension,
  SENSITIVE_FIELDS,
} = mod;

describe('AES-256-GCM primitives (T04)', () => {
  it('round-trips plaintext', () => {
    const secret = '123-45-6789';
    const token = encrypt(secret);
    expect(token).not.toBe(secret);
    expect(isEncrypted(token)).toBe(true);
    expect(token.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(token)).toBe(secret);
  });

  it('is non-deterministic (random IV per call)', () => {
    const a = encrypt('same-value');
    const b = encrypt('same-value');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same-value');
    expect(decrypt(b)).toBe('same-value');
  });

  it('is idempotent — will not double-encrypt', () => {
    const once = encrypt('hello');
    expect(encrypt(once)).toBe(once);
  });

  it('passes through non-encrypted values on decrypt', () => {
    expect(decrypt('plain text')).toBe('plain text');
    expect(isEncrypted('plain text')).toBe(false);
  });

  it('rejects a tampered ciphertext token', () => {
    const token = encrypt('sensitive');
    const parts = token.split(':');
    // Corrupt the ciphertext payload (last segment) but keep the structure.
    parts[4] = Buffer.from('tampered-data').toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });

  it('rejects a malformed token', () => {
    expect(() => decrypt('enc:v1:onlytwo')).toThrow(/Malformed/);
  });
});

describe('record transforms (T04)', () => {
  it('encrypts only the registered sensitive fields on Customer', () => {
    const input = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      ssn: '111-22-3333',
      phone: '+1-555-0100',
      address: '1 Analytical Way',
      email: 'ada@example.com',
    };
    const enc = encryptRecord('customer', input);
    // Encrypted fields
    expect(isEncrypted(enc.ssn)).toBe(true);
    expect(isEncrypted(enc.phone)).toBe(true);
    expect(isEncrypted(enc.address)).toBe(true);
    // Non-sensitive fields untouched
    expect(enc.firstName).toBe('Ada');
    expect(enc.email).toBe('ada@example.com');
    // Original object is not mutated
    expect(isEncrypted(input.ssn)).toBe(false);
    // Round-trips back
    const dec = decryptRecord('customer', enc);
    expect(dec.ssn).toBe('111-22-3333');
    expect(dec.phone).toBe('+1-555-0100');
    expect(dec.address).toBe('1 Analytical Way');
  });

  it('leaves models with no sensitive fields alone', () => {
    const input = { code: 'A00', description: 'Cholera' };
    expect(encryptRecord('encounterDiagnosis', input)).toEqual(input);
  });

  it('registers ssn/phone/address for customer', () => {
    expect([...SENSITIVE_FIELDS.customer!]).toEqual(['ssn', 'phone', 'address']);
  });

  it('encryptArgs handles data object, createMany array, and upsert shape', () => {
    const single = encryptArgs('customer', { data: { ssn: '1', phone: '2' } });
    expect(isEncrypted((single.data as Record<string, unknown>).ssn)).toBe(true);

    const many = encryptArgs('customer', { data: [{ ssn: 'a' }, { ssn: 'b' }] });
    const arr = many.data as Array<Record<string, unknown>>;
    expect(isEncrypted(arr[0]!.ssn)).toBe(true);
    expect(isEncrypted(arr[1]!.ssn)).toBe(true);

    const upsert = encryptArgs('customer', {
      create: { ssn: 'c' },
      update: { phone: 'd' },
    });
    expect(isEncrypted((upsert.create as Record<string, unknown>).ssn)).toBe(true);
    expect(isEncrypted((upsert.update as Record<string, unknown>).phone)).toBe(true);
  });

  it('decryptResult handles single rows and arrays', () => {
    const row = encryptRecord('customer', { ssn: 'x' });
    expect(decryptResult('customer', row).ssn).toBe('x');
    const rows = [encryptRecord('customer', { ssn: 'y' })];
    expect(decryptResult('customer', rows)[0]!.ssn).toBe('y');
  });
});

describe('$extends encryption middleware (T04)', () => {
  const runOp = async (
    ext: ReturnType<typeof createFieldEncryptionExtension>,
    ctx: { model?: string; operation: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> },
  ) => ext.query.$allModels.$allOperations(ctx as never);

  it('encrypts on create and decrypts the returned row (enabled=true)', async () => {
    const ext = createFieldEncryptionExtension({ enabled: true });
    let seenArgs: Record<string, unknown> | undefined;

    const result = (await runOp(ext, {
      model: 'Customer',
      operation: 'create',
      args: { data: { firstName: 'Grace', ssn: '999-88-7777' } },
      query: async (a) => {
        // Simulate the DB: what Prisma would persist is the (encrypted) args.data,
        // and what it returns is that same stored row.
        seenArgs = a as Record<string, unknown>;
        const data = (a as { data: Record<string, unknown> }).data;
        return { id: 'cust_1', ...data };
      },
    })) as Record<string, unknown>;

    // The value handed to the DB was encrypted...
    const persisted = (seenArgs!.data as Record<string, unknown>).ssn;
    expect(isEncrypted(persisted)).toBe(true);
    // ...but the value returned to the caller was decrypted back to plaintext.
    expect(result.ssn).toBe('999-88-7777');
    expect(result.firstName).toBe('Grace');
  });

  it('decrypts rows on findMany (enabled=true)', async () => {
    const ext = createFieldEncryptionExtension({ enabled: true });
    const stored = encryptRecord('customer', { id: 'c1', ssn: '111-11-1111' });

    const rows = (await runOp(ext, {
      model: 'Customer',
      operation: 'findMany',
      args: {},
      query: async () => [stored],
    })) as Array<Record<string, unknown>>;

    expect(rows[0]!.ssn).toBe('111-11-1111');
  });

  it('passes values through untouched when disabled (enabled=false)', async () => {
    const ext = createFieldEncryptionExtension({ enabled: false });
    let seenArgs: Record<string, unknown> | undefined;

    const result = (await runOp(ext, {
      model: 'Customer',
      operation: 'create',
      args: { data: { ssn: '123-45-6789' } },
      query: async (a) => {
        seenArgs = a as Record<string, unknown>;
        return (a as { data: Record<string, unknown> }).data;
      },
    })) as Record<string, unknown>;

    // Not encrypted going in...
    expect((seenArgs!.data as Record<string, unknown>).ssn).toBe('123-45-6789');
    // ...and returned as-is.
    expect(result.ssn).toBe('123-45-6789');
  });

  it('ignores models without sensitive fields', async () => {
    const ext = createFieldEncryptionExtension({ enabled: true });
    const result = (await runOp(ext, {
      model: 'EncounterDiagnosis',
      operation: 'create',
      args: { data: { code: 'A00' } },
      query: async (a) => (a as { data: Record<string, unknown> }).data,
    })) as Record<string, unknown>;
    expect(result.code).toBe('A00');
  });
});
