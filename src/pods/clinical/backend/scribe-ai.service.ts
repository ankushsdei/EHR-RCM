/**
 * Ambient AI scribe — Task T11.
 *
 * Pipeline: binary audio → OpenAI Whisper transcription → Claude 3.5 Sonnet →
 * structured JSON SOAP note ({ subjective, objective, assessment, plan }).
 *
 * External clients are injected (`ScribeDeps`) so the parsing/extraction logic
 * is tested with mocked OpenAI/Anthropic calls and no network.
 *
 * Acceptance (matrix T11): accepts binary audio; returns a structured JSON SOAP
 * object.
 */
import { z } from 'zod';
import type {
  MessagesLike,
  ScribeAudio,
  SoapNote,
  ToFileFn,
  TranscriptionLike,
} from './clinical.types';

export const DEFAULT_WHISPER_MODEL = 'whisper-1';
export const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';

export const soapSchema = z.object({
  subjective: z.string(),
  objective: z.string(),
  assessment: z.string(),
  plan: z.string(),
});

const SYSTEM_PROMPT = [
  'You are a clinical documentation assistant. Given a raw visit transcript,',
  'produce a concise, accurate SOAP note. Do NOT invent findings not supported',
  'by the transcript. Respond with ONLY a JSON object with exactly these keys:',
  '"subjective", "objective", "assessment", "plan". No prose, no code fences.',
].join(' ');

export interface ScribeDeps {
  /** OpenAI-like client for Whisper transcription. */
  transcriber: TranscriptionLike;
  /** Anthropic-like client for SOAP extraction. */
  llm: MessagesLike;
  whisperModel?: string;
  model?: string;
  maxTokens?: number;
  /** Bytes→uploadable helper. Defaults to openai's `toFile`. */
  toFile?: ToFileFn;
}

/**
 * Extract a JSON object from an LLM response that may be wrapped in prose or
 * fenced code blocks. Returns the parsed value or throws.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fence?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost {...} span.
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return JSON.parse(candidate.slice(first, last + 1));
    }
    throw new Error('No JSON object found in LLM response');
  }
}

/** Transcribe binary audio to text via Whisper. */
export async function transcribeAudio(audio: ScribeAudio, deps: ScribeDeps): Promise<string> {
  const toFile = deps.toFile ?? (await import('openai')).toFile;
  const file = await toFile(
    audio.content,
    audio.filename ?? 'audio.webm',
    audio.contentType ? { type: audio.contentType } : undefined,
  );
  const result = await deps.transcriber.audio.transcriptions.create({
    file,
    model: deps.whisperModel ?? DEFAULT_WHISPER_MODEL,
  });
  return result.text;
}

/** Turn a transcript into a validated SOAP note via Claude. */
export async function extractSoapFromTranscript(
  transcript: string,
  deps: ScribeDeps,
): Promise<SoapNote> {
  const response = await deps.llm.messages.create({
    model: deps.model ?? DEFAULT_CLAUDE_MODEL,
    max_tokens: deps.maxTokens ?? 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Visit transcript:\n"""\n${transcript}\n"""\n\nReturn the SOAP note JSON now.`,
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Empty response from language model');
  }

  return soapSchema.parse(extractJson(text));
}

export interface ScribeResult {
  transcript: string;
  soap: SoapNote;
}

/** Full pipeline: audio → transcript → SOAP note. */
export async function generateSoapNote(
  audio: ScribeAudio,
  deps: ScribeDeps,
): Promise<ScribeResult> {
  if (!audio?.content || audio.content.length === 0) {
    throw new Error('Audio content is required');
  }
  const transcript = await transcribeAudio(audio, deps);
  const soap = await extractSoapFromTranscript(transcript, deps);
  return { transcript, soap };
}
