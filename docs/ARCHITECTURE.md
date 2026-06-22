# OARFlow — Architecture & Resell Guide

This document explains how OARFlow is built, the key design decisions, and how
to repackage it for additional companies.

## Stack

- **Runtime:** Node.js (ESM), Express. No build step.
- **Database:** Postgres via `pg` in production; `@electric-sql/pglite`
  (in-process Postgres) as a zero-setup fallback for local dev and tests. The
  data layer (`src/lib/db.js`) exposes one surface (`query`, `queryOne`,
  `withTx`, `exec`) over both. PGlite operations are serialized through a mutex
  because it is a single in-process connection.
- **Frontend:** Static HTML "shells" under `public/` that call JSON APIs under
  `/api`. A small client runtime (`public/assets/app/admin.js`, the `OF` global)
  provides the API client, auth guard, app shell/nav, and UI primitives
  (toasts, modals, drawers, formatting). The design system is a single
  token-driven stylesheet (`public/assets/app/app.css`).
- **Payments:** Stripe (Checkout for one-off invoice balances, Subscriptions for
  recurring plans). Fully optional.
- **Calendar:** Google Calendar via OAuth2 + REST. Fully optional.
- **Email:** provider abstraction — Mailgun (HTTP) → SMTP (nodemailer) → console
  outbox (dev). Every send is recorded in `email_outbox`.

## Multi-tenancy

Every domain table carries a `tenant_id`. A request resolves its tenant by:

- **Admin:** the logged-in user's `tenant_id` (sessions are tenant-scoped).
- **Public booking/pay:** a slug in the URL (`/book?t=<slug>`), or a subdomain
  mapped to a slug, falling back to `DEFAULT_TENANT_SLUG`.

Per-tenant configuration lives in `tenants.settings` (JSONB), deep-merged over
sane defaults (`src/lib/defaults.js`) so existing tenants automatically gain new
config keys. `config_version` bumps on every settings write.

## Data model (Postgres)

All money is integer **cents**. All timestamps are `TIMESTAMPTZ` (UTC); per-tenant
wall-clock conversions happen in `src/lib/dates.js`.

| Table | Purpose |
| --- | --- |
| `tenants` | Company record + `settings` JSONB + `invoice_seq` + `config_version`. |
| `admin_users`, `admin_sessions` | Tenant-scoped logins (PBKDF2), cookie sessions, optional TOTP. |
| `audit_log` | Admin action trail. |
| `service_types` | What a tenant sells: duration, price, deposit, `booking_mode`, color. |
| `line_item_presets` | Customizable preselected invoice lines. |
| `recurring_plans` | Plan templates (interval, price, included service, auto-schedule/invoice). |
| `blackouts`, `schedule_overrides` | Availability blocks and per-date hour/closure/capacity overrides. |
| `customers` | CRM record. |
| `appointments` | Scheduled/requested visits. `requested_slots` JSONB holds proposed times in request mode. |
| `invoices` | `line_items` JSONB + totals; `amount_paid` is derived from the ledger. |
| `financial_events` | Append-only money ledger (payments/refunds/adjustments), idempotent via `external_ref`. |
| `subscriptions` | Customer enrollments; snapshots plan terms; tracks `next_run_date`. |
| `follow_ups` | Follow-up instances (queue); rules live in `tenants.settings.followups`. |
| `email_templates` | Per-tenant overrides of the default templates. |
| `email_outbox` | Record of every email (and dev inbox). |

## Booking & availability

`src/lib/availability.js` is pure slot math. Given a tenant's weekly hours
(`settings.availability.hours`), slot length, per-slot capacity, schedule
overrides, blackouts, and the day's existing appointments, it computes bookable
slots with a `remaining` count and an `available` flag (also honoring lead time
and the booking window). There is intentionally **no technician selection** —
capacity models "how many crews can run at once."

The booking mode is per service (`service_types.booking_mode`), defaulting to the
tenant's `settings.booking.defaultMode`:

- **instant** → `POST /api/public/:slug/book` with a chosen `slot`. The slot is
  re-validated server-side (race-safe) and the appointment is `scheduled`.
- **request** → the customer submits up to `requestSlotCount` `requestedSlots`.
  The appointment is `requested`; staff confirm one slot from the Requests queue
  or the appointment drawer, which schedules it and emails the customer.

## Invoicing (the revamp)

