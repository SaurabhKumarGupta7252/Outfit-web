import { query, withTransaction } from '../../db/index.js';
import { config } from '../../config/env.js';
import { createAccessToken } from '../../security/access-token.js';
import { hashPassword, verifyPassword } from '../../security/password.js';
import { evaluateFreeCreditEligibility } from '../../services/device-eligibility.js';
import { verifyGoogleIdToken } from '../../services/google-identity.js';
import { sendPasswordResetEmail } from '../../services/mailer.js';
import { getSetting } from '../../services/settings.js';
import { randomToken, safeEqualHex, sha256 } from '../../utils/crypto.js';
import { AppError, conflict, unauthorized } from '../../utils/errors.js';
import { lockInstallation } from '../devices/devices.service.js';
import { ensureUserWallet, presentWallet } from '../wallet/wallet.service.js';

export function presentUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    emailVerified: user.email_verified,
    role: user.role,
    hasPassword: Boolean(user.password),
    googleLinked: Boolean(user.google_sub),
    createdAt: user.created_at,
  };
}

async function issueUserSession(client, user, installationId = null) {
  const refreshToken = randomToken(48);
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, installation_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [user.id, sha256(refreshToken), installationId, config.auth.refreshTokenTtlDays],
  );
  return {
    accessToken: createAccessToken(user.id, { kind: 'user', installationId }),
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: config.auth.accessTokenTtlSeconds,
  };
}

// ---------------------------------------------------------------- guest

// Creates or resumes the guest session for an installation and grants the one-time free
// credits when the installation is eligible. Safe to call on every app start.
export async function signInGuest(input, ip) {
  const { amount } = await getSetting('free_credits');

  return withTransaction(async (client) => {
    const installation = await lockInstallation(client, { ...input, ip });

    let { rows: [session] } = await client.query(
      `SELECT * FROM guest_sessions WHERE installation_id = $1 AND status = 'active'`,
      [installation.id],
    );
    if (!session) {
      ({ rows: [session] } = await client.query(
        `INSERT INTO guest_sessions (installation_id, guest_token_hash) VALUES ($1, $2) RETURNING *`,
        [installation.id, installation.secret_hash],
      ));
      await client.query(`INSERT INTO wallets (owner_type, guest_session_id) VALUES ('guest', $1)`, [session.id]);
    }
    const { rows: [wallet] } = await client.query('SELECT * FROM wallets WHERE guest_session_id = $1', [session.id]);

    let freeCreditsGranted = false;
    let freeCreditsReason = 'ALREADY_CLAIMED';
    if (!installation.free_credit_claimed) {
      const eligibility = await evaluateFreeCreditEligibility(client, installation);
      freeCreditsReason = eligibility.reason;
      if (eligibility.eligible) {
        const { rows } = await client.query('SELECT fn_grant_free_credits($1, $2, $3) AS granted', [installation.id, wallet.id, amount]);
        freeCreditsGranted = rows[0].granted;
        freeCreditsReason = null;
      }
    }

    const { rows: [freshWallet] } = await client.query('SELECT * FROM wallets WHERE id = $1', [wallet.id]);
    return {
      accessToken: createAccessToken(session.id, { kind: 'guest', installationId: installation.id }),
      tokenType: 'Bearer',
      expiresIn: config.auth.accessTokenTtlSeconds,
      guest: { id: session.id, installationId: installation.id },
      wallet: presentWallet(freshWallet),
      freeCredits: { granted: freeCreditsGranted, amount: freeCreditsGranted ? amount : 0, reason: freeCreditsReason },
    };
  });
}

// ---------------------------------------------------------------- guest linking

