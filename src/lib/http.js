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
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parse "12.50" / 12.5 dollars into integer cents. */
export function dollarsToCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Prefer Express's req.ip, which honors the configured `trust proxy` setting:
// when trust proxy is off (directly-exposed host) it returns the socket address
// and ignores the spoofable X-Forwarded-For header, so rate limits can't be
// bypassed. Falls back to the socket address.
export function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

// Coerce a user-supplied color to a safe #rgb/#rrggbb hex so it can never break
// out of a CSS/style string (stored-XSS guard). Returns the fallback otherwise.
export function hexColor(value, fallback = '#1f8a3d') {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}
