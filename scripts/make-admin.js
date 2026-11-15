// Usage: npm run make-admin -- someone@example.com
import { pool, query } from '../src/db/index.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- <email>');
  process.exit(1);
}
try {
  const { rows } = await query(`UPDATE users SET role = 'admin', updated_at = now() WHERE email = $1 RETURNING id, email`, [email]);
  console.log(rows[0] ? `${rows[0].email} is now an admin.` : 'No user found with that email.');
} finally {
  await pool.end();
}
