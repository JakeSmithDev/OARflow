#!/usr/bin/env node
// Preflight "doctor" — validates go-live configuration, checks DB connectivity
// and migration status, and prints an actionable report. Exits non-zero when
// production-critical issues are present, so it can gate a deploy:
//   npm run doctor              (evaluate for the current NODE_ENV)
//   npm run doctor -- --prod    (evaluate as if NODE_ENV=production)
import { checkConfig } from '../src/lib/preflight.js';
import { config } from '../src/config.js';

const assumeProduction = process.argv.includes('--prod') || config.isProduction;
const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
const tag = (t, c) => `${c}${t}${C.reset}`;

function line(item, color) { console.log(`  ${tag('•', color)} ${item.message}\n      ${C.dim}fix:${C.reset} ${item.fix}`); }

async function dbStatus() {
  try {
    const { query, backendKind } = await import('../src/lib/db.js');
    const kind = await backendKind();
    await query('SELECT 1');
    let applied = null; let pending = null;
    try {
      const { runMigrations } = await import('./migrate.js');
      const s = await runMigrations({ statusOnly: true, quiet: true });
      applied = s.applied.length; pending = s.pending.length;
    } catch { /* status best-effort */ }
    return { ok: true, kind, applied, pending };
  } catch (e) { return { ok: false, error: e.message }; }
}

(async () => {
  console.log(`\n${C.bold}OARFlow doctor${C.reset} ${C.dim}(evaluating as ${assumeProduction ? 'PRODUCTION' : config.env})${C.reset}\n`);
  const pf = checkConfig({ assumeProduction });

  console.log(`${C.bold}Configuration${C.reset}`);
  console.log(`  database: ${pf.info.database}   storage: ${pf.info.storage}   email: ${pf.info.email}   inngest: ${pf.info.inngest}`);
  console.log(`  baseUrl:  ${pf.info.baseUrl}\n`);

  const db = await dbStatus();
  console.log(`${C.bold}Database connectivity${C.reset}`);
  if (db.ok) {
    console.log(`  ${tag('✓', C.green)} connected (${db.kind})${db.applied != null ? ` — ${db.applied} migration(s) applied${db.pending ? `, ${C.yellow}${db.pending} pending${C.reset}` : ''}` : ''}`);
  } else {
    console.log(`  ${tag('✗', C.red)} cannot connect — ${db.error}`);
  }
  console.log('');

  if (pf.critical.length) { console.log(`${C.bold}${tag('CRITICAL', C.red)}${C.reset} (must fix before production)`); pf.critical.forEach((i) => line(i, C.red)); console.log(''); }
  if (pf.warnings.length) { console.log(`${C.bold}${tag('WARNINGS', C.yellow)}${C.reset}`); pf.warnings.forEach((i) => line(i, C.yellow)); console.log(''); }

  const ok = pf.critical.length === 0 && (db.ok || !assumeProduction);
  if (ok && !pf.warnings.length) console.log(`${tag('✓ All clear — ready to go live.', C.green)}\n`);
  else if (ok) console.log(`${tag('✓ No blockers.', C.green)} Review warnings above.\n`);
  else console.log(`${tag('✗ Not production-ready — resolve the CRITICAL items above.', C.red)}\n`);

  process.exit(ok ? 0 : 1);
})();
