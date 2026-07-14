// Daily route planning and safe auto-dispatch.
//
// Precise routing uses persisted/geocoded coordinates when a Google or Mapbox
// key is configured. Without one, the planner still groups stops by shared ZIP,
// city, and address tokens, then emits a multi-stop Google Maps link so the map
// app can resolve the final roads.
import { query, withTx } from './db.js';
import { decryptSecret } from './crypto.js';
import { zonedWallTimeToUtc } from './dates.js';
import { findTechnicianConflict } from './technicians.js';

export function geocodingConfigured(tenant) {
  const g = tenant?.settings?.integrations?.geocoding || {};
  return ['google', 'mapbox'].includes(g.provider) && Boolean(g.apiKey);
}

function geocodeKey(tenant) {
  const stored = tenant?.settings?.integrations?.geocoding?.apiKey || '';
  return stored ? decryptSecret(stored) : '';
}

const EARTH_RADIUS_MILES = 3958.8;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/** Geocode an address via the configured provider. Returns {lat,lng} or null. */
export async function geocode(tenant, address) {
  if (!address || !geocodingConfigured(tenant)) return null;
  const g = tenant.settings.integrations.geocoding;
  const key = geocodeKey(tenant);
  try {
    if (g.provider === 'mapbox') {
      const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?limit=1&access_token=${key}`;
      const response = await fetch(u);
      if (!response.ok) return null;
      const j = await response.json();
      const c = j?.features?.[0]?.center;
      return c ? { lat: c[1], lng: c[0] } : null;
    }
    if (g.provider === 'google') {
      const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
      const response = await fetch(u);
      if (!response.ok) return null;
      const j = await response.json();
      const c = j?.results?.[0]?.geometry?.location;
      return c ? { lat: c.lat, lng: c.lng } : null;
    }
  } catch { /* provider error -> use address-based grouping */ }
  return null;
}

/** Google Maps multi-stop directions URL (works without our own geocoder). */
export function mapsUrl(stops, originAddress) {
  const pts = stops.map((s) => s.address).filter(Boolean);
  if (!pts.length) return null;
  const destination = encodeURIComponent(pts[pts.length - 1]);
  const waypoints = pts.slice(0, -1).map(encodeURIComponent);
  const origin = originAddress ? `&origin=${encodeURIComponent(originAddress)}` : '';
  const via = waypoints.length ? `&waypoints=${waypoints.join('%7C')}` : '';
  return `https://www.google.com/maps/dir/?api=1${origin}&destination=${destination}${via}&travelmode=driving`;
}

function normalizedAddress(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/\b(street|avenue|road|drive|lane|boulevard|court|highway|parkway)\b/g, (v) => ({
      street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', boulevard: 'blvd',
      court: 'ct', highway: 'hwy', parkway: 'pkwy',
    })[v])
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function addressMeta(address) {
  const raw = String(address || '');
  const normalized = normalizedAddress(raw);
  const zip = (raw.match(/\b\d{5}(?:-\d{4})?\b/) || [])[0]?.slice(0, 5) || '';
  const parts = raw.toLowerCase().split(',').map((x) => normalizedAddress(x)).filter(Boolean);
  const tokens = new Set(normalized.split(' ').filter((x) => x.length > 1 && !/^\d+$/.test(x)));
  const streetNumber = Number.parseInt((normalized.match(/^\d+/) || [])[0], 10);
  return { normalized, zip, parts, tokens, streetNumber: Number.isFinite(streetNumber) ? streetNumber : null };
}

// A deterministic fallback distance when coordinates are unavailable. Values
// are pseudo-miles: only their relative ordering is used for grouping.
export function addressDistance(a, b) {
  const am = a._addressMeta || addressMeta(a.address);
  const bm = b._addressMeta || addressMeta(b.address);
  if (!am.normalized || !bm.normalized) return 25;
  if (am.normalized === bm.normalized) return 0;
  const numberDelta = am.streetNumber != null && bm.streetNumber != null
    ? Math.min(Math.abs(am.streetNumber - bm.streetNumber) / 250, 3)
    : 1;
  if (am.zip && am.zip === bm.zip) return 1 + numberDelta;
  const aLocality = am.parts.slice(-2).join(' ');
  const bLocality = bm.parts.slice(-2).join(' ');
  if (aLocality && aLocality === bLocality) return 4 + numberDelta;
  let common = 0;
  for (const token of am.tokens) if (bm.tokens.has(token)) common += 1;
  const union = new Set([...am.tokens, ...bm.tokens]).size || 1;
  const similarity = common / union;
  return 8 + (1 - similarity) * 12;
}

export function stopDistance(a, b) {
  if (a?.lat != null && a?.lng != null && b?.lat != null && b?.lng != null) return haversine(a, b);
  return addressDistance(a || {}, b || {});
}

function nearestNeighbor(start, nodes) {
  const remaining = [...nodes];
  const order = [];
  let current = start;
  let distance = 0;
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = stopDistance(current, remaining[i]);
      if (d < bestDistance) { bestDistance = d; bestIndex = i; }
    }
    distance += bestDistance;
    current = remaining[bestIndex];
    order.push(current);
    remaining.splice(bestIndex, 1);
  }
  return { order, distance };
}

function addCalendarDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dayBounds(tenant, date) {
  return {
    from: zonedWallTimeToUtc(date, '00:00', tenant.timezone).toISOString(),
    to: zonedWallTimeToUtc(addCalendarDay(date), '00:00', tenant.timezone).toISOString(),
  };
}

function customerAddress(row) {
  return [row.customer_address, row.customer_city, row.customer_state, row.customer_postal_code].filter(Boolean).join(', ');
}

async function dayStops(tenant, date) {
  const { from, to } = dayBounds(tenant, date);
  const r = await query(
    `SELECT a.id, a.status, a.scheduled_start, a.scheduled_end, a.service_address, a.service_lat, a.service_lng,
            (a.scheduled_start >= $2 AND a.scheduled_start < $3) AS in_planning_day,
            c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
            c.city AS customer_city, c.state AS customer_state, c.postal_code AS customer_postal_code,
            aa.technician_id, aa.is_lead
       FROM appointments a
       JOIN customers c ON c.id=a.customer_id
       LEFT JOIN appointment_assignments aa ON aa.appointment_id=a.id AND aa.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 AND a.scheduled_start < $3 AND a.scheduled_end > $2 AND a.status <> 'canceled'
      ORDER BY a.scheduled_start, a.id, aa.is_lead DESC`,
    [tenant.id, from, to],
  );
  const byId = new Map();
  for (const row of r.rows) {
    let stop = byId.get(String(row.id));
    if (!stop) {
      const address = row.service_address || customerAddress(row) || null;
      stop = {
        appointmentId: row.id,
        status: row.status,
        time: row.scheduled_start,
        end: row.scheduled_end,
        customerName: row.customer_name,
        phone: row.customer_phone,
        address,
        lat: row.service_lat != null ? Number(row.service_lat) : null,
        lng: row.service_lng != null ? Number(row.service_lng) : null,
        inPlanningDay: Boolean(row.in_planning_day),
        assignments: [],
        _addressMeta: addressMeta(address),
      };
      byId.set(String(row.id), stop);
    }
    if (row.technician_id != null) {
      stop.assignments.push({ technicianId: Number(row.technician_id), isLead: Boolean(row.is_lead) });
    }
  }
  return [...byId.values()];
}

async function geocodeMissingStops(tenant, stops) {
  if (!geocodingConfigured(tenant)) return;
  for (const stop of stops) {
    if ((stop.lat == null || stop.lng == null) && stop.address) {
      const location = await geocode(tenant, stop.address);
      if (location) {
        stop.lat = location.lat;
        stop.lng = location.lng;
        await query(
          'UPDATE appointments SET service_lat=$3, service_lng=$4 WHERE tenant_id=$1 AND id=$2',
          [tenant.id, stop.appointmentId, location.lat, location.lng],
        ).catch(() => {});
      }
    }
  }
}

function overlaps(a, b) {
  const aStart = new Date(a.time).getTime();
  const aEnd = new Date(a.end || a.time).getTime();
  const bStart = new Date(b.time).getTime();
  const bEnd = new Date(b.end || b.time).getTime();
  return aStart < bEnd && aEnd > bStart;
}

function isolationScore(stop, allStops) {
  const others = allStops.filter((x) => x !== stop);
  if (!others.length) return 0;
  return Math.min(...others.map((x) => stopDistance(stop, x)));
}

/**
 * Allocate unassigned stops into geographically coherent, balanced groups.
 * Existing group stops are fixed anchors and are never moved. A rep is excluded
 * from a proposal when any of their fixed/proposed jobs overlaps the new stop.
 */
