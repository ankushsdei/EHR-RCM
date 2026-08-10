/**
 * Tests for Task T12 — rag-guidelines.service.ts.
 * Acceptance: performs a vector search and returns cited LLM responses.
 * Embeddings, $queryRaw, and Claude are mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  searchGuidelines,
  generateGuidance,
  embedQuery,
  toVectorLiteral,
  sql,
} from '../rag-guidelines.service';
import type { EmbeddingLike, GuidelineMatch, MessagesLike } from '../clinical.types';
import type { RagDeps, RagPrisma, SqlQuery } from '../rag-guidelines.service';

const MATCHES: GuidelineMatch[] = [
  { id: 'g1', title: 'Sepsis Bundle', source: 'SSC 2021', content: 'Give antibiotics within 1h.', similarity: 0.91 },
  { id: 'g2', title: 'Fluid Resuscitation', source: null, content: '30 mL/kg crystalloid.', similarity: 0.82 },
];

function makeDeps(opts: {
  rows?: GuidelineMatch[];
  embedding?: number[];
  answer?: string;
  withLlm?: boolean;
} = {}): RagDeps & {
  queryRaw: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn().mockResolvedValue({ data: [{ embedding: opts.embedding ?? [0.1, 0.2, 0.3] }] });
  const queryRaw = vi.fn().mockResolvedValue(opts.rows ?? MATCHES);
  const create = vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: opts.answer ?? 'Give antibiotics within 1h [Sepsis Bundle].' }] });

  const embedder = { embeddings: { create: embed } } as EmbeddingLike;
  const prisma = { $queryRaw: queryRaw } as unknown as RagPrisma;
  const llm = { messages: { create } } as MessagesLike;

  return {
    prisma,
    embedder,
    ...(opts.withLlm === false ? {} : { llm }),
    queryRaw,
    embed,
    create,
  };
}

describe('rag-guidelines (T12)', () => {
  it('embeds the query and runs a pgvector similarity search via $queryRaw', async () => {
    const deps = makeDeps();
    const results = await searchGuidelines('management of septic shock', deps);

    expect(deps.embed).toHaveBeenCalledTimes(1);
    expect(deps.embed.mock.calls[0]![0].input).toBe('management of septic shock');

    expect(deps.queryRaw).toHaveBeenCalledTimes(1);
    const stmt = deps.queryRaw.mock.calls[0]![0] as SqlQuery;
    // Uses the pgvector cosine-distance operator against the guidelines table.
    expect(stmt.text).toContain('<=>');
    expect(stmt.text.toLowerCase()).toContain('clinical_guidelines');
    // The embedded vector literal and limit are bound as parameters.
    expect(stmt.values).toContain(toVectorLiteral([0.1, 0.2, 0.3]));
    expect(stmt.values).toContain(5); // default match count

    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe('Sepsis Bundle');
  });

  it('honors a custom match count', async () => {
    const deps = makeDeps();
    deps.matchCount = 3;
    await searchGuidelines('q', deps);
    const stmt = deps.queryRaw.mock.calls[0]![0] as SqlQuery;
    expect(stmt.values).toContain(3);
  });

  it('throws when the embedder returns no vector', async () => {
    const deps = makeDeps({ embedding: [] });
    await expect(embedQuery('q', deps)).rejects.toThrow(/no vector/i);
  });

  it('generateGuidance returns an answer grounded in retrieved citations', async () => {
    const deps = makeDeps();
    const { answer, citations } = await generateGuidance('septic shock abx timing', deps);

    expect(deps.create).toHaveBeenCalledTimes(1);
    // The retrieved guidelines are passed to the model as context.
    const userMsg = deps.create.mock.calls[0]![0].messages[0].content as string;
    expect(userMsg).toContain('Sepsis Bundle');
    expect(userMsg).toContain('Fluid Resuscitation');

    expect(answer).toContain('[Sepsis Bundle]');
    expect(citations).toHaveLength(2);
    expect(citations[0]!.id).toBe('g1');
  });

  it('short-circuits with no citations when the search is empty', async () => {
    const deps = makeDeps({ rows: [] });
    const { answer, citations } = await generateGuidance('unknown topic', deps);
    expect(citations).toHaveLength(0);
    expect(answer).toMatch(/no matching/i);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('generateGuidance requires an LLM client', async () => {
    const deps = makeDeps({ withLlm: false });
    await expect(generateGuidance('q', deps)).rejects.toThrow(/LLM/i);
  });

  describe('sql builder', () => {
    it('produces a parameterized statement compatible with $queryRaw', () => {
      const q = sql`SELECT ${1} WHERE x = ${'a'}`;
      expect(q.values).toEqual([1, 'a']);
      expect(typeof q.text).toBe('string');
      expect(q.text).toContain('SELECT');
    });
  });
});
