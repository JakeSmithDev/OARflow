# Codex Prompt — UX improvements & missing features (admin + customer)

You are working in the OARFlow repo. This prompt is enhancement work — do it after the bugfix prompts (`codex_prompt_admin_bugfixes.md`, `codex_prompt_customer_pages_bugfixes.md`, `codex_prompt_backend_hardening.md`) have landed. Preserve existing patterns (`OF.api/escape/money/modal/drawer/hasCap`, `statusBadge`, tenant-TZ date handling, `requirePermission`, `logAudit`, `consumeRateLimit`).

Each numbered feature = one commit (or small series). No new dependencies.

---

## Feature 1 — Pagination on core admin lists

**Problem.** Customers backend supports `limit/offset` + returns `total` (`src/routes/admin/customers.js:23-43`, default 50) but the view never pages — only the first 50 customers (alphabetical) are reachable without search. Appointments caps at 50, invoices/estimates hard-cap at 200, all with no indicator.

**Build.** A shared "Load more" (or pager) component in `admin.js` used by `views/customers.js`, `views/appointments.js`, `views/invoices.js`, `views/estimates.js`. Show "Showing X of Y". Wire the existing `limit/offset/total` support; add `total` to any list endpoint missing it.

---

## Feature 2 — Search where the backend already supports it

**Problem.** Invoices and estimates backends support `q` (`src/routes/admin/invoices.js:60`, `src/routes/admin/estimates.js:30`) but the views never render a search input — the plumbed `state.q` is dead code. Documents and follow-ups have no search at all.

**Build.** Add the same search input pattern used in customers/appointments to invoices and estimates. Debounce 300ms, preserve in view state.

---

## Feature 3 — Customer picker in "New appointment"

**Problem.** `views/appointments.js:193-213` — free-text name/email/phone → `findOrCreateCustomer`; typing an existing customer's name creates a duplicate customer. Invoices/estimates/reviews/documents already have a customer-search combobox.

**Build.** Reuse that combobox in the new-appointment modal: pick existing customer OR "new customer" free-text mode. Pass `customerId` when picked (backend already accepts it — verify in `src/routes/admin/appointments.js` and extend if needed).

---

## Feature 4 — Hide/disable actions the role can't perform

**Problem.** Plan create/edit is owner-only server-side (`src/routes/admin/plans.js:46,59`) but shown to managers → 403 after filling the form. "Record payment"/"Void"/"Charge card" need `payments.manage` but staff see the buttons. `OF.hasCap` already exists (`admin.js:180`).