// Links the active guest session of an installation to the user. See fn_merge_guest_into_user
// for the transfer rules. Returns null when no guest details were supplied.
async function linkGuest(client, userId, guest, ip) {
  if (!guest) return null;
  const installation = await lockInstallation(client, { ...guest, ip });

  const { rows: [session] } = await client.query(
    `SELECT id FROM guest_sessions WHERE installation_id = $1 AND status = 'active'`,
    [installation.id],
  );
  if (!session) {
    const { rows: [last] } = await client.query(
      `SELECT linked_user_id FROM guest_sessions WHERE installation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [installation.id],
    );
    const status = last?.linked_user_id === userId ? 'ALREADY_LINKED' : last ? 'CLAIMED_BY_ANOTHER_ACCOUNT' : 'NO_GUEST_SESSION';
    return { status, transferredCredits: 0, installationId: installation.id };
  }

  const { rows } = await client.query('SELECT fn_merge_guest_into_user($1, $2) AS result', [session.id, userId]);
  const result = rows[0].result;
  return {
    status: result.status === 'linked' ? 'LINKED' : 'ALREADY_LINKED',
    transferredCredits: result.transferred,
    installationId: installation.id,
  };
}

async function finishUserSignIn(client, user, guest, ip) {
  const guestMerge = await linkGuest(client, user.id, guest, ip);
  const wallet = await ensureUserWallet(client, user.id);
  const tokens = await issueUserSession(client, user, guestMerge?.installationId ?? null);
  return {
    ...tokens,
    user: presentUser(user),
    wallet: presentWallet(wallet),
    guestMerge: guestMerge && { status: guestMerge.status, transferredCredits: guestMerge.transferredCredits },
  };
}

export async function mergeGuest(userId, guest, ip) {
  return withTransaction(async (client) => {
    const merge = await linkGuest(client, userId, guest, ip);
    if (merge.status === 'CLAIMED_BY_ANOTHER_ACCOUNT') {
      throw conflict('This guest session has already been linked to another account.', 'GUEST_ALREADY_CLAIMED');
    }
    const wallet = await ensureUserWallet(client, userId);
    return { guestMerge: { status: merge.status, transferredCredits: merge.transferredCredits }, wallet: presentWallet(wallet) };
  });
}

// ---------------------------------------------------------------- email / password

export async function signUp({ email, password, displayName, guest }, ip) {
  const passwordHash = await hashPassword(password);
  return withTransaction(async (client) => {
    let user;
    try {
      ({ rows: [user] } = await client.query(
        `INSERT INTO users (email, password, display_name) VALUES ($1, $2, $3) RETURNING *`,
        [email, passwordHash, displayName ?? null],
      ));
    } catch (error) {
      if (error.code === '23505') throw conflict('An account with this email already exists.', 'EMAIL_IN_USE');
      throw error;
    }
    return finishUserSignIn(client, user, guest, ip);
  });
}

export async function logIn({ email, password, guest }, ip) {
  const { rows: [user] } = await query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  const passwordOk = user?.password ? await verifyPassword(password, user.password) : false;
  if (!passwordOk) throw unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');
  return withTransaction((client) => finishUserSignIn(client, user, guest, ip));
}

// ---------------------------------------------------------------- google

export async function signInWithGoogle({ idToken, guest }, ip) {
  const google = await verifyGoogleIdToken(idToken);

  return withTransaction(async (client) => {
    let { rows: [user] } = await client.query('SELECT * FROM users WHERE google_sub = $1', [google.sub]);

    if (!user) {
      const { rows: [byEmail] } = await client.query('SELECT * FROM users WHERE email = $1', [google.email]);
      if (byEmail) {
        // Only attach Google to an existing email account when Google vouches for the address.
        if (!google.emailVerified) {
          throw conflict('An account with this email already exists. Sign in with your password.', 'EMAIL_IN_USE');
        }
        ({ rows: [user] } = await client.query(
          `UPDATE users SET google_sub = $2, email_verified = true,
                  display_name = COALESCE(display_name, $3), avatar_url = COALESCE(avatar_url, $4), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [byEmail.id, google.sub, google.name, google.picture],
        ));
      } else {
        ({ rows: [user] } = await client.query(
          `INSERT INTO users (email, google_sub, email_verified, display_name, avatar_url)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [google.email, google.sub, google.emailVerified, google.name, google.picture],
        ));
      }
    }
    if (user.deleted_at) throw unauthorized('This account is no longer available.', 'ACCOUNT_DELETED');
    return finishUserSignIn(client, user, guest, ip);
  });
}

// ---------------------------------------------------------------- sessions

// Refresh tokens are single-use. Presenting a token that was already rotated revokes every
// session of that user, because it means the token was copied.
export async function refreshSession(refreshToken) {
  return withTransaction(async (client) => {
    const { rows: [stored] } = await client.query(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [sha256(refreshToken)],
    );
    if (!stored) throw unauthorized('Session expired. Please sign in again.', 'INVALID_REFRESH_TOKEN');
    if (stored.revoked_at) {
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [stored.user_id]);
      return { reuseDetected: true };
    }
    if (stored.expires_at <= new Date()) throw unauthorized('Session expired. Please sign in again.', 'INVALID_REFRESH_TOKEN');

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [stored.user_id]);
    if (!user) throw unauthorized('Session expired. Please sign in again.', 'INVALID_REFRESH_TOKEN');

    await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [stored.id]);
    return { ...(await issueUserSession(client, user, stored.installation_id)), user: presentUser(user) };
  }).then((result) => {
    if (result.reuseDetected) throw unauthorized('Session expired. Please sign in again.', 'INVALID_REFRESH_TOKEN');
    return result;
  });
}

export async function logOut(userId, { refreshToken, allDevices }) {
  if (allDevices) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  } else if (refreshToken) {
    await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL',
      [userId, sha256(refreshToken)],
    );
  }
}

export async function getUser(userId) {
  const { rows: [user] } = await query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!user) throw unauthorized('This account is no longer available.', 'ACCOUNT_DELETED');
  return user;
}

// ---------------------------------------------------------------- password reset

// Always resolves the same way, so the response never reveals whether an email is registered.
export async function requestPasswordReset(email) {
  const { rows: [user] } = await query('SELECT id, email FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (!user) return;
  const token = randomToken(32);
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [user.id, sha256(token), config.auth.passwordResetTtlMinutes],
  );
  await sendPasswordResetEmail({ email: user.email, token });
}

export async function resetPassword({ token, newPassword }) {
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    const tokenHash = sha256(token);
    const { rows: [stored] } = await client.query(
      'SELECT * FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash],
    );
    if (!stored || !safeEqualHex(stored.token_hash, tokenHash) || stored.used_at || stored.expires_at <= new Date()) {
      throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
    }
    await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [stored.id]);
    await client.query('UPDATE users SET password = $2, updated_at = now() WHERE id = $1', [stored.user_id, passwordHash]);
    await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [stored.user_id]);
  });
}
