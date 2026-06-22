// Central runtime configuration. All environment access funnels through here
// so the rest of the codebase never reads process.env directly.
import 'dotenv/config';

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const NODE_ENV = process.env.NODE_ENV || 'development';

export const config = {
  env: NODE_ENV,
  isProduction: NODE_ENV === 'production',
  port: Number(process.env.PORT || 3000),

  // Public base URL used to build links in emails / payment redirects.
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),

  // The slug of the tenant served at the site root (single-tenant deployments).
  defaultTenantSlug: process.env.DEFAULT_TENANT_SLUG || 'pasternack',

  // --- Database -----------------------------------------------------------
  // When DATABASE_URL is present we use real Postgres (Neon/Vercel/Supabase/local).
  // Otherwise we fall back to an in-process Postgres (PGlite) for zero-setup dev.
  databaseUrl: process.env.DATABASE_URL || '',
  // Where PGlite persists data when DATABASE_URL is absent. Use 'memory://' for ephemeral.
  pgliteDir: process.env.PGLITE_DIR || './.pglite',

  // --- Sessions / security ------------------------------------------------
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'oarflow_session',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  // Secret used to sign public access tokens (invoice pay links, booking mgmt).
  tokenSecret: process.env.TOKEN_SECRET || 'dev-insecure-token-secret-change-me',
  // Key for encrypting sensitive tenant credentials at rest (Stripe secrets).
  // Falls back to TOKEN_SECRET; set a dedicated 32+ char value in production.
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  totpIssuer: process.env.TOTP_ISSUER || 'OARFlow',

  // Bootstrap credentials for the first admin user of the default tenant.
  bootstrap: {
    username: process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin',
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD || 'changeme123',
  },

  // --- Stripe -------------------------------------------------------------
  // Platform-level fallback keys. Tenants can also store their own keys in settings.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  },

  // --- Google Calendar (OAuth2) ------------------------------------------
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    // Redirect URI registered in the Google Cloud console.
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  },

  // --- Email --------------------------------------------------------------
  // Provider resolution order: mailgun -> smtp -> console (dev outbox).
  email: {
    from: process.env.EMAIL_FROM || 'OARFlow <no-reply@oarflow.app>',
    replyTo: process.env.EMAIL_REPLY_TO || '',
    mailgun: {
      apiKey: process.env.MAILGUN_API_KEY || '',
      domain: process.env.MAILGUN_DOMAIN || '',
      baseUrl: process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net',
    },
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  // Secret required to invoke cron endpoints (X-Cron-Key header or ?key=).
  cronKey: process.env.CRON_KEY || 'dev-cron-key',

  // Platform-level Twilio (optional fallback for "platform-managed" SMS mode).
  // Most tenants BYO their own creds in Settings → Integrations.
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },

  // Inngest (event-driven background jobs). When unset, OARFlow runs an
  // in-process fallback executor so everything works keyless in dev/demo.
  inngest: {
    eventKey: process.env.INNGEST_EVENT_KEY || '',
    signingKey: process.env.INNGEST_SIGNING_KEY || '',
  },
};

export function inngestConfigured() {
  return Boolean(config.inngest.eventKey && config.inngest.signingKey);
}

export function emailProviderName() {
  if (config.email.mailgun.apiKey && config.email.mailgun.domain) return 'mailgun';
  if (config.email.smtp.host) return 'smtp';
  return 'console';
}

export default config;
