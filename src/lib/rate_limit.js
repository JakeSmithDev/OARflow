// Simple DB-backed sliding-window rate limiter for public endpoints.
import { query } from './db.js';

export async function consumeRateLimit({ ip, endpoint, windowMinutes = 10, maxCount = 30 }) {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM rate_limits WHERE ip = $1 AND endpoint = $2 AND created_at > $3',
    [ip, endpoint, since],
  );
  const attempts = rows[0].n;
  if (attempts >= maxCount) {
    return { allowed: false, attempts, retryAfterSeconds: windowMinutes * 60 };
  }
  await query('INSERT INTO rate_limits (ip, endpoint) VALUES ($1, $2)', [ip, endpoint]);
  // Opportunistic cleanup (~3% of calls) of rows older than a day.
  if (Math.random() < 0.03) {
    await query("DELETE FROM rate_limits WHERE created_at < now() - INTERVAL '1 day'").catch(() => {});
  }
  return { allowed: true, attempts: attempts + 1, retryAfterSeconds: null };
}

export default { consumeRateLimit };
