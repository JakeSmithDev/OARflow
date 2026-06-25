// Local / portable entry point. Runs the Express app on a real HTTP port.
// Deploy targets that expect a long-running process (Render, Railway, Fly,
// a VM, Docker) use this. Vercel uses api/index.js instead.
import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { backendKind } from './src/lib/db.js';

const app = createApp();

app.listen(config.port, async () => {
  let kind = 'unknown';
  try { kind = await backendKind(); } catch { /* db lazily inits on first query */ }
  console.log(`\n  OARFlow running → ${config.baseUrl}`);
  console.log(`  Admin:   ${config.baseUrl}/admin`);
  console.log(`  Booking: ${config.baseUrl}/book`);
  console.log(`  Database: ${kind}${config.databaseUrl ? '' : ' (PGlite — set DATABASE_URL for Postgres)'}\n`);
});
