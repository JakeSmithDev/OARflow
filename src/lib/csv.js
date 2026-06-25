// Tiny, dependency-free CSV writer. RFC-4180 quoting. Reused by reports and the
// accounting export.
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns: [{ key, label }]; rows: array of objects. Returns a CSV string. */
export function toCsv(columns, rows) {
  const head = columns.map((c) => cell(c.label ?? c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

export default { toCsv };
