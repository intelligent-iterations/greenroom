import type { InterviewScenario, SourceDocument } from './domain.js';

/**
 * Retrieval, upstream of prompt compilation.
 *
 * `compileInterviewerPrompt` is pure and has to stay that way — the harness,
 * the CI gate and the whole version-bump discipline rest on identical input
 * producing identical output. Retrieval is not pure: it reads a corpus, and the
 * embedding retriever this interface exists for would load a model and touch a
 * GPU. So retrieval happens here, the orchestrator awaits it, and the compiler
 * receives the result as plain data that it only renders.
 *
 * The default retriever is lexical and dependency-free on purpose. CI has to be
 * reproducible on a machine with no network and no accelerator, and a
 * float-valued embedding model is not bit-reproducible across runtimes. An
 * embedding retriever is a better retriever; it is not a better *default*.
 * See docs/adr/0007-lexical-retrieval-first.md.
 */

export interface CorpusEntry {
  /** `scenario:<id>` for a context note, `doc:<id>` for a learner document. */
  sourceId: string;
  text: string;
}

export interface RetrievedPassage {
  sourceId: string;
  /**
   * Index of the chunk within its source. Stable across runs because chunking
   * is a pure function of the source text.
   */
  chunkIndex: number;
  /**
   * Verbatim from the corpus. A retriever never rewrites, summarises or
   * translates — everything it returns has to be quotable as evidence.
   */
  text: string;
  /**
   * Relevance, higher is better. Comparable only within one retriever: a
   * lexical score and a cosine similarity are not the same quantity, and no
   * caller may threshold across both.
   */
  score: number;
}

export interface RetrievalQuery {
  /** The question the interviewer is working toward this turn. */
  question: string;
  /** The learner's most recent answer, when there is one. */
  lastAnswer?: string;
  /** Hard cap on passages returned. */
  limit: number;
}

export interface Retriever {
  readonly id: string;
  /**
   * Prepare the corpus. Async even for the lexical retriever, which needs
   * nothing async, so that an embedding retriever loading weights here is a
   * drop-in rather than a signature change.
   */
  index(corpus: CorpusEntry[]): Promise<void>;
  /**
   * Must be deterministic: the same query against the same corpus returns the
   * same passages in the same order, ties included. The CI gate depends on it.
   */
  retrieve(query: RetrievalQuery): Promise<RetrievedPassage[]>;
}

/**
 * Below this, a lexical match is coincidence rather than relevance.
 *
 * A lexical retriever always returns something. Without a floor, a pasted
 * restaurant menu yields a "grounding" passage and the interviewer asks the
 * candidate about the soup. A named constant because this is a value that wants
 * tuning against real pasted documents — like the barge-in guard window, it is a
 * reasoned starting point rather than a measurement.
 */
export const MIN_LEXICAL_SCORE = 0.12;

/** Longest passage worth carrying. Beyond this a chunk stops being one idea. */
const MAX_CHUNK_CHARS = 240;

/**
 * Stop words for lexical scoring, English and French.
 *
 * Deliberately not shared with the set in checks.ts. That one is English-only
 * and tuned as an artefact of check precision; coupling grounding to it would
 * let a tweak intended for one check silently change what the model is told.
 */
const STOP_WORDS = new Set([
  // English
  'the', 'and', 'for', 'with', 'was', 'were', 'are', 'that', 'this', 'you', 'your', 'they',
  'their', 'have', 'has', 'had', 'not', 'but', 'from', 'about', 'into', 'over', 'been', 'its',
  'our', 'his', 'her', 'she', 'him', 'them', 'what', 'how', 'why', 'when', 'where', 'which',
  'who', 'can', 'will', 'would', 'could', 'should', 'there', 'here', 'more', 'than', 'then',
  'some', 'any', 'all', 'each', 'other', 'such', 'very', 'just', 'also', 'been', 'being',
  // French
  'les', 'des', 'une', 'que', 'qui', 'pour', 'dans', 'sur', 'avec', 'est', 'sont', 'ont',
  'vous', 'nous', 'ils', 'elle', 'elles', 'son', 'sa', 'ses', 'leur', 'leurs', 'aux', 'par',
  'pas', 'plus', 'mais', 'comme', 'tout', 'tous', 'cette', 'ces', 'lui', 'été', 'être',
]);

/** Lowercased content tokens. Keeps accented characters, for the French path. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Split a document into passages. Pure and total.
 *
 * Paragraphs first, because a pasted CV is already structured that way, then
 * sentences, then merged back up to MAX_CHUNK_CHARS so a chunk is one idea
 * rather than one line.
 */
