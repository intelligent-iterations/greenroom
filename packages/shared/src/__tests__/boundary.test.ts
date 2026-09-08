import { describe, expect, it } from 'vitest';
import * as core from '../index.js';
import * as interview from '../interview/index.js';

/**
 * The core must not know what an interview is.
 *
 * This package began as one product and the general parts were extracted from
 * it, which is the direction that leaks: it is very easy to re-export one
 * convenient interview type from the core and undo the split without noticing.
 * Someone evaluating a support agent or a booking assistant should never have
 * to see a CEFR level to use the harness.
 */
const INTERVIEW_ONLY = [
  'CefrLevel',
  'SeniorityLevel',
  'CompetencyId',
  'COMPETENCY_LABELS',
  'CompetencyMastery',
  'ObservedError',
  'LearnerState',
  'InterviewScenario',
  'masteryFor',
  'updateMastery',
  'compileInterviewerPrompt',
  'compileCoachPrompt',
  'selectFocusCompetencies',
  'SCENARIOS',
  'findScenario',
  'interviewPreset',
];

describe('the core/example boundary', () => {
  it('keeps every interview symbol out of the core entry point', () => {
    const exported = Object.keys(core);
    for (const name of INTERVIEW_ONLY) {
      expect(exported, `@greenroom/shared should not export ${name}`).not.toContain(name);
    }
  });

  it('still exposes them from the interview entry point', () => {
    const exported = Object.keys(interview);
    for (const name of INTERVIEW_ONLY) {
      expect(exported, `@greenroom/shared/interview should export ${name}`).toContain(name);
    }
  });

  it('keeps the reusable surface in the core', () => {
    const exported = Object.keys(core);
    for (const name of [
      'runChecks',
      'SPOKEN_CHECKS',
      'SPOKEN_RUBRIC',
      'applicableRubric',
      'buildJudgePrompt',
      'compositeScore',
      'LexicalRetriever',
      'buildCorpus',
      'splitSpeakableChunks',
      'ThinkingStripper',
      'selectModel',
      'parseEvalCsv',
    ]) {
      expect(exported, `@greenroom/shared should export ${name}`).toContain(name);
    }
  });

  // The words matter as much as the symbols: a core type whose field is called
  // `interviewer` is still an interview tool wearing a different hat.
  it('keeps interview vocabulary out of core type names', () => {
    const suspicious = Object.keys(core).filter((k) => /interview|learner|candidate|cefr/i.test(k));
    expect(suspicious).toEqual([]);
  });
});
