import { query } from '../../db/index.js';
import { config } from '../../config/env.js';
import { getSetting } from '../../services/settings.js';
import { AppError, conflict, notFound } from '../../utils/errors.js';
import { findOwnedImage, ownerClause, signedUrl } from '../images/images.service.js';
import { getWalletForPrincipal } from '../wallet/wallet.service.js';
import { kickGeneration } from './generations.worker.js';

// What the app shows for each stored error code. Provider details stay in the database.
const userMessages = {
  PREPARATION_FAILED: 'We could not prepare your photo. Your credits were returned.',
  PROVIDER_REJECTED: 'This photo could not be processed. Try a clear, full-body photo. Your credits were returned.',
  PROVIDER_ERROR: 'The outfit could not be created. Your credits were returned.',
  PROVIDER_CANCELED: 'The generation was cancelled. Your credits were returned.',
  PROVIDER_NO_OUTPUT: 'The outfit could not be created. Your credits were returned.',
  PROVIDER_TIMEOUT: 'This took too long and was stopped. Your credits were returned.',
  PROVIDER_UNAVAILABLE: 'Outfit generation is temporarily unavailable. Your credits were returned.',
  PROVIDER_SUBMIT_UNCERTAIN: 'We could not reach the generation service. Your credits were returned.',
  SUBMIT_INTERRUPTED: 'The generation was interrupted. Your credits were returned.',
};

const selectGeneration = `
  SELECT g.*, t.name AS template_name, t.preview_image_url AS template_preview_image_url,
         t.garment_type AS template_garment_type
    FROM generations g JOIN templates t ON t.id = g.template_id`;

export function presentGeneration(row, { withSignedUrl = false, outputImage = null } = {}) {
  const done = row.status === 'COMPLETED';
  const failed = row.status === 'REFUNDED' || row.status === 'FAILED';
  const generation = {
    id: row.id,
    status: row.status,
    isFinal: done || failed,
    template: {
      id: row.template_id,
      name: row.template_name,
      previewImageUrl: row.template_preview_image_url,
      garmentType: row.template_garment_type,
    },
    uploadedImageId: row.uploaded_image_id,
    creditsReserved: row.application_credits,
    creditsCharged: done ? row.application_credits : 0,
    creditsRefunded: row.status === 'REFUNDED' ? row.application_credits : 0,
    output: done && row.output_image_id
      ? { imageId: row.output_image_id, contentUrl: `/api/v1/images/${row.output_image_id}/content` }
      : null,
    error: failed
      ? { code: row.error_code, message: userMessages[row.error_code] || 'The outfit could not be created.' }
      : null,
    retryOf: row.retry_of,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
  if (withSignedUrl && generation.output && outputImage) generation.output.signedUrl = signedUrl(outputImage);
  return generation;
}

export async function findOwnedGeneration(auth, id) {
  const owner = ownerClause(auth, 'g', 2);
  const { rows } = await query(`${selectGeneration} WHERE g.id = $1 AND ${owner.sql}`, [id, owner.value]);
  if (!rows[0]) throw notFound('Generation not found.');
  return rows[0];
}

export async function getGenerationDetail(auth, id) {
  const row = await findOwnedGeneration(auth, id);
  let outputImage = null;
  if (row.status === 'COMPLETED' && row.output_image_id) {
    const { rows } = await query('SELECT * FROM images WHERE id = $1 AND deleted_at IS NULL', [row.output_image_id]);
    outputImage = rows[0] || null;
  }
  return presentGeneration(row, { withSignedUrl: true, outputImage });
}

export async function listOwnedGenerations(auth, { status }, limit, offset) {
  const owner = ownerClause(auth, 'g', 1);
  const params = [owner.value];
  let filter = '';
  if (status) { params.push(status); filter = ` AND g.status = $${params.length}`; }
  const [list, count] = await Promise.all([
    query(
      `${selectGeneration} WHERE ${owner.sql}${filter} ORDER BY g.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(`SELECT count(*)::int AS total FROM generations g WHERE ${owner.sql}${filter}`, params),
  ]);
  return { generations: list.rows.map((row) => presentGeneration(row)), total: count.rows[0].total };
}

// Validates everything first, then reserves the credits and creates the generation in one
// database call. The same Idempotency-Key always maps to the same generation, so a retried
// request, a double tap or an app restart can never charge twice.
export async function createGeneration(auth, { templateId, imageId }, idempotencyKey, retryOf = null) {
  if (!config.magicHour.configured) {
    throw new AppError(503, 'GENERATION_UNAVAILABLE', 'Outfit generation is not configured on the server.');
  }

  const { rows: [template] } = await query(
    `SELECT t.id, t.garment_image_path FROM templates t JOIN categories c ON c.id = t.category_id
      WHERE t.id = $1 AND t.is_active AND c.is_active`,
    [templateId],
  );
  if (!template) throw notFound('Template not found.');
  if (!template.garment_image_path) throw conflict('This template is not available yet.', 'TEMPLATE_UNAVAILABLE');

  const image = await findOwnedImage(auth, imageId);
  if (image.kind !== 'upload') throw new AppError(400, 'VALIDATION_ERROR', 'Choose one of your uploaded photos.');

  const wallet = await getWalletForPrincipal(auth);
  const { credits } = await getSetting('generation_cost');

  let result;
  try {
    ({ rows: [{ result }] } = await query(
      'SELECT fn_reserve_generation($1, $2, $3, $4, $5, $6, $7, $8) AS result',
      [wallet.id, auth.userId, auth.kind === 'guest' ? auth.guestSessionId : null, template.id, image.id, credits, idempotencyKey, retryOf],
    ));
  } catch (error) {
    if (String(error.message).includes('INSUFFICIENT_CREDITS')) {
      throw new AppError(402, 'INSUFFICIENT_CREDITS', `You need ${credits} credits to generate an outfit.`);
    }
    throw error;
  }

  if (result.created) kickGeneration(result.id);
  return { generation: await getGenerationDetail(auth, result.id), created: result.created };
}

// Retrying creates a new generation (and a new reservation) for the same photo and template.
export async function retryGeneration(auth, id, idempotencyKey) {
  const previous = await findOwnedGeneration(auth, id);
  if (!['REFUNDED', 'FAILED'].includes(previous.status)) {
    throw conflict('Only a failed generation can be retried.', 'GENERATION_NOT_RETRYABLE');
  }
  if (!previous.uploaded_image_id) throw conflict('The original photo is no longer available.', 'IMAGE_UNAVAILABLE');
  return createGeneration(auth, { templateId: previous.template_id, imageId: previous.uploaded_image_id }, idempotencyKey, previous.id);
}