Design goals, implemented:

- **Fully customizable balance.** `invoices.line_items` is a freely-edited JSONB
  array, seeded from `line_item_presets`. Staff add presets and/or custom lines,
  set quantities and amounts, mark lines taxable, apply a discount and tax rate.
  Totals are computed in `src/lib/invoices.js`.
- **No pre-appointment reminders.** There is no balance-reminder cron anywhere.
  `/api/cron/daily` only runs recurring generation and follow-ups.
- **Sent only on demand.** An invoice is emailed solely via
  `POST /api/admin/invoices/:id/send` (a button in the dashboard).
- **Honest balance.** `amount_paid` is recomputed from the append-only
  `financial_events` ledger; webhook payments are idempotent via `external_ref`.
- **Pay your way.** Record cash/check/card manually, or the customer pays online
  at `/pay?invoice=<id>&token=<token>` via Stripe Checkout (when configured).

## Recurring revenue

`src/lib/recurring.js` enrolls a customer (snapshotting plan terms) and computes
`next_run_date`. `generateDueCycles` (run from the Recurring page or the daily
cron) creates each due cycle's appointment (if `auto_schedule`) and a **draft**
invoice (if `auto_invoice` and not Stripe-billed) — staff still choose when to
send. Stripe-backed subscriptions bill themselves; the webhook records them.
MRR is each active subscription's price normalized to a month; ARR is ×12.

## Follow-ups

Rules in `settings.followups.rules` (edited under Follow-ups → Automations) fire
`after_completion`: when a job is marked completed, `scheduleForCompletion`
materializes follow-up rows due `offsetDays` later. `processDueFollowUps` (daily
cron or the "Send due emails now" button) sends email follow-ups and marks them
done; task follow-ups wait in the queue for staff.

## Integrations

- **Stripe** — keys per tenant (Settings → Integrations) or platform env. Used
  for invoice Checkout sessions and subscription Checkout. Webhook at
  `/api/stripe/webhook`.
- **Google Calendar** — OAuth2 from Settings → Integrations. The refresh token
  is stored in `settings.integrations.google`; confirmed appointments are pushed
  to the chosen calendar (`src/lib/google_calendar.js`). Safe no-op until
  connected.

## Security notes

- Admin auth: PBKDF2 password hashing, hashed session tokens, optional TOTP.
- Public endpoints are rate-limited (`rate_limits`).
- Invoice/appointment public pages are guarded by unguessable access tokens.
- Set a strong `TOKEN_SECRET` and rotate the seeded admin password in production.
- Tenant Stripe credentials (secret key + webhook signing secret) are
  **encrypted at rest with AES-256-GCM** (`src/lib/crypto.js`,
  `encryptSecret`/`decryptSecret`) before being written to `settings` JSONB, and
  are **never returned to the client** — the settings API only exposes
  `stripeEnabled` and the publishable key. The encryption key comes from
  `ENCRYPTION_KEY` (recommended) or falls back to `TOKEN_SECRET`; set a
  dedicated value in production. For the highest assurance, move secrets to a
  managed secrets store / Stripe Connect instead of per-tenant keys.

## Reselling / white-labeling — checklist

1. **Create the tenant.** Insert a `tenants` row: `slug`, `name`, `timezone`,
   `currency`, and a `settings` object (start from `defaultTenantSettings()` and
   set `branding`). `invoice_seq` and `config_version` default fine.
2. **Create the owner login.** Insert an `admin_users` row for that `tenant_id`
   (hash the password with `src/lib/crypto.js#hashPassword`).
3. **Seed catalog (optional).** Add `service_types`, `line_item_presets`,
   `recurring_plans`, and `email_templates`, or let the owner create them in
   Settings.
4. **Point the booking site.** Use `/book?t=<slug>` or map a subdomain (e.g.
   `acme.yourdomain.com`) to the slug — `resolveTenant` already checks the
   subdomain.
5. **Branding.** The booking and pay pages read `settings.branding`
   (`primaryColor`, `logoText`, `tagline`) at runtime, so each tenant is themed
   automatically.
6. **Integrations.** Each tenant connects its own Stripe and Google Calendar in
   Settings → Integrations; those override platform env vars.

A small "create tenant" admin/onboarding flow is the natural next step to turn
this into a self-serve SaaS; the data model and tenant resolution already
support it.
