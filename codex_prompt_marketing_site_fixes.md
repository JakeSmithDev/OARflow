# Codex Prompt — Marketing site bug fixes (Pasterneck static pages)

You are working in the OARFlow repo. The static marketing site lives in `public/` (index.html, about.html, services.html, contact.html, 404.html, assets/css/styles.css, assets/js/script.js). **Important:** root-level `index.html`, `about.html`, `services.html`, `contact.html` are deploy-synced byte-identical copies of the `public/` versions — every change to a `public/` page must be mirrored to the root copy (see git history: "Sync service area updates to served pages").

Make each fix a separate commit. No new dependencies.

---

## Fix 1 — Contact form silently discards every lead (CRITICAL)

**Problem.** `public/contact.html:120` — `<form id="quote-form" action="#" method="post" novalidate>`. The handler in `public/assets/js/script.js:81-115` calls `preventDefault()`, validates, shows "Thanks! Your request has been received," and clears the fields. Nothing is ever submitted anywhere. Customers believe they've contacted the company and never hear back.

**Fix.** Wire the form to the OARFlow backend instead of leaving it dead:

1. Add a public lead endpoint in `src/routes/public.js`: `POST /api/public/:slug/lead` accepting `{ name, phone, email, address, pest, notes }`. Follow the existing patterns in that file (tenant resolution by slug, `consumeRateLimit` per IP, input trimming/length caps, `logAudit`). Store as a follow-up or customer note using existing libs (`src/lib/follow_ups.js` has creation helpers — read it first), and send a notification email to the tenant's notification address via `src/lib/email.js` (mirror how booking-request notifications are sent, see `src/routes/public.js:84+`).
2. In `script.js`, replace the fake success with a real `fetch('/api/public/pasternack/lead', …)`. Keep the existing validation. Show the success panel only on a 2xx response; on failure show an inline error with the phone number as fallback ("Couldn't send — call us at (410) 446-1169").
3. Remove the "TO RECEIVE SUBMISSIONS" HTML comment at contact.html:194-197 once wired.

**Acceptance:** submitting the form creates a visible record in the admin (follow-ups or requests), sends the notification email in dev logs, and a network failure shows an error instead of a fake success.

---

## Fix 2 — Footer headings invisible (navy on navy)

**Problem.** `public/assets/css/styles.css:395` — `.footer h4 { color:#fff; … }` but the footer element's class is `site-footer` (no element has class `footer`). `h4` falls back to `h1,h2,h3,h4 { color: var(--navy) }` (line 67) → `#0a2740` text on the `#0a2740` footer. "Company", "Services", "Get in touch" headings are unreadable on all four pages.

**Fix.** Change the selector to `.site-footer h4`. Check lines around 388-410 for any other `.footer …` selectors with the same mismatch and fix them too.

---

## Fix 3 — 404 page: wrong tenant link, off-brand shell

**Problem.** `public/404.html`:
- Line 17: `href="/book"` — the booking app resolves tenant via `?t=` and defaults to `default`, so this loads the wrong tenant's booking flow. Every other page uses `/book?t=pasternack`.
- The page loads the internal app stylesheet `/assets/app/app.css` instead of `assets/css/styles.css`, has no favicon/header/nav/footer, and a generic `<title>Not found</title>`.

**Fix.** Rebuild 404.html on the marketing template: same `<head>` (favicon, styles.css with version query), site header + footer copied from index.html, links to Home / Services / Contact, and `href="/book?t=pasternack"` for the booking CTA.

---

## Fix 4 — Stylesheet cache-busting only on homepage

**Problem.** `public/index.html:30` loads `assets/css/styles.css?v=20260625-4`; about/services/contact load the bare path. `vercel.json` sets `Cache-Control: max-age=86400` on `/assets/(.*)`, so CSS deploys skew: homepage gets new CSS while other pages serve day-old cached CSS (or vice versa).

**Fix.** Apply the same `?v=` query string on all pages (about.html:26, services.html:25, contact.html:25, plus the rebuilt 404.html), and bump it in this change. Mirror to root copies.

---

## Fix 5 — Form accessibility

**Problem.** `public/contact.html:124-189` + `script.js:77-79`: required inputs use a custom `data-required` attribute with no `required`/`aria-required`; error `<span class="err">` messages have no `id`/`aria-describedby` linkage; invalid inputs never get `aria-invalid="true"`. Screen-reader users get no error feedback.

**Fix.**
1. Add `required` and `aria-required="true"` to required inputs (keep `novalidate` on the form so the custom UI still runs).
2. Give each `.err` span an id (`err-name`, `err-phone`, …); add matching `aria-describedby` on inputs.
3. In `setError()` in script.js, toggle `aria-invalid` on the input.
4. While in services.html: FAQ accordion (lines 262-283) — add `id` to each `.faq-a` panel and matching `aria-controls` on its `.faq-q` button (script.js already manages `aria-expanded`).
5. Add `aria-current="page"` to the active nav link on all pages (currently only `class="active"`).

---

## Fix 6 — Mobile header has no phone access

**Problem.** `.nav-cta` (phone + Book buttons) is `display:none` below 940px (styles.css:142,167-171). For a call-driven local service, the phone number is buried behind the hamburger on mobile.

**Fix.** Add a compact phone icon-button (`tel:` link) that shows only below 940px, placed next to the hamburger toggle in the header on all pages. Style it consistently with the existing header buttons. Also add an `sms:` link next to the `tel:` link in the contact page's "Call or text" tile (contact.html:94) — it currently says "text" but only offers `tel:`.

---

## Fix 7 — Plan cards point at the (previously dead) form; unify conversion path

**Problem.** services.html:101/115/127 — all three plan-card "Request a quote" buttons go to contact.html while every other CTA pushes `/book?t=pasternack`.

**Fix.** Make the featured plan's primary CTA "Book online" → `/book?t=pasternack`; keep "Request a quote" as the secondary link (it works after Fix 1). Mirror to root copy.

---

## Fix 8 — Contrast + preload nits

1. `styles.css:133` — `.brand-text span` uses `#8499a c`-range slate at 0.72rem (~2.9:1 on white, fails WCAG AA). Darken to ~`#5f7488`. Audit other small-text uses of `--slate-300`.
2. `styles.css:402` — `.footer-bottom` `rgba(255,255,255,.55)` is borderline; raise to `.72`.
3. `public/index.html:29` — the image preload `<link>` has `imagesrcset` but no `href`; add `href="assets/img/photos/hero-yard-2048.webp"` as fallback.

---

## Acceptance (whole prompt)

- `grep -c 'site-footer h4' public/assets/css/styles.css` ≥ 1; no remaining `.footer h4` selector.
- All four marketing pages + 404 load styles.css with the same `?v=` string.
- Root copies diff-identical to `public/` copies after changes (`diff index.html public/index.html` etc. is empty).
- Contact form performs a real POST; success only on 2xx.
- No booking link anywhere on the marketing pages or 404 without `?t=pasternack`.
