/**
 * What this build of the app is allowed to offer.
 *
 * The cloud route is off unless a deployment says otherwise, and the server
 * enforces the same posture independently (`cloudInferenceEnabled` in
 * packages/functions/src/generate.ts). Two switches rather than one, on purpose:
 * the client's job is not to offer what the deployment cannot serve, and the
 * server's job is to refuse regardless of what a client asks for. Neither is
 * trusted to be the only one.
 *
 * The default matters more than the mechanism. Before this existed the setup
 * screen offered a cloud toggle unconditionally, so on a deployment with no key
 * a visitor could opt in, start a session, and receive a 503 — an option that
 * looked like a feature and behaved like a bug.
 */
export function cloudInferenceOffered(): boolean {
  return import.meta.env.VITE_CLOUD_ENABLED === 'true';
}
