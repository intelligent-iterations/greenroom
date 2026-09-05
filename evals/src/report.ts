import { RUBRIC } from './deps.ts';
import type { GateResult } from './gate.ts';
import type { EvalReport } from './types.ts';

/**
 * Markdown report.
 *
 * Written for whoever is looking at a red build, so it leads with what failed
 * and shows the offending turn verbatim. A report that only prints aggregate
 * numbers makes the reader go and reproduce the run by hand, which means they
 * will not.
 */
export function renderMarkdown(report: EvalReport, gate: GateResult): string {
  const lines: string[] = [];
  const s = report.summary;

  lines.push('# Evaluation report', '');
  lines.push(`- **Result**: ${gate.passed ? 'PASS' : 'FAIL'}`);
  lines.push(`- **Prompt version**: \`${report.promptVersion}\``);
  lines.push(`- **Model under test**: \`${report.modelId}\``);
  lines.push(`- **Judge**: \`${report.judgeId}\``);
  lines.push(`- **Cases**: ${s.cases} (${s.scored} rubric-scored, ${s.errors} errored)`);
  if (s.scored > 0) lines.push(`- **Composite**: ${s.composite.toFixed(3)}`);
  lines.push(`- **Check failures**: ${s.checkFailures}`);
  lines.push(`- **Cases with critical failures**: ${s.criticalFailures}`);
  lines.push('');

  if (gate.failures.length > 0) {
    lines.push('## Gate failures', '');
    for (const failure of gate.failures) lines.push(`- ${failure}`);
    lines.push('');
  }
  if (gate.notes.length > 0) {
    lines.push('## Notes', '');
    for (const note of gate.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  if (s.scored > 0) {
    lines.push('## Scores by dimension', '', '| Dimension | Mean (1-5) | Critical |', '|---|---|---|');
    for (const dim of RUBRIC) {
      const mean = s.byDimension[dim.id];
      lines.push(
        `| ${dim.label} | ${mean === undefined ? '—' : mean.toFixed(2)} | ${dim.critical ? 'yes' : ''} |`,
      );
    }
    lines.push('');
  }

  const problems = report.results.filter(
    (r) => r.error || r.criticalFailures.length > 0 || r.checks.some((c) => !c.passed),
  );

  if (problems.length > 0) {
    lines.push('## Cases needing attention', '');
    for (const result of problems) {
      lines.push(`### \`${result.case.id}\``);
      lines.push(`*Probes:* ${result.case.probes}`);
      if (result.error) {
        lines.push('', `**Error:** ${result.error}`, '');
        continue;
      }
      lines.push('', '> ' + result.turn.replace(/\n/g, '\n> '), '');
      for (const check of result.checks.filter((c) => !c.passed)) {
        lines.push(`- ${check.critical ? '**CRITICAL** ' : ''}\`${check.check}\`: ${check.detail}`);
      }
      for (const score of result.scores.filter((sc) => sc.score <= 2)) {
        lines.push(`- \`${score.dimension}\` scored ${score.score}: "${score.evidence}"`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** One line per case, for watching a long run. */
export function renderProgressLine(id: string, ok: boolean, index: number, total: number): string {
  return `[${String(index).padStart(3)}/${total}] ${ok ? 'ok  ' : 'FAIL'} ${id}`;
}
