/**
 * Shared clinical-pod types — Tasks T11 / T12.
 *
 * The external AI providers (OpenAI, Anthropic) are represented by minimal
 * structural interfaces rather than the concrete SDK classes, so the services
 * can be unit-tested with lightweight fakes and no network access.
 */

/** Structured SOAP note produced by the ambient scribe (T11). */
export interface SoapNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

/** Raw audio to transcribe. */
export interface ScribeAudio {
  content: Buffer | Uint8Array;
  filename?: string;
  contentType?: string;
}

/** Minimal OpenAI Whisper transcription surface. */
export interface TranscriptionLike {
  audio: {
    transcriptions: {
      create(args: { file: unknown; model: string }): Promise<{ text: string }>;
    };
  };
}

/** Minimal Anthropic Messages surface. */
export interface MessagesLike {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

/** Minimal OpenAI Embeddings surface. */
export interface EmbeddingLike {
  embeddings: {
    create(args: {
      model: string;
      input: string;
    }): Promise<{ data: Array<{ embedding: number[] }> }>;
  };
}

/** `toFile`-style helper turning bytes into an SDK-uploadable file. */
export type ToFileFn = (
  content: Buffer | Uint8Array,
  filename?: string,
  options?: { type?: string },
) => Promise<unknown>;

/** A guideline row returned from the pgvector similarity search (T12). */
export interface GuidelineMatch {
  id: string;
  title: string;
  source: string | null;
  content: string;
  similarity: number;
}
