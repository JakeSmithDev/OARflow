# Prompt: "Onboard a New Company to OARFlow" Runbook

Paste **everything below the horizontal rule** into ChatGPT Pro (enable web browsing / deep research). The block in `=== GROUND TRUTH ===` is copied from the OARFlow codebase — it is what makes the report accurate, since ChatGPT cannot see the repo. Update any value there if the code changes.

---

# ROLE

You are a senior platform/integrations engineer writing an internal **onboarding runbook** for OARFlow, a multi-tenant booking/scheduling/invoicing SaaS for home-service businesses. The reader is a developer (me). Your runbook must be detailed enough that I can take a **brand-new company I know nothing about** and fully integrate it into OARFlow by following you step by step — **regardless of how that company's existing website is built** (WordPress, Wix, Squarespace, Webflow, Shopify, a hand-coded static site, a React/Next SPA, or anything else).

# OBJECTIVE

Produce a single, comprehensive, skimmable **Markdown runbook** titled "Onboarding a New Company to OARFlow." It must cover, end to end and in this priority order:

1. **Website integration** — wiring the company's existing site to OARFlow's booking flow, with a decision tree that handles *any* website stack.
2. **Database configuration** — provisioning, migrations, and the tenant record(s).
3. **Webhooks & integrations** — inbound (Stripe/SMS/Google/cron) and outbound (OARFlow → Zapier/Make), plus the public API.

The runbook must work for **both onboarding models** and tell me how to choose between them:

- **Model A — Shared multi-tenant** (default): add the company as a new *tenant* on one existing OARFlow deployment.
- **Model B — Dedicated instance**: stand up a separate OARFlow deployment + database for that company alone.

# === GROUND TRUTH (authoritative — OARFlow facts; do not contradict) ===

**Stack & shape**
- Node.js (ESM) + Express, **no build step**. Frontend = static HTML "shells" in `/public` (admin SPA, plus standalone `/book`, `/pay`, `/quote`, `/save-card`, `/review`, `/portal`, `/document`, `/device`, `/field`) that call JSON APIs under `/api`.
- Database = Postgres via `pg` in production; `@electric-sql/pglite` (in-process Postgres, persisted to `./.pglite`) as a zero-config dev fallback. **Auto-detected**: if `DATABASE_URL` is set → real Postgres; else → PGlite. No code change between dev and prod.
- Money is stored as integer **cents**; all timestamps are `TIMESTAMPTZ` (UTC), converted to per-tenant wall-clock at the edges.
- Two entry points: `server.js` (long-running: Render/Railway/Fly/VM/Docker) and `api/index.js` (Vercel serverless). `vercel.json` rewrites all routes → `/api/index`, sets `maxDuration` 30s, and registers a daily cron `0 13 * * *` → `/api/cron/daily`.

**Multi-tenancy & tenant resolution**
- Every domain table carries a `tenant_id`. Per-tenant config lives in `tenants.settings` (JSONB), deep-merged over defaults in `src/lib/defaults.js`; `config_version` bumps on each write.
- A request resolves its tenant by: **admin** → the logged-in user's `tenant_id` (sessions are tenant-scoped); **public booking/pay** → a **slug** in the URL. The booking page is `/book?t=<slug>`; the public API path is `/api/public/:slug/...`. There is also a `DEFAULT_TENANT_SLUG` fallback (used for single-tenant deployments).
- IMPORTANT NUANCE for the website section: **the slug in the URL is the canonical tenant selector in code.** "Subdomain mapping" and "custom domains" are achieved at the **DNS/host-routing layer** (point the hostname at the deployment) combined with either carrying the slug in the path/query or running that host as a single-tenant deploy via `DEFAULT_TENANT_SLUG`. Do not claim the app auto-detects an arbitrary subdomain unless a host→slug mapping/middleware is configured. Treat this accurately.

**Provisioning a tenant (Model A)**
- CLI: `npm run new-tenant -- --slug=acme --name="Acme Pest Control" --email=office@acme.com --phone="(555) 010-1234" --tz=America/New_York --admin-user=owner [--admin-pass=...] [--with-demo]`. If `--admin-pass` is omitted, a strong password is generated and printed once. `--with-demo` seeds sample services + invoice presets.
- It inserts a `tenants` row (slug, name, timezone, currency, contact info, `settings` from `defaultTenantSettings()` with `branding`) and an `admin_users` row (role `owner`, password hashed via PBKDF2 in `src/lib/crypto.js#hashPassword`). Equivalent manual SQL is possible but must reuse `hashPassword`.
- Branding: `settings.branding` (`primaryColor`, `logoText`, `tagline`, `supportEmail`, `supportPhone`) is read at runtime by the `/book` and `/pay` pages, so each tenant themes automatically.

