/**
 * Tests for Task T11 — scribe-ai.service.ts.
 * Acceptance: accepts binary audio; returns a structured JSON SOAP object.
 * External OpenAI (Whisper) and Anthropic (Claude) calls are mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateSoapNote,
  extractSoapFromTranscript,
  extractJson,
  soapSchema,
  DEFAULT_WHISPER_MODEL,
  type ScribeDeps,
} from '../scribe-ai.service';
import type { MessagesLike, TranscriptionLike } from '../clinical.types';

const SAMPLE_SOAP = {
  subjective: 'Patient reports a sore throat for 3 days.',
  objective: 'Temp 38.1C, pharyngeal erythema.',
  assessment: 'Acute pharyngitis, likely viral.',
  plan: 'Supportive care; return if symptoms worsen.',
};

function makeDeps(opts: {
  transcript?: string;
  llmText?: string;
} = {}): ScribeDeps & {
  transcribe: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const transcribe = vi.fn().mockResolvedValue({ text: opts.transcript ?? 'sore throat 3 days' });
  const create = vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: opts.llmText ?? JSON.stringify(SAMPLE_SOAP) }] });

  const transcriber = { audio: { transcriptions: { create: transcribe } } } as TranscriptionLike;
  const llm = { messages: { create } } as MessagesLike;

  return {
    transcriber,
    llm,
    // Bypass openai.toFile — just hand the bytes straight through.
    toFile: async (content: Buffer | Uint8Array) => content,
    transcribe,
    create,
  };
}

describe('scribe-ai (T11)', () => {
  it('turns binary audio into a structured SOAP note', async () => {
    const deps = makeDeps();
    const audio = { content: Buffer.from('fake-audio-bytes'), filename: 'visit.webm' };

    const result = await generateSoapNote(audio, deps);

    // Whisper was called with the right model.
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.transcribe.mock.calls[0]![0].model).toBe(DEFAULT_WHISPER_MODEL);
    // Claude was called once.
    expect(deps.create).toHaveBeenCalledTimes(1);

    expect(result.transcript).toBe('sore throat 3 days');
    expect(result.soap).toEqual(SAMPLE_SOAP);
    // Validated shape.
    expect(soapSchema.safeParse(result.soap).success).toBe(true);
  });

  it('rejects empty audio', async () => {
    const deps = makeDeps();
    await expect(generateSoapNote({ content: Buffer.alloc(0) }, deps)).rejects.toThrow(/required/i);
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('parses SOAP JSON wrapped in a markdown code fence', async () => {
    const fenced = '```json\n' + JSON.stringify(SAMPLE_SOAP) + '\n```';
    const deps = makeDeps({ llmText: fenced });
    const soap = await extractSoapFromTranscript('transcript', deps);
    expect(soap).toEqual(SAMPLE_SOAP);
  });

  it('parses SOAP JSON embedded in surrounding prose', async () => {
    const prose = `Here is the note:\n${JSON.stringify(SAMPLE_SOAP)}\nHope this helps.`;
    const deps = makeDeps({ llmText: prose });
    const soap = await extractSoapFromTranscript('transcript', deps);
    expect(soap.assessment).toBe(SAMPLE_SOAP.assessment);
  });

  it('throws when the model omits a required SOAP field', async () => {
    const deps = makeDeps({ llmText: JSON.stringify({ subjective: 'x', objective: 'y', plan: 'z' }) });
    await expect(extractSoapFromTranscript('t', deps)).rejects.toThrow();
  });

  it('throws on a non-JSON model response', async () => {
    const deps = makeDeps({ llmText: 'I could not produce a note.' });
    await expect(extractSoapFromTranscript('t', deps)).rejects.toThrow();
  });

  describe('extractJson', () => {
    it('handles plain, fenced, and embedded JSON', () => {
      expect(extractJson('{"a":1}')).toEqual({ a: 1 });
      expect(extractJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
      expect(extractJson('noise {"a":3} more')).toEqual({ a: 3 });
    });
    it('throws when no JSON is present', () => {
      expect(() => extractJson('nothing here')).toThrow();
    });
  });
});
