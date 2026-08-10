/**
 * Pod / domain configuration — Task T03.
 *
 * A single deployment of this platform can operate as a healthcare EHR, a salon
 * booking system, or a generic scheduler. This module is the one source of
 * truth for that switch and the compliance/security posture it implies.
 *
 * `domainMode` is read from `process.env.DOMAIN_MODE` (default HEALTHCARE).
 * Compliance flags and security settings are derived per domain, with optional
 * per-flag overrides via env for staged rollouts.
 *
 * Acceptance (matrix T03): type-safe config exporting `domainMode` and
 * `compliance` flags.
 */

export type DomainMode = 'HEALTHCARE' | 'SALON' | 'GENERIC';

export interface ComplianceFlags {
  /** US Health Insurance Portability and Accountability Act. */
  hipaa: boolean;
  /** EU General Data Protection Regulation. */
  gdpr: boolean;
  /** India Digital Personal Data Protection Act. */
  dpdpa: boolean;
}

export interface SecuritySettings {
  /** When true, sensitive PII fields are AES-256-GCM encrypted at rest (T04). */
  encryptSensitiveData: boolean;
}

export interface PodConfig {
  readonly domainMode: DomainMode;
  readonly compliance: Readonly<ComplianceFlags>;
  readonly security: Readonly<SecuritySettings>;
}

const DOMAIN_MODES = ['HEALTHCARE', 'SALON', 'GENERIC'] as const;

/** Baseline posture for each domain. */
const DOMAIN_DEFAULTS: Record<
  DomainMode,
  { compliance: ComplianceFlags; security: SecuritySettings }
> = {
  HEALTHCARE: {
    compliance: { hipaa: true, gdpr: true, dpdpa: true },
    security: { encryptSensitiveData: true },
  },
  SALON: {
    compliance: { hipaa: false, gdpr: true, dpdpa: true },
    security: { encryptSensitiveData: true },
  },
  GENERIC: {
    compliance: { hipaa: false, gdpr: false, dpdpa: false },
    security: { encryptSensitiveData: false },
  },
};

function isDomainMode(value: string | undefined): value is DomainMode {
  return typeof value === 'string' && (DOMAIN_MODES as readonly string[]).includes(value);
}

/** Parse a truthy/falsy env override; returns undefined when unset. */
function boolOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

/**
 * Build a `PodConfig` from an environment record. Pure and deterministic so it
 * can be unit-tested with synthetic env objects.
 */
export function buildPodConfig(source: NodeJS.ProcessEnv = process.env): PodConfig {
  const requested = source.DOMAIN_MODE?.trim().toUpperCase();
  const domainMode: DomainMode = isDomainMode(requested) ? requested : 'HEALTHCARE';

  const defaults = DOMAIN_DEFAULTS[domainMode];

  const compliance: ComplianceFlags = {
    hipaa: boolOverride(source.COMPLIANCE_HIPAA) ?? defaults.compliance.hipaa,
    gdpr: boolOverride(source.COMPLIANCE_GDPR) ?? defaults.compliance.gdpr,
    dpdpa: boolOverride(source.COMPLIANCE_DPDPA) ?? defaults.compliance.dpdpa,
  };

  const security: SecuritySettings = {
    encryptSensitiveData:
      boolOverride(source.ENCRYPT_SENSITIVE_DATA) ?? defaults.security.encryptSensitiveData,
  };

  return Object.freeze({
    domainMode,
    compliance: Object.freeze(compliance),
    security: Object.freeze(security),
  });
}

/** Application-wide pod configuration singleton. */
export const podConfig: PodConfig = buildPodConfig();
