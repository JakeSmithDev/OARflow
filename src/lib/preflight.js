// Production preflight. Pure config checks (no DB) shared by the `doctor` CLI,
// the health endpoint, and boot-time warnings. We NEVER throw at import/boot —
// on serverless that would 500 the whole app — we surface issues instead, and
// guard at the point of use (e.g. file uploads) where it matters.
import { config, emailProviderName, inngestConfigured } from '../config.js';

const DEFAULT_TOKEN = 'dev-insecure-token-secret-change-me';

/** Is durable object storage (S3/R2/MinIO) configured? */
export function objectStorageConfigured() {
  const s = config.storage.s3;
  return Boolean(s.bucket && s.accessKeyId && s.secretAccessKey);
}
/** Is a real Postgres (not the in-process PGlite) configured? */
export function realDatabaseConfigured() {
  return Boolean(config.databaseUrl);
}

/**
 * Evaluate go-live readiness. Returns { ok, critical[], warnings[], info{} }.
 * `critical` items must be fixed before serving real traffic in production.
 */
export function checkConfig({ assumeProduction } = {}) {
  const prod = assumeProduction ?? config.isProduction;
  const critical = []; const warnings = [];

  const add = (arr, id, message, fix) => arr.push({ id, message, fix });

  // Database — PGlite is in-process + filesystem-backed; unusable on serverless.
  if (!realDatabaseConfigured()) {
    (prod ? add.bind(null, critical) : add.bind(null, warnings))(
      'database', 'No DATABASE_URL — using in-process PGlite.', 'Set DATABASE_URL to a Neon/Postgres connection string and run `npm run migrate`.',
    );
  }

  // Object storage — local disk is ephemeral on Vercel; uploads would be lost.
  if (!objectStorageConfigured()) {
    (prod ? add.bind(null, critical) : add.bind(null, warnings))(
      'storage', 'No object storage (S3/R2) configured — using local disk.', 'Set S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (works with AWS S3, Cloudflare R2, MinIO).',
    );
  }

  // Secrets.
  if (config.tokenSecret === DEFAULT_TOKEN || config.tokenSecret.length < 24) {
    (prod ? add.bind(null, critical) : add.bind(null, warnings))(
      'token-secret', 'TOKEN_SECRET is the insecure default or too short.', 'Set TOKEN_SECRET to a long random string (32+ chars).',
    );
  }
  if (!config.encryptionKey || config.encryptionKey.length < 32) {
    (prod ? add.bind(null, critical) : add.bind(null, warnings))(
      'encryption-key', 'ENCRYPTION_KEY is unset/short (falls back to TOKEN_SECRET).', 'Set a dedicated 32+ char ENCRYPTION_KEY; rotating it invalidates stored tenant secrets.',
    );
  }
  if (config.bootstrap.password === 'changeme123') {
    (prod ? add.bind(null, critical) : add.bind(null, warnings))(
      'admin-password', 'Default admin bootstrap password (changeme123) in use.', 'Set ADMIN_BOOTSTRAP_PASSWORD before seeding, or change the admin password after first login.',
    );
  }
  if (config.cronKey === 'dev-cron-key' && !process.env.CRON_SECRET) {
    (prod ? add.bind(null, critical) : add.bind(null, warnings))(
      'cron-key', 'Cron endpoints use the default key and no CRON_SECRET.', 'Set CRON_KEY (or rely on Vercel CRON_SECRET) so /api/cron/daily is protected.',
    );
  }
  if (prod && /^http:\/\/localhost/.test(config.baseUrl)) {
    add(critical, 'base-url', 'BASE_URL is still localhost in production.', 'Set BASE_URL to your public https URL (used in email + payment links).');
  }
  if (prod && config.baseUrl.startsWith('http://')) {
    add(warnings, 'https', 'BASE_URL is not https.', 'Serve over https so secure cookies + Stripe redirects work.');
  }

  // Non-blocking notes.
  if (emailProviderName() === 'console') add(warnings, 'email', 'No email provider — emails go to the console/DB outbox.', 'Configure MAILGUN_* or SMTP_* to send real email.');
  if (!inngestConfigured()) add(warnings, 'inngest', 'Inngest not configured — background jobs run via Vercel Cron (/api/cron/daily) only.', 'Optional: set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY for managed retries/fan-out.');

  return {
    ok: critical.length === 0,
    critical,
    warnings,
    info: {
      env: config.env,
      database: realDatabaseConfigured() ? 'postgres' : 'pglite',
      storage: objectStorageConfigured() ? 's3' : 'local',
      email: emailProviderName(),
      inngest: inngestConfigured() ? 'configured' : 'in-process/cron',
      baseUrl: config.baseUrl,
      stripePlatform: Boolean(config.stripe.secretKey),
    },
  };
}

export default { checkConfig, objectStorageConfigured, realDatabaseConfigured };