**Database config**
- Prod: create Postgres (Neon pooled connection recommended, `?sslmode=require`; Supabase/RDS also fine). Set `DATABASE_URL`. Run `npm run migrate` once (idempotent; ~26 numbered SQL migrations in `db/migrations/`), then `npm run seed` (first tenant + admin) or `npm run new-tenant` per company. `npm run migrate:status` shows applied state. Dev: leave `DATABASE_URL` blank → PGlite at `PGLITE_DIR` (`./.pglite`).

**Environment variables (key ones)**
- Core: `NODE_ENV`, `BASE_URL` (public https URL; used in emails + payment links), `DATABASE_URL`, `DEFAULT_TENANT_SLUG`.
- Security: `TOKEN_SECRET` (signs public access tokens), `ENCRYPTION_KEY` (**dedicated** 32+ char; AES-256-GCM encrypts per-tenant secrets at rest — **do not rotate casually**; falls back to `TOKEN_SECRET` if unset), `SESSION_COOKIE_NAME`, `SESSION_TTL_HOURS`, `ADMIN_BOOTSTRAP_USERNAME`/`_PASSWORD`.
- **Production fails closed**: a default `TOKEN_SECRET` or a missing/short `ENCRYPTION_KEY` makes the app serve only `/api/health` (503 on everything else) unless `ALLOW_INSECURE_PROD=1`. `npm run doctor -- --prod` is a deploy gate (non-zero exit on blockers). `GET /api/health` → `{ ok, db }`.
- Storage: prod **refuses local disk** — set S3-compatible (`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT`/`S3_REGION=auto` for Cloudflare R2/MinIO). Dev → `./.storage`.
- Optional/feature-gated: `MAILGUN_*` or `SMTP_*` (email; dev → console outbox), `STRIPE_*`, `GOOGLE_CLIENT_*`/`GOOGLE_REDIRECT_URI`, `TWILIO_*`, `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` (managed background jobs; without it an in-process runner + the daily cron drive background work), `CRON_KEY`/`CRON_SECRET` (Vercel sends `Authorization: Bearer $CRON_SECRET`), `CONTENT_SECURITY_POLICY` (opt-in; off by default).
- **Per-tenant credentials override platform env**: each company normally brings its own Stripe / Twilio / email keys in **Admin → Settings → Integrations**, stored encrypted per tenant. That is the white-label model.

**Inbound webhooks (third party → OARFlow)**
- **Stripe**: `POST /api/stripe/webhook` (raw body; mounted before the JSON parser). Multi-tenant aware: resolves the tenant from `metadata.tenant_id` or the subscription id, then verifies the signature with **that tenant's** webhook secret (set in Settings → Integrations), falling back to the platform secret. Handled events: `checkout.session.completed`, `invoice.payment_succeeded`/`invoice.paid`, `setup_intent.succeeded`, `payment_intent.succeeded`, `customer.subscription.updated`/`deleted`. Payments are idempotent via `external_ref`.
- **Google OAuth callback**: `/api/integrations/google/callback` (must equal `GOOGLE_REDIRECT_URI`).
- **Twilio SMS inbound**: `/api/webhooks/sms`. **Voice (scaffold only)**: `/api/webhooks/voice`.
- **Inngest**: `/api/inngest` (only mounted when `INNGEST_*` set). **Cron**: `/api/cron/daily` (Bearer `CRON_SECRET`/`CRON_KEY`).

**Outbound webhooks (OARFlow → third party; e.g. Zapier/Make)**
- Configured in **Admin → Developer** (add endpoint URL + subscribed events). Event names: `appointment.scheduled`, `appointment.completed`, `appointment.canceled`, `invoice.sent`, `invoice.paid`, `estimate.accepted`, `review.responded`, `customer.created`, `call.received` (or `*`).
- Each delivery is signed: header `X-OARFlow-Signature: sha256=<HMAC-SHA256 of the raw body using the endpoint secret whsec_...>`, plus `X-OARFlow-Event`. Retries with exponential backoff (~2,4,8…60 min), 6 attempts then `failed`. SSRF-guarded: https required in prod, private/loopback/metadata IPs rejected, redirects not followed. Test sink: `GET/POST /api/v1/ping`.

