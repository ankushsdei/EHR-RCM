/**
 * Tests for Task T14 — claim-scrubber.service.ts.
 * Acceptance: returns a scrubRiskScore (0.0–1.0) and lists validation flags.
 */
import { describe, it, expect } from 'vitest';
import { scrubClaim, type ScrubInput } from '../claim-scrubber.service';

const clean: ScrubInput = {
  procedures: [{ code: '99213', units: 1 }],
  diagnoses: [{ code: 'E11.65' }],
};

describe('claim-scrubber (T14)', () => {
  it('passes a clean claim with score 0 and no flags', () => {
    const res = scrubClaim(clean);
    expect(res.flags).toHaveLength(0);
    expect(res.scrubRiskScore).toBe(0);
    expect(res.passed).toBe(true);
  });

  it('flags a mutually-exclusive CCI pair (indicator 0) as HIGH', () => {
    const res = scrubClaim({
      procedures: [{ code: '80053' }, { code: '80048' }],
      diagnoses: [{ code: 'E11.65' }],
    });
    const cci = res.flags.find((f) => f.type === 'CCI_CONFLICT');
    expect(cci?.severity).toBe('HIGH');
    expect(cci?.codes).toEqual(expect.arrayContaining(['80053', '80048']));
    expect(res.passed).toBe(false);
    expect(res.scrubRiskScore).toBeGreaterThanOrEqual(0.4);
  });

  it('flags an indicator-1 pair without a bypass modifier as MEDIUM', () => {
    const res = scrubClaim({
      procedures: [{ code: '99213' }, { code: '20610' }],
      diagnoses: [{ code: 'M17.11' }],
    });
    const cci = res.flags.find((f) => f.type === 'CCI_CONFLICT');
    expect(cci?.severity).toBe('MEDIUM');
    expect(res.scrubRiskScore).toBeCloseTo(0.2, 5);
  });

  it('clears an indicator-1 pair when a bypass modifier is present', () => {
    const res = scrubClaim({
      procedures: [{ code: '99213', modifiers: ['25'] }, { code: '20610' }],
      diagnoses: [{ code: 'M17.11' }],
    });
    expect(res.flags.find((f) => f.type === 'CCI_CONFLICT')).toBeUndefined();
    expect(res.scrubRiskScore).toBe(0);
    expect(res.passed).toBe(true);
  });

  it('flags a missing diagnosis as HIGH', () => {
    const res = scrubClaim({ procedures: [{ code: '99213' }] });
    expect(res.flags.some((f) => f.type === 'MISSING_DIAGNOSIS' && f.severity === 'HIGH')).toBe(
      true,
    );
    expect(res.passed).toBe(false);
  });

  it('flags a claim with no procedures as HIGH', () => {
    const res = scrubClaim({ procedures: [], diagnoses: [{ code: 'E11.65' }] });
    expect(res.flags.some((f) => f.type === 'NO_PROCEDURES')).toBe(true);
    expect(res.passed).toBe(false);
  });

  it('flags an invalid procedure code format', () => {
    const res = scrubClaim({ procedures: [{ code: 'ABC' }], diagnoses: [{ code: 'E11.65' }] });
    expect(res.flags.some((f) => f.type === 'INVALID_PROCEDURE_CODE')).toBe(true);
  });

  it('flags an unspecified diagnosis as LOW', () => {
    const res = scrubClaim({
      procedures: [{ code: '99213' }],
      diagnoses: [{ code: 'J06.9' }],
    });
    const flag = res.flags.find((f) => f.type === 'UNSPECIFIED_DIAGNOSIS');
    expect(flag?.severity).toBe('LOW');
    expect(res.scrubRiskScore).toBeCloseTo(0.1, 5);
  });

  it('flags duplicate service lines as LOW', () => {
    const res = scrubClaim({
      procedures: [{ code: '99213' }, { code: '99213' }],
      diagnoses: [{ code: 'E11.65' }],
    });
    expect(res.flags.some((f) => f.type === 'DUPLICATE_LINE')).toBe(true);
  });

  it('clamps the score to a maximum of 1.0', () => {
    const res = scrubClaim({
      procedures: [{ code: '80053' }, { code: '80048' }, { code: '93000' }, { code: '93005' }],
      diagnoses: [],
    });
    expect(res.scrubRiskScore).toBe(1);
    expect(res.scrubRiskScore).toBeLessThanOrEqual(1);
  });
});
