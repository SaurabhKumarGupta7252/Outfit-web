/**
 * Tests for admin service logic.
 *
 * These tests exercise the pure logic (tree building, path parsing)
 * without requiring a live database or Cloudinary credentials.
 *
 * Run:  npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Extracted logic under test ───────────────────────────────────────────────
// These mirror the exact algorithms in admin.service.js and categories.routes.js
// so we can unit-test them without mocking ESM imports.

function buildCategoryTree(rows) {
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

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function groupFilesBySubfolder(files) {
  const grouped = new Map();
  for (const file of files) {
    const parts = file.originalname.replace(/\\/g, '/').split('/').filter(Boolean);
    let subfolder = null;
    let fileName;
    if (parts.length >= 2) {
      subfolder = parts[0];
      fileName = parts[parts.length - 1];
    } else {
      fileName = parts[0] || file.originalname;
    }
    const key = subfolder || '__direct__';
    if (!grouped.has(key)) grouped.set(key, { subfolder, files: [] });
    grouped.get(key).files.push({ file, fileName });
  }
  return grouped;
}

function subCategorySlug(parentSlug, subfolderName) {
  return `${parentSlug}--${slugify(subfolderName)}`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildCategoryTree — parent counts', () => {
  it('parent template_count equals own + sum of children', () => {
    const rows = [
      { id: '1', name: 'Mens', slug: 'mens', parent_id: null, template_count: 0 },
      { id: '2', name: 'Casual', slug: 'mens--casual', parent_id: '1', template_count: 10 },
      { id: '3', name: 'Formal', slug: 'mens--formal', parent_id: '1', template_count: 5 },
    ];
    const tree = buildCategoryTree(rows);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].template_count, 15);
    assert.equal(tree[0].children.length, 2);
  });

  it('parent with own templates adds them to child totals', () => {
    const rows = [
      { id: '1', name: 'Mens', slug: 'mens', parent_id: null, template_count: 3 },
      { id: '2', name: 'Casual', slug: 'mens--casual', parent_id: '1', template_count: 7 },
    ];
    const tree = buildCategoryTree(rows);
    assert.equal(tree[0].template_count, 10);
  });

  it('parent with no children keeps own count', () => {
    const rows = [
      { id: '1', name: 'Solo', slug: 'solo', parent_id: null, template_count: 42 },
    ];
    const tree = buildCategoryTree(rows);
    assert.equal(tree[0].template_count, 42);
    assert.deepEqual(tree[0].children, []);
  });

  it('multiple parents each get their own children totals', () => {
    const rows = [
      { id: '1', name: 'Mens', slug: 'mens', parent_id: null, template_count: 0 },
      { id: '2', name: 'Womens', slug: 'womens', parent_id: null, template_count: 2 },
      { id: '3', name: 'Casual', slug: 'mens--casual', parent_id: '1', template_count: 10 },
      { id: '4', name: 'Dresses', slug: 'womens--dresses', parent_id: '2', template_count: 20 },
    ];
    const tree = buildCategoryTree(rows);
    assert.equal(tree.length, 2);
    assert.equal(tree[0].template_count, 10);
    assert.equal(tree[1].template_count, 22);
  });

  it('handles zero counts gracefully', () => {
    const rows = [
      { id: '1', name: 'Empty', slug: 'empty', parent_id: null, template_count: 0 },
      { id: '2', name: 'Also Empty', slug: 'empty--also', parent_id: '1', template_count: 0 },
    ];
    const tree = buildCategoryTree(rows);
    assert.equal(tree[0].template_count, 0);
  });
});

describe('groupFilesBySubfolder — folder-based subcategory uploads', () => {
  it('groups files with folder paths into subfolder buckets', () => {
    const files = [
      { originalname: 'Blazers/blazer1.jpg' },
      { originalname: 'Blazers/blazer2.jpg' },
      { originalname: 'Casual/shirt.png' },
    ];
    const grouped = groupFilesBySubfolder(files);
    assert.equal(grouped.size, 2);
    assert.equal(grouped.get('Blazers').subfolder, 'Blazers');
    assert.equal(grouped.get('Blazers').files.length, 2);
    assert.equal(grouped.get('Blazers').files[0].fileName, 'blazer1.jpg');
    assert.equal(grouped.get('Casual').subfolder, 'Casual');
    assert.equal(grouped.get('Casual').files.length, 1);
  });

  it('puts flat files in __direct__ bucket', () => {
    const files = [
      { originalname: 'shirt.jpg' },
      { originalname: 'pants.png' },
    ];
    const grouped = groupFilesBySubfolder(files);
    assert.equal(grouped.size, 1);
    assert.ok(grouped.has('__direct__'));
    assert.equal(grouped.get('__direct__').subfolder, null);
    assert.equal(grouped.get('__direct__').files.length, 2);
  });

  it('handles mixed flat and folder files', () => {
    const files = [
      { originalname: 'loose.jpg' },
      { originalname: 'Suits/suit1.jpg' },
    ];
    const grouped = groupFilesBySubfolder(files);
    assert.equal(grouped.size, 2);
    assert.ok(grouped.has('__direct__'));
    assert.ok(grouped.has('Suits'));
  });

  it('handles deeply nested paths', () => {
    const files = [{ originalname: 'Summer/Beach/bikini.jpg' }];
    const grouped = groupFilesBySubfolder(files);
    assert.equal(grouped.get('Summer').subfolder, 'Summer');
    assert.equal(grouped.get('Summer').files[0].fileName, 'bikini.jpg');
  });

  it('normalizes backslash paths (Windows)', () => {
    const files = [{ originalname: 'Formal\\jacket.jpg' }];
    const grouped = groupFilesBySubfolder(files);
    assert.equal(grouped.get('Formal').subfolder, 'Formal');
    assert.equal(grouped.get('Formal').files[0].fileName, 'jacket.jpg');
  });
});

describe('subCategorySlug — slug generation', () => {
  it('builds parent--child slug', () => {
    assert.equal(subCategorySlug('mens', 'Blazers'), 'mens--blazers');
  });

  it('slugifies special characters', () => {
    assert.equal(subCategorySlug('womens', 'Evening & Party'), 'womens--evening-party');
  });

  it('handles already-lowercase input', () => {
    assert.equal(subCategorySlug('mens', 'casual'), 'mens--casual');
  });
});

describe('manual subcategory upload (flat files)', () => {
  it('all flat files map to __direct__', () => {
    const files = [
      { originalname: 'a.jpg' },
      { originalname: 'b.png' },
      { originalname: 'c.webp' },
    ];
    const grouped = groupFilesBySubfolder(files);
    assert.equal(grouped.size, 1);
    assert.equal(grouped.get('__direct__').subfolder, null);
    assert.equal(grouped.get('__direct__').files.length, 3);
    assert.deepEqual(
      grouped.get('__direct__').files.map(f => f.fileName),
      ['a.jpg', 'b.png', 'c.webp'],
    );
  });
});
