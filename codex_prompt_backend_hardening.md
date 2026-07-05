# Codex Prompt — Backend hardening: payments, webhooks, validation

You are working in the OARFlow repo (Express, Postgres/PGlite, Stripe, multi-tenant). Read each file end-to-end before editing; preserve existing patterns (parameterized queries, tenant scoping on every query, `FOR UPDATE` + ledger-derived totals in `recordPayment`, `external_ref` idempotency, `logAudit`, `consumeRateLimit`, `hexColor`/`toInt` validators in `src/lib/http.js`).

Make each fix a separate commit. Add/extend unit tests where a `tests/` convention exists; otherwise include a small script-level verification note in the commit message. No new dependencies.

---

## Fix 1 — Stripe webhook swallows handler errors and always ACKs 200 (payment loss)

**Problem.** `src/routes/stripe_webhook.js:106-110` — the handler switch is wrapped in try/catch that only `console.error`s, then unconditionally `res.json({received:true})`. A transient DB failure during `recordPayment` returns 200 → Stripe marks the event delivered and never retries → the customer was charged but the ledger has no payment.

**Fix.** On handler error, `return res.status(500).json({ error: 'handler_failed' })` so Stripe retries. This is safe: `recordPayment` is idempotent via the tenant-scoped `external_ref` unique index. Keep the error log.

---

## Fix 2 — Webhook payment path never emits `invoice.paid`

**Problem.** `src/routes/stripe_webhook.js:57-98` — the checkout/`payment_intent.succeeded` branches call `recordPayment` but never `emitEvent('invoice.paid', …)`, unlike the manual-payment and charge-on-file paths. Result: `collected`-basis commissions never accrue and tenant outbound webhooks never fire for the **most common** payment path (customer pays online).

**Fix.** After a successful `recordPayment` in the webhook, when `r.invoice?.status === 'paid'`, emit `invoice.paid` with the same payload shape the other paths use (find them via `grep -rn "invoice.paid" src/`). Ensure idempotency: only emit when this recordPayment actually inserted (not when it was deduped by `external_ref`) — `recordPayment`'s return value distinguishes this; check and use it.

---

## Fix 3 — Tenant webhook secret misconfiguration silently drops events

**Problem.** `src/routes/stripe_webhook.js:41-48` — if a tenant's own webhook secret is wrong/missing and no platform secret exists, verification failure returns `{received:true, ignored:true}` (200). Real payment events are silently discarded.

**Fix.** Distinguish "no secret configured" (200 ignored is fine) from "signature verification failed" (return 400 with a log line including tenant id). Consider also writing an audit/ops log row so it's visible in `job_runs`-style tooling.

---

## Fix 4 — Charge-on-file race: funds captured but never recorded

**Problem.** `src/lib/payments.js:127-159` — `chargeInvoiceOnFile` reads the balance, creates a confirmed PaymentIntent (funds captured), then calls `recordPayment`. If a concurrent payment cleared the balance in between, `recordPayment` returns `rejected:'overpay'` and the function errors out — but the Stripe charge succeeded and is neither recorded nor refunded.

**Fix.** Two layers:
1. Before creating the PaymentIntent, re-read the invoice `FOR UPDATE` (short transaction) to compute the balance, minimizing the window.
2. If `recordPayment` still rejects after a captured PI: refund the PaymentIntent via Stripe and return a clear error; log with `logAudit`. Never leave a captured charge unrecorded.

---

## Fix 5 — Initial subscription payment missing from the ledger

**Problem.** `src/lib/recurring.js:35-38` — `handleStripeInvoicePaid` skips `billing_reason === 'subscription_create'` ("initial handled at checkout"), but `activateSubscriptionFromCheckout` only activates and records no payment/financial event. First-cycle revenue is missing from `financial_events`, understating collected revenue/MRR.

**Fix.** In `activateSubscriptionFromCheckout`, record the initial payment (amount from the Stripe checkout session/invoice), idempotent on the Stripe invoice or event id via `external_ref`. Follow the shapes used by `handleStripeInvoicePaid` for subsequent cycles.

---

## Fix 6 — Validate tenant timezone/currency (an invalid TZ 500s the whole tenant)

