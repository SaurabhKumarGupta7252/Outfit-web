import { query } from '../../db/index.js';

// garment_image_path (the reference image sent to the AI provider) is internal and is never
// returned to the app; clients only see the preview image.
export function presentTemplate(row, { admin = false } = {}) {
  const template = {
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name ?? undefined,
    name: row.name,
    description: row.description,
    previewImageUrl: row.preview_image_url,
    garmentType: row.garment_type,
    isFeatured: row.is_featured,
    displayOrder: row.display_order,
  };
  if (admin) {
    template.garmentImagePath = row.garment_image_path;
    template.isActive = row.is_active;
    template.createdAt = row.created_at;
    template.updatedAt = row.updated_at;
  }
  return template;
}

export async function listTemplates({ categoryId, includeChildren, featured, garmentType, search }, limit, offset) {
  const where = ['t.is_active', 'c.is_active'];
  const params = [];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

  if (categoryId && includeChildren) {
    // Match templates in this category OR any direct child category.
    params.push(categoryId);
    const p = params.length;
    where.push(`(t.category_id = $${p} OR t.category_id IN (SELECT id FROM categories WHERE parent_id = $${p}))`);
  } else if (categoryId) {
    add('t.category_id = ?', categoryId);
  }
  if (featured !== undefined) add('t.is_featured = ?', featured);
  if (garmentType) add('t.garment_type = ?', garmentType);
  if (search) add("t.name ILIKE '%' || ? || '%'", search);

  const from = `FROM templates t JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')}`;
  const [list, count] = await Promise.all([
    query(
      `SELECT t.*, c.name AS category_name ${from}
        ORDER BY t.display_order, t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(`SELECT count(*)::int AS total ${from}`, params),
  ]);
  return { templates: list.rows.map((row) => presentTemplate(row)), total: count.rows[0].total };
}
