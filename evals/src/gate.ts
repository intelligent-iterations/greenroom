import { RUBRIC } from './deps.ts';
import type { EvalReport } from './types.ts';

/**
 * Quality gates.
 *
 * These are the thresholds a change has to clear to merge. The values matter
 * less than the shape of the rule, which is why they are here in one readable
 * block rather than spread through the runner:
 *
 *  - **Critical failures are absolute.** One turn that leaks an answer or asks
 *    something discriminatory fails the build. Averaging that away across forty
 *    passing cases is how a product ships a harm it already measured.
 *  - **Regression is bounded, not forbidden.** A composite that drops more than
 *    `maxRegression` against the recorded baseline fails, because a prompt
 *    change that improves one dimension while quietly wrecking another is the
 *    most common way these systems get worse.
 *  - **Per-dimension floors** stop a strong average from hiding one dimension
 *    falling off a cliff.
 */
export interface Gates {
  /** Minimum mean composite across scored cases, 0..1. */
  minComposite: number;
  /** Minimum mean score, 1..5, for any single rubric dimension. */
  minDimensionMean: number;
  /** Largest tolerated composite drop against the baseline. */
  maxRegression: number;
  /** Cases that failed to run at all. Usually a broken harness, not a model. */
  maxErrors: number;
}

export const DEFAULT_GATES: Gates = {
  minComposite: 0.7,
  minDimensionMean: 3.5,
  maxRegression: 0.03,
  maxErrors: 0,
};

export interface Baseline {
  promptVersion: string;
  modelId: string;
  composite: number;
  byDimension: Record<string, number>;
  recordedAt: string;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
  notes: string[];
}

export function evaluateGates(
  report: EvalReport,
  gates: Gates = DEFAULT_GATES,
  baseline?: Baseline,
): GateResult {
  const failures: string[] = [];
  const notes: string[] = [];

  if (report.summary.errors > gates.maxErrors) {
    failures.push(
      `${report.summary.errors} case(s) failed to run (limit ${gates.maxErrors}). This is usually a harness or credentials problem, not a quality one.`,
    );
  }

  for (const result of report.results) {
    for (const failure of result.criticalFailures) {
      failures.push(`${result.case.id}: critical failure on ${failure}`);
    }
  }

  // The rest of the gates need rubric scores. A deterministic-only run
  // legitimately has none, and must not be reported as a pass on thresholds it
  // never actually evaluated.
  if (report.summary.scored === 0) {
    notes.push(
      'No rubric scores in this run: deterministic checks only. Composite and dimension gates were not evaluated.',
    );
    return { passed: failures.length === 0, failures, notes };
  }

  if (report.summary.composite < gates.minComposite) {
    failures.push(
      `composite ${report.summary.composite.toFixed(3)} is below the floor ${gates.minComposite}`,
    );
  }

  for (const dim of RUBRIC) {
    const mean = report.summary.byDimension[dim.id];
    if (mean !== undefined && mean < gates.minDimensionMean) {
      failures.push(`${dim.id} mean ${mean.toFixed(2)} is below the floor ${gates.minDimensionMean}`);
    }
  }

  if (baseline) {
    if (baseline.promptVersion !== report.promptVersion) {
      // Not a failure: a prompt bump is exactly when you expect the numbers to
      // move. It is recorded so nobody reads the comparison as like-for-like.
      notes.push(
        `Prompt version changed (${baseline.promptVersion} -> ${report.promptVersion}); regression gate compares across a prompt change.`,
      );
    }
    const delta = report.summary.composite - baseline.composite;
    if (delta < -gates.maxRegression) {
      failures.push(
        `composite regressed ${Math.abs(delta).toFixed(3)} against baseline ${baseline.composite.toFixed(3)} (limit ${gates.maxRegression})`,
      );
    } else {
      notes.push(
        `composite ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} against baseline ${baseline.composite.toFixed(3)}`,
      );
    }
  } else {
    notes.push('No baseline recorded; regression gate skipped. Record one with --write-baseline.');
  }

  return { passed: failures.length === 0, failures, notes };
}

export function toBaseline(report: EvalReport): Baseline {
  return {
    promptVersion: report.promptVersion,
    modelId: report.modelId,
    composite: report.summary.composite,
    byDimension: report.summary.byDimension,
    recordedAt: new Date().toISOString(),
  };
}
