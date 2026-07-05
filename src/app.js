// Builds and exports the Express application. `server.js` runs it locally;
// `api/index.js` exports it for serverless (Vercel) deployment.
//
// Architecture: the admin suite, public booking flow, and pay-invoice page are
// static HTML "shells" under /public that fetch data from JSON APIs under /api.
// No build step — fast to ship and easy to resell/white-label.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, inngestConfigured } from './config.js';
import { serverError } from './lib/http.js';
import { checkConfig } from './lib/preflight.js';

import stripeWebhookRouter from './routes/stripe_webhook.js';
import publicRouter from './routes/public.js';
import payRouter from './routes/pay.js';
import quotesRouter from './routes/quotes.js';
import apiV1Router from './routes/api_v1.js';
import saveCardRouter from './routes/save_card.js';
import reviewsPublicRouter from './routes/reviews_public.js';
import portalRouter from './routes/portal.js';
import fieldRouter from './routes/field.js';
import documentsPublicRouter from './routes/documents_public.js';
import devicesPublicRouter from './routes/devices_public.js';
import googleOAuthRouter from './routes/google_oauth.js';
import cronRouter from './routes/cron.js';
import smsWebhookRouter from './routes/sms_webhook.js';
import voiceWebhookRouter from './routes/voice_webhook.js';
import filesRouter from './routes/files.js';
import inngestRouter from './routes/inngest.js';
import adminApiRouter from './routes/admin/index.js';
import './inngest/index.js'; // register background workflows (also used by the dev fallback)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendShell(res, relPath) {
  const file = path.join(PUBLIC_DIR, relPath);
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.status(404).type('html').send('<h1>404</h1>');
}

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // --- Security headers (defense in depth; also covers non-Vercel hosting) ---
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (config.isProduction) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    // CSP is opt-in (set CONTENT_SECURITY_POLICY) so a misconfigured policy can
    // never break a launch. A tested allowlist value ships in docs/DEPLOY_VERCEL.md.
    if (process.env.CONTENT_SECURITY_POLICY) res.set('Content-Security-Policy', process.env.CONTENT_SECURITY_POLICY);
    next();
  });

  // Keep app/tool pages (booking, pay, portal, admin, …) out of search engines.
  // Only the marketing site should be indexable; these pages are thin shells or
  // token-gated and would only dilute search results (or expose the admin login).
  const NOINDEX_PREFIXES = ['/admin', '/book', '/pay', '/quote', '/save-card', '/review', '/portal', '/field', '/document', '/device'];
  app.use((req, res, next) => {
    if (NOINDEX_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    next();
  });

  // Log production-critical config issues once per cold start (never throws).
  if (config.isProduction) {
    try {
      const pf = checkConfig();
      if (!pf.ok) console.warn('[preflight] PRODUCTION CONFIG ISSUES:', pf.critical.map((c) => c.id).join(', '), '— run `npm run doctor` for details.');
    } catch { /* preflight is best-effort */ }
  }

  // Fail CLOSED on insecure crypto in production: a default TOKEN_SECRET or a
  // missing ENCRYPTION_KEY means tokens/secrets aren't safe, so refuse to serve
  // anything but /api/health until it's fixed (overridable with ALLOW_INSECURE_PROD=1).
  const insecureProd = config.isProduction && !process.env.ALLOW_INSECURE_PROD
    && (config.tokenSecret === 'dev-insecure-token-secret-change-me' || !config.encryptionKey || config.encryptionKey.length < 32);
  if (insecureProd) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') return next();
      res.status(503).json({ ok: false, error: 'Service not configured: set TOKEN_SECRET and ENCRYPTION_KEY. See docs/DEPLOY_VERCEL.md.' });
    });
  }

  // Stripe webhook needs the raw body for signature verification — mount BEFORE JSON parser.
  app.use('/api/stripe/webhook', express.raw({ type: '*/*' }), stripeWebhookRouter);

  // 25 MB to accommodate base64 photo/file uploads (job photos, e-signatures,
  // field PWA). JSON-only; all routes are auth-guarded.
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Liveness/readiness for uptime monitors + deploy gates. Pings the DB; returns
  // 503 if the database is unreachable. No secrets, no auth.
  app.get('/api/health', async (req, res) => {
    let db = 'down';
    try { const { query } = await import('./lib/db.js'); await query('SELECT 1'); db = 'up'; } catch { db = 'down'; }
    res.status(db === 'up' ? 200 : 503).json({ ok: db === 'up', env: config.env, db, time: new Date().toISOString() });
  });

  // --- JSON APIs ----------------------------------------------------------
  app.use('/api/admin', adminApiRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/pay', payRouter);
  app.use('/api/quotes', quotesRouter);
  app.use('/api/v1', apiV1Router);
  app.use('/api/save-card', saveCardRouter);
  app.use('/api/reviews', reviewsPublicRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/field', fieldRouter);
  app.use('/api/documents', documentsPublicRouter);
  app.use('/api/devices', devicesPublicRouter);
  app.use('/api/integrations/google', googleOAuthRouter);
  app.use('/api/webhooks/sms', smsWebhookRouter);
  app.use('/api/webhooks/voice', voiceWebhookRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/cron', cronRouter);
  // Only expose the Inngest serve endpoint when configured (prod). In dev the
  // in-process fallback runs workflows, so the endpoint isn't needed.
  if (inngestConfigured()) app.use('/api/inngest', inngestRouter);

  // --- Static assets + marketing site (served from /public) ---------------
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/img/favicon.svg'));
  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    },
  }));

  // --- HTML shell fallbacks for deep links --------------------------------
  // Admin deep links (e.g. /admin/customers?id=5) resolve to section shells via
  // express.static; anything unmatched under /admin falls back to the admin app.
  app.get(/^\/admin(\/.*)?$/, (req, res) => sendShell(res, 'admin/index.html'));
  app.get(/^\/book(\/.*)?$/, (req, res) => sendShell(res, 'book/index.html'));
  app.get(/^\/pay(\/.*)?$/, (req, res) => sendShell(res, 'pay/index.html'));
  app.get(/^\/quote(\/.*)?$/, (req, res) => sendShell(res, 'quote/index.html'));
  app.get(/^\/save-card(\/.*)?$/, (req, res) => sendShell(res, 'save-card/index.html'));
  app.get(/^\/review(\/.*)?$/, (req, res) => sendShell(res, 'review/index.html'));
  app.get(/^\/portal(\/.*)?$/, (req, res) => sendShell(res, 'portal/index.html'));
  app.get(/^\/field\/?$/, (req, res) => sendShell(res, 'field/index.html'));
  app.get(/^\/document(\/.*)?$/, (req, res) => sendShell(res, 'document/index.html'));
  app.get(/^\/device(\/.*)?$/, (req, res) => sendShell(res, 'device/index.html'));

  // 404
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found.' });
    const f = path.join(PUBLIC_DIR, '404.html');
    if (fs.existsSync(f)) return res.status(404).sendFile(f);
    res.status(404).type('html').send('<h1>404 — Not found</h1>');
  });

  // Error handler
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return next(err);
    serverError(res, err, `${req.method} ${req.path}`);
  });

  return app;
}

export default createApp;
