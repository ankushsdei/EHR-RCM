/**
 * Clinical guideline RAG — Task T12.
 *
 * Embeds a clinical query, runs a pgvector cosine-similarity search over the
 * `clinical_guidelines` table via Prisma `$queryRaw` (using the `<=>` distance
 * operator), and optionally synthesizes a cited, evidence-based answer with
 * Claude grounded strictly in the retrieved guidelines.
 *
 * The SQL is built with Prisma's `sql` tagged template when available (a
 * generated client); in environments without a generated client (CI sandbox)
 * it falls back to a structurally-compatible builder so `$queryRaw` is still
 * exercised. Clients and prisma are injected for testing.
 *
 * Acceptance (matrix T12): performs a vector search and returns cited LLM
 * responses.
 */
import pkg from '@prisma/client';
import type {
  EmbeddingLike,
  GuidelineMatch,
  MessagesLike,
} from './clinical.types';

const { Prisma } = pkg;

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';
export const DEFAULT_MATCH_COUNT = 5;

/** Structural subset of a Sql query object (mirrors Prisma.Sql). */
export interface SqlQuery {
  sql: string;
  text: string;
  values: unknown[];
}

/** Prisma-like client exposing the raw query method used here. */
export interface RagPrisma {
  $queryRaw<T = unknown>(query: SqlQuery): Promise<T>;
}

/**
 * Tagged-template SQL builder. Prefers the real `Prisma.sql` (correct against a
 * live database); falls back to a compatible builder when the client is not
 * generated so tests and CI still run.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  const realSql = (Prisma as unknown as { sql?: (...a: unknown[]) => SqlQuery }).sql;
  if (typeof realSql === 'function') {
    return realSql(strings, ...values);
  }
  // Fallback: build a `$1,$2,...` parameterized statement.
  let text = '';
  strings.forEach((chunk, i) => {
    text += chunk;
    if (i < values.length) text += `$${i + 1}`;
  });
  return { sql: text, text, values };
}

export interface RagDeps {
  prisma: RagPrisma;
  embedder: EmbeddingLike;
  llm?: MessagesLike;
  embeddingModel?: string;
  model?: string;
  matchCount?: number;
}

/** Embed a query string into a dense vector via the embeddings API. */
export async function embedQuery(query: string, deps: RagDeps): Promise<number[]> {
  const res = await deps.embedder.embeddings.create({
    model: deps.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    input: query,
  });
  const embedding = res.data[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new Error('Embedding provider returned no vector');
  }
  return embedding;
}

/** Format a numeric vector as a pgvector literal, e.g. "[0.1,0.2]". */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Retrieve the most similar guidelines for a query using cosine distance.
 * Returns matches ordered by similarity (highest first).
 */
export async function searchGuidelines(
  query: string,
  deps: RagDeps,
): Promise<GuidelineMatch[]> {
  const limit = deps.matchCount ?? DEFAULT_MATCH_COUNT;
  const vector = await embedQuery(query, deps);
  const literal = toVectorLiteral(vector);

  // Cosine similarity = 1 - cosine distance (`<=>`).
  const statement = sql`
    SELECT id, title, source, content,
           1 - (embedding <=> ${literal}::vector) AS similarity
    FROM clinical_guidelines
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;

  const rows = await deps.prisma.$queryRaw<GuidelineMatch[]>(statement);
  return rows.map((r) => ({
    ...r,
    similarity: typeof r.similarity === 'number' ? r.similarity : Number(r.similarity),
  }));
}

export interface Guidance {
  answer: string;
  citations: GuidelineMatch[];
}

const RAG_SYSTEM_PROMPT = [
  'You are a clinical decision-support assistant. Answer the clinician’s',
  'question using ONLY the provided guideline excerpts. Cite the guideline',
  'titles you rely on inline as [Title]. If the excerpts do not support an',
  'answer, say so explicitly. Do not fabricate citations or recommendations.',
].join(' ');

/**
 * Retrieve guidelines and synthesize a cited answer. Requires `deps.llm`.
 * The returned `citations` are the exact guidelines passed to the model.
 */
export async function generateGuidance(query: string, deps: RagDeps): Promise<Guidance> {
  if (!deps.llm) {
    throw new Error('generateGuidance requires an LLM client (deps.llm)');
  }
  const citations = await searchGuidelines(query, deps);

  if (citations.length === 0) {
    return { answer: 'No matching clinical guidelines were found for this query.', citations };
  }

  const context = citations
    .map((c, i) => `[${i + 1}] ${c.title}${c.source ? ` (${c.source})` : ''}\n${c.content}`)
    .join('\n\n');

  const response = await deps.llm.messages.create({
    model: deps.model ?? DEFAULT_CLAUDE_MODEL,
    max_tokens: 1024,
    system: RAG_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Guideline excerpts:\n${context}\n\nQuestion: ${query}`,
      },
    ],
  });

  const answer = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();

  return { answer, citations };
}
