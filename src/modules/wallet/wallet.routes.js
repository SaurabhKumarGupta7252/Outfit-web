import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/index.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { evaluateFreeCreditEligibility } from '../../services/device-eligibility.js';
import { getSetting } from '../../services/settings.js';
import { offsetOf, pageMeta, paginationQuery } from '../../utils/pagination.js';
import { ok } from '../../utils/respond.js';
import { getUsage, getWalletForPrincipal, presentTransaction, presentWallet } from './wallet.service.js';

const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get('/', async (req, res) => {
  ok(res, { wallet: presentWallet(await getWalletForPrincipal(req.auth)) });
});

walletRouter.get('/transactions', validate({ query: z.object(paginationQuery) }), async (req, res) => {
  const wallet = await getWalletForPrincipal(req.auth);
  const page = req.valid.query;
  const [list, count] = await Promise.all([
    query(
      'SELECT * FROM credit_transactions WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3',
      [wallet.id, page.limit, offsetOf(page)],
    ),
    query('SELECT count(*)::int AS total FROM credit_transactions WHERE wallet_id = $1', [wallet.id]),
  ]);
  ok(res, { transactions: list.rows.map(presentTransaction) }, { meta: pageMeta(page, count.rows[0].total) });
});

walletRouter.get('/usage', async (req, res) => {
  const wallet = await getWalletForPrincipal(req.auth);
  ok(res, { usage: await getUsage(wallet.id) });
});

async function guestInstallation(client, auth, lock) {
  const { rows } = await client.query(
    `SELECT d.* FROM device_installations d
       JOIN guest_sessions g ON g.installation_id = d.id
      WHERE g.id = $1 AND g.status = 'active' ${lock ? 'FOR UPDATE OF d' : ''}`,
    [auth.guestSessionId],
  );
  return rows[0] || null;
}

// Free credits belong to an installation and are claimed through its guest session.
// Registered accounts never receive a separate grant.
walletRouter.get('/eligibility', async (req, res) => {
  const { amount } = await getSetting('free_credits');
  if (req.auth.kind !== 'guest') {
    return ok(res, { eligible: false, reason: 'REGISTERED_ACCOUNT', amount });
  }
  const installation = await guestInstallation({ query }, req.auth, false);
  if (!installation) return ok(res, { eligible: false, reason: 'SESSION_EXPIRED', amount });
  ok(res, { ...(await evaluateFreeCreditEligibility({ query }, installation)), amount });
});

// Idempotent: calling it again after a successful claim returns granted=false and the same balance.
walletRouter.post('/claim-free', async (req, res) => {
  const { amount } = await getSetting('free_credits');
  if (req.auth.kind !== 'guest') {
    const wallet = await getWalletForPrincipal(req.auth);
    return ok(res, { granted: false, reason: 'REGISTERED_ACCOUNT', wallet: presentWallet(wallet) });
  }

  const result = await withTransaction(async (client) => {
    const wallet = await getWalletForPrincipal(req.auth, client);
    const installation = await guestInstallation(client, req.auth, true);
    const eligibility = await evaluateFreeCreditEligibility(client, installation);
    if (!eligibility.eligible) return { granted: false, reason: eligibility.reason, walletId: wallet.id };
    const { rows } = await client.query('SELECT fn_grant_free_credits($1, $2, $3) AS granted', [installation.id, wallet.id, amount]);
    return { granted: rows[0].granted, reason: rows[0].granted ? null : 'ALREADY_CLAIMED', walletId: wallet.id };
  });

  const { rows } = await query('SELECT * FROM wallets WHERE id = $1', [result.walletId]);
  ok(res, { granted: result.granted, reason: result.reason, amount, wallet: presentWallet(rows[0]) });
});

export default walletRouter;
