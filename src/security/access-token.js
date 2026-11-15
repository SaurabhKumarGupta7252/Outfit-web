import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';

function getSecret() {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    const error = new Error('AUTH_TOKEN_SECRET must contain at least 32 bytes.');
    error.statusCode = 503;
    throw error;
  }
  return secret;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(unsignedToken, secret) {
  return createHmac('sha256', secret).update(unsignedToken).digest('base64url');
}

// kind is 'user' (sub = users.id) or 'guest' (sub = guest_sessions.id).
// iid is the device_installations.id the token was issued for, when known.
export function createAccessToken(subject, { kind = 'user', installationId = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const claims = { sub: String(subject), kind, iat: now, exp: now + config.auth.accessTokenTtlSeconds };
  if (installationId) claims.iid = installationId;
  const unsignedToken = `${header}.${encode(claims)}`;
  return `${unsignedToken}.${sign(unsignedToken, getSecret())}`;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifyAccessToken(token) {
  const [headerPart, payloadPart, signaturePart, extra] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart || extra) return null;

  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || !Number.isInteger(payload.exp) || payload.exp <= Date.now() / 1000) return null;

    const expected = Buffer.from(sign(`${headerPart}.${payloadPart}`, getSecret()));
    const received = Buffer.from(signaturePart);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

    const kind = payload.kind || 'user';
    const installationId = typeof payload.iid === 'string' && uuidPattern.test(payload.iid) ? payload.iid : null;
    if (kind === 'user' && /^\d+$/.test(payload.sub)) {
      const id = Number(payload.sub);
      return { kind, id, userId: id, guestSessionId: null, installationId };
    }
    if (kind === 'guest' && uuidPattern.test(payload.sub)) {
      return { kind, id: null, userId: null, guestSessionId: payload.sub, installationId };
    }
    return null;
  } catch {
    return null;
  }
}
