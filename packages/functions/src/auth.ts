import { getAuth } from 'firebase-admin/auth';
import type { Request } from 'firebase-functions/https';

export interface AuthedUser {
  uid: string;
}

/**
 * Verifies the Firebase ID token on an Authorization: Bearer header.
 *
 * Anonymous accounts are accepted — the product deliberately does not require
 * an identity to practise — but a token is still required so requests are
 * attributable for rate limiting and the cloud-inference audit log.
 */
export async function verifyRequest(req: Request): Promise<AuthedUser | undefined> {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;

  try {
    const decoded = await getAuth().verifyIdToken(header.slice(7));
    return { uid: decoded.uid };
  } catch {
    // Expired, malformed, or from another project. All are just "not signed in".
    return undefined;
  }
}
