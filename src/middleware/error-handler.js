import { fail } from '../utils/respond.js';
import { logger } from '../logger.js';

const statusCodes = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE',
};

export function notFoundHandler(_req, res) {
  fail(res, 404, 'NOT_FOUND', 'Route not found.');
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return fail(res, status, status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', err.message);
  }
  if (err.type === 'entity.parse.failed') {
    return fail(res, 400, 'BAD_REQUEST', 'Request body must contain valid JSON.');
  }

  const status = err.statusCode || err.status || 500;
  if (status >= 500) {
    (req.log || logger).error({ err }, 'Unhandled error');
    return fail(res, status, statusCodes[status] || 'INTERNAL_ERROR', status === 500 ? 'Internal server error.' : err.message);
  }
  const code = err.name === 'AppError' ? err.code : statusCodes[status] || 'BAD_REQUEST';
  fail(res, status, code, err.message, err.details);
}
