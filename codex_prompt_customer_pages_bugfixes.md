# Codex Prompt — Customer-facing app pages: bug fixes

You are working in the OARFlow repo. These fixes cover the public app pages under `public/` (book, quote, pay, portal, review, document, save-card, field, device) and the backend routes/libs that serve them. Read each file end-to-end before editing; preserve existing patterns (`esc()` escaping, `api()` helpers, tenant-scoped queries, `consumeRateLimit`).

Make each fix a separate commit. No new dependencies.

---

## Fix 1 — Review page is completely dead: JS syntax error (CRITICAL)

**Problem.** `public/review/index.html:73` — the template literal contains double-escaped apostrophes: `'We\\'d be grateful…'`, `'we\\'ll use it…'`, `'you\\'d like…'`. In JS source `\\'` is a backslash followed by a string-terminating quote → `SyntaxError`, the whole inline script fails to parse, and the page shows a permanent loading spinner. **No customer can leave a review.**

**Fix.** Change all three `\\'` to `\'` (or rewrite those strings without apostrophes / use `’`). Load the page and confirm the script parses (`node --check` on the extracted script or open in a browser).

---

## Fix 2 — Field PWA broken when installed: token never read from localStorage

**Problem.** `public/field/index.html:37-38` — the token is saved to `localStorage('oarflow_field_token')` but only ever read from the URL. The manifest `start_url` is `./` with no token, so a technician who installs the PWA gets "Open the link your office sent you" forever.

**Fix.** `const token = new URLSearchParams(location.search).get('token') || (()=>{try{return localStorage.getItem('oarflow_field_token')}catch{return null}})() || '';` — keep the save-on-URL-visit behavior. Also clear the stored token and show the "open your link" message if the API returns 401 (revoked token).

---

## Fix 3 — Field service worker: stale-forever caching + tokens persisted in cache

**Problem.** `public/field/sw.js:12-22`:
1. Cache-first for every same-origin GET under a fixed cache name — deploys never reach installed PWAs unless the version string is bumped manually.
2. URLs containing `?token=<field_token>` are written to Cache Storage — a credential persisted per-URL.
3. The offline catch returns `./index.html` for **any** failed request, including CSS/images.

**Fix.**
1. Network-first (fall back to cache) for navigations and `index.html`; stale-while-revalidate or cache-first is fine for static assets under `/assets/`.
2. Never cache requests whose URL has a `token` search param; for the shell, cache a normalized request with the search stripped and match with `{ ignoreSearch: true }`.
3. Only fall back to `index.html` when `event.request.mode === 'navigate'`.
4. Bump the cache name and delete old caches in `activate`.

---

## Fix 4 — Portal: requested appointments invisible; draft invoices labeled "Paid"

**Problem A.** `src/lib/portal.js:38-41` — bucketing is `(when && when >= now ? upcoming : past)`. Requested appointments have `scheduled_start = null` → they land in `past`, which `public/portal/index.html` never renders. A customer who just submitted a booking request sees "No upcoming visits" — yet the frontend explicitly handles the null case ('Time to be confirmed', portal line 69).

**Fix A.** Bucket null-start appointments with status not in `('completed','canceled','no_show')` into `upcoming`.

**Problem B.** `src/lib/portal.js:44-53` + `public/portal/index.html:70` — the invoice query only excludes `void`, and `payUrl` is null for drafts; the frontend renders "Pay now" if `payUrl` else the literal text "Paid". An unpaid **draft** invoice appears in the customer portal labeled "Paid".

**Fix B.** Exclude drafts in the query (`status NOT IN ('void','draft')`) AND key the frontend label off `i.status`/`balanceCents` (`paid` → "Paid", otherwise show status), not off `payUrl` presence.

**Also while in portal.js:** the tenant object returned to the page omits `timezone` (unlike pay/field/public bootstraps). Add it, and update `public/portal/index.html:35-36` to format dates with `Intl.DateTimeFormat(…, { timeZone })` the way `public/book/index.html` already does. Render the `past` bucket as a "Past visits" section — the backend already computes it.

---

## Fix 5 — Estimate expiry: enforced nowhere server-side, off-by-one client-side

**Problem A (server).** `src/routes/quotes.js:32-44` / `src/lib/estimates.js:39-49` — `POST /api/quotes/:id/accept` never checks `valid_until`. Anyone with the link can accept an expired estimate and auto-create an invoice.

**Fix A.** In `acceptEstimate`, reject when `valid_until` is set and the current date in the tenant's timezone is past it (compare Y-M-D strings computed via `Intl.DateTimeFormat('en-CA',{timeZone})`, consistent with `src/lib/dates.js` helpers). Return a structured error the page can display ("This estimate expired on …").

**Problem B (client).** `public/quote/index.html:70` — `new Date(e.validUntil)` parses as UTC midnight and is compared to local midnight → estimates show "expired" a day early in all US timezones.

**Fix B.** Have the API return an `expired: boolean` computed server-side (tenant TZ) and use that; keep the date string purely for display.

---

## Fix 6 — Multi-tenant: manage links and portal ignore the tenant slug