export function assignNearbyStops(groups, unassigned) {
  if (!groups.length) return { proposals: [], unplaced: unassigned.map((stop) => ({ stop, reason: 'No technicians selected.' })) };
  const totalLoads = groups.reduce((sum, group) => sum + group.stops.length, 0) + unassigned.length;
  const targetLoad = Math.ceil(totalLoads / groups.length);
  const proposals = [];
  const unplaced = [];
  const ordered = [...unassigned].sort((a, b) => {
    const isolation = isolationScore(b, unassigned) - isolationScore(a, unassigned);
    if (Math.abs(isolation) > 0.0001) return isolation;
    return new Date(a.time) - new Date(b.time) || Number(a.appointmentId) - Number(b.appointmentId);
  });

  for (const stop of ordered) {
    let candidates = groups.filter((group) => !group.stops.some((existing) => overlaps(existing, stop)));
    if (!candidates.length) {
      unplaced.push({ stop, reason: 'Every selected rep already has an overlapping appointment.' });
      continue;
    }
    const belowTarget = candidates.filter((group) => group.stops.length < targetLoad);
    if (belowTarget.length) candidates = belowTarget;
    candidates.sort((a, b) => {
      const score = (group) => {
        // Seed empty reps before adding a second cluster to a busy rep.
        if (!group.stops.length) return -1000 + group.index / 100;
        const proximity = Math.min(...group.stops.map((member) => stopDistance(member, stop)));
        const loadPenalty = group.stops.length * 0.35;
        return proximity + loadPenalty + group.index / 10000;
      };
      return score(a) - score(b);
    });
    const group = candidates[0];
    const proposed = { ...stop, assignment: 'proposed', technicianId: group.technician.id };
    group.stops.push(proposed);
    proposals.push({ appointmentId: stop.appointmentId, technicianId: group.technician.id, scheduledStart: stop.time });
  }
  return { proposals, unplaced };
}

function routeOrder(stops, origin) {
  if (stops.length < 2) return { order: [...stops], distance: 0, optimized: false, totalMiles: null };
  // Appointment windows are commitments: a geographically short route that
  // says to visit a 2pm stop before a 9am stop is not actionable. Sort by start
  // time first and use nearest-neighbor only to break genuinely tied windows.
  const buckets = new Map();
  for (const stop of stops) {
    const key = new Date(stop.time).getTime();
    (buckets.get(key) || (buckets.set(key, []), buckets.get(key))).push(stop);
  }
  const order = [];
  let current = origin;
  for (const time of [...buckets.keys()].sort((a, b) => a - b)) {
    const tied = buckets.get(time).sort((a, b) => Number(a.appointmentId) - Number(b.appointmentId));
    if (tied.length === 1) order.push(tied[0]);
    else if (current) order.push(...nearestNeighbor(current, tied).order);
    else {
      const first = tied.shift();
      order.push(first, ...nearestNeighbor(first, tied).order);
    }
    current = order[order.length - 1];
  }
  let distance = 0;
  let previous = origin;
  let allCoordinates = Boolean(!origin || (origin.lat != null && origin.lng != null));
  for (const stop of order) {
    if (previous) distance += stopDistance(previous, stop);
    if (stop.lat == null || stop.lng == null) allCoordinates = false;
    previous = stop;
  }
  return { order, distance, optimized: true, totalMiles: allCoordinates ? Math.round(distance * 10) / 10 : null };
}

