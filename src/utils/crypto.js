import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 48) => randomBytes(bytes).toString('base64url');

export function safeEqualHex(a, b) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

// IP addresses are stored only as keyed hashes; they are used for abuse limits, not identification.
export function hashIp(ip) {
  if (!ip) return null;
  const secret = process.env.IP_HASH_SECRET || process.env.AUTH_TOKEN_SECRET || 'dev-ip-hash';
  return createHmac('sha256', secret).update(ip).digest('hex');
}
