# OARFlow Payments — Moving Off "Bring-Your-Own Stripe Keys" to Stripe Connect

**Prepared for:** Jake (OARFlow founder / product)
**Date:** June 27, 2026
**Scope:** How tenants connect payments today, the options to fix it, a friction-only vs. monetized comparison, OARFlow-specific economics, and a build plan mapped to the actual codebase.

> Companion to `docs/OARFlow_SelfServe_LowEnd_Market_Report_2026-06-27.pdf`, which lists "Stripe connect" as a Phase 0 self-serve requirement and flags monetizing payments as a gap ("Required to monetize self-serve").

---

## 1. TL;DR

- **Today** every tenant manually pastes a Stripe **secret key, publishable key, and webhook secret** into Settings → Integrations. The webhook step alone requires creating an endpoint inside the Stripe dashboard — a hard stop for a solo, non-technical pest operator. This is the single biggest payments-onboarding barrier.
- **The fix is Stripe Connect** — a "Connect with Stripe" button replaces all three keys. Stripe hosts the identity/bank onboarding, so OARFlow never touches keys again.
- **Build it once, decide the fee later.** Both the "just remove friction" path and the "take a cut" path run on the *same* Connect plumbing. The only difference is whether you attach an `application_fee`. So this is not an either/or infrastructure decision.
- **Recommendation: Stripe Connect Express, in two phases.**
  - **Phase A (now):** Express onboarding, **no platform fee** — kills the barrier, near-zero added Stripe cost, tenant stays merchant of record (lowest liability for OARFlow). Matches the market report's Phase 0.
  - **Phase B (once volume is flowing):** turn on a modest **application fee (start 0.5%, test toward ~1%)** as a second revenue line. At OARFlow's ~$70 ARPA this plausibly adds **35–100%+ to ARPA per active tenant** — the most direct answer to the report's "low ARPA" worry.
- **Do not** build a full PayFac or adopt PayFac-as-a-service (Finix/Payrix) yet — those pay off at much larger aggregate volume and add real compliance/underwriting burden. Connect gives ~the same merchant UX and lets you take a cut with far less lift. Revisit at the white-label/reseller stage.

---

## 2. The Problem Today (from the codebase)

OARFlow currently uses **per-tenant API keys**. Each tenant runs as its own isolated Stripe account, and OARFlow instantiates a separate Stripe client per tenant:

| Where | What it does today |
| --- | --- |
| `src/lib/defaults.js` | Tenant default: `stripe: { secretKey:'', publishableKey:'', webhookSecret:'', mode:'test' }` |
| `src/routes/admin/settings.js` (`PUT /integrations/stripe`) | Accepts `secretKey`, `publishableKey`, `webhookSecret`; encrypts secret + webhook at rest |
| `src/lib/stripe.js` | `getStripe(tenant)` builds a `new Stripe(tenantSecret)` client; resolves keys per-tenant with env fallback |
| `src/lib/payments.js` | Saved-card / SetupIntent flows, also per-tenant `getStripe(tenant)` |
| `src/routes/stripe_webhook.js` | Single endpoint, but verifies each event with the **tenant's own webhook secret** (peeks payload → loads tenant → verifies) |
| `src/routes/pay.js`, `src/routes/admin/plans.js` | Create Checkout Sessions via the per-tenant client |

**Why it hurts the target customer.** The market report's ICP is a solo / 1–3 tech pest operator buying self-serve at $29–$79/mo. Asking them to (1) create a Stripe account, (2) find and copy a *secret* key, (3) copy a publishable key, and (4) create a webhook endpoint and copy its signing secret is the antithesis of a 10-minute setup wizard. It is also a security smell (handing OARFlow a full-access secret key).

**The good news.** Moving to Connect *removes* code rather than adding net complexity: per-tenant secret resolution, per-tenant webhook secrets, and at-rest encryption of those secrets all go away, replaced by one platform key + a stored `acct_…` id per tenant.

---

## 3. The Options

All four are "rent, don't build." The realistic choice is between the three Stripe Connect account types; PayFac-as-a-service is listed for completeness.

