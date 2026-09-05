/**
 * The deterministic checks now live in @greenroom/shared so the in-browser
 * eval runner applies byte-identical rules to the on-device model. Re-exported
 * here so the harness's imports stay unchanged.
 */
export {
  runChecks,
  checkFailures,
  criticalCheckFailures,
  type CheckResult,
} from '@greenroom/shared';
