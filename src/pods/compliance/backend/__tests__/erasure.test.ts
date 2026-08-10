/**
 * Tests for Task T17 — anonymizer.service.ts.
 * Acceptance: anonymizes PII fields while retaining required medical records.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  anonymizeCustomer,
  buildAnonymizedData,
  pseudonym,
  ANONYMIZED_FIELDS,
  type AnonymizerCustomer,
  type AnonymizerPrisma,
} from '../anonymizer.service';

function makeCustomer(overrides: Partial<AnonymizerCustomer> = {}): AnonymizerCustomer {
  return {
    id: 'cust-1',
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Roe',
    anonymizedAt: null,
    ...overrides,
  };
}

function makePrisma(customer: AnonymizerCustomer | null) {
  const update = vi.fn().mockResolvedValue({ id: 'cust-1' });
  const create = vi.fn().mockResolvedValue({});
  const findUnique = vi.fn().mockResolvedValue(customer);
  const prisma = {
    customer: { findUnique, update },
    auditLog: { create },
  } as AnonymizerPrisma;
  return { prisma, update, create, findUnique };
}

const fixedNow = new Date('2026-08-10T00:00:00.000Z');

describe('anonymizer (T17)', () => {
  it('erases PII, sets anonymizedAt, and writes an ERASURE audit log', async () => {
    const { prisma, update, create } = makePrisma(makeCustomer());

    const result = await anonymizeCustomer('cust-1', {
      prisma,
      salt: 'test-salt',
      now: () => fixedNow,
      actorUserId: 'admin-1',
    });

    expect(result.alreadyAnonymized).toBe(false);
    expect(result.anonymizedAt).toBe(fixedNow);
    expect(result.fieldsAnonymized).toEqual(ANONYMIZED_FIELDS);

    // Customer PII scrubbed.
    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.firstName).toBe('REDACTED');
    expect(data.lastName).toBe('REDACTED');
    expect(String(data.email)).toMatch(/@anonymized\.invalid$/);
    expect(data.ssn).toBeNull();
    expect(data.phone).toBeNull();
    expect(data.address).toBeNull();
    expect(data.dateOfBirth).toBeNull();
    expect(data.anonymizedAt).toBe(fixedNow);

    // Audit entry written for compliance evidence.
    expect(create).toHaveBeenCalledTimes(1);
    const audit = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(audit).toMatchObject({ action: 'ERASURE', entityType: 'Customer', entityId: 'cust-1', userId: 'admin-1' });
    expect((audit.metadata as { regulation: string[] }).regulation).toEqual(['GDPR', 'DPDPA']);
  });

  it('retains clinical/financial records (only Customer + AuditLog are touched)', async () => {
    const { prisma, update, create } = makePrisma(makeCustomer());
    await anonymizeCustomer('cust-1', { prisma, now: () => fixedNow });
    // The pipeline exposes no encounter/claim mutators and calls only these two.
    expect(update).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(Object.keys(prisma)).toEqual(['customer', 'auditLog']);
  });

  it('is idempotent for an already-anonymized customer', async () => {
    const already = makeCustomer({ anonymizedAt: new Date('2025-01-01T00:00:00.000Z') });
    const { prisma, update, create } = makePrisma(already);

    const result = await anonymizeCustomer('cust-1', { prisma, now: () => fixedNow });

    expect(result.alreadyAnonymized).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('throws when the customer does not exist', async () => {
    const { prisma } = makePrisma(null);
    await expect(anonymizeCustomer('missing', { prisma })).rejects.toThrow(/not found/i);
  });

  it('pseudonym is deterministic per salt and irreversible-looking', () => {
    expect(pseudonym('cust-1', 'salt-a')).toBe(pseudonym('cust-1', 'salt-a'));
    expect(pseudonym('cust-1', 'salt-a')).not.toBe(pseudonym('cust-1', 'salt-b'));
    expect(pseudonym('cust-1', 'salt-a')).not.toContain('cust-1');
  });

  it('buildAnonymizedData produces a stable, unique anonymized email', () => {
    const c = makeCustomer();
    const a = buildAnonymizedData(c, 'salt', fixedNow);
    const b = buildAnonymizedData(c, 'salt', fixedNow);
    expect(a.email).toBe(b.email);
    expect(String(a.email)).toBe(`anon_${pseudonym(c.id, 'salt')}@anonymized.invalid`);
  });
});