/** Plan all selected technicians' routes without changing assignments. */
export async function planRoutes(tenant, { date, technicianIds = [], includeUnassigned = true } = {}) {
  const requestedIds = [...new Set(technicianIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const params = [tenant.id];
  let selectedSql = '';
  if (requestedIds.length) { params.push(requestedIds); selectedSql = 'AND id = ANY($2::bigint[])'; }
  const techResult = await query(
    `SELECT id, name, color FROM technicians WHERE tenant_id=$1 AND is_active=TRUE ${selectedSql} ORDER BY name`,
    params,
  );
  const technicians = techResult.rows.map((tech) => ({ ...tech, id: Number(tech.id) }));
  const found = new Set(technicians.map((tech) => tech.id));
  const invalidTechnicianIds = requestedIds.filter((id) => !found.has(id));
  if (invalidTechnicianIds.length) return { date, technicians, routes: [], proposals: [], unplaced: [], invalidTechnicianIds };

  const stops = await dayStops(tenant, date);
  await geocodeMissingStops(tenant, stops);
  let origin = tenant.address ? { address: tenant.address, ...addressMeta(tenant.address) } : null;
  if (origin && geocodingConfigured(tenant)) {
    const location = await geocode(tenant, tenant.address);
    if (location) origin = { ...origin, ...location };
  }

  const groups = technicians.map((technician, index) => ({
    technician,
    index,
    stops: stops
      .filter((stop) => stop.assignments.some((a) => a.technicianId === technician.id))
      .map((stop) => ({ ...stop, assignment: 'existing', technicianId: technician.id })),
  }));
  const available = stops.filter((stop) => stop.inPlanningDay && stop.status === 'scheduled' && stop.assignments.length === 0);
  const allocation = includeUnassigned
    ? assignNearbyStops(groups, available)
    : { proposals: [], unplaced: [] };
  const coordinateCount = stops.filter((stop) => stop.lat != null && stop.lng != null).length;
  const method = stops.length && coordinateCount === stops.length ? 'coordinates' : coordinateCount ? 'mixed' : 'address';
  const routes = groups.map((group) => {
    const ordered = routeOrder(group.stops, origin);
    return {
      technician: group.technician,
      stops: ordered.order.map(({ _addressMeta, assignments, inPlanningDay, ...stop }) => stop),
      assignedCount: group.stops.filter((stop) => stop.assignment === 'existing').length,
      proposedCount: group.stops.filter((stop) => stop.assignment === 'proposed').length,
      optimized: ordered.optimized,
      totalMiles: ordered.totalMiles,
      mapsUrl: mapsUrl(ordered.order, tenant.address || null),
    };
  });
  return {
    date,
    technicians,
    routes,
    proposals: allocation.proposals,
    unplaced: allocation.unplaced.map(({ stop, reason }) => ({
      appointmentId: stop.appointmentId,
      customerName: stop.customerName,
      time: stop.time,
      reason,
    })),
    unassignedCount: available.length,
    method,
    geocoder: geocodingConfigured(tenant),
    invalidTechnicianIds: [],
  };
}

/** Apply a fresh route plan, assigning only appointments that remain unassigned. */
export async function applyRouteAssignments(tenant, { date, technicianIds = [] } = {}) {
  const plan = await planRoutes(tenant, { date, technicianIds, includeUnassigned: true });
  if (plan.invalidTechnicianIds.length) return { ...plan, appliedCount: 0, skippedCount: 0 };
  const outcome = await withTx(async (cx) => {
    let appliedCount = 0;
    let skippedCount = 0;
    const techIds = [...new Set(plan.proposals.map((proposal) => proposal.technicianId))].sort((a, b) => a - b);
    if (techIds.length) {
      await cx.query(
        'SELECT id FROM technicians WHERE tenant_id=$1 AND id = ANY($2::bigint[]) AND is_active=TRUE ORDER BY id FOR UPDATE',
        [tenant.id, techIds],
      );
    }
    for (const proposal of plan.proposals) {
      const appt = await cx.query(
        `SELECT id, scheduled_start, scheduled_end FROM appointments
          WHERE tenant_id=$1 AND id=$2 AND status='scheduled' AND scheduled_start=$3
          FOR UPDATE`,
        [tenant.id, proposal.appointmentId, proposal.scheduledStart],
      );
      if (!appt.rows.length) { skippedCount += 1; continue; }
      const assignment = await cx.query(
        'SELECT 1 FROM appointment_assignments WHERE tenant_id=$1 AND appointment_id=$2 LIMIT 1',
        [tenant.id, proposal.appointmentId],
      );
      if (assignment.rows.length) { skippedCount += 1; continue; }
      const current = appt.rows[0];
      const conflict = await findTechnicianConflict(tenant, {
        appointmentId: proposal.appointmentId,
        technicianIds: [proposal.technicianId],
        start: current.scheduled_start,
        end: current.scheduled_end,
      }, cx);
      if (conflict) { skippedCount += 1; continue; }
      await cx.query(
        `INSERT INTO appointment_assignments (tenant_id, appointment_id, technician_id, is_lead)
         VALUES ($1,$2,$3,TRUE)`,
        [tenant.id, proposal.appointmentId, proposal.technicianId],
      );
      appliedCount += 1;
    }
    return { appliedCount, skippedCount };
  });
  const updated = await planRoutes(tenant, { date, technicianIds, includeUnassigned: false });
  return { ...updated, ...outcome };
}

/** Build one technician's current route for backwards compatibility. */
export async function optimizeRoute(tenant, { technicianId, date }) {
  const plan = await planRoutes(tenant, { technicianIds: [technicianId], date, includeUnassigned: false });
  const route = plan.routes[0] || { stops: [], optimized: false, totalMiles: null, mapsUrl: null };
  let reason;
  if (route.stops.length > 1 && plan.method !== 'coordinates') {
    reason = plan.method === 'mixed'
      ? 'Some stops lack coordinates; route order also uses address similarity.'
      : 'Grouped by ZIP, city, and address similarity. Add geocoding for precise mileage.';
  }
  return { stops: route.stops, optimized: route.optimized, reason, totalMiles: route.totalMiles, mapsUrl: route.mapsUrl };
}

export default {
  geocodingConfigured, geocode, mapsUrl, haversine, addressDistance, stopDistance,
  assignNearbyStops, planRoutes, applyRouteAssignments, optimizeRoute,
};
