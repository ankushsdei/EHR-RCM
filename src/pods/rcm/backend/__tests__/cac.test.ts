/**
 * Tests for Task T13 — cac-coder.service.ts.
 * Acceptance: populates EncounterDiagnosis and EncounterProcedure with
 * aiSuggested=true. Anthropic calls are mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  codeSoapNote,
  codeEncounter,
  extractJson,
  type CacDeps,
  type CacPrisma,
} from '../cac-coder.service';
import type { LlmMessages } from '../rcm.types';

const SOAP = {
  subjective: 'Productive cough and fever x4 days.',
  objective: 'Temp 38.4, crackles RLL.',
  assessment: 'Community-acquired pneumonia.',
  plan: 'Amoxicillin; chest x-ray.',
};

const CODING = {
  diagnoses: [{ code: 'J18.9', description: 'Pneumonia, unspecified organism', rank: 1 }],
  procedures: [
    { code: '99214', description: 'Office visit, established', units: 1 },
    { code: '71046', description: 'Chest x-ray, 2 views' },
  ],
};

function makeDeps(llmText: string = JSON.stringify(CODING)) {
  const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: llmText }] });
  const dxCreate = vi.fn().mockResolvedValue({ id: 'dx' });
  const pxCreate = vi.fn().mockResolvedValue({ id: 'px' });
  const llm = { messages: { create } } as LlmMessages;
  const prisma = {
    encounterDiagnosis: { create: dxCreate },
    encounterProcedure: { create: pxCreate },
  } as CacPrisma;
  const deps: CacDeps = { llm, prisma };
  return { deps, create, dxCreate, pxCreate };
}

describe('cac-coder (T13)', () => {
  it('codes a SOAP note into diagnoses and procedures', async () => {
    const { deps, create } = makeDeps();
    const coding = await codeSoapNote(SOAP, deps);
    expect(create).toHaveBeenCalledTimes(1);
    expect(coding.diagnoses[0]!.code).toBe('J18.9');
    expect(coding.procedures.map((p) => p.code)).toEqual(['99214', '71046']);
  });

  it('persists rows with aiSuggested=true and correct code systems', async () => {
    const { deps, dxCreate, pxCreate } = makeDeps();
    const result = await codeEncounter('enc-1', SOAP, deps);

    expect(dxCreate).toHaveBeenCalledTimes(1);
    expect(pxCreate).toHaveBeenCalledTimes(2);

    const dxData = dxCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(dxData).toMatchObject({
      encounterId: 'enc-1',
      code: 'J18.9',
      codeSystem: 'ICD10',
      rank: 1,
      aiSuggested: true,
    });

    const pxData = pxCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(pxData).toMatchObject({
      encounterId: 'enc-1',
      code: '99214',
      codeSystem: 'CPT',
      units: 1,
      aiSuggested: true,
    });

    // Every persisted row is AI-suggested.
    for (const call of [...dxCreate.mock.calls, ...pxCreate.mock.calls]) {
      expect((call[0].data as Record<string, unknown>).aiSuggested).toBe(true);
    }
    expect(result.diagnoses[0]!.rank).toBe(1);
  });

  it('defaults diagnosis rank by order when the model omits it', async () => {
    const { deps, dxCreate } = makeDeps(
      JSON.stringify({
        diagnoses: [{ code: 'E11.9' }, { code: 'I10' }],
        procedures: [],
      }),
    );
    await codeEncounter('enc-2', SOAP, deps);
    expect(dxCreate.mock.calls[0]![0].data.rank).toBe(1);
    expect(dxCreate.mock.calls[1]![0].data.rank).toBe(2);
  });

  it('throws on a malformed (non-JSON) model response', async () => {
    const { deps } = makeDeps('sorry, no codes');
    await expect(codeSoapNote(SOAP, deps)).rejects.toThrow();
  });

  it('extractJson tolerates fences and prose', () => {
    expect(extractJson('```json\n{"diagnoses":[],"procedures":[]}\n```')).toEqual({
      diagnoses: [],
      procedures: [],
    });
  });
});
