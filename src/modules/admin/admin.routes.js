import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/index.js';
import { requireAdmin } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { offsetOf, pageMeta, paginationQuery } from '../../utils/pagination.js';
import { ok } from '../../utils/respond.js';
import { presentCategory } from '../categories/categories.routes.js';
import { garmentTypes } from '../templates/templates.routes.js';
import { presentTemplate } from '../templates/templates.service.js';
import { presentWallet } from '../wallet/wallet.service.js';
import { parseBulkUpload } from './admin.upload.js';
import { bulkUploadTemplates, getCategoryTree, getTemplatesForCategory, uploadTemplatesToCategory } from './admin.service.js';
import { storeBuffer } from '../images/images.service.js';

const idParams = z.object({ id: z.string().uuid() });
const httpsUrl = z.string().url().max(2048).startsWith('https://');

const categoryFields = {
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:--?[a-z0-9]+)*$/).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  imageUrl: z.string().max(2048).nullable().optional(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
  parentId: z.string().uuid().nullable().optional(),
};
const templateFields = {
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  previewImageUrl: httpsUrl.nullable().optional(),
  garmentImagePath: z.string().trim().min(1).max(2048).nullable().optional(),
  garmentType: z.enum(garmentTypes).optional(),
  isFeatured: z.boolean().optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
};

const columns = {
  name: 'name', slug: 'slug', description: 'description', imageUrl: 'image_url',
  displayOrder: 'display_order', isActive: 'is_active', categoryId: 'category_id',
  previewImageUrl: 'preview_image_url', garmentImagePath: 'garment_image_path',
  garmentType: 'garment_type', isFeatured: 'is_featured', parentId: 'parent_id',
};

function assignments(body) {
  const entries = Object.entries(body).filter(([, value]) => value !== undefined);
  if (!entries.length) throw badRequest('Nothing to update.');
  return { cols: entries.map(([key]) => columns[key]), values: entries.map(([, value]) => value) };
}

async function run(statement, params) {
  try {
    return await query(statement, params);
  } catch (error) {
    if (error.code === '23505') throw conflict('A record with this slug already exists.');
    if (error.code === '23503') throw badRequest('The referenced category does not exist.');
    throw error;
  }
}

const adminRouter = Router();
adminRouter.use(requireAdmin);

// ─── Categories ──────────────────────────────────────────────────────────────

adminRouter.post('/categories', validate({ body: z.object(categoryFields).strict() }), async (req, res) => {
  const { cols, values } = assignments(req.valid.body);
  const { rows } = await run(
    `INSERT INTO categories (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values,
  );
  ok(res, { category: presentCategory(rows[0]) }, { status: 201 });
});

adminRouter.patch('/categories/:id', validate({ params: idParams, body: z.object(categoryFields).partial().strict() }), async (req, res) => {
  const { cols, values } = assignments(req.valid.body);
  const { rows } = await run(
    `UPDATE categories SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...values],
  );
  if (!rows[0]) throw notFound('Category not found.');
  ok(res, { category: presentCategory(rows[0]) });
});

adminRouter.delete('/categories/:id', validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    'UPDATE categories SET is_active = false WHERE id = $1 RETURNING id',
    [req.valid.params.id],
  );
  if (!rows[0]) throw notFound('Category not found.');
  // Also deactivate child categories
  await query(
    'UPDATE categories SET is_active = false WHERE parent_id = $1',
    [req.valid.params.id],
  );
  ok(res, { deleted: true });
});

// Upload icon image for a category
adminRouter.post('/categories/:id/icon', validate({ params: idParams }), parseBulkUpload, async (req, res) => {
  const files = req.files;
  if (!files?.length) throw badRequest('No image file provided.');
  const file = files[0];

  const { rows: [cat] } = await query('SELECT id FROM categories WHERE id = $1 AND is_active', [req.valid.params.id]);
  if (!cat) throw notFound('Category not found.');

  const stored = await storeBuffer(file.buffer, 'category-icon');

  const { rows: [img] } = await query(
    `INSERT INTO template_images (template_id, category_id, public_id, format, bytes, mime_type, width, height, kind)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, 'preview')
     RETURNING id`,
    [req.valid.params.id, stored.public_id, stored.format, stored.bytes,
      file.mimetype, stored.width ?? null, stored.height ?? null],
  );

  const iconUrl = `/api/v1/template-images/${img.id}/content`;
  await query('UPDATE categories SET image_url = $1 WHERE id = $2', [iconUrl, req.valid.params.id]);

  ok(res, { imageUrl: iconUrl });
});

// ─── Templates ───────────────────────────────────────────────────────────────

