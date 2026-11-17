import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { config } from './config/env.js';
import { db } from './db/index.js';
import { requestLogger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { globalLimiter } from './middleware/rate-limit.js';
import adminRouter from './modules/admin/admin.routes.js';
import authRouter from './modules/auth/auth.routes.js';
import categoriesRouter from './modules/categories/categories.routes.js';
import devicesRouter from './modules/devices/devices.routes.js';
import generationsRouter from './modules/generations/generations.routes.js';
import imagesRouter from './modules/images/images.routes.js';
import profileRouter from './modules/profile/profile.routes.js';
import storeRouter from './modules/store/store.routes.js';
import templateImagesRouter from './modules/template-images/template-images.routes.js';
import templatesRouter from './modules/templates/templates.routes.js';
import usersRouter from './modules/users/users.routes.js';
import walletRouter from './modules/wallet/wallet.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  const startedAt = Date.now();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: false, // allow admin panel inline scripts
  }));
  // Browsers are only allowed from the configured origins; the mobile app is not affected by CORS.
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : '*' }));
  app.use(requestLogger);

  // Liveness: confirms the process is running. Independent of external services.
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      message: 'Server is healthy',
    });
  });

  // Readiness includes PostgreSQL so traffic is only routed when the database is reachable.
  app.get('/ready', async (req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.status(200).json({ status: 'ready', database: 'connected' });
    } catch (error) {
      req.log.error({ err: error }, 'Database readiness check failed');
      res.status(503).json({ status: 'not_ready', database: 'unavailable' });
    }
  });

  // Serve admin web panel static files
  app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

  // Public privacy policy page (used for the Google Play listing).
  app.use('/privacy', express.static(path.join(__dirname, '..', 'public', 'privacy')));
  app.get('/privacy-policy', (_req, res) => res.redirect(301, '/privacy/'));

  // Increase JSON limit for bulk operations
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(globalLimiter);
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/devices', devicesRouter);
  api.use('/wallet', walletRouter);
  api.use('/categories', categoriesRouter);
  api.use('/templates', templatesRouter);
  api.use('/template-images', templateImagesRouter);
  api.use('/store', storeRouter);
  api.use('/profile', profileRouter);
  api.use('/images', imagesRouter);
  api.use('/generations', generationsRouter);
  api.use('/admin', adminRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
