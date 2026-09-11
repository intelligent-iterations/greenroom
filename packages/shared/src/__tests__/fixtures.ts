import type { InterviewScenario, LearnerState } from '../interview/domain.js';

export const scenario: InterviewScenario = {
  id: 'be-mid-payments',
  title: 'Backend engineer, payments',
  interviewerPersona: 'a pragmatic staff engineer who has run this team for four years',
  company: 'Northwind Logistics',
  role: 'Backend Engineer',
  seniority: 'mid',
  language: 'en',
  targetCompetencies: ['quantified_impact', 'technical_depth', 'concision'],
  requiredQuestions: [
    'Walk me through a system you owned end to end.',
    'Tell me about a time you made something faster.',
  ],
  contextNotes: ['The team runs Postgres and is migrating off a monolith.'],
  maxTurns: 10,
};

export const learner: LearnerState = {
  userId: 'u1',
  cefr: 'B2',
  seniority: 'mid',
  language: 'en',
  targetRole: 'Backend Engineer',
  mastery: [
    { competency: 'technical_depth', score: 0.8, observations: 12, updatedAt: 0 },
    { competency: 'concision', score: 0.3, observations: 9, updatedAt: 0 },
    { competency: 'quantified_impact', score: 0.55, observations: 6, updatedAt: 0 },
  ],
  recentErrors: [],
  sessionsCompleted: 4,
  updatedAt: 0,
};
