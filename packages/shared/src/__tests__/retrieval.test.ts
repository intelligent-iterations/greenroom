import { describe, expect, it } from 'vitest';
import {
  LexicalRetriever,
  MIN_LEXICAL_SCORE,
  buildCorpus,
  chunkDocument,
  type CorpusEntry,
} from '../retrieval.js';
import { SourceDocument } from '../domain.js';
import { scenario as en } from './fixtures.js';

function doc(text: string, id = 'cv-1'): SourceDocument {
  return SourceDocument.parse({ id, kind: 'cv', title: 'CV', text, updatedAt: 0 });
}

async function retrieve(corpus: CorpusEntry[], question: string, limit = 2) {
  const retriever = new LexicalRetriever();
  await retriever.index(corpus);
  return retriever.retrieve({ question, limit });
}

describe('chunkDocument', () => {
  it('is total on input with nothing in it', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   \n\n  \t ')).toEqual([]);
  });

  it('keeps a short paragraph as one chunk', () => {
    expect(chunkDocument('Led the billing rewrite.')).toEqual(['Led the billing rewrite.']);
  });

  it('splits paragraphs apart', () => {
    expect(chunkDocument('First thing.\n\nSecond thing.')).toEqual(['First thing.', 'Second thing.']);
  });

  it('does not split a decimal or an abbreviation', () => {
    const long = `${'Migrated the queue. '.repeat(12)}Latency fell to 3.5 seconds.`;
    expect(chunkDocument(long).some((c) => c.endsWith('3.'))).toBe(false);
  });

  it('breaks up a paragraph too long to be one idea', () => {
    const chunks = chunkDocument('Sentence about Kafka. '.repeat(40));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(240);
  });
});

describe('buildCorpus', () => {
  it('carries the scenario notes and tags their source', () => {
    const corpus = buildCorpus(en, []);
    expect(corpus).toHaveLength(en.contextNotes.length);
    for (const entry of corpus) expect(entry.sourceId).toBe(`scenario:${en.id}`);
  });

  it('adds document chunks under their own source id', () => {
    const corpus = buildCorpus(en, [doc('Ran the Kafka migration.\n\nOwned on-call.')]);
    const fromDoc = corpus.filter((c) => c.sourceId === 'doc:cv-1');
    expect(fromDoc).toHaveLength(2);
  });
});

describe('LexicalRetriever', () => {
  const corpus = buildCorpus(en, [
    doc('Led a Kafka migration that cut checkout latency in half.\n\nMentored two junior engineers.'),
  ]);

  it('finds the passage the question is about', async () => {
    const [top] = await retrieve(corpus, 'Tell me about the Kafka migration you ran.');
    expect(top?.text).toContain('Kafka');
  });

  // The property the CI gate depends on. Without a total order the same run
  // returns different passages and a scored regression is unbisectable.
  it('is deterministic, ties included', async () => {
    const question = 'What did you own on that team?';
    const a = await retrieve(corpus, question, 3);
    const b = await retrieve(corpus, question, 3);
    expect(a).toEqual(b);
  });

  it('honours the limit', async () => {
    expect(await retrieve(corpus, 'Kafka latency migration mentoring', 1)).toHaveLength(1);
  });

  it('returns nothing for an empty corpus rather than throwing', async () => {
    expect(await retrieve([], 'anything at all')).toEqual([]);
  });

  it('returns nothing when the question is all stop words', async () => {
    expect(await retrieve(corpus, 'and the with for')).toEqual([]);
  });

  // A lexical retriever always returns *something*. Without the floor, a
  // pasted menu grounds the interview and it asks about the soup.
  it('suppresses a document with nothing to do with the question', async () => {
    const menu = buildCorpus(en, [
      doc('Starters: soup of the day, garlic bread.\n\nMains: roast chicken, ravioli.', 'menu'),
    ]);
    const hits = await retrieve(menu, 'Tell me about a system you owned in production.');
    expect(hits.filter((h) => h.sourceId === 'doc:menu')).toEqual([]);
  });

  it('scores every returned passage at or above the floor', async () => {
    const hits = await retrieve(corpus, 'Kafka migration latency', 5);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.score).toBeGreaterThanOrEqual(MIN_LEXICAL_SCORE);
  });

  it('returns passages verbatim, so a score can quote them', async () => {
    const [top] = await retrieve(corpus, 'Kafka migration');
    expect(corpus.some((c) => c.text === top?.text)).toBe(true);
  });

  it('retrieves from a French document', async () => {
    const fr = buildCorpus(en, [
      doc("J'ai dirigé la migration vers Kafka et réduit la latence de moitié.", 'cv-fr'),
    ]);
    const [top] = await retrieve(fr, 'Parlez-moi de la migration que vous avez dirigée.');
    expect(top?.text).toContain('migration');
  });

  it('uses the last answer as well as the question', async () => {
    const retriever = new LexicalRetriever();
    await retriever.index(corpus);
    const hits = await retriever.retrieve({
      question: 'What happened next?',
      lastAnswer: 'We mentored the junior engineers through it.',
      limit: 1,
    });
    expect(hits[0]?.text).toContain('Mentored');
  });
});
