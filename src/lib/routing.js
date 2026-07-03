// Route optimization for a technician's day. Two tiers:
//   • geocoder configured → nearest-neighbor ordering by real coordinates + miles
//   • not configured      → keep time order; still emit a one-tap multi-stop map
//                           link (the map app geocodes the raw addresses)
import { query, queryOne } from './db.js';
import { decryptSecret } from './crypto.js';
import { zonedWallTimeToUtc } from './dates.js';
import { config } from '../config.js';

export function geocodingConfigured(tenant) {
  const g = tenant?.settings?.integrations?.geocoding || {};
  return g.provider && g.provider !== 'none' && Boolean(g.apiKey);
}
function geocodeKey(tenant) {
  const stored = tenant?.settings?.integrations?.geocoding?.apiKey || '';
  return stored ? decryptSecret(stored) : '';
}

const R = 3958.8; // miles
function haversine(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180; const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180; const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Geocode an address via the configured provider. Returns {lat,lng} or null. */
export async function geocode(tenant, address) {
  if (!address || !geocodingConfigured(tenant)) return null;
  const g = tenant.settings.integrations.geocoding; const key = geocodeKey(tenant);
  try {
    if (g.provider === 'mapbox') {
      const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?limit=1&access_token=${key}`;
      const j = await (await fetch(u)).json();
      const c = j?.features?.[0]?.center; return c ? { lat: c[1], lng: c[0] } : null;
    }
    if (g.provider === 'google') {
      const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
      const j = await (await fetch(u)).json();
      const c = j?.results?.[0]?.geometry?.location; return c ? { lat: c.lat, lng: c.lng } : null;
    }
  } catch { /* provider error → treat as no geocode */ }
  return null;
}

/** Google Maps multi-stop directions URL (works without our own geocoder). */
export function mapsUrl(stops, originAddress) {
  const pts = stops.map((s) => s.address).filter(Boolean);
  if (!pts.length) return null;
  const dest = encodeURIComponent(pts[pts.length - 1]);
  const mids = pts.slice(0, -1).map(encodeURIComponent);
  if (originAddress) mids.unshift(encodeURIComponent(originAddress));
  const wp = mids.length ? `&waypoints=${mids.join('%7C')}` : '';
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}${wp}&travelmode=driving`;
}

function nearestNeighbor(start, nodes) {
  const remaining = [...nodes]; const order = []; let cur = start; let miles = 0;
  while (remaining.length) {
    let bi = 0; let bd = Infinity;
    for (let i = 0; i < remaining.length; i += 1) { const d = haversine(cur, remaining[i]); if (d < bd) { bd = d; bi = i; } }
    miles += bd; cur = remaining[bi]; order.push(remaining[bi]); remaining.splice(bi, 1);
  }
  return { order, miles };
}

/**
 * Build a technician's optimized route for a day.
 * @returns { stops, optimized, reason?, totalMiles?, mapsUrl }
 */
export async function optimizeRoute(tenant, { technicianId, date }) {
  const dayStart = zonedWallTimeToUtc(date, '00:00', tenant.timezone);
  const from = dayStart.toISOString();
  const to = new Date(dayStart.getTime() + 86_400_000).toISOString();
  const r = await query(
    `SELECT a.id, a.scheduled_start, a.service_address, a.service_lat, a.service_lng, c.name AS customer_name, c.phone AS customer_phone
       FROM appointment_assignments aa JOIN appointments a ON a.id=aa.appointment_id JOIN customers c ON c.id=a.customer_id
      WHERE aa.tenant_id=$1 AND aa.technician_id=$2 AND a.scheduled_start >= $3 AND a.scheduled_start < $4 AND a.status <> 'canceled'
      ORDER BY a.scheduled_start`,
    [tenant.id, technicianId, from, to],
  );
  let stops = r.rows.map((x) => ({
    appointmentId: x.id, time: x.scheduled_start, customerName: x.customer_name, phone: x.customer_phone,
    address: x.service_address, lat: x.service_lat != null ? Number(x.service_lat) : null, lng: x.service_lng != null ? Number(x.service_lng) : null,
  }));

  const office = tenant.address || null;
  let optimized = false; let reason; let totalMiles;

  if (geocodingConfigured(tenant) && stops.length > 1) {
    // Geocode any missing coordinates (and persist them).
    for (const s of stops) {
      if ((s.lat == null || s.lng == null) && s.address) {
        const g = await geocode(tenant, s.address);
        if (g) { s.lat = g.lat; s.lng = g.lng; await query('UPDATE appointments SET service_lat=$2, service_lng=$3 WHERE id=$1', [s.appointmentId, g.lat, g.lng]).catch(() => {}); }
      }
    }
    const geocoded = stops.filter((s) => s.lat != null && s.lng != null);
    if (geocoded.length === stops.length) {
      const start = office ? await geocode(tenant, office) : geocoded[0];
      const { order, miles } = nearestNeighbor(start || geocoded[0], geocoded);
      stops = order; optimized = true; totalMiles = Math.round(miles * 10) / 10;
    } else { reason = 'Some stops could not be geocoded; showing time order.'; }
  } else if (stops.length > 1) {
    reason = 'Geocoding not configured; showing time order. The map link still routes all stops.';
  }

  return { stops, optimized, reason, totalMiles, mapsUrl: mapsUrl(stops, office) };
}

export default { geocodingConfigured, geocode, mapsUrl, optimizeRoute };
