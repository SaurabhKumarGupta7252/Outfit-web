import path from 'path';
import { query, withTransaction } from '../../db/index.js';
import { storeBuffer, sniffImageType } from '../images/images.service.js';

/**
 * Processes a bulk upload of template images.
 * Each file's originalname carries the relative path: "GroupName/SubcategoryName/image.jpg".
 */
export async function bulkUploadTemplates(files) {
  const results = { created: 0, skipped: 0, errors: [] };

  const grouped = new Map();
  for (const file of files) {
    const relativePath = file.originalname;
    const parts = relativePath.replace(/\\/g, '/').split('/');

    let groupName, subcategoryName, fileName;
    if (parts.length >= 3) {
      groupName = parts[parts.length - 3];
      subcategoryName = parts[parts.length - 2];
      fileName = parts[parts.length - 1];
    } else if (parts.length === 2) {
      groupName = parts[0];
      subcategoryName = parts[0];
      fileName = parts[1];
    } else {
      groupName = 'Uncategorized';
      subcategoryName = 'Uncategorized';
      fileName = parts[0];
    }

    const key = `${groupName}/${subcategoryName}`;
    if (!grouped.has(key)) {
      grouped.set(key, { groupName, subcategoryName, files: [] });
    }
    grouped.get(key).files.push({ file, fileName });
  }

  for (const [, { groupName, subcategoryName, files: groupFiles }] of grouped) {
    try {
      const parentSlug = slugify(groupName);
      let { rows: [parent] } = await query(
        `SELECT id FROM categories WHERE slug = $1 AND parent_id IS NULL`,
        [parentSlug],
      );
      if (!parent) {
        ({ rows: [parent] } = await query(
          `INSERT INTO categories (name, slug, parent_id, display_order)
           VALUES ($1, $2, NULL, 0)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [groupName, parentSlug],
        ));
      }

      const subSlug = `${parentSlug}--${slugify(subcategoryName)}`;
      let { rows: [sub] } = await query(
        `SELECT id FROM categories WHERE slug = $1`,
        [subSlug],
      );
      if (!sub) {
        ({ rows: [sub] } = await query(
          `INSERT INTO categories (name, slug, parent_id, display_order)
           VALUES ($1, $2, $3, 0)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [subcategoryName, subSlug, parent.id],
        ));
      }

      for (const { file, fileName } of groupFiles) {
        try {
          const type = sniffImageType(file.buffer);
          if (!type) {
            results.errors.push(`${fileName}: unsupported image format`);
            results.skipped++;
            continue;
          }

          const stored = await storeBuffer(file.buffer, 'template');
          const templateName = path.parse(fileName).name.replace(/[-_]/g, ' ');
          const { rows: [template] } = await query(
            `INSERT INTO templates (category_id, name, garment_type, is_active, display_order)
             VALUES ($1, $2, 'entire_outfit', true, 0)
             RETURNING id`,
            [sub.id, templateName],
          );

          const { rows: [templateImage] } = await query(
            `INSERT INTO template_images (template_id, category_id, public_id, format, bytes, mime_type, width, height, kind)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'preview')
             RETURNING id`,
            [template.id, sub.id, stored.public_id, stored.format, stored.bytes,
              type.mime, stored.width ?? null, stored.height ?? null],
          );

          await query(
            `UPDATE templates SET preview_image_url = $1, updated_at = now() WHERE id = $2`,
            [`/api/v1/template-images/${templateImage.id}/content`, template.id],
          );

          results.created++;
        } catch (err) {
          results.errors.push(`${fileName}: ${err.message}`);
          results.skipped++;
        }
      }
    } catch (err) {
      results.errors.push(`${groupName}/${subcategoryName}: ${err.message}`);
    }
  }

  return results;
}


/**
 * Uploads templates to a specific category.
 * If subfolder name is provided, auto-creates that subcategory under categoryId.
 */
