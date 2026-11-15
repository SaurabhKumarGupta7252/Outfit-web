import { v2 as cloudinary } from 'cloudinary';
import { query } from '../../db/index.js';
import { AppError, conflict, notFound } from '../../utils/errors.js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

function assertCloudinaryConfigured() {
  const missing = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
    .filter((key) => !process.env[key]);
  if (missing.length) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', `Cloudinary is not configured. Set ${missing.join(', ')}.`);
  }
}

// The declared MIME type is not trusted; the file's own signature decides the format.
export function sniffImageType(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: 'png', mime: 'image/png' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  return null;
}

// Stores bytes as a private ("authenticated") Cloudinary asset: it has no public URL.
export async function storeBuffer(buffer, kind) {
  assertCloudinaryConfigured();
  const base = process.env.CLOUDINARY_FOLDER || 'outfit-api';
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: `${base}/${kind === 'result' ? 'results' : 'uploads'}`,
      resource_type: 'image',
      type: 'authenticated',
    }, (error, uploaded) => (error ? reject(error) : resolve(uploaded)));
    stream.end(buffer);
  });
}

export async function destroyStored(publicId) {
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', type: 'authenticated', invalidate: true }).catch(() => {});
}

// owner = { userId, guestSessionId, installationId }
export async function saveImage(buffer, owner, kind, mime) {
  const stored = await storeBuffer(buffer, kind);
  try {
    const { rows } = await query(
      `INSERT INTO images (user_id, guest_session_id, installation_id, public_id, format, bytes, kind, mime_type, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [owner.userId ?? null, owner.userId ? null : owner.guestSessionId ?? null, owner.installationId ?? null,
        stored.public_id, stored.format, stored.bytes, kind, mime ?? `image/${stored.format}`, stored.width ?? null, stored.height ?? null],
    );
    return rows[0];
  } catch (error) {
    await destroyStored(stored.public_id);
    throw error;
  }
}

export async function createUpload(auth, file) {
  const type = sniffImageType(file.buffer);
  if (!type) throw new AppError(400, 'UNSUPPORTED_IMAGE', 'The file is not a valid JPEG, PNG or WebP image.');
  return saveImage(file.buffer, auth, 'upload', type.mime);
}

// A user owns rows with their user_id. A guest owns rows of their session that have not
// been moved to an account.
export function ownerClause(auth, alias, paramIndex) {
  return auth.kind === 'user'
    ? { sql: `${alias}.user_id = $${paramIndex}`, value: auth.userId }
    : { sql: `${alias}.guest_session_id = $${paramIndex} AND ${alias}.user_id IS NULL`, value: auth.guestSessionId };
}

export async function findOwnedImage(auth, imageId) {
  const owner = ownerClause(auth, 'i', 2);
  const { rows } = await query(
    `SELECT i.* FROM images i WHERE i.id = $1 AND ${owner.sql} AND i.deleted_at IS NULL`,
    [imageId, owner.value],
  );
  if (!rows[0]) throw notFound('Image not found.');
  return rows[0];
}

export async function listOwnedImages(auth, kind, limit, offset) {
  const owner = ownerClause(auth, 'i', 1);
  const [list, count] = await Promise.all([
    query(
      `SELECT i.* FROM images i WHERE ${owner.sql} AND i.kind = $2 AND i.deleted_at IS NULL
        ORDER BY i.created_at DESC LIMIT $3 OFFSET $4`,
      [owner.value, kind, limit, offset],
    ),
    query(`SELECT count(*)::int AS total FROM images i WHERE ${owner.sql} AND i.kind = $2 AND i.deleted_at IS NULL`, [owner.value, kind]),
  ]);
  return { images: list.rows, total: count.rows[0].total };
}

export function signedUrl(image, seconds = 300) {
  assertCloudinaryConfigured();
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  return {
    url: cloudinary.utils.private_download_url(image.public_id, image.format, {
      resource_type: 'image', type: 'authenticated', expires_at: expiresAt,
    }),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export async function fetchImageBytes(image) {
  const response = await fetch(signedUrl(image, 60).url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new AppError(502, 'STORAGE_ERROR', 'Unable to retrieve image from storage.');
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || image.mime_type || `image/${image.format}`,
  };
}

export async function deleteOwnedImage(auth, imageId) {
  const image = await findOwnedImage(auth, imageId);
  const { rows } = await query(
    `SELECT 1 FROM generations WHERE uploaded_image_id = $1 AND status IN ('RESERVED', 'SUBMITTED', 'PROCESSING') LIMIT 1`,
    [image.id],
  );
  if (rows[0]) throw conflict('This photo is being used by a generation in progress.', 'IMAGE_IN_USE');
  await query('UPDATE images SET deleted_at = now() WHERE id = $1', [image.id]);
  await destroyStored(image.public_id);
}

export function presentImage(image) {
  return {
    id: image.id,
    kind: image.kind,
    format: image.format,
    mimeType: image.mime_type,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    contentUrl: `/api/v1/images/${image.id}/content`,
    createdAt: image.created_at,
  };
}
