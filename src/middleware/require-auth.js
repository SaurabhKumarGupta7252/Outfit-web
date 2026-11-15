import { verifyAccessToken } from '../security/access-token.js';
import { query } from '../db/index.js';
import { forbidden, unauthorized } from '../utils/errors.js';

function readPrincipal(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? verifyAccessToken(match[1]) : null;
}

// Accepts a registered user or a guest. Sets req.auth =
// { kind: 'user' | 'guest', userId, guestSessionId, installationId }.
export function requireAuth(req, _res, next) {
  const principal = readPrincipal(req);
  if (!principal) return next(unauthorized('A valid bearer token is required.'));
  req.auth = principal;
  next();
}

export function requireUser(req, _res, next) {
  const principal = readPrincipal(req);
  if (!principal) return next(unauthorized('A valid bearer token is required.'));
  if (principal.kind !== 'user') {
    return next(forbidden('Sign in or create an account to continue.', 'ACCOUNT_REQUIRED'));
  }
  req.auth = principal;
  next();
}

// The role is read from the database on every request, so revoking admin takes effect immediately.
export async function requireAdmin(req, _res, next) {
  const principal = readPrincipal(req);
  if (!principal) return next(unauthorized('A valid bearer token is required.'));
  if (principal.kind !== 'user') return next(forbidden());
  const { rows } = await query('SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL', [principal.userId]);
  if (rows[0]?.role !== 'admin') return next(forbidden());
  req.auth = principal;
  next();
}
