/**
 * Tests for Task T15 — edi837-generator.service.ts.
 * Acceptance: generates a valid X12 837 transaction set string.
 */
import { describe, it, expect } from 'vitest';
import {
  generateEdi837P,
  splitSegments,
  type Edi837Input,
} from '../edi837-generator.service';

const input: Edi837Input = {
  submitter: { name: 'ACME BILLING', id: 'SUB123' },
  receiver: { name: 'GOOD HEALTH PLAN', id: 'RCV456' },
  billingProvider: {
    name: 'RIVER CLINIC',
    npi: '1234567893',
    taxId: '95-1234567',
    address: { street: '100 MAIN ST', city: 'AUSTIN', state: 'TX', zip: '78701' },
  },
  subscriber: { firstName: 'JOHN', lastName: 'DOE', memberId: 'MBR999' },
  payer: { name: 'GOOD HEALTH PLAN', id: 'GHP001' },
  claim: {
    id: 'CLAIM-1',
    totalChargeCents: 15000,
    placeOfService: '11',
    diagnoses: [{ code: 'E11.9' }, { code: 'I10' }],
    serviceLines: [
      { cpt: '99214', chargeCents: 12500, units: 1, dateOfService: '20240101' },
      { cpt: '20610', chargeCents: 2500, units: 1, modifiers: ['25'], dateOfService: '20240101' },
    ],
  },
  interchange: {
    senderId: 'SUB123',
    receiverId: 'RCV456',
    date: '240101',
    time: '1200',
    fullDate: '20240101',
    controlNumber: '000000001',
    usageIndicator: 'P',
  },
  groupControlNumber: '1',
  transactionControlNumber: '0001',
};

describe('edi837-generator (T15)', () => {
  const edi = generateEdi837P(input);
  const segments = splitSegments(edi);

  it('opens with ISA and closes with IEA', () => {
    expect(edi.startsWith('ISA*')).toBe(true);
    expect(edi.trimEnd().endsWith('IEA*1*000000001~')).toBe(true);
  });

  it('contains the 837P transaction header and claim segment', () => {
    expect(edi).toContain('ST*837*0001*005010X222A1~');
    expect(edi).toContain('CLM*CLAIM-1*150.00');
    expect(edi).toContain('GS*HC*SUB123*RCV456*20240101*1200*1*X*005010X222A1~');
  });

  it('emits diagnoses with ABK (principal) then ABF, decimals stripped', () => {
    expect(edi).toContain('HI*ABK:E119*ABF:I10~');
  });

  it('emits one LX/SV1/DTP triple per service line with modifiers', () => {
    const lxCount = segments.filter((s) => s.startsWith('LX*')).length;
    expect(lxCount).toBe(input.claim.serviceLines.length);
    expect(edi).toContain('SV1*HC:99214*125.00*UN*1');
    expect(edi).toContain('SV1*HC:20610:25*25.00*UN*1'); // modifier in composite
    expect(edi).toContain('DTP*472*D8*20240101~');
  });

  it('computes an accurate SE segment count', () => {
    const stIdx = segments.findIndex((s) => s.startsWith('ST*'));
    const seIdx = segments.findIndex((s) => s.startsWith('SE*'));
    expect(stIdx).toBeGreaterThanOrEqual(0);
    expect(seIdx).toBeGreaterThan(stIdx);

    const expectedCount = seIdx - stIdx + 1; // inclusive of ST and SE
    const seSeg = segments[seIdx]!.split('*');
    expect(Number(seSeg[1])).toBe(expectedCount);
    expect(seSeg[2]).toBe('0001'); // transaction control number matches ST
  });

  it('has matching GE and IEA control numbers', () => {
    expect(edi).toContain('GE*1*1~');
    expect(edi).toContain('IEA*1*000000001~');
  });
});