**Problem.** The booking page resolves tenant via `?t=<slug>` defaulting to `default` (`public/book/index.html:85`), but:
- `src/routes/public.js:141,179` — confirmation emails set `MANAGE_URL: ${config.baseUrl}/book?appt=…` with no `?t=` → for any non-default tenant, `showExisting()` queries `/api/public/default/appointment/:token` and gets "Appointment not found."
- `src/routes/portal.js:21-23` — `request-link` looks up customers only in `getDefaultTenant()`; non-default-tenant customers can never log in to the portal. `portalData.bookUrl` is also slug-less.

**Fix.**
1. Append `&t=${tenant.slug}` to MANAGE_URL in both places in public.js.
2. Portal: accept an optional `t` slug on `/portal` pages/requests (query param, propagated through the magic-link email), falling back to default tenant. Scope the customer lookup to that tenant. Build `bookUrl` with the slug.
3. Booking success screen (`public/book/index.html:284-295`): the API already returns `token` — add a "View or manage this booking" link to `/book?appt=<token>&t=<slug>`.

---

## Fix 7 — Field app: silent failures on flaky connections

**Problem.** `public/field/index.html`:
- Line 63: `openJob` awaits `api()` with no try/catch → infinite spinner on network failure.
- Line 106: photo upload — `if(res.ok){…}` with no else and no catch; oversized (>15 MB decoded cap in `decodeUpload`) or failed uploads give zero feedback while the tech believes photos saved.
- Lines 103-108, 124: `done`/`noshow`/`saveSig` — button disabled then stranded, or no feedback when `r.ok` is false.

**Fix.** Wrap all field API calls in try/catch; show a visible inline error with a Retry button; re-enable buttons on failure. For photos: handle non-ok responses (`res.error`), and downscale client-side before upload (canvas resize to ≤2000px longest edge, JPEG ~0.8) so phone photos fit the 15 MB cap.

---

## Fix 8 — Pay page asserts "paid in full" from a URL parameter

**Problem.** `public/pay/index.html:48` — `?paid=1` (Stripe success redirect) immediately renders "Invoice N is paid in full" without verifying. If the webhook is delayed, this is false; anyone can append `?paid=1` and screenshot a paid page.

**Fix.** On `?paid=1`, show "Payment processing…" and poll `GET /api/pay/:id` (e.g. every 2s, up to ~30s) until `status==='paid'`, then show the paid state; if it never confirms, show "Your payment is being processed — you'll receive a receipt by email" (no false assertion). While in `src/routes/pay.js` / `src/lib/stripe.js:45`: checkout uses `tenant.currency` for `price_data.currency` while the page displays `invoice.currency` — use the invoice's currency.

---

## Fix 9 — Undefined CSS var + unstyled untyped inputs across app pages

**Problem A.** `var(--card)` is used but never defined in `public/assets/app/app.css` (only `--surface` exists) → transparent boxes: `public/quote/index.html:21` (.approve-box), `public/document/index.html:17` (.sign-box), `public/field/index.html:19` (.jobcard).

**Fix A.** Add `--card: <same value as --surface>;` to the `:root` block in app.css (safest single change), or switch the three usages to `var(--surface)`.

**Problem B.** app.css styles inputs only via `input[type=text], input[type=email], …` (app.css:196) which does not match `<input>` without a `type`. Unstyled inputs: quote `#nm` (75), document `#nm` (53), save-card `#nm/#num/#exp/#cvc` (53, 74-76), field `#matPest`/`#signName` (94, 100), device `#i_action` (45).

**Fix B.** Add `input:not([type])` to the selector list in app.css AND add `type="text"` to the listed inputs. Also add a `.pill--serviced` style in `public/device/index.html` (line ~14): the `serviced` status renders an unstyled pill (only ok/activity/damaged/missing are defined).

---

## Fix 10 — Small correctness cleanups (one commit)

1. `public/save-card/index.html:45` — double-escaped tenant name: `fail()` escapes its argument which already contains `esc(d.tenant.name)` → "A&amp;B Pest". Pass the raw name to `fail()`.
2. `public/book/index.html:246` — email validated only for non-emptiness via `alert()`. Use `input.checkValidity()` + inline error text; a typo'd email silently loses the confirmation.
3. `public/book/index.html:148` — `dayList()` adds 86,400,000 ms per day; around DST fall-back this can produce a duplicate calendar day in the tenant TZ. Iterate calendar days via the tenant-TZ `en-CA` formatter instead.
4. `public/quote/index.html:94-95`, `public/document/index.html:71` — decline handlers fire-and-reload with no error feedback; show an error state on non-ok.
5. `public/field/index.html:85,106` — `p.url` / `res.file.url` interpolated into `href`/`src` without `esc()`; and `service_color` injected into style attributes unescaped in portal:69 / field:52. Escape/validate (server already has `hexColor` — reuse pattern client-side or trust-but-escape).
6. `src/routes/public.js:112-130` — instant booking takes `scheduledEnd` from client-supplied `body.slot.end` instead of the matched server slot. Use the matched slot's `end`.

---

## Acceptance (whole prompt)

- Review page renders and a review can be submitted end-to-end.
- Installed field PWA (no token in URL) loads jobs using the stored token; airplane-mode requests show retry UI, not spinners.
- Portal shows a just-requested appointment under Upcoming; no draft invoices appear; no "Paid" label on anything with balance > 0.
- Accepting an expired estimate returns an error server-side.
- A non-default tenant's confirmation email manage-link opens the correct booking.
- `?paid=1` shows "processing" until the server confirms paid.
- Quote/document/field/save-card inputs and cards render with proper backgrounds and input styling.
