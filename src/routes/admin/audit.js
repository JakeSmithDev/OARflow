// Owner-only audit log viewer.
import express from 'express';
import { requireAdmin, requireRole } from '../../lib/auth.js';
import { asyncHandler, toInt } from '../../lib/http.js';
import { query, queryOne } from '../../lib/db.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requireRole('owner'));

router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const offset = toInt(req.query.offset) || 0;
  const where = ['tenant_id=$1']; const params = [req.tenant.id];
  if (req.query.entity) { params.push(req.query.entity); where.push(`entity_type=$${params.length}`); }
  if (req.query.actor) { params.push(`%${req.query.actor}%`); where.push(`admin_username ILIKE $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); where.push(`created_at >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); where.push(`created_at < $${params.length}`); }
  const countParams = params.slice();
  params.push(limit); params.push(offset);
  const rows = await query(
    `SELECT id, admin_username, action, entity_type, entity_id, details, created_at
       FROM audit_log WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await queryOne(`SELECT count(*)::int n FROM audit_log WHERE ${where.join(' AND ')}`, countParams);
  res.json({ ok: true, entries: rows.rows, total: total.n });
}));

export default router;