| Option | Onboarding UX | Who is merchant of record | OARFlow effort | Can take a cut? | Fit for OARFlow now |
| --- | --- | --- | --- | --- | --- |
| **Connect Standard** | OAuth "Connect with Stripe" (fastest to build) | Tenant | Lowest | Yes (application fee) | Good v0 if eng time is tight; tenant gets full Stripe dashboard (heavier than needed) |
| **Connect Express** | Stripe-hosted onboarding + lightweight dashboard; instant payouts | Tenant | Low–medium | Yes (application fee) | **Best fit** — Stripe collects SSN/bank/identity for non-technical owners; OARFlow controls payouts, branding, fees |
| **Connect Custom / Embedded** | Fully in-app, OARFlow owns all UX | Platform/Tenant (configurable) | High | Yes | Overkill now — most build + most liability |
| **PayFac-as-a-service** (Finix, Payrix/Worldpay, Adyen) | Fully embedded | Platform | Highest | Yes (own the spread) | **Not yet** — pays off at large aggregate volume; adds underwriting/compliance burden |

**Key facts (Stripe, 2026):**
- Card processing is **2.9% + $0.30** (US); payouts **0.25% capped at $25** where applicable.
- **Pass-through mode** ("Stripe bills the connected account"): the tenant pays Stripe's fees, and the platform incurs **no** account/payout/tax-reporting fees. Stripe also issues the tenant's 1099-K. This is the friction-only path.
- **Platform-controls-pricing mode**: OARFlow sets the rate, keeps the spread, and Stripe bills OARFlow monthly based on payouts. In this mode OARFlow becomes responsible for 1099-K filing for its connected accounts.
- **Monetization mechanic**: `application_fee_amount` on a direct charge automatically routes OARFlow's cut from the tenant to the platform — clean, per-transaction, no invoicing.
- **Liability**: with **direct charges** on Standard/Express the **tenant is merchant of record** (bears chargebacks, gets their own 1099-K) — keeps OARFlow's risk and tax burden low. Only **destination charges** make OARFlow merchant of record (more control, more liability). For OARFlow, the small business is the real seller, so **direct charges + application fee** is the right model.

---

## 4. Two Strategic Paths — same plumbing

```
                       ┌─ Phase A: application_fee = 0   → friction-only (pass-through)
Build Stripe Connect ──┤
   (one time)          └─ Phase B: application_fee > 0   → second revenue line
```

| | Friction-only (Phase A) | Monetized (Phase B) |
| --- | --- | --- |
| Tenant experience | Click "Connect with Stripe", done | Identical |
| OARFlow revenue from payments | $0 (indirect: better activation/retention) | 0.5–1.0% of processed volume |
| Added Stripe cost to OARFlow | ~None (pass-through) | ~None per-txn in direct-charge model; minor platform fees if you switch to platform-priced |
| OARFlow liability / tax | Minimal (tenant is MoR, Stripe issues their 1099-K) | Still minimal with direct charges; rises only if you become MoR |
| Build delta over Phase A | — | A few lines: compute + attach `application_fee_amount`, plus fee reporting |

The takeaway: **ship Phase A to remove the barrier, then flip Phase B on when you're ready.** You are not choosing infrastructure twice.

---

## 5. Economics for OARFlow

Subscription ARPA planning figure from the market report: **~$70/mo** (conservative blended). The question is what a payments **application fee** adds on top.

**Assumptions (planning, tunable — not forecasts):** card volume actually processed *through OARFlow* per active paying tenant, and the OARFlow application-fee rate. Pest is recurring (quarterly plans, cards on file), but a chunk of revenue stays cash/check, so these are deliberately conservative.

### Per active tenant (monthly)

| Scenario | Card volume / mo | OARFlow fee rate | Payments rev / mo | vs. $70 sub ARPA |
| --- | --- | --- | --- | --- |
| Conservative | $4,000 | 0.6% | **$24** | +34% |
| Base | $8,000 | 0.6% | **$48** | +69% |
| Upside | $15,000 | 0.8% | **$120** | +171% |

A solo operator with 150–300 recurring accounts at $400–$600/yr runs roughly $60k–$150k/yr in revenue; even half of that flowing through cards on file lands in the $4k–$8k/mo range. 1–3 tech shops skew higher.

