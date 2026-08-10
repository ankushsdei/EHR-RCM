/**
 * Tests for Task T03 — src/config/pod.config.ts.
 * Acceptance: "Type-safe config exporting domainMode and compliance flags."
 */
import { describe, it, expect } from 'vitest';
import { buildPodConfig, podConfig } from '@/config/pod.config';
import type { PodConfig } from '@/config/pod.config';

describe('pod.config (T03)', () => {
  it('defaults to HEALTHCARE with full compliance + encryption', () => {
    const cfg = buildPodConfig({});
    expect(cfg.domainMode).toBe('HEALTHCARE');
    expect(cfg.compliance).toEqual({ hipaa: true, gdpr: true, dpdpa: true });
    expect(cfg.security.encryptSensitiveData).toBe(true);
  });

  it('configures SALON mode (no HIPAA, still GDPR/DPDPA)', () => {
    const cfg = buildPodConfig({ DOMAIN_MODE: 'SALON' });
    expect(cfg.domainMode).toBe('SALON');
    expect(cfg.compliance.hipaa).toBe(false);
    expect(cfg.compliance.gdpr).toBe(true);
    expect(cfg.compliance.dpdpa).toBe(true);
  });

  it('configures GENERIC mode with compliance + encryption off', () => {
    const cfg = buildPodConfig({ DOMAIN_MODE: 'GENERIC' });
    expect(cfg.domainMode).toBe('GENERIC');
    expect(cfg.compliance).toEqual({ hipaa: false, gdpr: false, dpdpa: false });
    expect(cfg.security.encryptSensitiveData).toBe(false);
  });

  it('is case-insensitive and falls back to HEALTHCARE on unknown modes', () => {
    expect(buildPodConfig({ DOMAIN_MODE: 'salon' }).domainMode).toBe('SALON');
    expect(buildPodConfig({ DOMAIN_MODE: 'nonsense' }).domainMode).toBe('HEALTHCARE');
    expect(buildPodConfig({ DOMAIN_MODE: '' }).domainMode).toBe('HEALTHCARE');
  });

  it('applies per-flag env overrides', () => {
    const cfg = buildPodConfig({
      DOMAIN_MODE: 'GENERIC',
      COMPLIANCE_HIPAA: 'true',
      ENCRYPT_SENSITIVE_DATA: '1',
    });
    expect(cfg.compliance.hipaa).toBe(true);
    expect(cfg.security.encryptSensitiveData).toBe(true);
  });

  it('can disable encryption in HEALTHCARE via override', () => {
    const cfg = buildPodConfig({ DOMAIN_MODE: 'HEALTHCARE', ENCRYPT_SENSITIVE_DATA: 'off' });
    expect(cfg.security.encryptSensitiveData).toBe(false);
  });

  it('exports a frozen, immutable singleton', () => {
    expect(Object.isFrozen(podConfig)).toBe(true);
    expect(Object.isFrozen(podConfig.compliance)).toBe(true);
    expect(Object.isFrozen(podConfig.security)).toBe(true);
  });

  it('satisfies the PodConfig type shape', () => {
    const cfg: PodConfig = buildPodConfig({});
    // exhaustive key presence check
    expect(Object.keys(cfg).sort()).toEqual(['compliance', 'domainMode', 'security']);
  });
});
