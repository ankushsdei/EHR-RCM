/**
 * Tests for Task T16 — edi835-parser.service.ts.
 * Acceptance: extracts CARC codes and updates Claim records (PAID / DENIED).
 */
import { describe, it, expect, vi } from 'vitest';
import { parseEra, postEra, mapClaimStatus, type EraPrisma } from '../edi835-parser.service';

// A minimal but structurally realistic 835 with two claims: one paid, one denied.
const ERA = [
  'ISA*00*          *00*          *ZZ*PAYER          *ZZ*PROVIDER       *240101*1200*^*00501*000000001*0*P*:',
  'GS*HP*PAYER*PROVIDER*20240101*1200*1*X*005010X221A1',
  'ST*835*0001',
  'BPR*I*400.00*C*ACH*CCP*01*999999999*DA*123*1512345678**01*888888888*DA*456*20240102',
  'TRN*1*12345*1512345678',
  'N1*PR*GOOD HEALTH PLAN',
  'N1*PE*RIVER CLINIC*XX*1234567893',
  'LX*1',
  'CLP*CLAIM-1*1*500.00*400.00*100.00*MC*PAYERCTRL1*11',
  'CAS*PR*1*100.00',
  'NM1*QC*1*DOE*JOHN',
  'SVC*HC:99214*500.00*400.00**1',
  'CAS*CO*45*0.00',
  'CLP*CLAIM-2*4*300.00*0.00*0.00*MC*PAYERCTRL2*11',
  'CAS*CO*197*300.00',
  'SE*13*0001',
  'GE*1*1',
  'IEA*1*000000001',
].join('~') + '~';

describe('edi835-parser (T16)', () => {
  it('maps CLP status codes to PAID / DENIED', () => {
    expect(mapClaimStatus('1')).toBe('PAID');
    expect(mapClaimStatus('19')).toBe('PAID');
    expect(mapClaimStatus('4')).toBe('DENIED');
    expect(mapClaimStatus('22')).toBe('DENIED');
  });

  it('parses both claims with amounts, status, and CARC codes', () => {
    const { remittances, totalPaidCents } = parseEra(ERA);
    expect(remittances).toHaveLength(2);
    expect(totalPaidCents).toBe(40000);

    const [paid, denied] = remittances;
    expect(paid).toMatchObject({
      claimId: 'CLAIM-1',
      status: 'PAID',
      chargeCents: 50000,
      paidCents: 40000,
      patientResponsibilityCents: 10000,
      payerControlNumber: 'PAYERCTRL1',
    });
    // CARC codes gathered from both CAS segments belonging to CLAIM-1.
    expect(paid!.carcCodes).toEqual(['1', '45']);

    expect(denied).toMatchObject({
      claimId: 'CLAIM-2',
      status: 'DENIED',
      paidCents: 0,
      payerControlNumber: 'PAYERCTRL2',
    });
    expect(denied!.carcCodes).toEqual(['197']);
  });

  it('posts remittances to Claim records accurately', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'ok' });
    const prisma = { claim: { update } } as unknown as EraPrisma;
    const fixedNow = new Date('2024-01-02T00:00:00.000Z');

    const result = await postEra(ERA, { prisma, now: () => fixedNow });

    expect(result.updated).toBe(2);
    expect(update).toHaveBeenCalledTimes(2);

    const first = update.mock.calls[0]![0] as { where: { id: string }; data: Record<string, unknown> };
    expect(first.where).toEqual({ id: 'CLAIM-1' });
    expect(first.data).toMatchObject({
      status: 'PAID',
      paidCents: 40000,
      carcCodes: ['1', '45'],
      payerClaimId: 'PAYERCTRL1',
      adjudicatedAt: fixedNow,
    });

    const second = update.mock.calls[1]![0] as { where: { id: string }; data: Record<string, unknown> };
    expect(second.where).toEqual({ id: 'CLAIM-2' });
    expect(second.data).toMatchObject({ status: 'DENIED', paidCents: 0, carcCodes: ['197'] });
  });

  it('is robust to newline-terminated segments', () => {
    const withNewlines = ERA.replace(/~/g, '\n');
    const { remittances } = parseEra(withNewlines);
    expect(remittances).toHaveLength(2);
    expect(remittances[0]!.claimId).toBe('CLAIM-1');
  });
});
