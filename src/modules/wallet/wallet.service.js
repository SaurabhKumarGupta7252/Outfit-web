import { query } from '../../db/index.js';
import { unauthorized } from '../../utils/errors.js';

export function presentWallet(wallet) {
  return {
    id: wallet.id,
    ownerType: wallet.owner_type,
    freeBalance: wallet.free_balance,
    purchasedBalance: wallet.purchased_balance,
    totalCredits: wallet.free_balance + wallet.purchased_balance,
    updatedAt: wallet.updated_at,
  };
}

export async function ensureUserWallet(client, userId) {
  await client.query(
    `INSERT INTO wallets (owner_type, user_id) VALUES ('user', $1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const { rows } = await client.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  return rows[0];
}

// Resolves the wallet from the verified token only. A guest wallet is usable only while its
// session is still active, so a linked (claimed) guest session cannot keep spending.
export async function getWalletForPrincipal(auth, client = { query }) {
  if (auth.kind === 'user') return ensureUserWallet(client, auth.userId);

  const { rows } = await client.query(
    `SELECT w.* FROM wallets w
       JOIN guest_sessions g ON g.id = w.guest_session_id
      WHERE g.id = $1 AND g.status = 'active'`,
    [auth.guestSessionId],
  );
  if (!rows[0]) throw unauthorized('This guest session is no longer active.', 'SESSION_EXPIRED');
  return rows[0];
}

export function presentTransaction(row) {
  return {
    id: row.id,
    type: row.transaction_type,
    source: row.credit_source,
    amount: row.amount,
    freeDelta: row.free_delta,
    purchasedDelta: row.purchased_delta,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    referenceId: row.reference_id,
    description: row.description,
    createdAt: row.created_at,
  };
}

export async function getUsage(walletId) {
  const { rows } = await query(
    `SELECT
       COALESCE(sum(amount) FILTER (WHERE credit_source = 'GENERATION_DEBIT'), 0)::int
         - COALESCE(sum(amount) FILTER (WHERE credit_source = 'GENERATION_REFUND'), 0)::int AS used,
       COALESCE(sum(amount) FILTER (WHERE credit_source = 'FREE_CREDIT'), 0)::int AS free_granted,
       COALESCE(sum(amount) FILTER (WHERE credit_source = 'CREDIT_PURCHASE'), 0)::int AS purchased,
       COALESCE(sum(amount) FILTER (WHERE credit_source = 'GENERATION_REFUND'), 0)::int AS refunded
     FROM credit_transactions WHERE wallet_id = $1`,
    [walletId],
  );
  return {
    totalCreditsUsed: rows[0].used,
    totalFreeCreditsGranted: rows[0].free_granted,
    totalCreditsPurchased: rows[0].purchased,
    totalCreditsRefunded: rows[0].refunded,
  };
}
