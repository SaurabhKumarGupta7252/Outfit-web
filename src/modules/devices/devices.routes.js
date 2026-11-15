import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/index.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { guestLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import { evaluateFreeCreditEligibility } from '../../services/device-eligibility.js';
import { config } from '../../config/env.js';
import { notFound } from '../../utils/errors.js';
import { ok } from '../../utils/respond.js';
import { installationFields } from '../auth/auth.schemas.js';
import { lockInstallation, presentInstallation } from './devices.service.js';

const devicesRouter = Router();

async function currentInstallation(req) {
  if (!req.auth.installationId) throw notFound('No installation is associated with this session.');
  const { rows } = await query('SELECT * FROM device_installations WHERE id = $1', [req.auth.installationId]);
  if (!rows[0]) throw notFound('Installation not found.');
  return rows[0];
}

devicesRouter.post('/register', guestLimiter, validate({ body: z.object(installationFields) }), async (req, res) => {
  const installation = await withTransaction(async (client) => {
    const locked = await lockInstallation(client, { ...req.valid.body, ip: req.ip });
    return locked;
  });
  ok(res, { installation: presentInstallation(installation) });
});

devicesRouter.get('/current', requireAuth, async (req, res) => {
  ok(res, { installation: presentInstallation(await currentInstallation(req)) });
});

devicesRouter.get('/eligibility', requireAuth, async (req, res) => {
  const installation = await currentInstallation(req);
  const result = await evaluateFreeCreditEligibility({ query }, installation);
  ok(res, { freeCredits: result });
});

// Play Integrity verification is added with the Google Play milestone (it uses the same
// service account). Until then the token is not trusted and nothing is stored.
devicesRouter.post('/attest', requireAuth, validate({ body: z.object({ integrityToken: z.string().min(1).max(20000) }) }), async (req, res) => {
  await currentInstallation(req);
  ok(res, { status: 'NOT_CONFIGURED', verified: false, serviceAccountPresent: config.googlePlay.hasServiceAccount });
});

export default devicesRouter;