**Build.** Audit every view for mutating buttons; wrap with `OF.hasCap(...)` checks matching the server-side gates (grep each route's `requirePermission`/owner checks and mirror them). Hide, don't just disable, for actions the role can never do.

---

## Feature 5 — Live badge counts + messaging polling

**Problem.** Nav badge counts fetched once at mount (`admin.js:343`) and never refreshed; confirming all requests leaves the stale badge. Inbound SMS never appear without manual reload; opening a thread zeroes unread server-side but the list badge doesn't update.

**Build.**
1. Refresh nav counts on every route change (cheap endpoint already exists).
2. In messaging view: poll the conversation list every ~20s while the view is mounted (clear interval on unmount/navigation); re-render the unread badge after opening a thread.

---

## Feature 6 — Customer self-service: cancel / reschedule-request + add-to-calendar

**Problem.** Booking confirmation (`public/book/index.html:298-313`) and portal show appointments read-only. The confirmation email says "Manage it online anytime" but there's nothing to manage. No public cancel endpoint exists.

**Build.**
1. Backend (`src/routes/public.js`): on the existing appointment-token routes add `POST /api/public/:slug/appointment/:token/cancel` and `POST .../reschedule-request` (message + optional preferred dates → creates a request/follow-up for staff, notifies tenant email). Guard: only future, non-completed appointments; rate-limited; `logAudit`. Respect a tenant setting for minimum cancel notice (add to settings with a sensible default, e.g. 24h).
2. Booking manage view (`/book?appt=…`): render Cancel (with confirm) and "Request a different time" actions, plus an "Add to calendar" .ics download (generate client-side; include tenant name/address, correct TZ).
3. Portal upcoming visits: link each to its manage URL.
4. Admin: surface reschedule requests in the requests/inbox flow.

---

## Feature 7 — Pay with saved card on the public pay page

**Problem.** Portal lists saved payment methods and `chargeInvoiceOnFile` exists (`src/lib/payments.js:128`), but `/pay` always routes through Stripe Checkout with manual entry.

**Build.** On `GET /api/pay/:id`, when the invoice's customer has saved methods, return card summaries (brand/last4). Page offers "Pay with •••• 4242" → `POST /api/pay/:id/charge-saved` (new route calling `chargeInvoiceOnFile`, rate-limited, idempotent per invoice+PM) alongside "Pay with a different card" (existing checkout). Handle the race-fix semantics from the backend-hardening prompt. Also add remove/set-default card actions to the portal (backend helpers `removePaymentMethod`/`setDefaultPaymentMethod` exist — add customer-token-scoped routes).

---

## Feature 8 — Booking date strip: show availability, don't make users hunt

**Problem.** `public/book/index.html:171-176` — up to 120 identical day buttons; users tap day-by-day hunting for openings. `.daybtn.closed` (line 42) is dead CSS. Backend already exposes `GET /api/public/:slug/month` (`src/routes/public.js:56`) — never called.

**Build.** Call the month endpoint as the strip renders (and on scroll into a new month); mark closed/full days with the `.closed` style (disabled), add subtle month labels between segments. Prefetch the next month.

---

## Feature 9 — CSV export/import for core lists

**Problem.** Reports/commissions/compliance export exists, but Customers, Appointments, Invoices lists have none — and there's no customer CSV **import**, the #1 onboarding need when switching tools.

**Build.**
1. Export: `GET /api/admin/{customers,appointments,invoices}/export.csv` honoring current filters, using `src/lib/csv.js`; button on each list view. Gate with the same read permissions as the list.
2. Import: `POST /api/admin/customers/import` accepting CSV (name,email,phone,address,notes), with a dry-run mode returning row-level validation results; modal in customers view with file input → preview table → confirm. Dedupe by email/phone against existing customers; `logAudit` the batch.

---

## Feature 10 — Admin quality-of-life batch

1. **Escape key + scrim:** close topmost modal/drawer on Escape (resolving confirms false); create the `.scrim` element for the mobile sidebar (CSS exists, JS never creates it) with tap-to-close.
2. **Invoice/estimate PDF:** "Download PDF" on the invoice drawer using the existing `pdf-lib` dependency (`src/lib/documents.js` may already have patterns — read it). Simple letterhead from tenant branding, line items, totals, payment status.
3. **Audit log viewer:** backend writes `logAudit` everywhere but nothing reads it. Add owner-only `GET /api/admin/audit` (paginated, filter by entity/actor/date) and a simple Settings-tab table.
4. **Reschedule prefill:** the appointment drawer's reschedule form starts empty — prefill current date/time.
5. **Charge-on-file card picker:** `views/invoices.js:73-77` silently charges the default card; when multiple cards exist show a picker (backend accepts `paymentMethodId`).
6. **404 route in SPA:** unknown `/admin/*` paths render Dashboard (`admin.js:272`); render a "Not found" view instead.

---

## Feature 11 — Marketing site conversion & SEO batch

(Static pages under `public/` + root-synced copies; see `codex_prompt_marketing_site_fixes.md` for the sync rule.)

1. **Analytics:** add a privacy-friendly analytics snippet (Plausible-style single script tag with a placeholder domain, clearly commented) + outbound `tel:` click events on all pages.
2. **Privacy policy:** add `public/privacy.html` on the marketing template (standard local-business policy covering the contact form PII), linked from the footer of every page; the form's "We'll never share your information" line should link to it.
3. **Schema gaps:** add `openingHoursSpecification` (Mon–Sat by appointment), `sameAs` array placeholder, and `BreadcrumbList` JSON-LD on about/services/contact (visible breadcrumbs already exist). Complete Twitter card tags (`twitter:title`/`twitter:description`) on about/services/contact. Remove the obsolete `meta keywords` (index.html:8).
4. **Apple touch icon:** add a 180×180 PNG fallback + `apple-touch-icon` link (favicon is currently SVG-only).
5. **Reviews credibility:** link the testimonials section (index.html:292-300) to the real Google Business Profile ("Read our reviews on Google") — leave a clearly marked placeholder URL for the owner to fill.

---

## Acceptance (whole prompt)

- Customer #51+ reachable via Load more; invoices searchable.
- Manager role sees no owner-only buttons; staff sees no payment buttons.
- A customer can cancel a booking from the manage link and staff see it reflected (status + notification).
- `/pay` offers a saved card when one exists and completes payment without Checkout.
- Booking date strip visually distinguishes closed/full days.
- Customers CSV round-trips: export → edit → import (dry-run shows validation) with no duplicates.
- Marketing pages have analytics, privacy policy, and complete structured data; root copies stay in sync.
