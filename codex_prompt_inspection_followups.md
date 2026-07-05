# Codex Prompt — Inspection follow-ups (post-review punch list)

You are working in the OARFlow repo. A verification pass of the previous five prompts found the work ~95% correct (smoke suite 163/163). This prompt fixes the remaining issues — a few introduced by the new code, a few left open. Read each file end-to-end first; keep existing patterns. One commit per numbered section.

---

## 1 — Spurious `invoice.paid` emitted on overpay rejection (correctness)

**Problem.** `src/routes/stripe_webhook.js:21-25` — `emitInvoicePaidIfInserted` checks `!result?.duplicate && status==='paid'`. When `recordPayment` returns `{invoice, rejected:'overpay'}`, `duplicate` is `undefined` and if the invoice was concurrently paid its status is `paid` → a spurious duplicate `invoice.paid` fires to tenant outbound webhooks.

**Fix.** Emit only when `result.duplicate === false` (i.e. a row was actually inserted). Verify `recordPayment`'s return shape at `src/lib/invoices.js:94,130` and keep the payload unchanged.

---

## 2 — HTML injection in new public notification emails (security)

**Problem.** `src/routes/public.js:397` and `:436` interpolate `customer_name` unescaped into email HTML (`<p>${updated.customer_name} canceled…`). Customer name is attacker-controlled via the public booking form; anyone with an appointment token can trigger these emails. Adjacent lines already escape `reason`/`note` via `htmlEscape`.

**Fix.** Wrap both interpolations in `htmlEscape()`. Grep the whole file for any other raw `customer_name`/user-string interpolation into `html:` payloads and fix those too. Also harden `trimCap` (public.js:47-49) to strip `[\r\n]` — `lead.name` reaches an email `subject` (public.js:222) and newlines are a header-injection surface for direct API callers.

---

## 3 — Field app revoked-token cleanup is dead code

**Problem.** The client clears the stored token on `httpStatus===401` (`public/field/index.html:82`), but every field route returns `notFound()` → **404** for an invalid token (`src/routes/field.js:39,55,…`). A revoked stored token loops "link no longer valid / Retry" forever and is never cleared.

**Fix.** In `src/routes/field.js`, return 401 (`unauthorized` helper in `src/lib/http.js` — add it if missing) when the token itself is invalid/revoked, keeping 404 for valid-token-but-missing-resource cases. Confirm the client path then clears localStorage and shows the "open your link" message.

---

## 4 — Root asset copies out of sync

**Problem.** Root HTML pages are byte-identical to `public/` but two referenced assets weren't mirrored:
- `assets/js/script.js` (root) is missing the analytics/tel-event block added to `public/assets/js/script.js`.
- `assets/img/apple-touch-icon.png` doesn't exist at root, yet root pages link it relatively.

**Fix.** Copy both files to the root `assets/` tree. Then add a guard: extend `npm run smoke` (or add a tiny script) that diffs each root-synced file against its `public/` counterpart and fails on drift, so this class of miss can't recur.

---

## 5 — Residual SPA render race via colliding element ids

**Problem.** `public/assets/app/admin.js:430-441` detaches a superseded `viewRoot` (good), but views still write via `document.getElementById('list'|'chips'|'tiles')` after awaits (e.g. `views/customers.js:15`, `views/appointments.js:47-51`, `views/invoices.js:19-27`). Those ids are shared across views, so a stale in-flight `refresh()` resolving after navigation finds the NEW view's `#list` and clobbers it (e.g. customer rows in the appointments list).

**Fix.** Have each view capture its `root` and resolve elements via `root.querySelector('#list')` instead of `document.getElementById`. A detached root then makes stale writes harmless no-ops. Mechanical change across the views that use the shared ids (customers, appointments, invoices, estimates, and any others `grep -l "getElementById('list')" public/assets/app/views` finds).

---

## 6 — Public month endpoint query amplification (perf/DoS)

**Problem.** `GET /api/public/:slug/month?serviceId=…` now runs per-day conflict queries (~60-90 queries per call); the booking page fires one call per visible month (~4 in parallel) on every service change. With the 180/10min IP limit, one IP can drive ~16k queries/10min on an unauthenticated route.

**Fix.** Batch: fetch all appointments/blackouts for the whole month range in one or two queries, then compute per-day availability in memory (the day-level logic already exists — refactor it to accept prefetched conflict data). Target ≤5 queries per month call. Keep the response shape unchanged.

---

## 7 — Small items (one commit)

1. `public/assets/app/admin.js` `OF.customerPicker` — the per-invocation `document` click listener is never removed; remove it in the picker's cleanup/close path (or use `OF.onCleanup`).
2. Rate-limit tuning: save-card GET is 5/10min (5 refreshes locks a customer out); raise to ~20/10min. Field POST is 80/10min shared per IP (photo batches from one crew NAT can hit it); raise to ~300/10min — tokens are already required, the limit is just abuse backstop.
3. Status-badge color suffix: `public/portal/index.html:72` (and any same-pattern site) appends `1a` to a hex color; a 3-digit hex (`#abc`) yields invalid `#abc1a`. Normalize 3-digit hex to 6-digit in the client `hexColor` helper before suffixing.
4. `src/lib/estimates.js:13-14` — `estimateValidUntilYmd` uses `toISOString().slice(0,10)` on Date objects from node-postgres (server-local midnight) → off-by-one on servers east of UTC. Format via the tenant-TZ `en-CA` formatter instead.
5. `public/pay/index.html` saved-card flow — honor the response's `paid`/status flag instead of assuming success shows "paid in full" (mirror the polling logic used for `?paid=1`).
6. `src/lib/payments.js` `setDefaultPaymentMethod` — validates `pmId` only after clearing all defaults; an invalid id leaves no default card. Validate first, then update in one transaction.
7. Nav Requests badge count: include pending public reschedule requests (follow-ups with `created_by='public_reschedule'`) so they're as visible as booking requests.

---

## Acceptance

- Overpay-rejected webhook events emit zero `invoice.paid`.
- `curl` the cancel endpoint with a `<img onerror>` customer name → received email HTML shows escaped entities.
- A revoked field token clears storage and shows the onboarding message (server returns 401).
- `diff -r` of root-synced files vs `public/` counterparts is empty and enforced by the smoke/guard script.
- Rapid Customers→Appointments navigation with throttled network never shows customer rows in the appointments list.
- Month endpoint issues ≤5 queries per call (log/count in a quick manual check).
- `npm run smoke` still passes.
