// Migration runner. Applies db/migrations/*.sql in lexicographic order and
// records applied files in schema_migrations. Works against Postgres (pg) or
// the PGlite fallback transparently.
//
//   npm run migrate          apply all pending migrations
//   npm run migrate:status   show applied / pending
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query, exec, backendKind, closeDb } from '../src/lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function ensureTable() {
  await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
}

async function appliedSet() {
  const { rows } = await query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export async function runMigrations({ statusOnly = false, quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const kind = await backendKind();
  log(`Database backend: ${kind}`);
  await ensureTable();
  const applied = await appliedSet();
  const files = listMigrations();

  if (statusOnly) {
    for (const f of files) log(`${applied.has(f) ? '[applied]' : '[pending]'} ${f}`);
    return { applied: [...applied], pending: files.filter((f) => !applied.has(f)) };
  }

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) { log(`[skip]  ${file}`); continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (!quiet) process.stdout.write(`[apply] ${file} ... `);
    try {
      await exec(sql);
      await query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      count += 1;
      log('ok');
    } catch (err) {
      log('FAILED');
      console.error(err);
      throw err;
    }
  }
  log(`Done. Applied ${count} migration(s).`);
  return { count };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runMigrations({ statusOnly: process.argv.includes('--status') })
    .then(async () => { await closeDb(); process.exit(0); })
    .catch(async () => { await closeDb(); process.exit(1); });
}
