// Admin reporting: list reports, run one (JSON), or export it as CSV.
import express from 'express';
import { requireAdmin } from '../../lib/auth.js';
import { requirePermission } from '../../lib/permissions.js';
import { asyncHandler, badRequest } from '../../lib/http.js';
import { listReports, runReport, reportKpis } from '../../lib/reports.js';
import { toCsv } from '../../lib/csv.js';

const router = express.Router();
router.use(requireAdmin());
router.use(requirePermission('reports.view'));

function opts(req) { return { from: req.query.from || undefined, to: req.query.to || undefined }; }

router.get('/', asyncHandler(async (req, res) => {
  res.json({ ok: true, reports: listReports(), kpis: await reportKpis(req.tenant, opts(req)) });
}));

// CSV export — declared before /:key so the .csv suffix isn't swallowed by it.
// Money columns are rendered as plain decimal strings for Excel.
router.get('/:key.csv', asyncHandler(async (req, res) => {
  const key = req.params.key.replace(/\.csv$/, '');
  const out = await runReport(req.tenant, key, opts(req));
  if (!out) return badRequest(res, 'Unknown report.');
  const rows = out.rows.map((r) => {
    const o = {};
    for (const c of out.columns) o[c.key] = c.type === 'money' ? (Number(r[c.key]) / 100).toFixed(2) : r[c.key];
    return o;
  });
  if (out.totals) rows.push(out.columns.reduce((o, c) => { o[c.key] = c.type === 'money' ? (Number(out.totals[c.key] || 0) / 100).toFixed(2) : (out.totals[c.key] ?? ''); return o; }, {}));
  const csv = toCsv(out.columns, rows);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${key}_${(req.query.from || 'all')}_${(req.query.to || 'now')}.csv"`);
  res.send(csv);
}));

router.get('/:key', asyncHandler(async (req, res) => {
  const out = await runReport(req.tenant, req.params.key, opts(req));
  if (!out) return badRequest(res, 'Unknown report.');
  res.json({ ok: true, report: out });
}));

export default router;