**Public API v1 (actions/polling; pairs with outbound webhooks as triggers)**
- Base `…/api/v1`. Auth: `Authorization: Bearer oarf_<key>` or `X-API-Key`. Create a key in **Admin → Developer** (read vs write scope). Endpoints: `GET /me`, `GET/POST /customers` (POST needs write), `GET /appointments` (`?status=`, `?since=`), `GET /invoices`, `GET /services`, `POST /webhooks` (programmatic subscribe). `GET /ping` is unauthenticated.

**Booking modes (context)**
- Per service: **instant** (`POST /api/public/:slug/book` with a chosen, server-revalidated slot → `scheduled`) or **request** (customer proposes up to N slots → `requested`; staff confirm). No technician selection on the public side — capacity = "how many crews run at once."

**Security defaults relevant to embedding**
- The app sets `X-Frame-Options: SAMEORIGIN` (in both `vercel.json` headers and Express middleware). **Cross-origin iframe embedding of `/book` is therefore blocked by default** — an embed on the company's own domain requires relaxing this (e.g. remove/loosen `X-Frame-Options` for that route and set a `frame-ancestors` CSP allowlisting the partner domain). Call out this tradeoff; don't hand-wave it.

# === END GROUND TRUTH ===

# REQUIRED REPORT STRUCTURE

Write these sections, in order. Use real commands, env tables, and copy-paste snippets with clearly marked placeholders (`<SLUG>`, `<COMPANY_DOMAIN>`, `<APP_DOMAIN>`, `<DATABASE_URL>`, etc.). Every phase ends with a **Verification** subsection (an exact command or click-path and the expected result) and a **Rollback / if-it-breaks** note.

1. **TL;DR & the two models.** One-paragraph overview, then a short decision guide: when to pick **Model A (shared multi-tenant)** vs **Model B (dedicated instance)** — criteria like isolation/compliance needs, billing separation, custom-domain requirements, blast radius, ops overhead. State your default recommendation.

2. **Intake checklist (the "random company" inputs).** A fill-in-the-blanks form capturing everything needed before touching anything: legal + display name, desired `slug`, timezone, currency, contact email/phone, branding (primary color, logo text, tagline), **website platform and whether they control DNS**, whether they bring their own Stripe/Twilio/email or use platform credentials, service catalog + prices (cents), recurring plans, and which website-wiring method (from §4) they need. Note which inputs block which later phases.

3. **Database configuration.**
   - Model A: confirm the existing `DATABASE_URL`, that migrations are current (`npm run migrate:status`), and that you'll add a tenant (no schema change).
   - Model B: provision a fresh Postgres (Neon pooled example), set env, `npm run migrate` then `npm run seed`/`new-tenant`.
   - Cover the PGlite-vs-Postgres auto-detection, the cents/UTC conventions, and a sanity query to confirm the tenant row landed.

4. **Website integration — decision tree for ANY stack.** This is the centerpiece. Open with a decision tree (render it as a Mermaid `flowchart` AND as a plain numbered fallback) keyed on: *Does booking need to live under the company's own domain? Do they control DNS? Must it be inline in an existing page? Cross-origin embedding acceptable?* Then give a subsection per method, each with concrete per-platform steps:
   - **(a) Link-out button/link** to `https://<APP_DOMAIN>/book?t=<SLUG>` — the universal default; works on every stack. Show how to add it on WordPress (block + menu), Wix, Squarespace, Webflow, Shopify, and a raw HTML anchor.
   - **(b) Subdomain** (`booking.<COMPANY_DOMAIN>`) — CNAME to the deployment, add the domain in the host (e.g. Vercel Domains), set `BASE_URL`, and map the host to the tenant (carry the slug, or run it single-tenant via `DEFAULT_TENANT_SLUG`). Be precise per the GROUND TRUTH nuance.
   - **(c) Reverse proxy** so booking lives at `<COMPANY_DOMAIN>/book` — show Cloudflare Workers/Rules, nginx `proxy_pass`, and a Vercel `rewrites` example on the company side; note header/cookie/`BASE_URL` implications.
   - **(d) iframe embed** inline in an existing page — show the snippet, **and** the `X-Frame-Options`/`frame-ancestors` CSP changes required for cross-origin, with the security tradeoff spelled out.
   - For each: how branding (`settings.branding`) makes it themed, and a note on instant vs request mode UX.

