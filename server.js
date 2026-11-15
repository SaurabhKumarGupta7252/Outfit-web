import { config } from './src/config/env.js';
import { createApp } from './src/app.js';
import { pool } from './src/db/index.js';
import { logger } from './src/logger.js';
import { startGenerationWorker } from './src/modules/generations/generations.worker.js';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`Outfit API listening on http://localhost:${config.port}`);
});
const stopWorker = startGenerationWorker();
if (!config.magicHour.configured) logger.warn('MAGIC_HOUR_API_KEY is not set; outfit generation is disabled.');

function shutdown() {
  stopWorker();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
