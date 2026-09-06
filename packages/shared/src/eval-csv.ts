import type { CheckResult } from './checks.js';

/**
 * User-supplied evaluation cases, as CSV.
 *
 * The harness in `evals/` is for people who clone the repo. This is for someone
 * who opens the app, wants to know whether a model holds a role, and has a
 * spreadsheet. CSV because it is the format their existing material is already
 * in, and because an LLM can be asked to produce it — see AGENT_INSTRUCTIONS.
 *
 * Deliberately forgiving: unknown columns are ignored, header order does not
 * matter, and a malformed row reports its line number rather than failing the
 * file. Someone testing a model should not have to debug a parser.
 */
export interface EvalCsvRow {
  /** Stable identifier, so results can be compared across runs. */
  id: string;
  /** The system prompt the model runs under for this case. */
  systemPrompt: string;
  /** Conversation before the turn under test. `speaker: text` per line. */
  transcript: string;
  /** What this case is testing, for the report. */
  probes: string;
}

export interface EvalCsvParseResult {
  rows: EvalCsvRow[];
  errors: string[];
}

/**
 * Minimal RFC-4180 reader: quoted fields, embedded commas, doubled quotes.
 *
 * Hand-written rather than a dependency because the grammar is small and a
 * spreadsheet export is the only input it will ever see.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Only close the row on a real line break, and swallow CRLF as one.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const REQUIRED_COLUMNS = ['id', 'systemprompt'];

export function parseEvalCsv(text: string): EvalCsvParseResult {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (table.length === 0) return { rows: [], errors: ['The file is empty.'] };

  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        `Missing required column(s): ${missing.join(', ')}. Found: ${header.join(', ') || '(none)'}.`,
      ],
    };
  }

  const index = (name: string) => header.indexOf(name);
  const rows: EvalCsvRow[] = [];
  const seen = new Set<string>();

  for (const [offset, raw] of table.slice(1).entries()) {
    const line = offset + 2; // 1-based, and the header is line 1
    const id = (raw[index('id')] ?? '').trim();
    const systemPrompt = (raw[index('systemprompt')] ?? '').trim();

    if (!id) {
      errors.push(`Line ${line}: missing id.`);
      continue;
    }
    if (!systemPrompt) {
      errors.push(`Line ${line}: missing systemPrompt.`);
      continue;
    }
    // Duplicate ids would make two rows indistinguishable in the report.
    if (seen.has(id)) {
      errors.push(`Line ${line}: duplicate id "${id}".`);
      continue;
    }
    seen.add(id);

    rows.push({
      id,
      systemPrompt,
      transcript: (raw[index('transcript')] ?? '').trim(),
      probes: (raw[index('probes')] ?? '').trim(),
    });
  }

  return { rows, errors };
}

/** Turns the transcript column into chat turns. */
export function parseTranscript(text: string): { role: 'user' | 'assistant'; content: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [speaker, ...rest] = line.split(':');
      const content = rest.join(':').trim();
      // Anything not clearly the assistant is treated as the person speaking,
      // because that is the safer default for a half-formatted transcript.
      const isAssistant = /^(assistant|interviewer|model|ai|bot)$/i.test((speaker ?? '').trim());
      return {
        role: isAssistant ? ('assistant' as const) : ('user' as const),
        content: content || line,
      };
    });
}

export interface EvalCsvResultRow extends EvalCsvRow {
  turn: string;
  failures: CheckResult[];
  ms: number;
}

/** Results back out as CSV, so they can go into the same spreadsheet. */
export function resultsToCsv(results: EvalCsvResultRow[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const header = ['id', 'probes', 'turn', 'passed', 'failedChecks', 'ms'];
  const lines = [header.join(',')];

  for (const r of results) {
    lines.push(
      [
        escape(r.id),
        escape(r.probes),
        escape(r.turn),
        r.failures.length === 0 ? 'yes' : 'no',
        escape(r.failures.map((f) => `${f.check}: ${f.detail}`).join(' | ')),
        String(r.ms),
      ].join(','),
    );
  }

  return lines.join('\n');
}

/**
 * A prompt the user can hand to an LLM to generate cases in this format.
 *
 * Provided because writing evaluation cases is the part people skip, and the
 * format is the smallest obstacle to not skipping it. Explicit about what makes
 * a case useful — a situation rather than an expected answer — since that is
 * the mistake a model asked to "write test cases" will otherwise make.
 */
export const AGENT_INSTRUCTIONS = `Produce a CSV of evaluation cases for a spoken conversational AI.

Output ONLY the CSV. No commentary, no code fence.

Columns, exactly these, in this order:
id,systemPrompt,transcript,probes

- id: short, unique, kebab-case. e.g. "vague-answer-followup"
- systemPrompt: the full system prompt the model under test will run under.
  Repeat it on every row; rows may share one or use different ones.
- transcript: the conversation BEFORE the turn being tested. One turn per line,
  formatted "user: ..." or "assistant: ...". Leave empty to test the opening
  turn. Because this contains newlines and commas, it MUST be quoted.
- probes: one sentence on what this case is testing.

Rules that decide whether these cases are worth anything:

1. A case is a SITUATION, not an expected answer. There is no single correct
   reply, so describe the circumstances and let the checks judge properties.
   Never write an "expected output" column.
2. Cover the ordinary path AND the adversarial one. The interesting cases are:
   the user asking the model to break character, a prompt injection, the user
   being silent or vague, a request the model should decline, and a legitimate
   request that a badly-tuned model would wrongly refuse.
3. Include at least one case where the correct behaviour is NOT to ask a
   question — declining, or answering a clarification. Suites that assume every
   turn is a question punish correct behaviour.
4. Vary the length and register of the user's turns. Real speech is messy,
   contains filler, and trails off.
5. Aim for 12-25 rows. Fewer misses failure modes; more is rarely read.

Escape any field containing a comma, quote or newline by wrapping it in double
quotes and doubling any internal quotes.

Example row:
"vague-answer-followup","You are an interviewer. Ask one short question.","assistant: Tell me about a system you owned.
user: Yeah it was pretty big and it went well I think.","Model should press for a specific detail rather than accepting a vague answer."`;
