import { Router } from 'express';
import { z } from 'zod';
import { v2 as cloudinary } from 'cloudinary';
import { query } from '../../db/index.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { notFound, AppError } from '../../utils/errors.js';
import { ok } from '../../utils/respond.js';

const idParams = z.object({ id: z.string().uuid() });
const templateImagesRouter = Router();

// All template image routes require bearer auth
templateImagesRouter.use(requireAuth);

// Get image metadata
templateImagesRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM template_images WHERE id = $1',
    [req.valid.params.id],
  );
  if (!rows[0]) throw notFound('Template image not found.');
  ok(res, {
    image: {
      id: rows[0].id,
      templateId: rows[0].template_id,
      format: rows[0].format,
      mimeType: rows[0].mime_type,
      width: rows[0].width,
      height: rows[0].height,
      contentUrl: `/api/v1/template-images/${rows[0].id}/content`,
    },
  });
});

// Streams the image bytes — the only way to see the image; Cloudinary asset is private.
templateImagesRouter.get('/:id/content', validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM template_images WHERE id = $1',
    [req.valid.params.id],
  );
  if (!rows[0]) throw notFound('Template image not found.');

  const image = rows[0];
  const missing = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
    .filter((key) => !process.env[key]);
  if (missing.length) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Image storage is not configured.');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const url = cloudinary.utils.private_download_url(image.public_id, image.format, {
    resource_type: 'image',
    type: 'authenticated',
    expires_at: expiresAt,
  });

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new AppError(502, 'STORAGE_ERROR', 'Unable to retrieve template image.');
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.set({
    'Content-Type': image.mime_type || `image/${image.format}`,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.status(200).send(body);
});

export default templateImagesRouter;
