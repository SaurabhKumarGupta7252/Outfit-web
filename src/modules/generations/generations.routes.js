import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/require-auth.js';
import { generationLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../utils/errors.js';
import { offsetOf, pageMeta, paginationQuery } from '../../utils/pagination.js';
import { ok } from '../../utils/respond.js';
import * as generations from './generations.service.js';

const idParams = z.object({ id: z.string().uuid() });
const createBody = z.object({ templateId: z.string().uuid(), imageId: z.coerce.number().int().positive() });
const listQuery = z.object({
  ...paginationQuery,
  status: z.enum(['PENDING', 'RESERVED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED']).optional(),
});

// The app creates one random key per "Generate" tap and reuses it for every retry of that request.
function idempotencyKey(req) {
  const key = (req.get('idempotency-key') || '').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (16-128 letters, digits, "-" or "_").');
  }
  return key;
}

const generationsRouter = Router();
generationsRouter.use(requireAuth);

generationsRouter.post('/', generationLimiter, validate({ body: createBody }), async (req, res) => {
  const result = await generations.createGeneration(req.auth, req.valid.body, idempotencyKey(req));
  ok(res, { generation: result.generation }, { status: result.created ? 202 : 200 });
});

generationsRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const { status, ...page } = req.valid.query;
  const result = await generations.listOwnedGenerations(req.auth, { status }, page.limit, offsetOf(page));
  ok(res, { generations: result.generations }, { meta: pageMeta(page, result.total) });
});

generationsRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  ok(res, { generation: await generations.getGenerationDetail(req.auth, req.valid.params.id) });
});

// Small payload for polling while the progress screen is open.
generationsRouter.get('/:id/status', validate({ params: idParams }), async (req, res) => {
  const generation = await generations.getGenerationDetail(req.auth, req.valid.params.id);
  ok(res, {
    id: generation.id,
    status: generation.status,
    isFinal: generation.isFinal,
    output: generation.output,
    error: generation.error,
  });
});

generationsRouter.post('/:id/retry', generationLimiter, validate({ params: idParams }), async (req, res) => {
  const result = await generations.retryGeneration(req.auth, req.valid.params.id, idempotencyKey(req));
  ok(res, { generation: result.generation }, { status: result.created ? 202 : 200 });
});

export default generationsRouter;
