# Codex Prompt — Admin UI bug fixes

You are working in the OARFlow repo. Admin SPA: `public/admin/index.html`, `public/admin/login.html`, shell/router `public/assets/app/admin.js`, views in `public/assets/app/views/*.js`, styles `public/assets/app/app.css`. Backend: `src/routes/admin/*.js`. Read files end-to-end first; preserve existing patterns (`OF.api`, `OF.escape`, `OF.money`, `OF.modal/confirm/drawer`, `statusBadge`, tenant-TZ formatting via `Intl.DateTimeFormat('en-CA',{timeZone:OF.tenant.timezone})`).

Make each fix a separate commit. No new dependencies.

---

## Fix 1 — Open redirect on login (security)

**Problem.** `public/admin/login.html:83` — `const next = new URLSearchParams(location.search).get('next') || '/admin/'; location.href = next;`. `?next=https://evil.com` redirects after successful login — phishing-grade.

**Fix.** Only follow `next` when it's a same-origin path starting with `/admin` and not starting with `//` or containing `\`: otherwise use `/admin/`. E.g. `const safe = next.startsWith('/admin') && !next.startsWith('//') ? next : '/admin/';`

---

## Fix 2 — XSS in device QR print window

**Problem.** `public/assets/app/views/customers.js:114-121` (`printQr`) — `label` comes from `dataset.label` (entity-decoded raw user input) and is interpolated unescaped into `<title>${label}</title>` via `document.write` into a same-origin window; the `<h2>` only escapes `<`. A device label like `</title><script>…` executes with opener access. Staff-entered, but crosses privilege boundaries between admin users.

**Fix.** Escape with `OF.escape` everywhere the label is interpolated (title and body), or build the print document with DOM APIs (`doc.title = label; el.textContent = label`).

---

## Fix 3 — `OF.confirm` hangs forever on backdrop dismiss

**Problem.** `public/assets/app/admin.js:135-143` — `OF.modal` closes on overlay click (line 119) but `OF.confirm` only resolves via `[data-ok]`/`[data-close]`. Dismissing via backdrop removes the dialog and leaves the awaiting caller hung. Concrete symptom: `views/requests.js:36-45` disables the Confirm button ("Confirming…") before `await OF.confirm(...)`; backdrop-dismiss strands it disabled forever.

**Fix.** Make the overlay-click close path resolve the pending confirm promise with `false` (e.g. `OF.modal` accepts an `onClose` callback that `OF.confirm` uses to resolve). Verify Escape-key close (if added) resolves too.

---

## Fix 4 — SPA render race clobbers the current view

**Problem.** `public/assets/app/admin.js:284-310` — `routeSeq` is checked after the dynamic `import()` but not after `cfg.render()`'s own awaited fetches. Navigating Dashboard → Customers quickly lets dashboard's late `root.innerHTML = …` overwrite the customers view.

**Fix.** Give each navigation a fresh child container element; after `render()` resolves (and inside any async continuation), only attach/keep it if `seq === routeSeq`. Simplest: pass the container to render, and after awaiting render, check seq before swapping it into `#content`; views that write later should write to their captured container (which is detached if superseded — harmless).

---

## Fix 5 — Settings saves silently wipe stored integration values

**Problem.**
- SMS: the view always sends `messagingServiceSid: #sm_mss.value.trim()` and the input is never prefilled → every SMS save erases a stored Messaging Service SID unless retyped. Backend `src/routes/admin/settings.js:269` writes any `!== undefined` value.
- Email: backend `settings.js:258` does `replyTo: b.replyTo || ''` and the view never sends `replyTo` → saving the From address clears stored reply-to.

