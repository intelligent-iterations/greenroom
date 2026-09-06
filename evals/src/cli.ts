import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBackend, type EvalBackend } from './backends.ts';
import { LocalBackend } from './backend-local.ts';
import { DEFAULT_GATES, evaluateGates, toBaseline, type Baseline } from './gate.ts';
import { renderMarkdown, renderProgressLine } from './report.ts';
import { loadCases, runSuite } from './runner.ts';
import type { EvalCase } from './types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS = join(ROOT, 'datasets');
const REPORTS = join(ROOT, 'reports');
const BASELINE = join(ROOT, 'baseline.json');

interface Args {
  backend: string;
  model?: string;
  dtype?: string;
  judge: string;
  gate: boolean;
  style?: 'full' | 'compact';
  record: boolean;
  writeBaseline: boolean;
  tag?: string;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

  return {
    backend: get('backend') ?? 'replay',
    ...(get('model') ? { model: get('model')! } : {}),
    ...(get('dtype') ? { dtype: get('dtype')! } : {}),
    // Deterministic checks only unless a judge is named. That default is what
    // lets the suite gate every pull request without a single secret.
    judge: get('judge') ?? 'none',
    gate: argv.includes('--gate'),
    ...(get('style') ? { style: get('style') as 'full' | 'compact' } : {}),
    record: argv.includes('--record'),
    writeBaseline: argv.includes('--write-baseline'),
    ...(get('tag') ? { tag: get('tag')! } : {}),
    concurrency: Number(get('concurrency') ?? 4),
  };
}

async function readBaseline(): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await readFile(BASELINE, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

/** Writes turns from a live run back into the dataset files. */
async function recordTurns(cases: EvalCase[], turns: Map<string, string>): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(DATASETS)).filter((f) => f.endsWith('.jsonl'));

  for (const file of files) {
    const path = join(DATASETS, file);
    const lines = (await readFile(path, 'utf8')).split('\n');

    const updated = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) return line;
      const parsed = JSON.parse(trimmed) as EvalCase;
      const turn = turns.get(parsed.id);
      // Preserve key order so the diff on a re-record is only the turn itself.
      return turn === undefined ? line : JSON.stringify({ ...parsed, referenceTurn: turn });
    });

    await writeFile(path, updated.join('\n'), 'utf8');
  }
  console.log(`Recorded ${turns.size} turn(s) into ${files.length} dataset file(s).`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let cases = await loadCases(DATASETS);
  if (args.tag) cases = cases.filter((c) => c.tags.includes(args.tag!));
  if (cases.length === 0) throw new Error(args.tag ? `No cases tagged "${args.tag}"` : 'No cases found');

  const recorded = new Map(
    cases.filter((c) => c.referenceTurn).map((c) => [c.id, c.referenceTurn!]),
  );
  // `local` runs the on-device model natively rather than in a browser tab.
  // Behaviour is what the checks measure and behaviour does not depend on the
  // accelerator, so this is the right place for it; bench.html keeps the job
  // that actually needs a GPU, which is latency.
  const backend =
    args.backend === 'local'
      ? new LocalBackend({
          model: args.model ?? 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
          ...(args.dtype ? { dtype: args.dtype as 'q4' } : {}),
        })
      : makeBackend(args.backend, recorded);

  if (backend instanceof LocalBackend) {
    let last = '';
    await backend.load((message) => {
      // Rewrite one line rather than scrolling the terminal.
      if (message !== last) {
        last = message;
        process.stdout.write(`\r${message.padEnd(30)}`);
      }
    });
    process.stdout.write('\r'.padEnd(32) + '\r');
  }
  const judge: EvalBackend | undefined =
    args.judge === 'none' ? undefined : makeBackend(args.judge, recorded);

  console.log(
    `Running ${cases.length} case(s) — model: ${backend.id}, judge: ${judge?.id ?? 'deterministic checks only'}`,
  );

  const report = await runSuite(cases, {
    backend,
    // Local models get the compact prompt by default, since that is what the
    // product compiles for them.
    promptStyle: args.style ?? (args.backend === 'local' ? 'compact' : 'full'),
    ...(judge ? { judge } : {}),
    concurrency: args.concurrency,
    onProgress: (result, index, total) => {
      const ok = !result.error && result.criticalFailures.length === 0;
      console.log(renderProgressLine(result.case.id, ok, index, total));
    },
  });

  const gate = evaluateGates(report, DEFAULT_GATES, await readBaseline());
  const markdown = renderMarkdown(report, gate);

  await mkdir(REPORTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(join(REPORTS, `${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(REPORTS, `${stamp}.md`), markdown, 'utf8');
  await writeFile(join(REPORTS, 'latest.md'), markdown, 'utf8');

  console.log('\n' + markdown);
  console.log(`\nReports written to evals/reports/${stamp}.{json,md}`);

  if (args.record) {
    await recordTurns(
      cases,
      new Map(report.results.filter((r) => r.turn).map((r) => [r.case.id, r.turn])),
    );
  }

  if (args.writeBaseline) {
    await writeFile(BASELINE, JSON.stringify(toBaseline(report), null, 2) + '\n', 'utf8');
    console.log(`Baseline written to evals/baseline.json`);
  }

  if (args.gate && !gate.passed) {
    console.error(`\nQuality gate FAILED with ${gate.failures.length} failure(s).`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
