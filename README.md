# OARFlow

A modern booking, scheduling, invoicing, and recurring-revenue platform for
home-service businesses — built first for **Pasternack Pest Management**, and
architected as a **multi-tenant SaaS** you can repackage and resell to other
companies.

Think GorillaDesk, but lighter, faster, and yours. Customers book a visit
online (or request times you confirm), you run the day from a premium admin
dashboard, send fully customizable invoices on demand, and grow recurring
revenue with subscription plans — with optional Stripe payments and Google
Calendar sync, all configured from the admin suite.

> Note: the `CBSFLiveTest copy/` folder is the original fishing-charter app,
> kept only as a build reference. It is git-ignored and not part of OARFlow.

---

## Highlights

- **Online booking, two modes (per service).**
  - *Instant* — the customer picks an open time slot and it's confirmed immediately.
  - *Request* — the customer proposes up to N preferred times and your team confirms one.
  - No technician selection — just **time slots** with a configurable per-slot capacity (how many crews can run at once). Everything is set in the admin suite.
- **Premium admin suite** — dashboard, schedule, appointments, a request queue, customers (CRM), invoices, recurring plans, and a follow-up queue.
- **Reimagined invoicing.** Build a balance from **customizable preset line items** plus custom lines, tax, and discounts. **No pre-appointment balance reminders, ever.** An invoice/balance goes out **only when you click Send** from the dashboard. Record cash/check/card payments or collect online via Stripe. An append-only ledger keeps the math honest.
- **Recurring revenue.** Define plans (quarterly, monthly, annual, or custom), enroll customers, and auto-generate each cycle's visit and draft invoice. MRR/ARR on the dashboard. Optional Stripe subscriptions.
- **Follow-ups.** Rules (e.g. "3 days after a job, email a check-in") auto-create follow-ups when a job completes; a queue lets staff act, snooze, or send.
- **Integrations, configured in-app.** Stripe (payments + subscriptions) and Google Calendar (event sync) connect from Settings → Integrations. Email via Mailgun, SMTP, or a dev console outbox.
- **Multi-tenant from day one.** Every record is tenant-scoped, so adding and white-labeling new companies is trivial.
- **No build step.** Vanilla HTML/CSS/JS frontend + an Express API. Runs anywhere Node runs; deploys to Vercel, Render, Railway, Fly, or a VM.

---

## Quick start (zero setup)

```bash
npm install
npm run setup     # runs migrations + seeds the demo tenant
npm start         # http://localhost:3000
```

The zero-setup PGlite seed also creates 20 map-ready appointments for the next Monday through Friday. Run `npm run seed:appointments` whenever you want to add or refresh that rolling example schedule in another development database. Production mode refuses the command unless you explicitly append `-- --allow-production`.

With no `DATABASE_URL`, OARFlow uses an in-process Postgres (PGlite) stored in
`./.pglite` — nothing else to install.

- Booking site: <http://localhost:3000/book>
- Admin: <http://localhost:3000/admin>  → **admin / changeme123**
- A customer marketing site is served at `/`.

Run the end-to-end test suite anytime:

```bash
npm run smoke     # boots an in-memory app and exercises every major flow
```

---

## Production (Neon + Vercel)

1. Create a Postgres database (Neon, Vercel Postgres, Supabase, RDS…).
2. Set `DATABASE_URL` (and the secrets below) as environment variables.
3. Run migrations once: `npm run migrate` (then optionally `npm run seed`).
4. Deploy. `vercel.json` routes everything to the Express app in `api/index.js`
   and registers a daily cron at `/api/cron/daily`.

OARFlow auto-detects the backend: if `DATABASE_URL` is set it uses real Postgres
(`pg`); otherwise it falls back to PGlite. No code changes between dev and prod.

### Environment variables

See `.env.example` for the full annotated list. The important ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (e.g. Neon). Omit for local PGlite. |
| `BASE_URL` | Public URL, used in email + payment links. |
| `TOKEN_SECRET` | Secret for signing public access tokens. **Change in prod.** |
| `ADMIN_BOOTSTRAP_USERNAME` / `_PASSWORD` | First admin login created by the seed. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PUBLISHABLE_KEY` | Payments + subscriptions (optional; can also be set per-tenant in Settings). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google Calendar OAuth (optional). |
| `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` or `SMTP_*` | Email delivery (optional; dev logs to a console outbox). |
| `CRON_KEY` / `CRON_SECRET` | Protects `/api/cron/daily`. |

Integrations also work **per-tenant**: keys entered in Settings → Integrations
override the platform env vars, so each resold company can use its own Stripe
account and Google Calendar.

### Stripe webhook

Point a Stripe webhook at `POST /api/stripe/webhook` (events:
`checkout.session.completed`). It records invoice payments and activates
subscriptions idempotently.

---

## How it fits together

```
public/                Static frontend (no build step)
  index.html …         Marketing site (Pasternack)
  book/                Customer booking flow (both modes)
  pay/                 Public pay-invoice page
  admin/               Admin suite (HTML shells + admin.js framework)
  assets/app/          Design system (app.css) + client runtime (admin.js)
src/
  app.js               Express app wiring
  config.js            All env access
  lib/                 db, tenants, auth, availability, invoices, recurring,
                       follow_ups, email, stripe, google_calendar, …
  routes/              public, pay, stripe_webhook, google_oauth, cron,
                       admin/* (auth, dashboard, appointments, customers,
                       invoices, plans, follow-ups, settings)
db/migrations/         Numbered SQL migrations
scripts/               migrate.js, seed.js, smoke.js
api/index.js           Vercel serverless entry (exports the Express app)
server.js              Local / long-running entry
```

Data is tenant-scoped Postgres. Money is stored as integer cents. Tunable
configuration lives in `tenants.settings` (JSONB) and is editable in the admin
suite. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model,
the invoicing design, and a guide to reselling/white-labeling.

---

## Reselling it

OARFlow is multi-tenant out of the box. To onboard another company: insert a new
`tenants` row (slug, name, timezone, branding), create its admin user, and point
its booking page at `/book?t=<slug>` (or map a subdomain to the slug). Each
tenant gets its own services, availability, invoice presets, email templates,
plans, follow-up rules, and integration credentials. Details and a checklist are
in `docs/ARCHITECTURE.md`.

---

## License

Proprietary — © Pasternack Pest Management / OARFlow. All rights reserved.
