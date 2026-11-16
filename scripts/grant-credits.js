// Usage: npm run grant-credits -- someone@example.com 100 [tag]
// Adds credits to a user's wallet and records an ADMIN_ADJUSTMENT row in the ledger.
// Safe to re-run: the same email + amount + tag is granted only once (default tag: "initial").
import { pool } from '../src/db/index.js';

const email = (process.argv[2] || '').trim().toLowerCase();
const amount = Number.parseInt(process.argv[3], 10);
const tag = (process.argv[4] || 'initial').trim();

if (!email || !Number.isInteger(amount) || amount <= 0) {
  console.error('Usage: npm run grant-credits -- <email> <amount> [tag]');
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const { rows: [user] } = await client.query('SELECT id, email FROM users WHERE email = $1', [email]);
  if (!user) {
    await client.query('ROLLBACK');
    console.log('No user found with that email. Sign up in the app first.');
    process.exit(0);
  }

  const key = `admin-grant:${user.id}:${amount}:${tag}`;
  const { rows: [existing] } = await client.query('SELECT 1 FROM credit_transactions WHERE idempotency_key = $1', [key]);
  if (existing) {
    await client.query('ROLLBACK');
    console.log(`Already granted (${amount} credits, tag "${tag}") to ${user.email}. Nothing changed.`);
    process.exit(0);
  }

  await client.query(
    `INSERT INTO wallets (owner_type, user_id) VALUES ('user', $1) ON CONFLICT (user_id) DO NOTHING`,
    [user.id],
  );
  const { rows: [wallet] } = await client.query(
    'SELECT id, free_balance, purchased_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
    [user.id],
  );
  const before = wallet.free_balance + wallet.purchased_balance;

  await client.query(
    'UPDATE wallets SET free_balance = free_balance + $1, updated_at = now() WHERE id = $2',
    [amount, wallet.id],
  );
  await client.query(
    `INSERT INTO credit_transactions
       (wallet_id, transaction_type, credit_source, amount, free_delta, purchased_delta,
        balance_before, balance_after, reference_id, idempotency_key, description)
     VALUES ($1, 'CREDIT', 'ADMIN_ADJUSTMENT', $2, $2, 0, $3, $4, $5, $6, 'Admin credit grant')`,
    [wallet.id, amount, before, before + amount, `admin:${tag}`, key],
  );

  await client.query('COMMIT');
  console.log(`Granted ${amount} credits to ${user.email}. Balance: ${before} -> ${before + amount}.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