export async function uploadTemplatesToCategory(categoryId, files, subfolder = null) {
  const results = { created: 0, skipped: 0, errors: [] };

  const { rows: [cat] } = await query('SELECT id, name, slug, parent_id FROM categories WHERE id = $1 AND is_active', [categoryId]);
  if (!cat) {
    results.errors.push('Category not found or inactive');
    return results;
  }

  // If subfolder given, create/find subcategory under this category
  let targetId = categoryId;
  if (subfolder) {
    const parentSlug = cat.slug;
    const subSlug = `${parentSlug}--${slugify(subfolder)}`;
    let { rows: [existing] } = await query(
      'SELECT id FROM categories WHERE slug = $1 AND parent_id = $2',
      [subSlug, categoryId],
    );
    if (!existing) {
      ({ rows: [existing] } = await query(
        `INSERT INTO categories (name, slug, parent_id, display_order)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [subfolder, subSlug, categoryId],
      ));
    }
    targetId = existing.id;
  }

  for (const file of files) {
    const fileName = file.originalname;
    try {
      const type = sniffImageType(file.buffer);
      if (!type) {
        results.errors.push(`${fileName}: unsupported image format`);
        results.skipped++;
        continue;
      }

      const stored = await storeBuffer(file.buffer, 'template');
      const templateName = path.parse(fileName).name.replace(/[-_]/g, ' ');

      const { rows: [template] } = await query(
        `INSERT INTO templates (category_id, name, garment_type, is_active, display_order)
         VALUES ($1, $2, 'entire_outfit', true, 0)
         RETURNING id`,
        [targetId, templateName],
      );

      const { rows: [templateImage] } = await query(
        `INSERT INTO template_images (template_id, category_id, public_id, format, bytes, mime_type, width, height, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'preview')
         RETURNING id`,
        [template.id, targetId, stored.public_id, stored.format, stored.bytes,
          type.mime, stored.width ?? null, stored.height ?? null],
      );

      await query(
        `UPDATE templates SET preview_image_url = $1, updated_at = now() WHERE id = $2`,
        [`/api/v1/template-images/${templateImage.id}/content`, template.id],
      );

      results.created++;
    } catch (err) {
      results.errors.push(`${fileName}: ${err.message}`);
      results.skipped++;
    }
  }

  return results;
}


function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Returns category tree: parent categories with their children.
 * Parent template_count = own count + sum of children counts.
 */
export async function getCategoryTree() {
  const { rows } = await query(
    `SELECT c.*,
       (SELECT count(*)::int FROM templates t WHERE t.category_id = c.id AND t.is_active) AS template_count
     FROM categories c WHERE c.is_active ORDER BY c.display_order, c.name`,
  );

  const parents = rows.filter((r) => !r.parent_id);
  const children = rows.filter((r) => r.parent_id);

  return parents.map((p) => {
    const kids = children.filter((c) => c.parent_id === p.id);
    const childTotal = kids.reduce((sum, c) => sum + (c.template_count || 0), 0);
    return {
      ...p,
      template_count: (p.template_count || 0) + childTotal,
      children: kids,
    };
  });
}

/**
 * Returns templates for a given category with their images (paginated).
 */
export async function getTemplatesForCategory(categoryId, limit = 20, offset = 0) {
  const [list, count] = await Promise.all([
    query(
      `SELECT t.*, c.name AS category_name,
         (SELECT json_agg(json_build_object('id', ti.id, 'format', ti.format, 'kind', ti.kind))
          FROM template_images ti WHERE ti.template_id = t.id) AS images
       FROM templates t JOIN categories c ON c.id = t.category_id
       WHERE t.category_id = $1 AND t.is_active
       ORDER BY t.display_order, t.created_at DESC LIMIT $2 OFFSET $3`,
      [categoryId, limit, offset],
    ),
    query(
      `SELECT count(*)::int AS total FROM templates WHERE category_id = $1 AND is_active`,
      [categoryId],
    ),
  ]);
  return { templates: list.rows, total: count.rows[0].total };
}
