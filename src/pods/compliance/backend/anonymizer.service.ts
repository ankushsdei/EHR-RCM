/**
 * Data-subject erasure pipeline — Task T17.
 *
 * Implements the GDPR "Right to be Forgotten" / DPDPA erasure requirement by
 * irreversibly anonymizing a Customer's personal identifiers while:
 *   - preserving referential integrity (the row and its id are kept, so linked
 *     clinical records remain valid), and
 *   - retaining clinical/financial records that laws require be kept
 *     (Encounters, Claims are never deleted here), and
 *   - writing an immutable AuditLog entry documenting the erasure.
 *
 * Identifiers are replaced with a salted SHA-256 pseudonym (one-way), and
 * sensitive fields (ssn/phone/address/DOB) are nulled outright.
 *
 * Acceptance (matrix T17): anonymizes PII fields while retaining required
 * medical records.
 */
import { createHash } from 'node:crypto';

/** Minimal Customer shape the pipeline reads. */
export interface AnonymizerCustomer {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string;
  anonymizedAt: Date | null;
}

/** Prisma subset used by the erasure pipeline. */
export interface AnonymizerPrisma {
  customer: {
    findUnique(args: { where: { id: string } }): Promise<AnonymizerCustomer | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface AnonymizeDeps {
  prisma: AnonymizerPrisma;
  /** Salt/pepper for pseudonymization. Defaults to env, then a constant. */
  salt?: string;
  /** Clock (injectable for deterministic tests). */
  now?: () => Date;
  /** The user/admin who executed the erasure (for the audit trail). */
  actorUserId?: string;
}

/** The PII fields this pipeline erases on a Customer. */
export const ANONYMIZED_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'ssn',
  'phone',
  'address',
  'dateOfBirth',
] as const;

const REDACTED = 'REDACTED';

function resolveSalt(explicit?: string): string {
  return explicit ?? process.env.ANONYMIZER_SALT ?? process.env.ENCRYPTION_KEY ?? 'ehr-rcm-anon';
}

/** One-way, salted pseudonym for a value (stable for the same input+salt). */
export function pseudonym(value: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 16);
}

/** Build the anonymized field set for a customer (pure). */
export function buildAnonymizedData(
  customer: AnonymizerCustomer,
  salt: string,
  at: Date,
): Record<string, unknown> {
  const token = pseudonym(customer.id, salt);
  return {
    firstName: REDACTED,
    lastName: REDACTED,
    // Keep a unique, non-identifying, non-routable address.
    email: `anon_${token}@anonymized.invalid`,
    ssn: null,
    phone: null,
    address: null,
    dateOfBirth: null,
    anonymizedAt: at,
  };
}

export interface ErasureResult {
  customerId: string;
  anonymizedAt: Date;
  alreadyAnonymized: boolean;
  fieldsAnonymized: readonly string[];
}

/**
 * Erase (anonymize) a customer's PII. Idempotent: a customer already anonymized
 * is left unchanged and reported as such. Clinical/financial records are never
 * deleted — only the personal identifiers on the Customer are scrubbed.
 */
export async function anonymizeCustomer(
  customerId: string,
  deps: AnonymizeDeps,
): Promise<ErasureResult> {
  const salt = resolveSalt(deps.salt);
  const now = (deps.now ?? (() => new Date()))();

  const customer = await deps.prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    throw new Error(`Customer ${customerId} not found`);
  }

  if (customer.anonymizedAt) {
    return {
      customerId,
      anonymizedAt: customer.anonymizedAt,
      alreadyAnonymized: true,
      fieldsAnonymized: [],
    };
  }

  const data = buildAnonymizedData(customer, salt, now);
  await deps.prisma.customer.update({ where: { id: customerId }, data });

  // Immutable record of the erasure for compliance evidence.
  await deps.prisma.auditLog.create({
    data: {
      userId: deps.actorUserId ?? null,
      action: 'ERASURE',
      entityType: 'Customer',
      entityId: customerId,
      metadata: {
        regulation: ['GDPR', 'DPDPA'],
        fields: [...ANONYMIZED_FIELDS],
        retention: 'Clinical and financial records retained per statutory requirements.',
      },
    },
  });

  return {
    customerId,
    anonymizedAt: now,
    alreadyAnonymized: false,
    fieldsAnonymized: ANONYMIZED_FIELDS,
  };
}
