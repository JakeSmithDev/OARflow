# Deploy OARFlow to Vercel

OARFlow is serverless-safe: stateless requests, DB-backed sessions, no in-memory
queues, no long-running workers, no filesystem dependence (files go to object
storage, background work runs via Vercel Cron or Inngest). `api/index.js` exports
the Express app as the serverless handler; `vercel.json` routes everything to it.

> Run `npm run doctor -- --prod` any time to see exactly what's missing. It exits
> non-zero on production blockers, so you can use it as a deploy gate.

## 1. Provision the database (Neon)

1. Create a Postgres database (Neon is the easiest serverless fit; Supabase/RDS work too).
2. Copy the **pooled** connection string (Neon: "Pooled connection", `?sslmode=require`).
3. Run migrations once from your machine against it:
   ```bash
   DATABASE_URL="postgres://…?sslmode=require" npm run migrate
   DATABASE_URL="postgres://…?sslmode=require" npm run seed        # first tenant + admin
   ```

## 2. Object storage (required for file uploads in prod)

Vercel's filesystem is ephemeral, so OARFlow **refuses local-disk storage in
production**. Use any S3-compatible store (Cloudflare R2 is cheap + zero-egress):

- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- R2/MinIO: also set `S3_ENDPOINT` (and `S3_REGION=auto` for R2)
- Optional `S3_PUBLIC_BASE_URL` for a public/CDN bucket (otherwise signed URLs are used)

## 3. Set environment variables (Vercel → Project → Settings → Environment Variables)

Required for production:

| Var | Value |
|---|---|
| `NODE_ENV` | `production` |
| `BASE_URL` | your public https URL (e.g. `https://app.yourdomain.com`) |
| `DATABASE_URL` | Neon pooled connection string |
| `TOKEN_SECRET` | long random string (`openssl rand -base64 48`) |
| `ENCRYPTION_KEY` | **dedicated** 32+ char random string (encrypts tenant secrets at rest — don't rotate casually) |
| `CRON_SECRET` | Vercel sends this as `Authorization: Bearer` on cron calls |
| `S3_*` | object storage credentials (step 2) |
| `ADMIN_BOOTSTRAP_PASSWORD` | set before seeding (or change after first login) |

Optional (light up features when set): `MAILGUN_*` or `SMTP_*` (email),
`INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` (managed background jobs),
`CONTENT_SECURITY_POLICY` (see `.env.example` for a tested value).

> Platform-level `STRIPE_*` / `TWILIO_*` are optional — each business normally
> brings **its own** Stripe/Twilio/email credentials in Admin → Settings →
> Integrations, stored encrypted per tenant. That's the white-label model.

## 4. Deploy

```bash
vercel            # preview deploy
vercel --prod     # production
```

`vercel.json` already wires: all routes → `api/index.js`, `maxDuration` 30s,
asset caching, baseline security headers, and a **daily cron** at 13:00 UTC →
`/api/cron/daily` (runs reminders, recurring billing, follow-ups, review sends,
webhook retries). Without Inngest this cron is what drives background work, which
is all serverless‑safe (events fan out synchronously during the request).

## 5. Verify

- `GET /api/health` → `{ ok: true, db: "up" }` (503 if the DB is unreachable).
- Sign in at `/admin` → **Developer → Go-live status** shows the same preflight the
  `doctor` CLI prints, plus live driver detection (database/storage/email/jobs).
- Stripe: set the tenant's keys in Settings → Integrations, then add a Stripe
  webhook to `https://<your-domain>/api/stripe/webhook` with that tenant's secret.

## 6. Onboard another business (resale)

Each customer is an isolated tenant:

```bash
npm run new-tenant -- --slug=acme --name="Acme Pest Control" \
  --email=office@acme.com --phone="(555) 010-1234" --tz=America/New_York \
  --admin-user=owner --with-demo
```

Point that tenant's domain at the deployment (or set `DEFAULT_TENANT_SLUG` for a
single-tenant deploy). The owner signs in and adds their own integration
credentials — nothing else to configure.

## Custom domain

Add the domain in Vercel → Domains, set `BASE_URL` to match, and (for multi-tenant
host routing) map each tenant's domain to the deployment. Cookies are `secure` +
`httpOnly` in production automatically.