export function chunkDocument(text: string): string[] {
  const chunks: string[] = [];

  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim().replace(/\s+/g, ' ');
    if (trimmed.length === 0) continue;
    if (trimmed.length <= MAX_CHUNK_CHARS) {
      chunks.push(trimmed);
      continue;
    }
    // Whitespace is required after the terminator so "3.5" and "Ph.D." do not
    // split — the same rule splitSpeakableChunks uses, for the same reason.
    let current = '';
    for (const sentence of trimmed.split(/(?<=[.!?…])\s+/)) {
      if (current.length > 0 && current.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current.length > 0 ? `${current} ${sentence}` : sentence;
      }
    }
    if (current.length > 0) chunks.push(current.slice(0, MAX_CHUNK_CHARS).trim());
  }

  return chunks;
}

/**
 * Assemble the corpus. Pure, so the browser and the harness build the same one
 * from the same inputs — which is the only reason an offline eval score says
 * anything about what ships.
 */
export function buildCorpus(
  scenario: InterviewScenario,
  documents: readonly SourceDocument[] = [],
): CorpusEntry[] {
  const entries: CorpusEntry[] = scenario.contextNotes.map((text) => ({
    sourceId: `scenario:${scenario.id}`,
    text,
  }));
  for (const document of documents) {
    for (const text of chunkDocument(document.text)) {
      entries.push({ sourceId: `doc:${document.id}`, text });
    }
  }
  return entries;
}

/**
 * BM25-lite over the corpus.
 *
 * Term frequency saturates and rare terms count for more, which is the whole of
 * why BM25 beats raw overlap: without saturation a chunk that says "system"
 * six times outranks the one that answers the question.
 */
export class LexicalRetriever implements Retriever {
  readonly id = 'lexical-bm25';
  #chunks: Array<CorpusEntry & { chunkIndex: number; tokens: string[] }> = [];
  #documentFrequency = new Map<string, number>();
  #averageLength = 0;

  async index(corpus: CorpusEntry[]): Promise<void> {
    const perSource = new Map<string, number>();
    this.#chunks = corpus.map((entry) => {
      const chunkIndex = perSource.get(entry.sourceId) ?? 0;
      perSource.set(entry.sourceId, chunkIndex + 1);
      return { ...entry, chunkIndex, tokens: tokenize(entry.text) };
    });

    this.#documentFrequency = new Map();
    for (const chunk of this.#chunks) {
      for (const term of new Set(chunk.tokens)) {
        this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
      }
    }
    const total = this.#chunks.reduce((sum, c) => sum + c.tokens.length, 0);
    this.#averageLength = this.#chunks.length > 0 ? total / this.#chunks.length : 0;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedPassage[]> {
    if (this.#chunks.length === 0 || query.limit <= 0) return [];

    // The last answer is what makes retrieval conversational rather than
    // static, but the question is what the turn is actually about, so the
    // question is not allowed to be drowned out by a long answer.
    const terms = [...tokenize(query.question), ...tokenize(query.lastAnswer ?? '')];
    if (terms.length === 0) return [];

    const k1 = 1.2;
    const b = 0.75;
    const n = this.#chunks.length;

    const scored = this.#chunks.map((chunk) => {
      let score = 0;
      for (const term of new Set(terms)) {
        const frequency = chunk.tokens.filter((t) => t === term).length;
        if (frequency === 0) continue;
        const df = this.#documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm =
          this.#averageLength > 0 ? 1 - b + (b * chunk.tokens.length) / this.#averageLength : 1;
        score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * norm));
      }
      // Normalised by query length so the floor means the same thing whether
      // the turn asked three words or thirty.
      return { chunk, score: score / Math.max(1, new Set(terms).size) };
    });

    return scored
      .filter((s) => s.score >= MIN_LEXICAL_SCORE)
      // Ties break on source then chunk index, so the ordering is total and the
      // choice never flaps between runs — the same discipline selectModel uses.
      .sort(
        (a, b2) =>
          b2.score - a.score ||
          a.chunk.sourceId.localeCompare(b2.chunk.sourceId) ||
          a.chunk.chunkIndex - b2.chunk.chunkIndex,
      )
      .slice(0, query.limit)
      .map(({ chunk, score }) => ({
        sourceId: chunk.sourceId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        score,
      }));
  }
}
