import { Router } from 'express';
import { query } from '../../db/index.js';
import { config } from '../../config/env.js';
import { getSetting } from '../../services/settings.js';
import { ok } from '../../utils/respond.js';

const storeRouter = Router();

// Prices are intentionally absent: the app reads localized prices from Google Play Billing
// using these product IDs. The credit amount for a product always comes from this table.
storeRouter.get('/products', async (_req, res) => {
  const { rows } = await query(
    'SELECT product_id, package_name, credits, display_order FROM credit_packages WHERE is_active ORDER BY display_order',
  );
  ok(res, {
    products: rows.map((row) => ({
      productId: row.product_id,
      name: row.package_name,
      credits: row.credits,
      displayOrder: row.display_order,
    })),
  });
});

storeRouter.get('/config', async (_req, res) => {
  const [{ credits }, { amount }] = await Promise.all([getSetting('generation_cost'), getSetting('free_credits')]);
  ok(res, {
    provider: 'google_play',
    packageName: config.googlePlay.packageName,
    purchasesEnabled: config.googlePlay.hasServiceAccount && Boolean(config.googlePlay.packageName),
    guestPurchasesAllowed: false,
    generationCostCredits: credits,
    freeCreditsAmount: amount,
  });
});

export default storeRouter;