**Fix.** Two-sided:
1. Backend: for these integration PATCH-like saves, only write keys actually present in the body (`if (b.replyTo !== undefined)`), never coerce absent → `''`.
2. Frontend (`views/settings.js` ~163-170): prefill current values from the GET (extend the integrations summary response to include the mss / replyTo values, redacted if you prefer — e.g. return them fully since they're not secrets, unlike auth tokens which must stay write-only).

---

## Fix 6 — Missing CSS classes: invoice/estimate builders, Plans, Settings hours, Messaging render unstyled

**Problem.** Zero matches in `public/assets/app/app.css` for classes the views use: `.li-row`, `.tx` (line-item rows — `views/invoices.js:113-118`, `views/estimates.js:98-103`), `.totline`/`.grand` (totals blocks), `.preset-pill`, `.plan-card` (entire Plans grid, `views/plans.js:21-28`), `.daygrid` (Settings weekly hours, `views/settings.js:37`), `.convo-item`/`.convo-item.active` (Messaging selected-conversation highlight, `views/messaging.js:18,46`). These sections render as unstyled stacked elements.

**Fix.** Add the missing rules to app.css, consistent with existing tokens (`--surface`, `--border`, spacing scale). Minimum: grid layout for `.li-row` (label/qty/amount/remove), right-aligned `.totline` with bold `.grand`, pill styling for `.preset-pill`, card styling + hover for `.plan-card` (including `button.plan-card` reset), 7-column `.daygrid` rows, and background/active state for `.convo-item`.

---

## Fix 7 — Reports: accounting export card empty on first visit

**Problem.** `public/assets/app/views/reports.js:83-99` — `render()` awaits `loadKpis()` and `run()` but never `loadAccounting()`; `#accounting` stays empty until a filter is touched.

**Fix.** Call `await loadAccounting()` in render alongside the others.

---

## Fix 8 — "New appointment" prefill dropped

**Problem.** `views/appointments.js:225` — `if (OF.qs('new')) newAppointment();` ignores the `name` param, but `views/customers.js:32` and `views/receptionist.js:61` link to `/admin/appointments?new=1&name=<encoded>` expecting prefill (`newAppointment(prefill)` supports it).

**Fix.** `if (OF.qs('new')) newAppointment({ name: OF.qs('name') || '' });`

---

## Fix 9 — Schedule opens on wrong day for non-Eastern tenants

**Problem.** `views/schedule.js:8` — initial `cursor` uses hardcoded `'America/New_York'` while everything else uses `OF.tenant.timezone`.

**Fix.** Use the same tenant-TZ `en-CA` formatter as `todayYmd()` (line 16). Views load after the session, so `OF.tenant` is available.

---

## Fix 10 — Messaging: failed send loses the typed message

**Problem.** `views/messaging.js:31-36` — `comp.value = ''` before the `await`; on failure the text is gone (SMS failures are common: opt-outs, unconfigured Twilio).

**Fix.** Clear the composer only after the send succeeds; on error restore focus and keep the text, show the error toast.

---

## Fix 11 — "Save & send" duplicates records on send failure

**Problem.** `views/invoices.js:148-160`, `views/estimates.js:132-144`, `views/documents.js:87-91` — create succeeds, then `/send` throws (e.g. customer has no email → 400 from `src/routes/admin/invoices.js:146`); the modal stays open without an `editId`, so clicking again creates a duplicate.

**Fix.** When create succeeds but send fails: close the modal, open the drawer of the created record, and toast "Saved as draft — send failed: <error>". (Or set the modal into edit mode with the created id; either prevents duplicates.)

---

## Fix 12 — Requests with zero proposed slots are a dead end

**Problem.** `views/requests.js:18-21` disables Confirm until a slot is picked; the appointment drawer (`views/appointments.js:72-74`) shows "No proposed times" with a permanently disabled Confirm. Backend supports confirming with explicit `{date,time}` (`src/routes/admin/appointments.js:330-332`).

**Fix.** When `slots.length === 0` (and optionally always, as an "other time" option), render date + time inputs in the confirm card and send `{date,time}`.

---

## Fix 13 — Small admin fixes (one commit)

1. `views/appointments.js:33-34` — add a `no_show` filter chip (backend counts and filter already support it).
2. `admin.js:59-68` — extend the STATUS badge map: `accepted`, `declined`, `converted`, `signed`, `responded` (and voice call statuses) currently render as raw gray text.
3. `views/dashboard.js:13`, `views/appointments.js:42,145`, `views/requests.js:12` — `service_color` interpolated raw; renders `background:null1a` when no service. Use the `OF.color` fallback helper like schedule.js does.
4. `views/reports.js:6`, `views/compliance.js:23` — date ranges built with local `toISOString()` → off-by-one for non-UTC-aligned locales; `views/dashboard.js:19` subtitle uses browser TZ. Use the tenant-TZ `en-CA` pattern.
5. `views/plans.js:43` — subscription Pause/Cancel fire on a single click; wrap Cancel (at least) in `OF.confirm`.
6. `admin.js:326-343` — cached sessionStorage shell is never re-rendered after the fresh `/auth/session` returns; diff and re-render nav/branding when they changed.
7. `views/followups.js:58` — tab click double-renders (handler calls `renderTabs` which renders, then renders again).
8. `views/commissions.js:31` — accrued rows show a badge labeled "Sent" (`e.status==='paid'?'paid':'sent'`); map `accrued` to its own label. Also expose the already-supported `technicianId` filter as a select.

---

## Acceptance (whole prompt)

- `?next=https://evil.com` on login lands on `/admin/`.
- Backdrop-dismissing any confirm resolves false; the requests Confirm button re-enables.
- Rapid Dashboard→Customers navigation never shows dashboard content on the customers route.
- Saving SMS settings without retyping the Messaging Service SID preserves it; saving email From preserves reply-to.
- Invoice builder line items, Plans grid, Settings weekly hours, and Messaging conversation list are visibly styled; selected conversation is highlighted.
- Reports page shows the accounting card on first load.
- A booking request with no proposed slots can be confirmed with a manually chosen date/time.
