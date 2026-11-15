import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/index.js';
import { requireUser } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { badRequest } from '../../utils/errors.js';
import { ok } from '../../utils/respond.js';
import { getUser, presentUser } from '../auth/auth.service.js';
import { getUsage, getWalletForPrincipal, presentWallet } from '../wallet/wallet.service.js';

const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  avatarUrl: z.string().url().max(2048).startsWith('https://').nullable().optional(),
}).strict();

const profileRouter = Router();
profileRouter.use(requireUser);

profileRouter.get('/', async (req, res) => {
  ok(res, { profile: presentUser(await getUser(req.auth.userId)) });
});

profileRouter.patch('/', validate({ body: patchSchema }), async (req, res) => {
  const { displayName, avatarUrl } = req.valid.body;
  if (displayName === undefined && avatarUrl === undefined) throw badRequest('Nothing to update.');
  const { rows } = await query(
    `UPDATE users
        SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
            avatar_url = CASE WHEN $4::boolean THEN $5 ELSE avatar_url END,
            updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [req.auth.userId, displayName !== undefined, displayName ?? null, avatarUrl !== undefined, avatarUrl ?? null],
  );
  ok(res, { profile: presentUser(rows[0]) });
});

profileRouter.get('/stats', async (req, res) => {
  const wallet = await getWalletForPrincipal(req.auth);
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE status = 'REFUNDED')::int AS failed
       FROM generations WHERE user_id = $1`,
    [req.auth.userId],
  );
  ok(res, { wallet: presentWallet(wallet), usage: await getUsage(wallet.id), generations: rows[0] });
});

export default profileRouter;
