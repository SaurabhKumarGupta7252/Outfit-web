import { config } from '../config/env.js';
import { logger } from '../logger.js';

// Email delivery is not wired to a provider yet. In development the reset token is logged so
// the flow can be tested; in production nothing secret is logged and the email is NOT sent.
// Replace the body of this function with a real provider (SMTP, SES, Resend, ...) before release.
export async function sendPasswordResetEmail({ email, token }) {
  if (config.isProduction) {
    logger.error({ email }, 'Password reset requested but no email provider is configured.');
    return;
  }
  logger.info({ email, resetToken: token }, 'DEV ONLY: password reset token');
}
