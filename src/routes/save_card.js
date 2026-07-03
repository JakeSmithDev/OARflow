// Public hosted "add a card on file" page. A business texts/emails the customer
// a tokenized link; the customer enters their card (Stripe Elements in prod, a
// simulated form in dev). No auth — guarded by the per-customer card_token.
import express from 'express';
import { asyncHandler, badRequest, notFound, toInt, getClientIp } from '../lib/http.js';
import { queryOne } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { createSetupIntent, attachFromSetupIntent, attachMockCard, cardsStatus } from '../lib/payments.js';
import { rateLimit } from '../lib/rate_limit.js';

const router = express.Router();
const limitSetupIntent = rateLimit({ endpoint: 'save_card_get', windowMinutes: 10, maxCount: 5 });
const limitSaveCard = rateLimit({ endpoint: 'save_card_post', windowMinutes: 10, maxCount: 10 });

async function load(id, token) {
  const c = await queryOne('SELECT * FROM customers WHERE id=$1', [id]);
  if (!c || !c.card_token || c.card_token !== token) return null;
  return c;
}

router.get('/:id', limitSetupIntent, asyncHandler(async (req, res) => {
  const c = await load(toInt(req.params.id), String(req.query.token || ''));
  if (!c) return notFound(res, 'This link is no longer valid.');
  const tenant = await getTenantById(c.tenant_id);
  const setup = await createSetupIntent(tenant, c);
  res.json({
    ok: true,
    customer: { name: c.name },
    tenant: { name: tenant.name, branding: tenant.settings.branding },
    cards: cardsStatus(tenant),
    setup,
  });
}));

router.post('/:id', limitSaveCard, asyncHandler(async (req, res) => {
  const c = await load(toInt(req.params.id), String((req.body || {}).token || ''));
  if (!c) return notFound(res, 'This link is no longer valid.');
  const tenant = await getTenantById(c.tenant_id);
  const b = req.body || {};
  const consent = { name: b.name || c.name, ip: getClientIp(req), userAgent: req.headers['user-agent'], source: 'online' };
  let r;
  if (b.setupIntentId) r = await attachFromSetupIntent(tenant, c, b.setupIntentId, consent);
  else r = await attachMockCard(tenant, c, { last4: b.last4, brand: b.brand, expMonth: b.expMonth, expYear: b.expYear }, consent);
  if (!r.ok) return badRequest(res, r.error || 'Could not save the card.');
  res.json({ ok: true, last4: r.paymentMethod.last4, brand: r.paymentMethod.brand });
}));

export default router;
