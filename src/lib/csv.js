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

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((h) => String(h || '').trim().toLowerCase());
  return rows.filter((r) => r.some((v) => String(v || '').trim())).map((r, idx) => {
    const obj = { row: idx + 2 };
    headers.forEach((h, i) => { if (h) obj[h] = r[i] == null ? '' : String(r[i]).trim(); });
    return obj;
  });
}

export default { toCsv, parseCsv };
