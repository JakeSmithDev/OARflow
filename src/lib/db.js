// Database access layer.
//
// One uniform surface over two backends:
//   • node-postgres (`pg`)  — used whenever DATABASE_URL is set (Neon, Vercel
//     Postgres, Supabase, local Postgres). This is the production path.
//   • PGlite                — an in-process Postgres (WASM) used when no
//     DATABASE_URL is present, so the app runs with zero external setup.
//
// Both speak Postgres SQL and $1-style params and return `{ rows }`, so the
// rest of the app is backend-agnostic.
import { config } from '../config.js';

let backend = null; // { kind, query(sql, params), tx(fn), close() }
let initPromise = null;

function shouldUseSsl(connectionString) {
  if (/sslmode=disable/.test(connectionString)) return false;
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
  return true;
}

// DATE columns (valid_until, due_date, service_date, next_run_date, …) hold
// calendar dates with no timezone. Both drivers default to parsing them into
// JS Date objects at some midnight (node-postgres: server-local; PGlite: UTC),
// which shifts the calendar day depending on the process timezone. Return the
// raw 'YYYY-MM-DD' string instead — every consumer already handles strings.
const DATE_OID = 1082;

async function createPgBackend() {
  const pg = await import('pg');
  const { Pool, types } = pg.default ?? pg;
  types.setTypeParser(DATE_OID, (v) => v);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: shouldUseSsl(config.databaseUrl) ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });

  return {
    kind: 'postgres',
    async query(sql, params) {
      return pool.query(sql, params);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (sql, params) => client.query(sql, params),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

async function createPgliteBackend() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = config.pgliteDir === 'memory://' ? undefined : config.pgliteDir;
  const options = { parsers: { [DATE_OID]: (v) => v } };
  const db = dir ? new PGlite(dir, options) : new PGlite(options);
  await db.waitReady;

  // PGlite is a single in-process connection. Serialize all operations through
  // a promise chain so overlapping requests can't race the WASM engine.
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    kind: 'pglite',
    async query(sql, params) {
      return exclusive(async () => {
        const res = params && params.length ? await db.query(sql, params) : await db.query(sql);
        return { rows: res.rows ?? [], rowCount: res.affectedRows ?? (res.rows ? res.rows.length : 0) };
      });
    },
    async exec(sql) { return exclusive(() => db.exec(sql)); },
    async tx(fn) {
      return exclusive(() => db.transaction(async (txn) => fn({
        query: async (sql, params) => {
          const res = params && params.length ? await txn.query(sql, params) : await txn.query(sql);
          return { rows: res.rows ?? [], rowCount: res.affectedRows ?? 0 };
        },
      })));
    },
    async close() { await db.close(); },
  };
}

async function init() {
  if (backend) return backend;
  if (!initPromise) {
    initPromise = (async () => {
      backend = config.databaseUrl ? await createPgBackend() : await createPgliteBackend();
      return backend;
    })();
  }
  return initPromise;
}

/** Run a single query. Returns { rows, rowCount }. */
export async function query(sql, params) {
  const b = await init();
  return b.query(sql, params);
}

/** Convenience: return the first row (or null). */
export async function queryOne(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] ?? null;
}

/** Run work inside a transaction. The callback receives a client with `.query`. */
export async function withTx(fn) {
  const b = await init();
  return b.tx(fn);
}

/** Execute a raw multi-statement SQL string (DDL). Used by the migration runner. */
export async function exec(sql) {
  const b = await init();
  if (b.exec) return b.exec(sql);
  return b.query(sql);
}

export async function backendKind() {
  const b = await init();
  return b.kind;
}

export async function closeDb() {
  if (backend) await backend.close();
  backend = null;
  initPromise = null;
}

export default { query, queryOne, withTx, exec, backendKind, closeDb };
