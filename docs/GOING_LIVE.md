# OARFlow — Going Live

Everything below works **keyless in dev/demo** (PGlite + console outbox + mock providers) and is **config-gated** in production: until you add credentials, the feature shows "not configured" instead of breaking. This guide is the wire-up checklist.

## Quick start

```bash
npm install
npm run seed          # creates the default tenant + admin (admin / changeme123)
npm run dev           # http://localhost:3000  (admin at /admin)
npm run smoke         # 157-check end-to-end suite (in-process, no setup)
```

Production: set `DATABASE_URL` (Neon/Supabase/RDS), run `npm run migrate` (25 migrations), set `TOKEN_SECRET` + `ENCRYPTION_KEY`, deploy `api/index.js` (Vercel) or run `server.js`.

## What's built

**Core** — multi-tenant white-label SaaS; time-slot **and** arrival-window booking (no technician selection on the public side); instant-book or request-up-to-N-slots modes; fully customizable invoicing sent **on demand** (no pre-appointment balance reminders); recurring plans/MRR; follow-ups; Google Calendar; premium SPA admin.

**Phase 1** — transactional SMS (confirmations/reminders/on-my-way); quotes/estimates with online clickwrap approval → convert to invoice; saved cards / charge-on-file; reporting v1 (7 reports + KPIs + CSV/print); reviews & NPS (auto-request after jobs, **no rating gating**); drag-and-drop calendar reschedule.

**Phase 2** — customer self-service portal (magic-link); document library + e-signature (typed + drawn); job photos/files; technicians + optional per-job assignment (still no public selection); technician field PWA (installable, offline shell, photos, signature, on-my-way); accounting events + CSV/IIF (QuickBooks Desktop) export, QBO-ready interface; route optimization + GPS map links.

**Phase 3** — pest compliance (chemical catalog, application records w/ EPA + applicator snapshot, service reports, state-report CSV export — never auto-submits); device/trap tracking with printable QR + scan-to-log inspections; **AI voice receptionist — SCAFFOLD ONLY** (data model, webhooks, intent payload, missed-call + handoff workflow, mock simulator; no live telephony); public API v1 + signed outbound webhooks (Zapier/Make); commission tracking (rules, accruals, payouts, CSV); multi-unit properties/units + floorplan diagrams.

## Integration wire-up

| Capability | How to turn it on | Dev fallback |
|---|---|---|
| Database | `DATABASE_URL` + `npm run migrate` | PGlite (in-process) |
| Email | `MAILGUN_*` or `SMTP_*` | console/DB outbox |
| Stripe (pay, subs, saved cards, charge-on-file) | Admin → Settings → Integrations (per-tenant, encrypted) or `STRIPE_*` env | simulated cards + "contact us to pay" |
| Stripe webhooks | point Stripe at `/api/stripe/webhook` (per-tenant secret) | n/a |
| SMS (Twilio) | Admin → Settings → Integrations → SMS (BYO per-tenant or platform `TWILIO_*`); set 10DLC brand/campaign | console SMS outbox |
| Google Calendar | `GOOGLE_CLIENT_*` then connect in Settings | off |
| File storage | `S3_*` / R2 / MinIO env | local disk |
| Background jobs | Inngest (`INNGEST_*`) | in-process runner + `/api/cron/daily` |
| Accounting | CSV/IIF export works now; live QBO sync implements the same `AccountingProvider` interface later | export only |
| Geocoding (route optimization) | Settings → Integrations → Geocoding (Google/Mapbox key) | multi-stop map links from raw addresses |
| Public API | Admin → Developer → create API key; base `…/api/v1`, `Authorization: Bearer <key>` | works in dev |
| Outbound webhooks | Admin → Developer → add endpoint + events; verify `X-OARFlow-Signature` (HMAC-SHA256) | delivers to any URL |
| AI voice receptionist | **scaffold only** — set provider/handoff/missed-call in Admin → Receptionist; "Simulate a call" exercises the pipeline | mock simulator |

## Public pages (token-guarded)

`/book` booking · `/pay` invoice · `/quote` estimate approval · `/save-card` hosted card capture · `/review` reviews · `/portal` customer portal · `/document` e-signature · `/device` QR device log · `/field` technician PWA.

## Admin sections

Dashboard · Schedule (day/week/month, DnD reschedule, route optimizer) · Requests · Appointments (crew, photos, materials, service report) · Messages · Receptionist (scaffold) · Compliance · Customers (cards, devices, properties/units) · Estimates · Invoices · Recurring · Reports · Commissions · Reviews · Documents · Developer · Settings.

## Security notes

Per-tenant secrets are AES-256-GCM encrypted at rest and never returned in API responses; Stripe key resolution fails closed; every query is tenant-scoped; public actions are token-guarded and ownership-checked; webhook deliveries are HMAC-signed with retries; accruals/deliveries are idempotent. Run `npm run smoke` after any change.
