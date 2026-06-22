// Admin route optimization: a technician's ordered stops for a day + map link.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { asyncHandler, badRequest, toInt } from '../../lib/http.js';
import { optimizeRoute, geocodingConfigured } from '../../lib/routing.js';

const router = express.Router();
router.use(requireAdmin());

router.get('/', asyncHandler(async (req, res) => {
  const technicianId = toInt(req.query.technicianId);
  const date = String(req.query.date || '');
  if (!technicianId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'technicianId and date (YYYY-MM-DD) are required.');
  const route = await optimizeRoute(req.tenant, { technicianId, date });
  res.json({ ok: true, geocoder: geocodingConfigured(req.tenant), ...route });
}));

export default router;