### Portfolio view (illustrative)

Assume **300 paying tenants**, and a **60% "actively processing" haircut** (not everyone collects online, free-tier users excluded):

| Line | Annual |
| --- | --- |
| Subscriptions: 300 × $70 × 12 | **$252,000** |
| Payments (base): 300 × 60% × $48 × 12 | **$103,680** |
| **Total** | **$355,680** (**+41%** over subscriptions alone) |

**Why this matters strategically.** The market report's central risk is thin ARPA funding CAC against 3–5%/mo churn. A payments line that grows with each customer's *own* revenue (a) raises ARPA without raising the sticker price, (b) scales with tenant success, and (c) deepens lock-in (their money is flowing through you). It is the highest-leverage answer to the report's "monetize self-serve" gap — and it rides on infrastructure you need to build for activation anyway.

**Caveat to confirm with Stripe:** the exact fee configuration (who bears the base 2.9% + $0.30, and whether you operate pass-through vs. platform-priced) determines net margin on the application fee. The model above treats the application fee as near-net OARFlow revenue with the tenant bearing Stripe's base processing — the standard direct-charge-with-application-fee setup. Validate against your Connect platform pricing before publishing rates.

---

## 6. Recommendation

1. **Adopt Stripe Connect Express** with hosted onboarding. Express is the sweet spot for non-technical operators: Stripe collects identity/SSN/bank and handles verification, while OARFlow controls payout timing, branding, instant-payout upsell, and (later) fees. (Choose **Standard/OAuth** only if you need the absolute fastest v0 and accept giving tenants the heavier full Stripe dashboard.)
2. **Phase A — friction-only, application_fee = 0.** Replace the three-key form with "Connect with Stripe." Tenant stays merchant of record. Ship inside the self-serve setup wizard the report calls for.
3. **Phase B — turn on the fee.** Start at **0.5%**, A/B toward ~1%, applied to new signups (grandfather existing tenants). Keep **direct charges** so tenants remain merchant of record and receive their own 1099-K — OARFlow's compliance stays light.
4. **Defer PayFac-as-a-service.** Re-evaluate Finix/Payrix only when aggregate processing is large enough that owning more of the economics beats Stripe's share, likely alongside the report's Phase 3 white-label/reseller channel.

---

## 7. Implementation Plan (mapped to the code)

### 7.1 Data model
Add a migration `db/migrations/0027_stripe_connect.sql`:
- On `tenants` (or under `settings.integrations.stripe`): `stripe_account_id TEXT` (`acct_…`), `stripe_connect_status TEXT` (`none|pending|enabled`), `stripe_charges_enabled BOOLEAN`, `stripe_payouts_enabled BOOLEAN`.
- Keep the existing `secretKey/publishableKey/webhookSecret` fields temporarily for backward-compatible rollout.

### 7.2 Platform config (`src/config.js`)
`config.stripe.secretKey` / `publishableKey` / `webhookSecret` become the **primary platform** credentials (one Connect-enabled account), not just a fallback. Complete the Stripe **platform profile** and accept Connect terms; configure platform pricing if monetizing.

### 7.3 `src/lib/stripe.js` (the core refactor)
- Add `getPlatformStripe()` → a single `new Stripe(config.stripe.secretKey)` client.
- Add `connectedAccountId(tenant)` → reads stored `acct_…`.
- Change `createInvoiceCheckout`, `createSubscriptionCheckout`, and the `payments.js` SetupIntent/card flows to call the **platform client with `{ stripeAccount: acctId }`** (direct charge). For monetization, add `payment_intent_data.application_fee_amount` (Phase B).
- `isConfigured(tenant)` → `Boolean(connectedAccountId(tenant) && tenant.stripe_charges_enabled)`.
- **Legacy branch:** if a tenant still has a stored secret key and no connected account, keep the old path so nothing breaks mid-rollout.

