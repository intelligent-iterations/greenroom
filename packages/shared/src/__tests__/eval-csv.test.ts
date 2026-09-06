import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTIONS, parseCsv, parseEvalCsv, parseTranscript, resultsToCsv } from '../eval-csv.js';

describe('parseCsv', () => {
  it('reads quoted fields containing commas and newlines', () => {
    // The transcript column is exactly this shape, so it is the case that matters.
    const rows = parseCsv('id,transcript\n"a","user: hi, there\nassistant: hello"');
    expect(rows).toEqual([
      ['id', 'transcript'],
      ['a', 'user: hi, there\nassistant: hello'],
    ]);
  });

  it('handles doubled quotes', () => {
    expect(parseCsv('a\n"he said ""no"""')).toEqual([['a'], ['he said "no"']]);
  });

  it('treats CRLF as one line break', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a\n\n\nb')).toEqual([['a'], ['b']]);
  });
});

describe('parseEvalCsv', () => {
  const header = 'id,systemPrompt,transcript,probes\n';

  it('accepts a well-formed file', () => {
    const { rows, errors } = parseEvalCsv(`${header}case-1,Be an interviewer.,"user: hi",Tests the opener`);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { id: 'case-1', systemPrompt: 'Be an interviewer.', transcript: 'user: hi', probes: 'Tests the opener' },
    ]);
  });

  it('ignores header case, spacing and column order', () => {
    const { rows, errors } = parseEvalCsv('System_Prompt , ID\nBe brief.,case-2');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ id: 'case-2', systemPrompt: 'Be brief.' });
  });

  it('names the missing columns rather than failing silently', () => {
    const { errors } = parseEvalCsv('foo,bar\n1,2');
    expect(errors[0]).toMatch(/Missing required column\(s\): id, systemprompt/);
  });

  it('reports a bad row by line number and keeps the good ones', () => {
    const { rows, errors } = parseEvalCsv(`${header}good,A prompt.,,\n,B prompt.,,`);
    expect(rows).toHaveLength(1);
    expect(errors[0]).toMatch(/Line 3: missing id/);
  });

  it('rejects duplicate ids, which would make two rows indistinguishable', () => {
    const { rows, errors } = parseEvalCsv(`${header}same,A.,,\nsame,B.,,`);
    expect(rows).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate id "same"/);
  });

  it('reports an empty file plainly', () => {
    expect(parseEvalCsv('').errors).toEqual(['The file is empty.']);
  });
});

describe('parseTranscript', () => {
  it('maps speakers to chat roles', () => {
    expect(parseTranscript('assistant: Tell me more.\nuser: It was fine.')).toEqual([
      { role: 'assistant', content: 'Tell me more.' },
      { role: 'user', content: 'It was fine.' },
    ]);
  });

  it('treats interviewer and model as the assistant', () => {
    expect(parseTranscript('interviewer: Go on.')[0]?.role).toBe('assistant');
    expect(parseTranscript('model: Go on.')[0]?.role).toBe('assistant');
  });

  it('keeps a colon inside the content', () => {
    expect(parseTranscript('user: the ratio was 3:1')[0]?.content).toBe('the ratio was 3:1');
  });

  it('defaults an unlabelled line to the person speaking', () => {
    // Safer default for a half-formatted transcript than assuming the model.
    expect(parseTranscript('just some text')).toEqual([{ role: 'user', content: 'just some text' }]);
  });
});

describe('resultsToCsv', () => {
  it('escapes quotes and commas so the file reopens cleanly', () => {
    const csv = resultsToCsv([
      {
        id: 'a',
        systemPrompt: 'p',
        transcript: '',
        probes: 'tests "quoting", and commas',
        turn: 'What, exactly?',
        failures: [],
        ms: 12,
      },
    ]);
    expect(csv.split('\n')[1]).toContain('"tests ""quoting"", and commas"');
    expect(csv).toContain(',yes,');
  });
});

describe('AGENT_INSTRUCTIONS', () => {
  it('names the exact columns the parser requires', () => {
    expect(AGENT_INSTRUCTIONS).toContain('id,systemPrompt,transcript,probes');
  });

  it('warns against the mistake a model would otherwise make', () => {
    // Asked to "write test cases", a model writes expected outputs.
    expect(AGENT_INSTRUCTIONS).toContain('SITUATION, not an expected answer');
    expect(AGENT_INSTRUCTIONS).toContain('correct behaviour is NOT to ask');
  });
});
