# OARFlow Code Review — 2026-07-03

Full-stack review: marketing site, customer-facing pages, admin SPA, backend. All findings verified against source (file:line refs in the codex prompts). Fixes are batched into four codex prompts, ordered by priority:

| Prompt file | Scope | Highlights |
|---|---|---|
| `codex_prompt_customer_pages_bugfixes.md` | Public app pages | **Review page 100% dead (JS syntax error at review/index.html:73)** · installed field PWA never reads its token back · portal hides just-requested appointments and labels draft invoices "Paid" · field SW caches tokens + never updates · estimate expiry not enforced server-side · manage links broken for non-default tenants · pay page trusts `?paid=1` |
| `codex_prompt_marketing_site_fixes.md` | Static Pasterneck site | **Contact form silently discards every lead (fake success, no submit)** · footer headings navy-on-navy (`.footer h4` vs `.site-footer`) · 404 page links wrong tenant + off-brand · CSS cache-bust skew · a11y + mobile phone CTA |
| `codex_prompt_admin_bugfixes.md` | Admin SPA | Open redirect on login `?next=` · XSS in device QR print · `OF.confirm` hangs on backdrop dismiss · SPA render race clobbers views · settings saves wipe stored SMS SID / reply-to · ~8 CSS classes used by views don't exist (invoice builder, Plans, Settings hours render unstyled) · save&send duplicates records on failure |
| `codex_prompt_backend_hardening.md` | Express/Stripe backend | Stripe webhook ACKs 200 on handler failure (silent payment loss) · online payments never emit `invoice.paid` (commissions/webhooks skipped) · charge-on-file race can capture funds without recording · initial subscription payment missing from ledger · unvalidated tenant timezone can 500 whole tenant · email `primaryColor` injection · no rate limiting on Stripe-cost public endpoints |
| `codex_prompt_ux_features.md` | Enhancements (run last) | Pagination (only first 50 customers reachable!) · customer cancel/reschedule + .ics · pay with saved card · booking calendar availability (month endpoint exists, unused) · CSV import/export · role-aware buttons · live badges · invoice PDF · audit log viewer · analytics + privacy policy |

**What's in good shape (verified non-issues):** no SQL injection (consistently parameterized, allowlisted dynamic columns), tenant scoping solid, `recordPayment` uses FOR UPDATE + ledger totals + idempotency, booking uses advisory locks, session/API/field tokens hashed at rest, Twilio signature verification fails closed in prod, SSRF guard on outbound webhooks, money handling consistently cents-based end to end, XSS escaping (`esc`/`OF.escape`) applied almost everywhere.

**Suggested execution order:** customer-pages bugfixes → marketing fixes → admin bugfixes → backend hardening → UX features. The five fixes to ship today: review-page syntax error, contact form wiring, Stripe webhook 500-on-failure, footer CSS selector, login open redirect.
