import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { config } from '../config/env.js';

const { Pool } = pg;

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is missing. Add it to your .env file.');
}

export const pool = new Pool({ connectionString: config.databaseUrl });
export const db = drizzle(pool, { schema });

export const query = (text, params) => pool.query(text, params);

// Runs fn inside one transaction on a dedicated connection. fn receives the pg client.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
