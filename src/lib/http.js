// Small HTTP helpers shared across routes.
import crypto from 'node:crypto';

/** Wrap an async route handler so rejections flow to Express error middleware. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createRequestId() {
  return 'req_' + crypto.randomBytes(6).toString('hex');
}

export function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

export function badRequest(res, message = 'Invalid request.', extra = {}) {
  return sendError(res, 400, message, extra);
}

export function unauthorized(res, message = 'Not authorized.') {
  return sendError(res, 401, message);
}

export function notFound(res, message = 'Not found.') {
  return sendError(res, 404, message);
}

export function serverError(res, err, context = 'request') {
  const requestId = createRequestId();
  // eslint-disable-next-line no-console
  console.error(`[${context}] ${requestId}`, err);
  return res.status(500).json({ ok: false, error: 'Something went wrong.', request_id: requestId });
}

/** Coerce a value to a positive integer or return null. */
export function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse "12.50" / 12.5 dollars into integer cents. */
export function dollarsToCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}
