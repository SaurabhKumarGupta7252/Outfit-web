import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/index.js';
import { validate } from '../../middleware/validate.js';
import { notFound } from '../../utils/errors.js';
import { offsetOf, pageMeta, paginationQuery } from '../../utils/pagination.js';
import { ok } from '../../utils/respond.js';
import { listTemplates } from '../templates/templates.service.js';

export function presentCategory(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    imageUrl: row.image_url,
    parentId: row.parent_id ?? null,
    displayOrder: row.display_order,
    isActive: row.is_active,
    templateCount: row.template_count ?? undefined,
    children: row.children ?? undefined,
  };
}

const idParams = z.object({ id: z.string().uuid() });
const categoriesRouter = Router();

// Returns the full category tree: parent categories with nested children.
categoriesRouter.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT c.*, (SELECT count(*)::int FROM templates t WHERE t.category_id = c.id AND t.is_active) AS template_count
       FROM categories c WHERE c.is_active ORDER BY c.display_order, c.name`,
  );

  // Build tree: parents with embedded children
  // Parent template_count = own count + sum of children counts
  const parents = rows.filter((r) => !r.parent_id);
  const children = rows.filter((r) => r.parent_id);

  const tree = parents.map((p) => {
    const kids = children.filter((c) => c.parent_id === p.id);
    const childTotal = kids.reduce((sum, c) => sum + (c.template_count || 0), 0);
    return {
      ...p,
      template_count: (p.template_count || 0) + childTotal,
      children: kids,
    };
  });

  ok(res, { categories: tree.map((p) => ({
    ...presentCategory(p),
    children: p.children.map(presentCategory),
  })) });
});

categoriesRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, (SELECT count(*)::int FROM templates t WHERE t.category_id = c.id AND t.is_active) AS template_count
       FROM categories c WHERE c.id = $1 AND c.is_active`,
    [req.valid.params.id],
  );
  if (!rows[0]) throw notFound('Category not found.');
  ok(res, { category: presentCategory(rows[0]) });
});

categoriesRouter.get('/:id/templates', validate({ params: idParams, query: z.object(paginationQuery) }), async (req, res) => {
  const { rows } = await query('SELECT 1 FROM categories WHERE id = $1 AND is_active', [req.valid.params.id]);
  if (!rows[0]) throw notFound('Category not found.');
  const page = req.valid.query;
  const result = await listTemplates({ categoryId: req.valid.params.id }, page.limit, offsetOf(page));
  ok(res, { templates: result.templates }, { meta: pageMeta(page, result.total) });
});

export default categoriesRouter;