adminRouter.get('/templates', validate({ query: z.object(paginationQuery) }), async (req, res) => {
  const page = req.valid.query;
  const [list, count] = await Promise.all([
    query(
      `SELECT t.*, c.name AS category_name FROM templates t JOIN categories c ON c.id = t.category_id
        ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
      [page.limit, offsetOf(page)],
    ),
    query('SELECT count(*)::int AS total FROM templates'),
  ]);
  ok(res, { templates: list.rows.map((row) => presentTemplate(row, { admin: true })) }, { meta: pageMeta(page, count.rows[0].total) });
});

adminRouter.post('/templates', validate({ body: z.object(templateFields).strict() }), async (req, res) => {
  const { cols, values } = assignments(req.valid.body);
  const { rows } = await run(
    `INSERT INTO templates (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values,
  );
  ok(res, { template: presentTemplate(rows[0], { admin: true }) }, { status: 201 });
});

adminRouter.patch('/templates/:id', validate({ params: idParams, body: z.object(templateFields).partial().strict() }), async (req, res) => {
  const { cols, values } = assignments(req.valid.body);
  const { rows } = await run(
    `UPDATE templates SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...values],
  );
  if (!rows[0]) throw notFound('Template not found.');
  ok(res, { template: presentTemplate(rows[0], { admin: true }) });
});

adminRouter.delete('/templates/:id', validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    'UPDATE templates SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id',
    [req.valid.params.id],
  );
  if (!rows[0]) throw notFound('Template not found.');
  ok(res, { deleted: true });
});

// ─── Bulk Upload ─────────────────────────────────────────────────────────────

adminRouter.post('/templates/bulk-upload', parseBulkUpload, async (req, res) => {
  if (!req.files || !req.files.length) {
    throw badRequest('No files uploaded. Use the "images" field with folder structure.');
  }
  // Override originalname with actual paths (browsers strip directories from filenames)
  if (req.body.paths) {
    try {
      const paths = JSON.parse(req.body.paths);
      req.files.forEach((f, i) => {
        if (paths[i]) f.originalname = paths[i];
      });
    } catch { /* ignore */ }
  }
  const result = await bulkUploadTemplates(req.files);
  ok(res, result, { status: 201 });
});

// ─── Category Tree (for admin panel) ─────────────────────────────────────────

adminRouter.get('/category-tree', async (_req, res) => {
  const tree = await getCategoryTree();
  ok(res, { categories: tree });
});

// ─── Category templates (for admin panel) ─────────────────────────────────────

adminRouter.get('/categories/:id/templates', validate({ params: idParams, query: z.object(paginationQuery) }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const result = await getTemplatesForCategory(req.valid.params.id, limit, offsetOf({ page, limit }));
  ok(res, result, { meta: pageMeta({ page, limit }, result.total) });
});

// ─── Upload templates to a specific category ─────────────────────────────────

adminRouter.post('/categories/:id/upload-templates', validate({ params: idParams }), parseBulkUpload, async (req, res) => {
  if (!req.files || !req.files.length) {
    throw badRequest('No files uploaded. Use the "images" field.');
  }
  // subfolder field = frontend grouped by subfolder and sends name explicitly
  const subfolder = req.body?.subfolder || null;
  const result = await uploadTemplatesToCategory(req.valid.params.id, req.files, subfolder);
  ok(res, result, { status: 201 });
});

// ─── Wallets ─────────────────────────────────────────────────────────────────

adminRouter.get('/wallets', validate({ query: z.object(paginationQuery) }), async (req, res) => {
  const page = req.valid.query;
  const [list, count] = await Promise.all([
    query(
      `SELECT w.*, u.email FROM wallets w LEFT JOIN users u ON u.id = w.user_id
        ORDER BY w.updated_at DESC LIMIT $1 OFFSET $2`,
      [page.limit, offsetOf(page)],
    ),
    query('SELECT count(*)::int AS total FROM wallets'),
  ]);
  ok(res, {
    wallets: list.rows.map((row) => ({ ...presentWallet(row), userId: row.user_id, email: row.email, guestSessionId: row.guest_session_id })),
  }, { meta: pageMeta(page, count.rows[0].total) });
});

// ─── Generations ─────────────────────────────────────────────────────────────

const generationsQuery = z.object({
  ...paginationQuery,
  status: z.enum(['PENDING', 'RESERVED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED']).optional(),
});

adminRouter.get('/generations', validate({ query: generationsQuery }), async (req, res) => {
  const { status, ...page } = req.valid.query;
  const params = status ? [status] : [];
  const filter = status ? 'WHERE g.status = $1' : '';
  const [list, count] = await Promise.all([
    query(
      `SELECT g.*, u.email, t.name AS template_name FROM generations g
         LEFT JOIN users u ON u.id = g.user_id JOIN templates t ON t.id = g.template_id
        ${filter} ORDER BY g.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.limit, offsetOf(page)],
    ),
    query(`SELECT count(*)::int AS total FROM generations g ${filter}`, params),
  ]);
  ok(res, {
    generations: list.rows.map((row) => ({
      id: row.id,
      status: row.status,
      userId: row.user_id,
      email: row.email,
      guestSessionId: row.guest_session_id,
      templateId: row.template_id,
      templateName: row.template_name,
      applicationCredits: row.application_credits,
      provider: row.provider,
      providerProjectId: row.provider_project_id,
      providerCredits: row.provider_credits,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      completedAt: row.completed_at,
    })),
  }, { meta: pageMeta(page, count.rows[0].total) });
});

export default adminRouter;
