// Accounting export layer. Normalizes OARFlow's source-of-truth records
// (invoices + the financial_events ledger) into provider-agnostic accounting
// events, each tied back to an OARFlow record with a STABLE id so re-exports are
// idempotent. Exports CSV (generic journal) and IIF (QuickBooks Desktop) now;
// a future QBO Online sync implements the same `AccountingProvider` interface
// without changing callers — nothing here is hardcoded to QuickBooks.
import { query } from './db.js';
import { toCsv } from './csv.js';

const ACCOUNTS = {
  ar: 'Accounts Receivable',
  income: 'Sales Income',
  tax: 'Sales Tax Payable',
  undeposited: 'Undeposited Funds',
  discounts: 'Discounts',
};

function d2(cents) { return (Number(cents || 0) / 100).toFixed(2); }
function mdy(date) { const d = new Date(date); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`; }

/**
 * Normalized accounting events for a date range. Stable ids: `inv:<id>` and
 * `pay:<financial_event_id>`. Auditable: every row carries refType/refId.
 */
export async function listAccountingEvents(tenant, { from, to, types } = {}) {
  const fromD = from || '1970-01-01';
  const toD = to || new Date().toISOString().slice(0, 10);
  const want = types && types.length ? new Set(types) : null;
  const events = [];

  // Invoices issued (accrual revenue). Use sent_at when present, else created_at.
  if (!want || want.has('invoice')) {
    const inv = await query(
      `SELECT i.id, i.number, i.total_cents, i.subtotal_cents, i.tax_cents, i.discount_cents,
              COALESCE(i.sent_at, i.created_at) AS doc_date, c.name AS customer_name, c.id AS customer_id
         FROM invoices i JOIN customers c ON c.id=i.customer_id
        WHERE i.tenant_id=$1 AND i.status <> 'void'
          AND COALESCE(i.sent_at, i.created_at) >= $2::date AND COALESCE(i.sent_at, i.created_at) < ($3::date + INTERVAL '1 day')
        ORDER BY doc_date, i.id`,
      [tenant.id, fromD, toD],
    );
    for (const r of inv.rows) {
      events.push({
        id: `inv:${r.id}`, date: r.doc_date, type: 'invoice', refType: 'invoice', refId: r.id,
        docNumber: r.number, customerName: r.customer_name, customerId: r.customer_id,
        amountCents: r.total_cents, subtotalCents: r.subtotal_cents, taxCents: r.tax_cents, discountCents: r.discount_cents,
        account: ACCOUNTS.ar, memo: `Invoice ${r.number}`,
      });
    }
  }

  // Payments + refunds (cash) from the append-only ledger.
  if (!want || want.has('payment') || want.has('refund')) {
    const pays = await query(
      `SELECT fe.id, fe.event_type, fe.amount_cents, fe.method, fe.created_at, fe.note,
              i.number AS invoice_number, c.name AS customer_name, c.id AS customer_id, fe.invoice_id
         FROM financial_events fe
         LEFT JOIN invoices i ON i.id=fe.invoice_id
         LEFT JOIN customers c ON c.id=fe.customer_id
        WHERE fe.tenant_id=$1 AND fe.event_type IN ('payment','refund')
          AND fe.created_at >= $2::date AND fe.created_at < ($3::date + INTERVAL '1 day')
        ORDER BY fe.created_at, fe.id`,
      [tenant.id, fromD, toD],
    );
    for (const r of pays.rows) {
      if (want && !want.has(r.event_type)) continue;
      events.push({
        id: `pay:${r.id}`, date: r.created_at, type: r.event_type, refType: 'financial_event', refId: r.id,
        docNumber: r.invoice_number || `${r.event_type.toUpperCase()}-${r.id}`, customerName: r.customer_name || '', customerId: r.customer_id,
        amountCents: r.amount_cents, method: r.method, account: ACCOUNTS.undeposited, memo: r.note || `${r.event_type} ${r.method || ''}`.trim(),
      });
    }
  }
  events.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.id).localeCompare(b.id));
  return events;
}

export async function accountingSummary(tenant, opts) {
  const events = await listAccountingEvents(tenant, opts);
  const sum = (t) => events.filter((e) => e.type === t).reduce((s, e) => s + e.amountCents, 0);
  return {
    counts: { invoices: events.filter((e) => e.type === 'invoice').length, payments: events.filter((e) => e.type === 'payment').length, refunds: events.filter((e) => e.type === 'refund').length },
    totals: { invoicedCents: sum('invoice'), collectedCents: sum('payment'), refundedCents: sum('refund') },
  };
}

/** Generic transactions CSV (importable by most accounting tools / Excel). */
export function toAccountingCsv(events) {
  const columns = [
    { key: 'date', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'docNumber', label: 'Doc #' },
    { key: 'customerName', label: 'Customer' }, { key: 'memo', label: 'Memo' },
    { key: 'amount', label: 'Amount' }, { key: 'tax', label: 'Tax' }, { key: 'account', label: 'Account' }, { key: 'ref', label: 'OARFlow Ref' },
  ];
  const rows = events.map((e) => ({
    date: mdy(e.date), type: e.type, docNumber: e.docNumber, customerName: e.customerName, memo: e.memo,
    amount: d2(e.amountCents), tax: e.taxCents ? d2(e.taxCents) : '', account: e.account, ref: e.id,
  }));
  return toCsv(columns, rows);
}

/** QuickBooks Desktop IIF (tab-separated, double-entry). */
export function toIif(tenant, events) {
  const lines = [];
  lines.push(['!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'].join('\t'));
  lines.push(['!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'].join('\t'));
  lines.push('!ENDTRNS');
  const clean = (s) => String(s || '').replace(/[\t\r\n]/g, ' ');

  for (const e of events) {
    if (e.type === 'invoice') {
      const total = e.amountCents; const tax = e.taxCents || 0; const income = total - tax;
      lines.push(['TRNS', '', 'INVOICE', mdy(e.date), ACCOUNTS.ar, clean(e.customerName), d2(total), clean(e.docNumber), clean(e.memo)].join('\t'));
      lines.push(['SPL', '', 'INVOICE', mdy(e.date), ACCOUNTS.income, clean(e.customerName), d2(-income), clean(e.docNumber), 'Sales'].join('\t'));
      if (tax) lines.push(['SPL', '', 'INVOICE', mdy(e.date), ACCOUNTS.tax, clean(e.customerName), d2(-tax), clean(e.docNumber), 'Sales tax'].join('\t'));
      lines.push('ENDTRNS');
    } else if (e.type === 'payment' || e.type === 'refund') {
      const amt = e.type === 'refund' ? -Math.abs(e.amountCents) : Math.abs(e.amountCents);
      lines.push(['TRNS', '', 'PAYMENT', mdy(e.date), ACCOUNTS.undeposited, clean(e.customerName), d2(amt), clean(e.docNumber), clean(e.memo)].join('\t'));
      lines.push(['SPL', '', 'PAYMENT', mdy(e.date), ACCOUNTS.ar, clean(e.customerName), d2(-amt), clean(e.docNumber), clean(e.memo)].join('\t'));
      lines.push('ENDTRNS');
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Provider interface. The generic provider exports files; a QBO Online provider
 * (future) implements push()/pull() against Intuit's API behind the same shape.
 */
export function getAccountingProvider(tenant) {
  const mode = tenant?.settings?.integrations?.accounting?.provider || 'export';
  return {
    name: mode,
    supportsSync: false, // becomes true when a live API provider is configured
    async events(opts) { return listAccountingEvents(tenant, opts); },
    async csv(opts) { return toAccountingCsv(await listAccountingEvents(tenant, opts)); },
    async iif(opts) { return toIif(tenant, await listAccountingEvents(tenant, opts)); },
  };
}

export default { listAccountingEvents, accountingSummary, toAccountingCsv, toIif, getAccountingProvider };
