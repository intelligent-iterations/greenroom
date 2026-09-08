/**
 * The interview-coaching example.
 *
 * Imported as `@greenroom/shared/interview`. The core entry point deliberately
 * does not re-export any of this: someone evaluating a support agent or a
 * booking assistant should never have to see a CEFR level to use the harness.
 */
export * from './domain.js';
export * from './prompt.js';
export * from './presets.js';
export * from './scenarios.js';
