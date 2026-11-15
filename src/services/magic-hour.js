import { config } from '../config/env.js';

// Thin client for the Magic Hour REST API. Only endpoints and fields from the official
// reference are used:
//   POST /v1/files/upload-urls        -> items[].{upload_url, expires_at, file_path}
//   PUT  <upload_url>                 -> raw file bytes
//   POST /v1/ai-clothes-changer       -> { id, credits_charged }
//   GET  /v1/image-projects/{id}      -> { status, downloads[], error, credits_charged, ... }
// Docs: https://docs.magichour.ai/api-reference/image-projects/ai-clothes-changer

export class MagicHourError extends Error {
  // uncertain = the request may have reached Magic Hour even though we got no usable answer
  // (timeout, dropped connection, 5xx). Such a request must not be blindly repeated.
  constructor(message, { status = null, code = null, uncertain = false } = {}) {
    super(message);
    this.name = 'MagicHourError';
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
  }
}

function apiKey() {
  const key = process.env.MAGIC_HOUR_API_KEY;
  if (!key) throw new MagicHourError('MAGIC_HOUR_API_KEY is not set.', { code: 'not_configured' });
  return key;
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(`${config.magicHour.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey()}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.magicHour.requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof MagicHourError) throw error;
    throw new MagicHourError(`Magic Hour request failed: ${error.name}`, { code: 'network_error', uncertain: true });
  }

  const text = await response.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

  if (!response.ok) {
    throw new MagicHourError(json?.message || `Magic Hour responded with ${response.status}.`, {
      status: response.status,
      code: json?.code || `http_${response.status}`,
      uncertain: response.status >= 500,
    });
  }
  return json;
}

// Uploads one image and returns the file_path to use in a create call.
export async function uploadImage(buffer, extension) {
  const result = await request('POST', '/v1/files/upload-urls', { items: [{ type: 'image', extension }] });
  const item = result?.items?.[0];
  if (!item?.upload_url || !item?.file_path) {
    throw new MagicHourError('Magic Hour did not return an upload URL.', { code: 'bad_upload_response' });
  }

  let put;
  try {
    put = await fetch(item.upload_url, { method: 'PUT', body: buffer, signal: AbortSignal.timeout(60000) });
  } catch (error) {
    throw new MagicHourError(`Upload to Magic Hour failed: ${error.name}`, { code: 'upload_failed' });
  }
  if (!put.ok) {
    throw new MagicHourError(`Upload to Magic Hour failed with ${put.status}.`, { status: put.status, code: 'upload_failed' });
  }
  return item.file_path;
}

export async function createClothesChange({ personFilePath, garmentFilePath, garmentType, name }) {
  const result = await request('POST', '/v1/ai-clothes-changer', {
    name,
    assets: {
      person_file_path: personFilePath,
      garment_file_path: garmentFilePath,
      garment_type: garmentType,
    },
  });
  if (!result?.id) {
    throw new MagicHourError('Magic Hour did not return a project id.', { code: 'bad_create_response', uncertain: true });
  }
  return { id: result.id, creditsCharged: Number.isInteger(result.credits_charged) ? result.credits_charged : null };
}

// status is one of: draft, queued, rendering, complete, error, canceled.
export async function getImageProject(id) {
  const result = await request('GET', `/v1/image-projects/${encodeURIComponent(id)}`);
  return {
    status: result.status,
    downloads: Array.isArray(result.downloads) ? result.downloads : [],
    error: result.error || null,
    creditsCharged: Number.isInteger(result.credits_charged) ? result.credits_charged : null,
  };
}
