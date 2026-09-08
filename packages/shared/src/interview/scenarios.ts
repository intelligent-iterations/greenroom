import type { InterviewScenario } from './domain.js';

/**
 * Built-in scenarios.
 *
 * Lives in the shared package because three surfaces need the identical
 * content: the app renders it, the scoring function recompiles prompts against
 * it, and the eval harness replays it. A second copy anywhere means the harness
 * eventually measures a scenario that never shipped.
 *
 * Bundled rather than fetched so the app runs with no backend at all. In a
 * portal deployment these come from the content service and this becomes the
 * offline fallback.
 */
export const SCENARIOS: InterviewScenario[] = [
  {
    id: 'backend-mid-en',
    title: 'Backend engineer, mid-level',
    interviewerPersona: 'a pragmatic staff engineer who has led this team for four years',
    company: 'Northwind Logistics',
    role: 'Backend Engineer',
    seniority: 'mid',
    language: 'en',
    targetCompetencies: ['quantified_impact', 'technical_depth', 'concision'],
    requiredQuestions: [
      'Walk me through a system you owned from design to production.',
      'Tell me about a time you made something measurably faster.',
      'Describe a decision you made that turned out to be wrong.',
    ],
    contextNotes: [
      'The team runs Postgres and is midway through leaving a Rails monolith.',
      'On-call is shared and the team is protective of its incident load.',
    ],
    maxTurns: 10,
  },
  {
    id: 'support-junior-fr',
    title: "Conseiller au service client, débutant",
    interviewerPersona: "une gestionnaire d'équipe chaleureuse mais directe",
    company: 'Services Boréal',
    role: 'Conseiller au service client',
    seniority: 'junior',
    language: 'fr',
    targetCompetencies: ['active_listening', 'handling_pressure', 'domain_vocabulary'],
    requiredQuestions: [
      "Parlez-moi d'une fois où un client était mécontent.",
      'Comment organisez-vous une journée chargée ?',
      "Qu'est-ce qui vous attire dans ce poste ?",
    ],
    contextNotes: ['Le service traite environ deux cents appels par jour.'],
    maxTurns: 8,
  },
  {
    id: 'pm-senior-en',
    title: 'Product manager, senior',
    interviewerPersona: 'a director of product who is sceptical of process talk',
    company: 'Meridian Health',
    role: 'Senior Product Manager',
    seniority: 'senior',
    language: 'en',
    targetCompetencies: ['structured_storytelling', 'quantified_impact', 'clarifying_questions'],
    requiredQuestions: [
      'Tell me about a product bet you made that did not pay off.',
      'How did you decide what not to build last quarter?',
      'Walk me through how you would size this market.',
    ],
    contextNotes: [
      'The company sells into hospitals, so procurement cycles run twelve to eighteen months.',
    ],
    maxTurns: 10,
  },
];

export function findScenario(id: string): InterviewScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