5. **Tenant provisioning & admin handoff (Model A focus, reused by B).** The `new-tenant` command with annotated flags; the manual-SQL equivalent (reusing `hashPassword`); first login at `/admin`; rotating the bootstrap password; seeding services/presets/plans either via `--with-demo` or in-app.

6. **Integrations & webhooks.**
   - **Per-tenant integrations** in Admin → Settings → Integrations (Stripe, Twilio/SMS + 10DLC note, email, Google Calendar, geocoding), and how they override platform env.
   - **Inbound Stripe webhook**: create it in the Stripe dashboard pointing at `https://<APP_DOMAIN>/api/stripe/webhook`, paste the per-tenant signing secret into Settings → Integrations, list the events, and explain the metadata-based tenant resolution + idempotency. Include a `stripe trigger`/test-event verification.
   - **Google Calendar OAuth**: redirect URI must match `GOOGLE_REDIRECT_URI` (`/api/integrations/google/callback`); connect from Settings.
   - **Outbound webhooks**: add an endpoint in Admin → Developer, choose events, and show **HMAC-SHA256 signature verification** pseudocode (compare `X-OARFlow-Signature` to `sha256=` HMAC of the raw body with the `whsec_` secret). Demonstrate end-to-end with `webhook.site` or `/api/v1/ping`, and explain retry/backoff + the SSRF rules.
   - **Public API v1**: mint a key in Admin → Developer; `curl` examples for `/me`, polling `/appointments?since=`, creating a customer (write scope), and `POST /webhooks`.

7. **Go-live & end-to-end acceptance.** `npm run doctor -- --prod` as the gate; `GET /api/health`; then a scripted smoke test of the real flow: load the company's booking entry point → book a test appointment (both instant and request) → admin confirms → send an invoice → pay it via Stripe test card → confirm the `invoice.paid` outbound webhook fired and the Stripe inbound webhook recorded the payment. Provide it as a numbered acceptance checklist with expected results.

8. **Troubleshooting matrix.** Symptom → likely cause → fix, covering at least: 503 on everything (fail-closed `TOKEN_SECRET`/`ENCRYPTION_KEY`), booking page shows the wrong/default company (slug/`DEFAULT_TENANT_SLUG`), iframe blank (X-Frame-Options/CSP), Stripe webhook signature failures (per-tenant vs platform secret, raw-body), payments not recording (metadata/idempotency), outbound webhook stuck failed (SSRF block, non-2xx, attempt cap), uploads failing in prod (missing S3), emails not sending (Mailgun/SMTP not set).

9. **Appendices / reusable templates.** A blank intake form, an env-var table (var · required-when · example), a per-tenant Settings → Integrations checklist, and a copy-paste "new company in 10 minutes" quickstart for the common case (Model A + link-out).

# QUALITY BAR & CONSTRAINTS

- **Accurate to the GROUND TRUTH.** Never invent routes, env names, events, or CLI flags beyond what's given; if something isn't specified, say so and mark it "verify in repo/Settings" rather than guessing.
- **Copy-paste ready.** Real commands and code blocks, consistent placeholders, and a one-line note on what each command does. Prefer `curl` for API/webhook verification.
- **Branchy where reality is branchy** (website method, Model A vs B, BYO-credentials vs platform) — use tables and decision trees, not prose walls.
- **Web research**: treat the GROUND TRUTH as authoritative for OARFlow itself, but **use browsing to verify and cite current provider UI steps** (Vercel domains/env, Neon pooled connection, Stripe dashboard webhook + test events, Cloudflare CNAME/Workers, and the WordPress/Wix/Squarespace/Webflow/Shopify link/embed steps). Cite those sources inline. Flag anything that looks version-dependent.
- **Length**: thorough but skimmable — tables, short steps, Mermaid for the decision tree and the go-live flow. Lead with the decision tree and the 10-minute quickstart so common cases are fast.
- Begin the report by listing the **assumptions** you're making and any inputs you'd need from me; then proceed without further questions.
