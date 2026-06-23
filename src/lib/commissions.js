// Commission tracking. Rules accrue commission entries on job completion
// (basis: revenue or flat) and on invoice payment (basis: collected). Accruals
// are idempotent via a per-entry dedupe key, so replays never double-pay.
import { query, queryOne } from './db.js';
import { getAssignments } from './technicians.js';
import { toCsv } from './csv.js';

export async function listRules(tenant, { includeInactive = false } = {}) {
  const r = await query(
    `SELECT cr.*, t.name AS technician_name, s.name AS service_name FROM commission_rules cr
       LEFT JOIN technicians t ON t.id=cr.technician_id LEFT JOIN service_types s ON s.id=cr.service_type_id
      WHERE cr.tenant_id=$1 ${includeInactive ? '' : 'AND cr.is_active=TRUE'} ORDER BY cr.id DESC`,
    [tenant.id],
  );
  return r.rows;
}
export async function createRule(tenant, b) {
  return queryOne(
    `INSERT INTO commission_rules (tenant_id, name, technician_id, service_type_id, basis, percent, flat_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenant.id, b.name || 'Commission', b.technicianId || null, b.serviceTypeId || null, b.basis || 'revenue', Number(b.percent) || 0, Math.round(Number(b.flatCents) || 0)],
  );
}
export async function updateRule(tenant, id, b) {
  const cols = { name: b.name, technician_id: b.technicianId, service_type_id: b.serviceTypeId, basis: b.basis, percent: b.percent, flat_cents: b.flatCents, is_active: b.isActive };
  const sets = []; const params = [id, tenant.id];
  for (const [k, v] of Object.entries(cols)) { if (v !== undefined) { params.push(v); sets.push(`${k}=$${params.length}`); } }
  if (!sets.length) return queryOne('SELECT * FROM commission_rules WHERE id=$1 AND tenant_id=$2', [id, tenant.id]);
  sets.push('updated_at=now()');
  return queryOne(`UPDATE commission_rules SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
}

function amountFor(rule, basisCents) {
  if (rule.basis === 'flat') return rule.flat_cents;
  return Math.round((basisCents * Number(rule.percent)) / 100);
}

async function insertEntry(tenant, { rule, technicianId, appointmentId, invoiceId, basisCents, dedupeKey, note }) {
  const amount = amountFor(rule, basisCents);
  // Idempotent: ON CONFLICT (tenant_id, dedupe_key) DO NOTHING.
  return queryOne(
    `INSERT INTO commission_entries (tenant_id, rule_id, technician_id, appointment_id, invoice_id, basis, basis_cents, amount_cents, dedupe_key, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING *`,
    [tenant.id, rule.id, technicianId, appointmentId || null, invoiceId || null, rule.basis, basisCents, amount, dedupeKey, note || null],
  );
}

async function matchingRules(tenant, { technicianId, serviceTypeId, bases }) {
  const r = await query(
    `SELECT * FROM commission_rules WHERE tenant_id=$1 AND is_active=TRUE AND basis = ANY($2::text[])
       AND (technician_id IS NULL OR technician_id=$3)
       AND (service_type_id IS NULL OR service_type_id=$4)`,
    [tenant.id, bases, technicianId, serviceTypeId || null],
  );
  return r.rows;
}

/** Accrue revenue/flat commissions for each tech assigned to a completed job. */
export async function accrueForAppointment(tenant, appointment) {
  const crew = await getAssignments(tenant, appointment.id);
  if (!crew.length) return { accrued: 0 };
  const basisCents = appointment.price_cents || 0;
  let accrued = 0;
  for (const tech of crew) {
    const rules = await matchingRules(tenant, { technicianId: tech.id, serviceTypeId: appointment.service_type_id, bases: ['revenue', 'flat'] });
    for (const rule of rules) {
      const row = await insertEntry(tenant, { rule, technicianId: tech.id, appointmentId: appointment.id, basisCents, dedupeKey: `appt:${rule.id}:${appointment.id}:${tech.id}`, note: rule.name });
      if (row) accrued += 1;
    }
  }
  return { accrued };
}

/** Accrue collected-basis commissions when an invoice is paid. */
export async function accrueForInvoicePaid(tenant, invoice) {
  if (!invoice.appointment_id) return { accrued: 0 };
  const crew = await getAssignments(tenant, invoice.appointment_id);
  if (!crew.length) return { accrued: 0 };
  const appt = await queryOne('SELECT service_type_id FROM appointments WHERE id=$1 AND tenant_id=$2', [invoice.appointment_id, tenant.id]);
  let accrued = 0;
  for (const tech of crew) {
    const rules = await matchingRules(tenant, { technicianId: tech.id, serviceTypeId: appt?.service_type_id, bases: ['collected'] });
    for (const rule of rules) {
      const row = await insertEntry(tenant, { rule, technicianId: tech.id, appointmentId: invoice.appointment_id, invoiceId: invoice.id, basisCents: invoice.total_cents, dedupeKey: `inv:${rule.id}:${invoice.id}:${tech.id}`, note: rule.name });
      if (row) accrued += 1;
    }
  }
  return { accrued };
}

export async function listEntries(tenant, { status, technicianId, from, to } = {}) {
  const where = ['ce.tenant_id=$1']; const params = [tenant.id];
  if (status && status !== 'all') { params.push(status); where.push(`ce.status=$${params.length}`); }
  if (technicianId) { params.push(technicianId); where.push(`ce.technician_id=$${params.length}`); }
  if (from) { params.push(from); where.push(`ce.accrued_at >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`ce.accrued_at < ($${params.length}::date + INTERVAL '1 day')`); }
  const r = await query(
    `SELECT ce.*, t.name AS technician_name FROM commission_entries ce JOIN technicians t ON t.id=ce.technician_id
      WHERE ${where.join(' AND ')} ORDER BY ce.id DESC LIMIT 500`,
    params,
  );
  return r.rows;
}

export async function commissionSummary(tenant, opts = {}) {
  const entries = await listEntries(tenant, opts);
  const byTech = {};
  for (const e of entries) {
    const k = e.technician_id;
    byTech[k] = byTech[k] || { technicianId: k, technicianName: e.technician_name, accruedCents: 0, paidCents: 0, count: 0 };
    byTech[k].count += 1;
    if (e.status === 'paid') byTech[k].paidCents += e.amount_cents; else byTech[k].accruedCents += e.amount_cents;
  }
  return Object.values(byTech);
}

export async function markPaid(tenant, { technicianId, ids }) {
  if (Array.isArray(ids) && ids.length) {
    await query("UPDATE commission_entries SET status='paid', paid_at=now() WHERE tenant_id=$1 AND id = ANY($2::bigint[]) AND status='accrued'", [tenant.id, ids.map(Number)]);
  } else if (technicianId) {
    await query("UPDATE commission_entries SET status='paid', paid_at=now() WHERE tenant_id=$1 AND technician_id=$2 AND status='accrued'", [tenant.id, technicianId]);
  }
  return { ok: true };
}

export function entriesCsv(entries) {
  const columns = [
    { key: 'date', label: 'Accrued' }, { key: 'technician', label: 'Technician' }, { key: 'basis', label: 'Basis' },
    { key: 'basisAmount', label: 'Basis Amount' }, { key: 'amount', label: 'Commission' }, { key: 'status', label: 'Status' }, { key: 'note', label: 'Note' },
  ];
  const rows = entries.map((e) => ({
    date: new Date(e.accrued_at).toISOString().slice(0, 10), technician: e.technician_name, basis: e.basis,
    basisAmount: (e.basis_cents / 100).toFixed(2), amount: (e.amount_cents / 100).toFixed(2), status: e.status, note: e.note || '',
  }));
  return toCsv(columns, rows);
}

export default { listRules, createRule, updateRule, accrueForAppointment, accrueForInvoicePaid, listEntries, commissionSummary, markPaid, entriesCsv };
