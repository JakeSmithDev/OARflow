// Invoice math + lifecycle. The balance is fully customizable: line_items is a
// freely-edited array (seeded from presets). amount_paid is DERIVED from the
// append-only financial_events ledger — never trusted from the client.
import { query, queryOne, withTx } from './db.js';
import { randomToken } from './crypto.js';
import { nextInvoiceNumber } from './tenants.js';

/** Coerce client line items into a normalized shape with computed amounts. */
export function normalizeLineItems(items) {
  return (Array.isArray(items) ? items : []).map((li) => {
    const qty = Number(li.quantity) > 0 ? Number(li.quantity) : 1;
    const unit = Math.round(Number(li.unit_amount_cents) || 0);
    return {
      label: String(li.label || 'Item').slice(0, 200),
      description: li.description ? String(li.description).slice(0, 500) : '',
      quantity: qty,
      unit_amount_cents: unit,
      amount_cents: Math.round(qty * unit),
      taxable: li.taxable !== false,
    };
  });
}

export function computeTotals(lineItems, taxRatePercent = 0, discountCents = 0) {
  const items = normalizeLineItems(lineItems);
  const subtotal = items.reduce((s, li) => s + li.amount_cents, 0);
  const taxableBase = items.filter((li) => li.taxable).reduce((s, li) => s + li.amount_cents, 0);
  const discount = Math.max(0, Math.round(discountCents || 0));
  const rate = Number(taxRatePercent) || 0;
  const tax = Math.round(Math.max(0, taxableBase - discount) * rate / 100);
  const total = Math.max(0, subtotal - discount + tax);
  return { items, subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: total };
}

export async function createInvoice(tenant, data, createdBy) {
  const totals = computeTotals(data.lineItems, data.taxRatePercent ?? tenant.settings.invoicing.taxRatePercent, data.discountCents);
  const number = await nextInvoiceNumber(tenant.id);
  const row = await queryOne(
    `INSERT INTO invoices
       (tenant_id, customer_id, appointment_id, subscription_id, number, status, currency,
        line_items, subtotal_cents, discount_cents, tax_rate_percent, tax_cents, total_cents,
        notes, terms, due_date, access_token, created_by)
     VALUES ($1,$2,$3,$4,$5,'draft',$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      tenant.id, data.customerId, data.appointmentId || null, data.subscriptionId || null, number,
      tenant.currency, JSON.stringify(totals.items), totals.subtotalCents, totals.discountCents,
      data.taxRatePercent ?? tenant.settings.invoicing.taxRatePercent, totals.taxCents, totals.totalCents,
      data.notes || tenant.settings.invoicing.footerNote || null, data.terms || tenant.settings.invoicing.terms || null,
      data.dueDate || null, randomToken(), createdBy || null,
    ],
  );
  return row;
}

export async function updateInvoice(tenant, id, data) {
  const inv = await queryOne('SELECT * FROM invoices WHERE tenant_id=$1 AND id=$2', [tenant.id, id]);
  if (!inv) return null;
  if (inv.status === 'paid' || inv.status === 'void') throw new Error('Paid or void invoices cannot be edited.');
  const totals = computeTotals(
    data.lineItems ?? inv.line_items,
    data.taxRatePercent ?? inv.tax_rate_percent,
    data.discountCents ?? inv.discount_cents,
  );
  const row = await queryOne(
    `UPDATE invoices SET line_items=$3::jsonb, subtotal_cents=$4, discount_cents=$5, tax_rate_percent=$6,
        tax_cents=$7, total_cents=$8, notes=COALESCE($9,notes), terms=COALESCE($10,terms),
        due_date=COALESCE($11,due_date), updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [tenant.id, id, JSON.stringify(totals.items), totals.subtotalCents, totals.discountCents,
     data.taxRatePercent ?? inv.tax_rate_percent, totals.taxCents, totals.totalCents,
     data.notes ?? null, data.terms ?? null, data.dueDate ?? null],
  );
  return row;
}

/** Record a payment/refund in the ledger and recompute the invoice's paid + status. */
export async function recordPayment(tenant, invoiceId, { amountCents, eventType = 'payment', method, note, stripeRef, externalRef, createdBy }) {
  return withTx(async (cx) => {
    // Idempotency: skip if this external ref was already recorded.
    if (externalRef) {
      const dup = await cx.query('SELECT id FROM financial_events WHERE tenant_id=$1 AND external_ref=$2', [tenant.id, externalRef]);
      if (dup.rows.length) {
        const inv = await cx.query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
        return { invoice: inv.rows[0], duplicate: true };
      }
    }
    await cx.query(
      `INSERT INTO financial_events (tenant_id, invoice_id, customer_id, event_type, amount_cents, method, note, stripe_ref, external_ref, created_by)
       SELECT $1,$2,i.customer_id,$3,$4,$5,$6,$7,$8,$9 FROM invoices i WHERE i.id=$2`,
      [tenant.id, invoiceId, eventType, Math.round(amountCents), method || null, note || null, stripeRef || null, externalRef || null, createdBy || null],
    );
    const sum = await cx.query(
      "SELECT COALESCE(SUM(amount_cents),0)::bigint paid FROM financial_events WHERE invoice_id=$1 AND event_type IN ('payment','refund','adjustment')",
      [invoiceId],
    );
    const paid = Number(sum.rows[0].paid);
    const invRow = await cx.query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
    const inv = invRow.rows[0];
    let status = inv.status;
    if (paid >= inv.total_cents && inv.total_cents > 0) status = 'paid';
    else if (paid > 0) status = 'partial';
    else if (inv.sent_at) status = 'sent';
    const updated = await cx.query(
      `UPDATE invoices SET amount_paid_cents=$2, status=$3, paid_at=CASE WHEN $3='paid' AND paid_at IS NULL THEN now() ELSE paid_at END, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [invoiceId, paid, status],
    );
    return { invoice: updated.rows[0], duplicate: false };
  });
}

export function balanceCents(inv) { return Math.max(0, inv.total_cents - inv.amount_paid_cents); }

export default { normalizeLineItems, computeTotals, createInvoice, updateInvoice, recordPayment, balanceCents };
