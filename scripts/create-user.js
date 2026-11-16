// Usage: npm run create-user -- someone@example.com 'Password123' ["Display Name"]
// Creates a user with a hashed password. If the email already exists, nothing is changed.
import { pool, query } from '../src/db/index.js';
import { hashPassword } from '../src/security/password.js';

const email = (process.argv[2] || '').trim().toLowerCase();
const password = process.argv[3] || '';
const displayName = (process.argv[4] || '').trim() || null;

if (!email || !password) {
  console.error('Usage: npm run create-user -- <email> <password> [display name]');
  process.exit(1);
}

try {
  const { rows: [existing] } = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    console.log(`User ${email} already exists. Nothing changed.`);
  } else {
    const passwordHash = await hashPassword(password);
    await query(
      `INSERT INTO users (email, password, display_name, email_verified) VALUES ($1, $2, $3, true)`,
      [email, passwordHash, displayName],
    );
    console.log(`Created user ${email}.`);
  }
} finally {
  await pool.end();
}
