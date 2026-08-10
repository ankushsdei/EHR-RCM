/**
 * Computer-Assisted Coding (CAC) — Task T13.
 *
 * Uses Claude 3.5 Sonnet to read a signed SOAP note and propose ICD-10
 * diagnoses and CPT/HCPCS procedures, then persists them as
 * EncounterDiagnosis / EncounterProcedure rows flagged `aiSuggested: true`
 * (a human coder confirms before billing).
 *
 * LLM and Prisma are injected for testing.
 *
 * Acceptance (matrix T13): populates EncounterDiagnosis and EncounterProcedure
 * with aiSuggested=true.
 */
import { z } from 'zod';
import type { LlmMessages } from './rcm.types';

export const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';

/** SOAP shape accepted as coding input. */
export interface SoapInput {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

const codingSchema = z.object({
  diagnoses: z
    .array(
      z.object({
        code: z.string().min(2),
        description: z.string().optional(),
        rank: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  procedures: z
    .array(
      z.object({
        code: z.string().min(4),
        description: z.string().optional(),
        modifiers: z.array(z.string()).optional(),
        units: z.number().int().positive().optional(),
      }),
    )
    .default([]),
});

export type Coding = z.infer<typeof codingSchema>;

/** Prisma subset used to persist coding results. */
export interface CacPrisma {
  encounterDiagnosis: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  encounterProcedure: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

export interface CacDeps {
  llm: LlmMessages;
  prisma?: CacPrisma;
  model?: string;
  maxTokens?: number;
}

const SYSTEM_PROMPT = [
  'You are a certified medical coder. From the SOAP note, assign ICD-10-CM',
  'diagnosis codes and CPT/HCPCS procedure codes. Rank diagnoses (1 = primary).',
  'Only assign codes supported by the documentation. Respond with ONLY JSON:',
  '{"diagnoses":[{"code","description","rank"}],"procedures":[{"code","description","modifiers","units"}]}.',
  'No prose, no code fences.',
].join(' ');

/** Robustly extract a JSON object from an LLM response. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fence?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) return JSON.parse(candidate.slice(first, last + 1));
    throw new Error('No JSON object found in LLM response');
  }
}

/** Ask the model to code a SOAP note (no persistence). */
export async function codeSoapNote(soap: SoapInput, deps: CacDeps): Promise<Coding> {
  const response = await deps.llm.messages.create({
    model: deps.model ?? DEFAULT_CLAUDE_MODEL,
    max_tokens: deps.maxTokens ?? 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          `SOAP note:\n` +
          `S: ${soap.subjective}\nO: ${soap.objective}\n` +
          `A: ${soap.assessment}\nP: ${soap.plan}\n\nReturn the coding JSON now.`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('Empty response from language model');

  return codingSchema.parse(extractJson(text));
}

export interface PersistedCoding {
  diagnoses: Coding['diagnoses'];
  procedures: Coding['procedures'];
}

/**
 * Persist a coding result against an encounter, marking every row
 * `aiSuggested: true`. Requires `deps.prisma`.
 */
export async function persistCoding(
  encounterId: string,
  coding: Coding,
  deps: CacDeps,
): Promise<PersistedCoding> {
  if (!deps.prisma) throw new Error('persistCoding requires deps.prisma');

  const diagnoses = coding.diagnoses.map((d, i) => ({ ...d, rank: d.rank ?? i + 1 }));

  await Promise.all([
    ...diagnoses.map((d) =>
      deps.prisma!.encounterDiagnosis.create({
        data: {
          encounterId,
          code: d.code,
          codeSystem: 'ICD10',
          description: d.description ?? null,
          rank: d.rank,
          aiSuggested: true,
        },
      }),
    ),
    ...coding.procedures.map((p) =>
      deps.prisma!.encounterProcedure.create({
        data: {
          encounterId,
          code: p.code,
          codeSystem: 'CPT',
          description: p.description ?? null,
          modifiers: p.modifiers ?? [],
          units: p.units ?? 1,
          aiSuggested: true,
        },
      }),
    ),
  ]);

  return { diagnoses, procedures: coding.procedures };
}

/** Full pipeline: code the SOAP note and persist the results. */
export async function codeEncounter(
  encounterId: string,
  soap: SoapInput,
  deps: CacDeps,
): Promise<PersistedCoding> {
  const coding = await codeSoapNote(soap, deps);
  return persistCoding(encounterId, coding, deps);
}
