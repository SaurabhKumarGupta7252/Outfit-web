import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../utils/errors.js';
import { offsetOf, pageMeta, paginationQuery } from '../../utils/pagination.js';
import { ok } from '../../utils/respond.js';
import { getWalletForPrincipal } from '../wallet/wallet.service.js';
import * as images from './images.service.js';
import { parseImageUpload } from './images.upload.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({ ...paginationQuery, kind: z.enum(['upload', 'result']).default('upload') });

const imagesRouter = Router();
imagesRouter.use(requireAuth);

async function upload(req, res) {
  if (!req.file) throw new AppError(400, 'VALIDATION_ERROR', 'Attach an image using the "image" form field.');
  // Confirms a guest session is still active before storing anything for it.
  await getWalletForPrincipal(req.auth);
  const image = await images.createUpload(req.auth, req.file);
  ok(res, { image: images.presentImage(image) }, { status: 201 });
}

imagesRouter.post('/upload', parseImageUpload, upload);
imagesRouter.post('/', parseImageUpload, upload);

imagesRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const { kind, ...page } = req.valid.query;
  const result = await images.listOwnedImages(req.auth, kind, page.limit, offsetOf(page));
  ok(res, { images: result.images.map(images.presentImage) }, { meta: pageMeta(page, result.total) });
});

// Metadata plus a short-lived signed URL the app can load directly.
imagesRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const image = await images.findOwnedImage(req.auth, req.valid.params.id);
  ok(res, { image: { ...images.presentImage(image), signedUrl: images.signedUrl(image) } });
});

// Streams the bytes through the API after the ownership check.
imagesRouter.get('/:id/content', validate({ params: idParams }), async (req, res) => {
  const image = await images.findOwnedImage(req.auth, req.valid.params.id);
  const content = await images.fetchImageBytes(image);
  res.set({
    'Content-Type': content.contentType,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.status(200).send(content.body);
});

imagesRouter.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await images.deleteOwnedImage(req.auth, req.valid.params.id);
  ok(res, { deleted: true });
});

export default imagesRouter;
