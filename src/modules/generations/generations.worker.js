import { query } from '../../db/index.js';
import { config } from '../../config/env.js';
import { logger } from '../../logger.js';
import * as magicHour from '../../services/magic-hour.js';
import { getSetting } from '../../services/settings.js';
import { destroyStored, fetchImageBytes, saveImage, sniffImageType } from '../images/images.service.js';

// Background processing for generations. All state lives in the database, so after a crash
// or restart the worker continues from the stored provider project id instead of submitting
// the job again.
//
//   RESERVED   -> submit(): upload both images to Magic Hour, create the job, store its id
//   SUBMITTED  -> poll():   read the job status until it finishes
//   PROCESSING -> poll()
//
// A row is "claimed" with poll_locked_until so two workers never handle it at once.

const maxGarmentBytes = 15 * 1024 * 1024;

async function refund(id, code, detail) {
  const { rows } = await query('SELECT fn_refund_generation($1, $2, $3) AS refunded', [id, code, detail ?? null]);
  if (rows[0].refunded) logger.warn({ generationId: id, code, detail }, 'Generation failed; credits refunded');
  return rows[0].refunded;
}

async function fetchGarment(path) {
  if (!/^https:\/\//i.test(path)) throw new Error('Template garment image must be an https URL.');
  const response = await fetch(path, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Garment image responded with ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxGarmentBytes) throw new Error('Garment image is too large.');
  return body;
}

function requireType(buffer, label) {
  const type = sniffImageType(buffer);
  if (!type) throw new Error(`${label} is not a JPEG, PNG or WebP image.`);
  return type;
}

function submitFailureCode(error) {
  if (!(error instanceof magicHour.MagicHourError)) return 'PROVIDER_ERROR';
  if (error.uncertain) return 'PROVIDER_SUBMIT_UNCERTAIN';
  if (error.status === 401 || error.status === 402 || error.code === 'not_configured') return 'PROVIDER_UNAVAILABLE';
  if (error.status === 400 || error.status === 422) return 'PROVIDER_REJECTED';
  return 'PROVIDER_ERROR';
}

async function submit(id) {
  const { rows: [generation] } = await query(
    `UPDATE generations SET poll_locked_until = now() + interval '5 minutes'
      WHERE id = $1 AND status = 'RESERVED' AND provider_project_id IS NULL
        AND (poll_locked_until IS NULL OR poll_locked_until < now())
      RETURNING *`,
    [id],
  );
  if (!generation) return;

  let personPath;
  let garmentPath;
  let garmentType;
  try {
    const { rows: [template] } = await query('SELECT garment_image_path, garment_type FROM templates WHERE id = $1', [generation.template_id]);
    const { rows: [image] } = await query('SELECT * FROM images WHERE id = $1 AND deleted_at IS NULL', [generation.uploaded_image_id]);
    if (!template?.garment_image_path || !image) throw new Error('Template or photo is no longer available.');
    garmentType = template.garment_type;

    const [person, garment] = await Promise.all([fetchImageBytes(image), fetchGarment(template.garment_image_path)]);
    [personPath, garmentPath] = await Promise.all([
      magicHour.uploadImage(person.body, requireType(person.body, 'Photo').extension),
      magicHour.uploadImage(garment, requireType(garment, 'Garment image').extension),
    ]);
  } catch (error) {
    // Nothing has been submitted yet, so failing here is safe.
    const code = error instanceof magicHour.MagicHourError && (error.status === 401 || error.status === 402 || error.code === 'not_configured')
      ? 'PROVIDER_UNAVAILABLE' : 'PREPARATION_FAILED';
    await refund(id, code, error.message);
    return;
  }

  let project;
  try {
    project = await magicHour.createClothesChange({
      personFilePath: personPath,
      garmentFilePath: garmentPath,
      garmentType,
      name: `generation-${id}`,
    });
  } catch (error) {
    // The create call is never repeated automatically. If Magic Hour may have accepted it
    // (timeout, dropped connection, 5xx) the user is refunded and the job name above lets
    // the generation be matched in the Magic Hour dashboard.
    const code = submitFailureCode(error);
    if (code === 'PROVIDER_SUBMIT_UNCERTAIN' || code === 'PROVIDER_UNAVAILABLE') {
      logger.error({ generationId: id, code, status: error.status, providerCode: error.code }, 'Magic Hour submission problem needs attention');
    }
    await refund(id, code, `${error.code || ''} ${error.message}`.trim());
    return;
  }

  try {
    await query(
      `UPDATE generations
          SET status = 'SUBMITTED', provider_project_id = $2, provider_credits = $3,
              submitted_at = now(), updated_at = now(), poll_locked_until = NULL
        WHERE id = $1`,
      [id, project.id, project.creditsCharged],
    );
  } catch (error) {
    logger.error({ generationId: id, providerProjectId: project.id, err: error }, 'Could not store Magic Hour project id');
  }
}

async function complete(generation, project) {
  const url = project.downloads[0]?.url;
  if (!url) return refund(generation.id, 'PROVIDER_NO_OUTPUT', 'Completed without a download URL.');

  // Provider URLs expire, so the result is copied into our own private storage.
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Result download responded with ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  const type = requireType(body, 'Result');

  // Read the owner again: the guest may have registered while the job was running.
  const { rows: [current] } = await query('SELECT user_id, guest_session_id FROM generations WHERE id = $1', [generation.id]);
  const image = await saveImage(body, { userId: current.user_id, guestSessionId: current.guest_session_id }, 'result', type.mime);

  const { rows } = await query('SELECT fn_commit_generation($1, $2, $3) AS committed', [generation.id, image.id, project.creditsCharged]);
  if (!rows[0].committed) {
    await query('UPDATE images SET deleted_at = now() WHERE id = $1', [image.id]);
    await destroyStored(image.public_id);
  }
}

async function poll(generation, timeoutMinutes) {
  const ageMinutes = (Date.now() - new Date(generation.submitted_at || generation.created_at).getTime()) / 60000;
  const timedOut = ageMinutes > timeoutMinutes;

  let project;
  try {
    project = await magicHour.getImageProject(generation.provider_project_id);
  } catch (error) {
    logger.warn({ generationId: generation.id, providerCode: error.code }, 'Magic Hour status check failed');
    if (timedOut) await refund(generation.id, 'PROVIDER_TIMEOUT', 'Status could not be read before the time limit.');
    return;
  }

  if (project.status === 'complete') {
    try {
      await complete(generation, project);
    } catch (error) {
      logger.warn({ generationId: generation.id, err: error }, 'Could not store generation result yet');
      if (timedOut) await refund(generation.id, 'PROVIDER_NO_OUTPUT', error.message);
    }
    return;
  }
  if (project.status === 'error') {
    await refund(generation.id, 'PROVIDER_ERROR', `${project.error?.code || ''} ${project.error?.message || ''}`.trim());
    return;
  }
  if (project.status === 'canceled') {
    await refund(generation.id, 'PROVIDER_CANCELED', 'Canceled at the provider.');
    return;
  }
  if (timedOut) {
    await refund(generation.id, 'PROVIDER_TIMEOUT', `Still ${project.status} after ${timeoutMinutes} minutes.`);
    return;
  }
  if (project.status === 'rendering' && generation.status === 'SUBMITTED') {
    await query(`UPDATE generations SET status = 'PROCESSING', updated_at = now() WHERE id = $1 AND status = 'SUBMITTED'`, [generation.id]);
  }
}

let ticking = false;

export async function runWorkerOnce() {
  if (ticking) return;
  ticking = true;
  try {
    const { timeoutMinutes } = await getSetting('generation_limits');

    const { rows: open } = await query(
      `UPDATE generations SET poll_locked_until = now() + interval '2 minutes'
        WHERE id IN (
          SELECT id FROM generations
           WHERE status IN ('SUBMITTED', 'PROCESSING')
             AND (poll_locked_until IS NULL OR poll_locked_until < now())
           ORDER BY updated_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
    );
    for (const generation of open) {
      try {
        await poll(generation, timeoutMinutes);
      } catch (error) {
        logger.error({ generationId: generation.id, err: error }, 'Generation poll failed');
      } finally {
        await query(
          `UPDATE generations SET poll_locked_until = NULL WHERE id = $1 AND status IN ('SUBMITTED', 'PROCESSING')`,
          [generation.id],
        ).catch(() => {});
      }
    }

    // Reservations that never reached Magic Hour (for example the server stopped mid-submit).
    const { rows: stale } = await query(
      `SELECT id FROM generations
        WHERE status = 'RESERVED' AND created_at < now() - interval '6 minutes'
          AND (poll_locked_until IS NULL OR poll_locked_until < now())
        LIMIT 20`,
    );
    for (const { id } of stale) await refund(id, 'SUBMIT_INTERRUPTED', 'Reservation was never submitted.');
  } catch (error) {
    logger.error({ err: error }, 'Generation worker tick failed');
  } finally {
    ticking = false;
  }
}

export function kickGeneration(id) {
  setImmediate(() => {
    submit(id).catch((error) => logger.error({ generationId: id, err: error }, 'Generation submit crashed'));
  });
}

export function startGenerationWorker() {
  const timer = setInterval(runWorkerOnce, config.magicHour.pollIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
