// Scheduled jobs. Invoked by Vercel cron (vercel.json) or any external
// scheduler. Protected by a cron key (header/query) or Vercel's bearer secret.
//
// IMPORTANT: there are deliberately NO balance/invoice reminder jobs here.
// Invoices are only ever sent when staff request it from the dashboard.
import express from 'express';
import { asyncHandler } from '../lib/http.js';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { getTenantById } from '../lib/tenants.js';
import { generateDueCycles } from '../lib/recurring.js';
import { processDueFollowUps } from '../lib/follow_ups.js';

const router = express.Router();

function authorized(req) {
  const key = req.headers['x-cron-key'] || req.query.key;
  if (key && key === config.cronKey) return true;
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  return false;
}

async function runDaily() {
  const { rows } = await query('SELECT id FROM tenants WHERE is_active = TRUE');
  const summary = [];
  for (const { id } of rows) {
    const tenant = await getTenantById(id);
    const cycles = await generateDueCycles(tenant).catch((e) => ({ error: e.message }));
    const followups = await processDueFollowUps(tenant).catch((e) => ({ error: e.message }));
    summary.push({ tenant: id, cycles, followups });
  }
  return summary;
}

const handler = asyncHandler(async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized cron request.' });
  const summary = await runDaily();
  res.json({ ok: true, ranAt: new Date().toISOString(), summary });
});

router.get('/daily', handler);
router.post('/daily', handler);

export default router;
