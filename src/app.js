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

import stripeWebhookRouter from './routes/stripe_webhook.js';
import publicRouter from './routes/public.js';
import payRouter from './routes/pay.js';
import quotesRouter from './routes/quotes.js';
import saveCardRouter from './routes/save_card.js';
import reviewsPublicRouter from './routes/reviews_public.js';
import portalRouter from './routes/portal.js';
import googleOAuthRouter from './routes/google_oauth.js';
import cronRouter from './routes/cron.js';
import smsWebhookRouter from './routes/sms_webhook.js';
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
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // Stripe webhook needs the raw body for signature verification — mount BEFORE JSON parser.
  app.use('/api/stripe/webhook', express.raw({ type: '*/*' }), stripeWebhookRouter);

  // 25 MB to accommodate base64 photo/file uploads (job photos, e-signatures,
  // field PWA). JSON-only; all routes are auth-guarded.
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (req, res) => res.json({ ok: true, env: config.env, time: new Date().toISOString() }));

  // --- JSON APIs ----------------------------------------------------------
  app.use('/api/admin', adminApiRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/pay', payRouter);
  app.use('/api/quotes', quotesRouter);
  app.use('/api/save-card', saveCardRouter);
  app.use('/api/reviews', reviewsPublicRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/integrations/google', googleOAuthRouter);
  app.use('/api/webhooks/sms', smsWebhookRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/cron', cronRouter);
  // Only expose the Inngest serve endpoint when configured (prod). In dev the
  // in-process fallback runs workflows, so the endpoint isn't needed.
  if (inngestConfigured()) app.use('/api/inngest', inngestRouter);

  // --- Static assets + marketing site (served from /public) ---------------
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

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
