/**
 * EDI 835 (ERA) parser & payment poster — Task T16.
 *
 * Parses an ANSI X12 835 Electronic Remittance Advice, extracting per-claim
 * payment/denial info and CARC (Claim Adjustment Reason Codes), then posts the
 * results to Claim records (status → PAID / DENIED, amounts, CARC codes).
 *
 * Parsing is pure; posting takes an injected Prisma client and clock.
 *
 * Acceptance (matrix T16): extracts CARC codes and updates Claim records
 * accurately (PAID / DENIED).
 */

export type RemitStatus = 'PAID' | 'DENIED';

export interface ClaimRemittance {
  /** CLP01 — the submitter's claim id (our Claim.id). */
  claimId: string;
  /** CLP02 — raw claim status code. */
  statusCode: string;
  status: RemitStatus;
  chargeCents: number; // CLP03
  paidCents: number; // CLP04
  patientResponsibilityCents: number; // CLP05
  /** CLP07 — payer claim control number. */
  payerControlNumber: string | null;
  /** CARC codes gathered from CAS segments for this claim. */
  carcCodes: string[];
}

export interface EraParseResult {
  remittances: ClaimRemittance[];
  /** BPR04-ish total payment if present (cents). */
  totalPaidCents: number | null;
}

const SEG_TERM_RE = /[~\r\n]+/;

function dollarsToCents(value: string | undefined): number {
  if (!value) return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Map a CLP02 claim-status code to a coarse PAID/DENIED outcome. */
export function mapClaimStatus(statusCode: string): RemitStatus {
  // 1=primary, 2=secondary, 3=tertiary, 19=primary-forwarded → paid.
  // 4=denied, 22=reversal, 23=not-our-claim → denied.
  return ['1', '2', '3', '19'].includes(statusCode) ? 'PAID' : 'DENIED';
}

/** Extract CARC codes from a CAS segment (reason codes at positions 2,5,8,…). */
function carcFromCas(elements: string[]): string[] {
  const codes: string[] = [];
  // elements[0] = 'CAS', [1] = group code (CO/PR/OA/PI), then triplets.
  for (let i = 2; i < elements.length; i += 3) {
    const code = elements[i];
    if (code) codes.push(code);
  }
  return codes;
}

/**
 * Parse a raw 835 string into structured remittances. Robust to `~`, CRLF, or
 * LF segment terminators.
 */
export function parseEra(raw: string): EraParseResult {
  const segments = raw
    .split(SEG_TERM_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split('*'));

  const remittances: ClaimRemittance[] = [];
  let current: ClaimRemittance | null = null;
  let totalPaidCents: number | null = null;

  for (const el of segments) {
    const tag = el[0];

    if (tag === 'BPR') {
      // BPR02 = total actual provider payment amount.
      totalPaidCents = dollarsToCents(el[2]);
      continue;
    }

    if (tag === 'CLP') {
      if (current) remittances.push(current);
      const statusCode = el[2] ?? '';
      current = {
        claimId: el[1] ?? '',
        statusCode,
        status: mapClaimStatus(statusCode),
        chargeCents: dollarsToCents(el[3]),
        paidCents: dollarsToCents(el[4]),
        patientResponsibilityCents: dollarsToCents(el[5]),
        payerControlNumber: el[7] ?? null,
        carcCodes: [],
      };
      continue;
    }

    if (tag === 'CAS' && current) {
      current.carcCodes.push(...carcFromCas(el));
      continue;
    }
  }

  if (current) remittances.push(current);
  return { remittances, totalPaidCents };
}

/** Prisma subset for posting remittances. */
export interface EraPrisma {
  claim: {
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
}

export interface PostEraDeps {
  prisma: EraPrisma;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
}

export interface PostEraResult {
  updated: number;
  results: Array<{ claimId: string; status: RemitStatus; carcCodes: string[] }>;
}

/**
 * Post a parsed (or raw) ERA to Claim records. Each remittance updates one
 * Claim: status, paid amount, CARC codes, payer control number, adjudication
 * timestamp.
 */
export async function postEra(
  era: string | EraParseResult,
  deps: PostEraDeps,
): Promise<PostEraResult> {
  const parsed = typeof era === 'string' ? parseEra(era) : era;
  const now = (deps.now ?? (() => new Date()))();

  const results: PostEraResult['results'] = [];
  for (const r of parsed.remittances) {
    if (!r.claimId) continue;
    await deps.prisma.claim.update({
      where: { id: r.claimId },
      data: {
        status: r.status,
        paidCents: r.paidCents,
        carcCodes: r.carcCodes,
        payerClaimId: r.payerControlNumber,
        adjudicatedAt: now,
      },
    });
    results.push({ claimId: r.claimId, status: r.status, carcCodes: r.carcCodes });
  }

  return { updated: results.length, results };
}