**Problem.** `src/lib/tenants.js:51-62` + `src/routes/admin/settings.js:55-62` — `updateTenantProfile` persists `timezone` verbatim. An invalid IANA string makes every `Intl.DateTimeFormat`/`zonedWallTimeToUtc` call throw → availability, dashboard, reminders all 500 tenant-wide. Currency is free text too. The admin Settings UI exposes both as plain text inputs.

**Fix.**
1. Backend: validate timezone with a try/catch probe (`new Intl.DateTimeFormat('en-US',{timeZone: tz})`) or `Intl.supportedValuesOf('timeZone')`; validate currency against a small ISO-4217 allowlist (at least the ones Stripe supports that you care about). Return 400 with a clear message.
2. Frontend (`public/assets/app/views/settings.js`): make timezone a `<select>` populated from `Intl.supportedValuesOf('timeZone')` and currency a select of supported codes.

---

## Fix 7 — Sanitize `branding.primaryColor` (HTML/CSS injection into customer emails)

**Problem.** `src/lib/email_templates.js:29-44` — `brand.primaryColor` is interpolated raw into inline styles and a `<style>` block of outbound customer emails. Service colors go through `hexColor()` but this one doesn't. A value like `#000;}</style><script>…` becomes markup injection.

**Fix.** Run `primaryColor` through `hexColor()` at both write time (`src/routes/admin/settings.js` branding save) and render time (`buildShell` fallback to the default color when invalid).

---

## Fix 8 — Rate-limit the public token endpoints (Stripe cost amplification)

**Problem.** Only book/portal/auth use `consumeRateLimit`. Unlimited: `src/routes/save_card.js:18-30` (every GET creates a Stripe SetupIntent and possibly a Customer — direct cost amplification), plus `pay.js`, `quotes.js`, `documents_public.js`, `reviews_public.js`, `devices_public.js`, `field.js`.

**Fix.** Apply `consumeRateLimit` (per IP + route bucket, limits consistent with existing usage in `public.js`) to: save-card GET/POST (tightest), all public POST handlers (accept/decline/sign/respond/inspect), and a looser limit on the GETs. Return 429 with a retry message the pages can display.

---

## Fix 9 — Routing day-boundary computed in server-local time

**Problem.** `src/lib/routing.js:71-73` — `new Date(\`${date}T00:00:00\`)` parses in process TZ; every other boundary uses `zonedWallTimeToUtc(date,'00:00',tenant.timezone)`. Route optimization can include/exclude wrong-day jobs when server TZ ≠ tenant TZ.

**Fix.** Use `zonedWallTimeToUtc` like `field.js`/`dashboard.js`.

---

## Fix 10 — Defense-in-depth cleanups (one commit)

1. `src/routes/public.js:112-130` — instant booking takes `scheduledEnd` from client `body.slot.end`; use the matched server slot's `end`. (Also listed in the customer-pages prompt — skip if already done.)
2. `src/routes/admin/invoices.js:88-90`, `src/routes/admin/customers.js:34-36,69-70` — rollup subqueries filter by `invoice_id`/`customer_id` without `tenant_id`. Not currently exploitable (parent row is tenant-scoped) but fragile; add explicit `tenant_id` predicates.
3. Public token lookups (`pay.js:17`, `quotes.js:14`, `save_card.js:14-15`) compare with `!==` / SQL equality; tokens are 192-bit so timing attacks are impractical, but use `safeEqual` from `src/lib/crypto.js` where comparison happens in JS.
4. `src/lib/http.js:37-40` — `toInt` accepts negatives despite the "positive integer" doc; clamp/reject negatives.
5. Consider gating financially sensitive admin reads (`dashboard.js` revenue/MRR, appointments `internal_notes`) behind `requirePermission('reports.view')` / appropriate caps — currently any `requireAdmin` role including `tech` can read them. Implement if role definitions in `src/lib/permissions.js` make this clean; otherwise leave a TODO with rationale.

---

## Acceptance (whole prompt)

- A thrown error inside a Stripe webhook handler yields HTTP 500 (test with a stubbed failing `recordPayment`); a replayed event after success yields 200 with no duplicate ledger row.
- Paying an invoice via hosted checkout accrues collected-basis commissions and delivers tenant `invoice.paid` webhooks.
- Saving an invalid timezone returns 400; existing tenants unaffected.
- `primaryColor: "red;}</style>"` renders emails with the default brand color.
- Hammering `GET /save-card/:id` returns 429 before creating unbounded Stripe objects.
- All existing tests pass (`npm run smoke` and any unit tests).