### 7.4 New onboarding endpoints (`src/routes/admin/stripe_connect.js`)
- `POST /integrations/stripe/connect/start` → `accounts.create({ type:'express', … })` if none, then `accountLinks.create({ type:'account_onboarding', refresh_url, return_url })`; return the URL. (Standard variant: build the OAuth authorize URL instead.)
- `GET /integrations/stripe/connect/return` + `/refresh` → `accounts.retrieve` to read `charges_enabled` / `payouts_enabled`; persist status.
- `POST /integrations/stripe/connect/dashboard` → `accounts.createLoginLink` for the Express dashboard / payouts.

### 7.5 Settings UI
Replace the three key inputs with a **"Connect with Stripe"** button + a status pill (*Not connected · Pending · Connected · payouts enabled*). Deprecate the key-writing branch in `PUT /integrations/stripe` (`settings.js` lines ~249–251).

### 7.6 Webhook (`src/routes/stripe_webhook.js`) — simplify
- Register **one platform Connect webhook**; verify every event with the single platform `STRIPE_WEBHOOK_SECRET`.
- Connect events carry an **`account`** field → resolve tenant by `acct_…` (keep `metadata.tenant_id` as a secondary). Drop per-tenant secret resolution entirely.
- Add `account.updated` handling to flip `stripe_charges_enabled` / `payouts_enabled` as onboarding completes.

### 7.7 Monetization toggle (Phase B)
- Configurable fee in basis points (platform default + optional per-tenant override). Compute `application_fee_amount` on each Checkout/PaymentIntent; default **0** for grandfathered tenants.
- Add a platform report of fees collected (new admin/report view or export).

### 7.8 Migration / backfill
- On next login, prompt existing tenants to complete Connect onboarding. Once `charges_enabled`, stop using stored keys for that tenant. After all are migrated, drop the encrypted key columns.

### 7.9 Tests
Mirror the existing suite (`npm run smoke`, unit tests like `checkout-status.test.js`): add coverage for account-link creation, `account.updated` → status flip, tenant resolution by `event.account`, and `application_fee_amount` calculation.

### 7.10 Compliance / ops notes
- **Direct charges (recommended):** tenant is merchant of record → bears chargebacks, receives their own 1099-K. OARFlow's burden stays low.
- **If you ever switch to destination charges / platform-controls-pricing:** OARFlow becomes merchant of record and is responsible for 1099-K filing and centralized dispute handling — only take this on deliberately.

---

## 8. Risks & Open Questions
- **Exact fee economics**: confirm pass-through vs. platform-priced configuration with Stripe before advertising a rate (affects net margin — see §5 caveat).
- **Tenant trust**: some operators already have a Stripe account; Express/OAuth both let them connect an existing one, so don't force a new account.
- **Onboarding drop-off**: Stripe-hosted KYC can still stall older users at the SSN/bank step — instrument completion and add a "finish later" resume link (the account-link `refresh_url`).
- **Subscription billing for OARFlow's own plans** (separate from this): the report notes OARFlow still needs to bill its *own* tenants for $29–$79/mo. That's standard Stripe Billing on the platform account — related but distinct from Connect, and worth sequencing alongside Phase A.

---

## 9. Sources
- Jobber + Stripe partnership (proof the category runs on Connect): https://stripe.com/newsroom/news/jobber
- Stripe Connect pricing: https://stripe.com/connect/pricing
- How charges work in Connect (direct vs. destination, merchant of record): https://docs.stripe.com/connect/charges
- Charge SaaS fees to connected accounts (application fees): https://docs.stripe.com/connect/integrate-billing-connect
- US tax reporting for Connect platforms (1099-K responsibility): https://docs.stripe.com/connect/tax-reporting
- PayFac-as-a-service context (when it pays off): https://payabli.com/payfac-as-a-service-for-saas-a-complete-guide/
- When Stripe Connect is/ isn't the answer at scale: https://www.apideck.com/blog/vertical-saas-payouts-stripe-connect

*Code references verified against the OARFlow repo on 2026-06-27: `src/lib/stripe.js`, `src/lib/payments.js`, `src/lib/defaults.js`, `src/routes/admin/settings.js`, `src/routes/stripe_webhook.js`, `src/routes/pay.js`, `src/routes/admin/plans.js`, `src/config.js`, `db/migrations/` (through 0026).*
