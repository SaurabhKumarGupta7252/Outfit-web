import { config } from '../config/env.js';
import { AppError, unauthorized } from '../utils/errors.js';

let clientPromise;

// Verifies a Google ID token (from native Google Sign-In) against Google's public keys and
// our own OAuth client IDs. Nothing the app sends besides the token itself is trusted.
export async function verifyGoogleIdToken(idToken) {
  if (!config.auth.googleClientIds.length) {
    throw new AppError(503, 'GOOGLE_SIGN_IN_NOT_CONFIGURED', 'Google Sign-In is not configured on the server.');
  }
  clientPromise ??= import('google-auth-library').then(({ OAuth2Client }) => new OAuth2Client());
  const client = await clientPromise;

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: config.auth.googleClientIds });
    payload = ticket.getPayload();
  } catch {
    throw unauthorized('Google sign-in could not be verified.', 'INVALID_GOOGLE_TOKEN');
  }
  if (!payload?.sub || !payload.email) {
    throw unauthorized('Google sign-in could not be verified.', 'INVALID_GOOGLE_TOKEN');
  }
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name || null,
    picture: payload.picture || null,
  };
}
