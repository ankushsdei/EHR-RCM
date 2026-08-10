/**
 * Shared RCM-pod types — Tasks T13–T16.
 */

/** Minimal Anthropic Messages surface (kept local so the pod is self-contained). */
export interface LlmMessages {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

/** A coded diagnosis (ICD-10). */
export interface CodedDiagnosis {
  code: string;
  description?: string;
  rank?: number;
}

/** A coded procedure (CPT/HCPCS). */
export interface CodedProcedure {
  code: string;
  description?: string;
  modifiers?: string[];
  units?: number;
}

/** Format validators (loose but useful for scrubbing). */
export const ICD10_RE = /^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
export const CPT_RE = /^[0-9]{4}[0-9A-Z]$/; // 5 chars: CPT (all digits) or HCPCS (letter + 4 digits reversed) — see note
export const HCPCS_RE = /^[A-Z][0-9]{4}$/;

export function isValidProcedureCode(code: string): boolean {
  return CPT_RE.test(code) || HCPCS_RE.test(code);
}

export function isValidDiagnosisCode(code: string): boolean {
  return ICD10_RE.test(code);
}
