import 'dotenv/config';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function list(name) {
  return (process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int('PORT', 3000),
  appName: process.env.APP_NAME || 'AI Outfit Changer',
  corsOrigins: list('CORS_ORIGINS'),
  trustProxy: int('TRUST_PROXY', 0),
  databaseUrl: nodeEnv === 'test'
    ? process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    : process.env.DATABASE_URL,
  auth: {
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 60),
    passwordResetTtlMinutes: 30,
    googleClientIds: list('GOOGLE_OAUTH_CLIENT_IDS'),
  },
  googlePlay: {
    packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME || '',
    hasServiceAccount: Boolean(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON),
  },
  magicHour: {
    configured: Boolean(process.env.MAGIC_HOUR_API_KEY),
    baseUrl: (process.env.MAGIC_HOUR_BASE_URL || 'https://api.magichour.ai').replace(/\/+$/, ''),
    requestTimeoutMs: int('MAGIC_HOUR_REQUEST_TIMEOUT_MS', 30000),
    pollIntervalMs: int('GENERATION_POLL_INTERVAL_MS', 4000),
  },
};
