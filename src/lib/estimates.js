// Quotes/estimates. Reuses the invoice totals engine. Accept = clickwrap with
// an immutable snapshot (name + IP + user agent). Convert to a draft invoice
// (and optionally a requested appointment).
import { query, queryOne } from './db.js';
import { randomToken } from './crypto.js';
import { nextEstimateNumber } from './tenants.js';
import { computeTotals, createInvoice } from './invoices.js';
import { addDays, ymdInTimeZone } from './dates.js';

export function estimateValidUntilYmd(value, timeZone = 'UTC') {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : ymdInTimeZone(d, timeZone);
}

export function estimateExpired(tenant, estimate, now = new Date()) {
  const validUntil = estimateValidUntilYmd(estimate?.valid_until, tenant.timezone);
  return Boolean(validUntil && ymdInTimeZone(now, tenant.timezone) > validUntil);
}

export async function createEstimate(tenant, data, createdBy) {
  const totals = computeTotals(data.lineItems, data.taxRatePercent ?? tenant.settings.invoicing.taxRatePercent, data.discountCents);
  const number = await nextEstimateNumber(tenant.id);
  const validUntil = data.validUntil || ymdInTimeZone(addDays(new Date(), 30), tenant.timezone);
  return queryOne(
    `INSERT INTO estimates (tenant_id, customer_id, service_type_id, number, status, currency, line_items,
       subtotal_cents, discount_cents, tax_rate_percent, tax_cents, total_cents, notes, terms, valid_until, access_token, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [tenant.id, data.customerId, data.serviceTypeId || null, number, tenant.currency, JSON.stringify(totals.items),
     totals.subtotalCents, totals.discountCents, data.taxRatePercent ?? tenant.settings.invoicing.taxRatePercent, totals.taxCents, totals.totalCents,
     data.notes || null, data.terms || tenant.settings.invoicing.terms || null, validUntil, randomToken(), createdBy || null],
  );
}

export async function updateEstimate(tenant, id, data) {
  const e = await queryOne('SELECT * FROM estimates WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
  if (!e) return null;
  if (['accepted', 'converted'].includes(e.status)) throw new Error('Accepted/converted estimates cannot be edited.');
  const totals = computeTotals(data.lineItems ?? e.line_items, data.taxRatePercent ?? e.tax_rate_percent, data.discountCents ?? e.discount_cents);
  return queryOne(
    `UPDATE estimates SET line_items=$3::jsonb, subtotal_cents=$4, discount_cents=$5, tax_rate_percent=$6, tax_cents=$7,
       total_cents=$8, notes=COALESCE($9,notes), terms=COALESCE($10,terms), valid_until=COALESCE($11,valid_until), service_type_id=COALESCE($12,service_type_id), updated_at=now()
     WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [tenant.id, id, JSON.stringify(totals.items), totals.subtotalCents, totals.discountCents,
     data.taxRatePercent ?? e.tax_rate_percent, totals.taxCents, totals.totalCents, data.notes ?? null, data.terms ?? null, data.validUntil ?? null, data.serviceTypeId ?? null],
  );
}

/** Customer accepts (clickwrap). Records an immutable snapshot. */
export async function acceptEstimate(tenant, id, { name, ip, userAgent }) {
  const e = await queryOne('SELECT * FROM estimates WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
  if (!e) return { ok: false, error: 'Not found.' };
  if (e.status === 'accepted' || e.status === 'converted') return { ok: true, already: true, estimate: e };
  if (e.status === 'declined') return { ok: false, error: 'This estimate was declined.' };
  if (estimateExpired(tenant, e)) {
    const validUntil = estimateValidUntilYmd(e.valid_until);
    return { ok: false, error: `This estimate expired on ${validUntil}.`, code: 'estimate_expired', expired: true, validUntil };
  }
  const updated = await queryOne(
    "UPDATE estimates SET status='accepted', accepted_at=now(), accepted_name=$3, accepted_ip=$4, accepted_user_agent=$5, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
    [tenant.id, id, name || null, ip || null, userAgent || null],
  );
  return { ok: true, estimate: updated };
}

export async function declineEstimate(tenant, id) {
  return queryOne("UPDATE estimates SET status='declined', declined_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('accepted','converted') RETURNING *", [tenant.id, id]);
}

/**
 * Convert an estimate to a draft invoice. Idempotent AND concurrency-safe via an
 * atomic compare-and-swap "claim": exactly one concurrent caller flips the row to
 * 'converted'; the loser sees it's taken and no-ops. (No nested transaction — so
 * it's safe on both pooled Postgres and the single-connection PGlite, and serverless-friendly.)
 */
export async function convertToInvoice(tenant, id, createdBy) {
  const existing = await queryOne('SELECT * FROM estimates WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
  if (!existing) return { ok: false, error: 'Not found.' };
  if (existing.converted_invoice_id) return { ok: true, invoiceId: existing.converted_invoice_id, already: true };
  const prevStatus = existing.status;
  // Claim: only succeeds if not already converted. Whoever wins this UPDATE owns the conversion.
  const claimed = await queryOne(
    "UPDATE estimates SET status='converted', updated_at=now() WHERE tenant_id=$1 AND id=$2 AND converted_invoice_id IS NULL AND status<>'converted' RETURNING id",
    [tenant.id, id],
  );
  if (!claimed) {
    const e = await queryOne('SELECT converted_invoice_id FROM estimates WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
    return { ok: true, invoiceId: e?.converted_invoice_id || null, already: true };
  }
  let inv;
  try {
    inv = await createInvoice(tenant, {
      customerId: existing.customer_id, lineItems: existing.line_items, taxRatePercent: existing.tax_rate_percent, discountCents: existing.discount_cents,
      notes: existing.notes, terms: existing.terms,
    }, createdBy);
  } catch (err) {
    // Roll the claim back so a transient failure doesn't strand the estimate.
    await query('UPDATE estimates SET status=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND converted_invoice_id IS NULL', [tenant.id, id, prevStatus]).catch(() => {});
    throw err;
  }
  await query('UPDATE estimates SET converted_invoice_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenant.id, id, inv.id]);
  return { ok: true, invoiceId: inv.id, invoice: inv };
}

export default { createEstimate, updateEstimate, acceptEstimate, declineEstimate, convertToInvoice, estimateExpired, estimateValidUntilYmd };
