import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/index.js';
import { validate } from '../../middleware/validate.js';
import { notFound } from '../../utils/errors.js';
import { offsetOf, pageMeta, paginationQuery } from '../../utils/pagination.js';
import { ok } from '../../utils/respond.js';
import { listTemplates, presentTemplate } from './templates.service.js';

export const garmentTypes = ['upper_body', 'lower_body', 'entire_outfit'];

const listQuery = z.object({
  ...paginationQuery,
  categoryId: z.string().uuid().optional(),
  includeChildren: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  featured: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  garmentType: z.enum(garmentTypes).optional(),
  search: z.string().trim().min(1).max(80).optional(),
});

const templatesRouter = Router();

templatesRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const { page, limit, ...filters } = req.valid.query;
  const result = await listTemplates(filters, limit, offsetOf({ page, limit }));
  ok(res, { templates: result.templates }, { meta: pageMeta({ page, limit }, result.total) });
});

templatesRouter.get('/:id', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, c.name AS category_name FROM templates t JOIN categories c ON c.id = t.category_id
      WHERE t.id = $1 AND t.is_active AND c.is_active`,
    [req.valid.params.id],
  );
  if (!rows[0]) throw notFound('Template not found.');
  ok(res, { template: presentTemplate(rows[0]) });
});

export default templatesRouter;
