/**
 * Scenario lookup for the scoring trigger.
 *
 * Re-exported from the shared catalogue rather than duplicated: the trigger
 * recompiles the interviewer prompt to recover a session's focus competencies,
 * and it can only do that correctly if it sees byte-identical content to what
 * the browser ran.
 */
export { SCENARIOS, findScenario } from '@greenroom/shared';
