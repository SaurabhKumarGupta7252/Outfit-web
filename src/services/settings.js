import { query } from '../db/index.js';

// Business settings live in app_settings so they can change without a deploy.
const defaults = {
  free_credits: { amount: 25 },
  generation_cost: { credits: 2 },
  free_grant_limits: { maxGrantsPerIpPerDay: 3 },
  generation_limits: { timeoutMinutes: 10, maxUploadBytes: 10 * 1024 * 1024 },
};

const cacheTtlMs = 30 * 1000;
let cache = { loadedAt: 0, values: {} };

export async function getSetting(key) {
  if (Date.now() - cache.loadedAt > cacheTtlMs) {
    const { rows } = await query('SELECT setting_key, setting_value FROM app_settings');
    cache = { loadedAt: Date.now(), values: Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value])) };
  }
  return { ...defaults[key], ...cache.values[key] };
}

export function clearSettingsCache() {
  cache = { loadedAt: 0, values: {} };
}
