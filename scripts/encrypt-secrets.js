// One-time backfill: encrypt any tenant Stripe secret/webhook-secret that was
// stored as plaintext before encryption-at-rest was introduced. Idempotent —
// already-encrypted values (enc:v1:) are skipped. Run: npm run encrypt-secrets
import { pathToFileURL } from 'node:url';
import { query, closeDb } from '../src/lib/db.js';
import { encryptSecret, isEncrypted } from '../src/lib/crypto.js';

export async function run() {
  const { rows } = await query('SELECT id, slug, settings FROM tenants');
  let changed = 0;
  for (const t of rows) {
    const s = t.settings || {};
    const st = s.integrations && s.integrations.stripe;
    if (!st) continue;
    let mutated = false;
    for (const key of ['secretKey', 'webhookSecret']) {
      const v = st[key];
      if (v && !isEncrypted(v)) { st[key] = encryptSecret(v); mutated = true; }
    }
    if (mutated) {
      await query('UPDATE tenants SET settings=$2::jsonb, updated_at=now() WHERE id=$1', [t.id, JSON.stringify(s)]);
      changed += 1;
      console.log(`  encrypted secrets for tenant ${t.slug} (#${t.id})`);
    }
  }
  console.log(`Done. Re-encrypted secrets for ${changed} tenant(s).`);
  return changed;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().then(async () => { await closeDb(); process.exit(0); }).catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
}
