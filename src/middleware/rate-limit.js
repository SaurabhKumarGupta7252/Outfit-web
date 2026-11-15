import { rateLimit } from 'express-rate-limit';
import { fail } from '../utils/respond.js';
import { config } from '../config/env.js';

function limiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.isTest,
    handler: (_req, res) => fail(res, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.'),
  });
}

export const globalLimiter = limiter(60 * 1000, 240);
// Login, signup, password reset and guest creation are the abuse-sensitive endpoints.
export const authLimiter = limiter(15 * 60 * 1000, 30);
export const guestLimiter = limiter(60 * 60 * 1000, 40);
export const generationLimiter = limiter(60 * 1000, 20);
