/**
 * Claim scrubber — Task T14.
 *
 * Pre-submission validation that:
 *   1. checks CCI (Correct Coding Initiative) mutually-exclusive edits between
 *      procedure code pairs, honoring modifier bypass rules, and
 *   2. runs additional structural checks (code format, missing/unspecified
 *      diagnosis, duplicate lines),
 * then rolls the findings into a denial-risk score in [0.0, 1.0].
 *
 * Pure and deterministic; the CCI edit table is injectable.
 *
 * Acceptance (matrix T14): returns a scrubRiskScore (0.0 to 1.0) and lists
 * validation flags.
 */
import { isValidDiagnosisCode, isValidProcedureCode } from './rcm.types';

export interface ScrubLine {
  code: string;
  modifiers?: string[];
  units?: number;
}

export interface ScrubDiagnosis {
  code: string;
}

export interface ScrubInput {
  procedures: ScrubLine[];
  diagnoses?: ScrubDiagnosis[];
}

export type FlagSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export type FlagType =
  | 'CCI_CONFLICT'
  | 'MISSING_DIAGNOSIS'
  | 'UNSPECIFIED_DIAGNOSIS'
  | 'INVALID_PROCEDURE_CODE'
  | 'INVALID_DIAGNOSIS_CODE'
  | 'DUPLICATE_LINE'
  | 'NO_PROCEDURES';

export interface ScrubFlag {
  type: FlagType;
  severity: FlagSeverity;
  message: string;
  codes?: string[];
}

export interface ScrubResult {
  scrubRiskScore: number; // 0.0 (clean) .. 1.0 (high risk)
  flags: ScrubFlag[];
  passed: boolean; // false if any HIGH-severity flag present
}

/**
 * A CCI edit pair. `modifierIndicator`:
 *   0 = the two codes may never be billed together (no modifier bypass);
 *   1 = they may be billed together only with an appropriate bypass modifier.
 */
export interface CciEdit {
  column1: string;
  column2: string;
  modifierIndicator: 0 | 1;
}

/** Modifiers that bypass a CCI edit with modifierIndicator=1. */
export const CCI_BYPASS_MODIFIERS = new Set(['59', 'XE', 'XS', 'XP', 'XU', '25', '91']);

/** A small default CCI edit table (illustrative, not exhaustive). */
export const DEFAULT_CCI_EDITS: CciEdit[] = [
  { column1: '80053', column2: '80048', modifierIndicator: 0 }, // comprehensive vs basic metabolic panel
  { column1: '93000', column2: '93005', modifierIndicator: 0 }, // ECG complete vs tracing only
  { column1: '11055', column2: '11056', modifierIndicator: 1 },
  { column1: '99213', column2: '20610', modifierIndicator: 1 }, // E/M with procedure needs modifier 25
];

const SEVERITY_WEIGHT: Record<FlagSeverity, number> = { LOW: 0.1, MEDIUM: 0.2, HIGH: 0.4 };

function buildEditIndex(edits: CciEdit[]): Map<string, 0 | 1> {
  const index = new Map<string, 0 | 1>();
  for (const e of edits) {
    // Store both orderings for O(1) unordered lookup.
    index.set(`${e.column1}|${e.column2}`, e.modifierIndicator);
    index.set(`${e.column2}|${e.column1}`, e.modifierIndicator);
  }
  return index;
}

export interface ScrubOptions {
  cciEdits?: CciEdit[];
  /** ICD-10 codes treated as "unspecified" (heuristic: trailing .9 / 9). */
  unspecifiedSuffix?: RegExp;
}

/**
 * Scrub a claim's procedure/diagnosis set and return flags + a risk score.
 */
export function scrubClaim(input: ScrubInput, options: ScrubOptions = {}): ScrubResult {
  const flags: ScrubFlag[] = [];
  const editIndex = buildEditIndex(options.cciEdits ?? DEFAULT_CCI_EDITS);
  const unspecified = options.unspecifiedSuffix ?? /\.9\d?$|9$/;

  const procedures = input.procedures ?? [];
  const diagnoses = input.diagnoses ?? [];

  // --- No procedures at all -------------------------------------------------
  if (procedures.length === 0) {
    flags.push({ type: 'NO_PROCEDURES', severity: 'HIGH', message: 'Claim has no procedure lines.' });
  }

  // --- Code format ----------------------------------------------------------
  for (const p of procedures) {
    if (!isValidProcedureCode(p.code)) {
      flags.push({
        type: 'INVALID_PROCEDURE_CODE',
        severity: 'MEDIUM',
        message: `Procedure code "${p.code}" is not a valid CPT/HCPCS format.`,
        codes: [p.code],
      });
    }
  }
  for (const d of diagnoses) {
    if (!isValidDiagnosisCode(d.code)) {
      flags.push({
        type: 'INVALID_DIAGNOSIS_CODE',
        severity: 'MEDIUM',
        message: `Diagnosis code "${d.code}" is not a valid ICD-10 format.`,
        codes: [d.code],
      });
    }
  }

  // --- Diagnosis presence / specificity ------------------------------------
  if (diagnoses.length === 0) {
    flags.push({
      type: 'MISSING_DIAGNOSIS',
      severity: 'HIGH',
      message: 'Claim has no diagnosis codes; payers require at least one.',
    });
  } else {
    for (const d of diagnoses) {
      if (unspecified.test(d.code)) {
        flags.push({
          type: 'UNSPECIFIED_DIAGNOSIS',
          severity: 'LOW',
          message: `Diagnosis "${d.code}" appears unspecified; a more specific code may reduce denials.`,
          codes: [d.code],
        });
      }
    }
  }

  // --- Duplicate service lines ---------------------------------------------
  const seen = new Set<string>();
  for (const p of procedures) {
    const key = `${p.code}|${(p.modifiers ?? []).slice().sort().join(',')}`;
    if (seen.has(key)) {
      flags.push({
        type: 'DUPLICATE_LINE',
        severity: 'LOW',
        message: `Duplicate service line for ${p.code} with identical modifiers.`,
        codes: [p.code],
      });
    }
    seen.add(key);
  }

  // --- CCI mutually-exclusive edits ----------------------------------------
  for (let i = 0; i < procedures.length; i++) {
    for (let j = i + 1; j < procedures.length; j++) {
      const a = procedures[i]!;
      const b = procedures[j]!;
      const indicator = editIndex.get(`${a.code}|${b.code}`);
      if (indicator === undefined) continue;

      if (indicator === 0) {
        flags.push({
          type: 'CCI_CONFLICT',
          severity: 'HIGH',
          message: `${a.code} and ${b.code} are mutually exclusive (CCI); they cannot be billed together.`,
          codes: [a.code, b.code],
        });
      } else {
        const hasBypass = [...(a.modifiers ?? []), ...(b.modifiers ?? [])].some((m) =>
          CCI_BYPASS_MODIFIERS.has(m),
        );
        if (!hasBypass) {
          flags.push({
            type: 'CCI_CONFLICT',
            severity: 'MEDIUM',
            message: `${a.code} and ${b.code} require a bypass modifier (e.g. 59) to be billed together.`,
            codes: [a.code, b.code],
          });
        }
      }
    }
  }

  const rawScore = flags.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const scrubRiskScore = Math.min(1, Math.round(rawScore * 100) / 100);
  const passed = !flags.some((f) => f.severity === 'HIGH');

  return { scrubRiskScore, flags, passed };
}
