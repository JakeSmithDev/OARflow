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
import { DEFAULT_ROUTING_SETTINGS } from './defaults.js';

export function geocodingConfigured(tenant) {
  const g = tenant?.settings?.integrations?.geocoding || {};
  return ['google', 'mapbox'].includes(g.provider) && Boolean(decryptSecret(g.apiKey || ''));
}

function geocodeKey(tenant) {
  const stored = tenant?.settings?.integrations?.geocoding?.apiKey || '';
  return stored ? decryptSecret(stored) : '';
}

const EARTH_RADIUS_MILES = 3958.8;
const GEOCODE_TIMEOUT_MS = 6_000;
const GEOCODE_PLAN_BUDGET_MS = 5_500;
const MAX_GEOCODES_PER_PLAN = 12;
const GEOCODE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const GEOCODE_FAILURE_TTL_MS = 5 * 60 * 1_000;
const geocodeCache = new Map();

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

const ASSUMPTION_RANGES = Object.freeze({
  averageSpeedMph: [5, 80],
  roadDistanceFactor: [1, 3],
  vehicleMpg: [1, 200],
  fuelPricePerGallon: [0, 25],
});

function safeNumber(value, fallback, [min, max]) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

export function routingAssumptions(tenantOrSettings = {}) {
  const input = tenantOrSettings?.settings?.routing || tenantOrSettings?.routing || tenantOrSettings || {};
  const assumptions = {};
  for (const [key, range] of Object.entries(ASSUMPTION_RANGES)) {
    assumptions[key] = safeNumber(input[key], DEFAULT_ROUTING_SETTINGS[key], range);
  }
  assumptions.includeReturnToBase = typeof input.includeReturnToBase === 'boolean'
    ? input.includeReturnToBase
    : DEFAULT_ROUTING_SETTINGS.includeReturnToBase;
  return assumptions;
}

function coordinate(point) {
  if (point?.lat == null || point?.lng == null) return null;
  const lat = Number(point.lat); const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function round(value, places = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function routePoint(point, kind) {
  const coords = coordinate(point);
  return {
    kind,
    appointmentId: kind === 'stop' ? point.appointmentId : null,
    address: point?.address || null,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
  };
}

function qualityFor(measuredLegCount, totalLegCount) {
  if (!totalLegCount || !measuredLegCount) return 'unavailable';
  return measuredLegCount === totalLegCount ? 'estimate' : 'partial';
}

/**
 * Calculate transparent, keyless route estimates. Geometry is deliberately
 * straight-line GeoJSON; road miles are a configurable multiplier and must be
 * displayed as an estimate, never as live turn-by-turn routing.
 */
export function buildEstimatedRoute(stops = [], origin = null, inputAssumptions = {}) {
  const assumptions = routingAssumptions(inputAssumptions);
  const nodes = [];
  if (origin) nodes.push(routePoint(origin, 'base'));
  for (const stop of stops) nodes.push(routePoint(stop, 'stop'));
  if (assumptions.includeReturnToBase && origin && stops.length) nodes.push(routePoint(origin, 'base'));

  const legs = [];
  let straightLineMiles = 0;
  let estimatedRoadMiles = 0;
  let estimatedDriveMinutes = 0;
  let estimatedFuelGallons = 0;
  let estimatedFuelCostCents = 0;
  let measuredLegCount = 0;
  const fuelPriceCents = Math.round(assumptions.fuelPricePerGallon * 100);

  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1]; const to = nodes[index];
    const fromCoordinate = coordinate(from); const toCoordinate = coordinate(to);
    if (!fromCoordinate || !toCoordinate) {
      legs.push({
        index, from, to, quality: 'unavailable', straightLineMiles: null,
        estimatedRoadMiles: null, estimatedDriveMinutes: null,
        estimatedFuelGallons: null, estimatedFuelCostCents: null,
      });
      continue;
    }
    const direct = haversine(fromCoordinate, toCoordinate);
    const road = direct * assumptions.roadDistanceFactor;
    const driveMinutes = road / assumptions.averageSpeedMph * 60;
    const fuelGallons = road / assumptions.vehicleMpg;
    const fuelCostCents = fuelGallons * fuelPriceCents;
    straightLineMiles += direct;
    estimatedRoadMiles += road;
    estimatedDriveMinutes += driveMinutes;
    estimatedFuelGallons += fuelGallons;
    estimatedFuelCostCents += fuelCostCents;
    measuredLegCount += 1;
    legs.push({
      index, from, to, quality: 'estimate',
      straightLineMiles: round(direct, 1),
      estimatedRoadMiles: round(road, 1),
      estimatedDriveMinutes: Math.round(driveMinutes),
      estimatedFuelGallons: round(fuelGallons, 3),
      estimatedFuelCostCents: Math.round(fuelCostCents),
    });
  }

  const totalLegCount = legs.length;
  const quality = qualityFor(measuredLegCount, totalLegCount);
  // Never bridge across an address whose coordinates are missing. A complete
  // route is one LineString; a partial route is a set of only the measurable,
  // adjacent legs so the map cannot imply a false A → C hop over missing B.
  const completeCoordinates = nodes.map((node) => coordinate(node) ? [node.lng, node.lat] : null);
  const measuredLines = legs
    .filter((leg) => leg.quality === 'estimate')
    .map((leg) => [[leg.from.lng, leg.from.lat], [leg.to.lng, leg.to.lat]]);
  let geometry = null;
  if (quality === 'estimate' && completeCoordinates.length >= 2) {
    geometry = { type: 'LineString', coordinates: completeCoordinates };
  } else if (measuredLines.length) {
    geometry = { type: 'MultiLineString', coordinates: measuredLines };
  }
  const metrics = {
    quality,
    measuredLegCount,
    totalLegCount,
    straightLineMiles: measuredLegCount ? round(straightLineMiles, 1) : null,
    estimatedRoadMiles: measuredLegCount ? round(estimatedRoadMiles, 1) : null,
    estimatedDriveMinutes: measuredLegCount ? Math.round(estimatedDriveMinutes) : null,
    estimatedFuelGallons: measuredLegCount ? round(estimatedFuelGallons, 3) : null,
    estimatedFuelCostCents: measuredLegCount ? Math.round(estimatedFuelCostCents) : null,
  };
  // Short aliases keep consumers simple while the explicit estimated names make
  // the source/quality unmistakable in API inspection.
  metrics.distanceMiles = metrics.estimatedRoadMiles;
  metrics.driveMinutes = metrics.estimatedDriveMinutes;
  metrics.fuelGallons = metrics.estimatedFuelGallons;
  metrics.fuelCostCents = metrics.estimatedFuelCostCents;
  return { quality, geometry, legs, metrics };
}

export function summarizeEstimatedRoutes(routes = []) {
  const metrics = routes.map((route) => route.metrics || {});
  const measuredLegCount = metrics.reduce((sum, item) => sum + (item.measuredLegCount || 0), 0);
  const totalLegCount = metrics.reduce((sum, item) => sum + (item.totalLegCount || 0), 0);
  const sumKnown = (key) => metrics.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
  const quality = qualityFor(measuredLegCount, totalLegCount);
  const hasEstimate = measuredLegCount > 0;
  const routedStopCount = routes.reduce((sum, route) => sum + (route.stops?.length || 0), 0);
  const stopIds = new Set(); let stopsWithoutIds = 0;
  for (const route of routes) {
    for (const stop of route.stops || []) {
      if (stop.appointmentId == null) stopsWithoutIds += 1;
      else stopIds.add(String(stop.appointmentId));
    }
  }
  const summary = {
    quality,
    routeCount: routes.length,
    // A crew job can appear on multiple per-rep routes. Count the customer
    // visit once in the board total while retaining the route-stop total for
    // consumers that model one vehicle per rep.
    stopCount: stopIds.size + stopsWithoutIds,
    routedStopCount,
    measuredLegCount,
    totalLegCount,
    totalMiles: quality === 'estimate' ? round(sumKnown('estimatedRoadMiles'), 1) : null,
    estimatedRoadMiles: hasEstimate ? round(sumKnown('estimatedRoadMiles'), 1) : null,
    estimatedDriveMinutes: hasEstimate ? Math.round(sumKnown('estimatedDriveMinutes')) : null,
    estimatedFuelGallons: hasEstimate ? round(sumKnown('estimatedFuelGallons'), 3) : null,
    estimatedFuelCostCents: hasEstimate ? Math.round(sumKnown('estimatedFuelCostCents')) : null,
  };
  summary.distanceMiles = summary.estimatedRoadMiles;
  summary.driveMinutes = summary.estimatedDriveMinutes;
  summary.fuelGallons = summary.estimatedFuelGallons;
  summary.fuelCostCents = summary.estimatedFuelCostCents;
  summary.totalDriveMinutes = summary.estimatedDriveMinutes;
  summary.totalFuelGallons = summary.estimatedFuelGallons;
  summary.totalFuelCostCents = summary.estimatedFuelCostCents;
  return summary;
}

/** Geocode an address via the configured provider. Returns {lat,lng} or null. */
export async function geocode(tenant, address, { timeoutMs = GEOCODE_TIMEOUT_MS } = {}) {
  if (!address || !geocodingConfigured(tenant)) return null;
  const g = tenant.settings.integrations.geocoding;
  const key = geocodeKey(tenant);
  try {
    if (g.provider === 'mapbox') {
      const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?limit=1&access_token=${key}`;
      const response = await fetch(u, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
      if (!response.ok) return null;
      const j = await response.json();
      const c = j?.features?.[0]?.center;
      return c ? coordinate({ lat: c[1], lng: c[0] }) : null;
    }
    if (g.provider === 'google') {
      const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
      const response = await fetch(u, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
      if (!response.ok) return null;
      const j = await response.json();
      const c = j?.results?.[0]?.geometry?.location;
      return c ? coordinate({ lat: c.lat, lng: c.lng }) : null;
    }
  } catch { /* provider error -> use address-based grouping */ }
  return null;
}

function geocodeCacheKey(tenant, address) {
  const provider = tenant?.settings?.integrations?.geocoding?.provider || 'none';
  // A settings save bumps config_version, immediately invalidating cached
  // provider failures after an API key is corrected or rotated.
  return `${tenant?.id || 'tenant'}:${tenant?.config_version || 0}:${provider}:${String(address || '').trim().toLowerCase()}`;
}

async function cachedGeocode(tenant, address, deadline) {
  const key = geocodeCacheKey(tenant, address); const now = Date.now();
  const cached = geocodeCache.get(key);
  if (cached?.promise) return cached.promise;
  if (cached && cached.expiresAt > now) return cached.value;
  const remaining = Math.min(GEOCODE_TIMEOUT_MS, deadline - now);
  if (remaining <= 0) return null;
  const promise = geocode(tenant, address, { timeoutMs: remaining })
    .then((value) => {
      geocodeCache.set(key, {
        value,
        expiresAt: Date.now() + (value ? GEOCODE_SUCCESS_TTL_MS : GEOCODE_FAILURE_TTL_MS),
      });
      return value;
    })
    .catch(() => {
      geocodeCache.set(key, { value: null, expiresAt: Date.now() + GEOCODE_FAILURE_TTL_MS });
      return null;
    });
  geocodeCache.set(key, { promise, expiresAt: deadline });
  return promise;
}

/** Google Maps multi-stop directions URL (works without our own geocoder). */
export function mapsUrl(stops, originAddress, includeReturnToBase = false) {
  const pts = stops.map((s) => s.address).filter(Boolean);
  if (!pts.length) return null;
  const returnsToOrigin = Boolean(includeReturnToBase && originAddress);
  const destination = encodeURIComponent(returnsToOrigin ? originAddress : pts[pts.length - 1]);
  const waypoints = (returnsToOrigin ? pts : pts.slice(0, -1)).map(encodeURIComponent);
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

async function geocodeMissingStops(tenant, stops, deadline) {
  if (!geocodingConfigured(tenant)) return;
  const missing = stops
    .filter((stop) => !coordinate(stop) && stop.address)
    .slice(0, MAX_GEOCODES_PER_PLAN);
  // Small batches prevent one slow provider response from serially blocking a
  // full dispatch board while still avoiding an uncontrolled request burst.
  for (let index = 0; index < missing.length; index += 3) {
    if (Date.now() >= deadline) break;
    await Promise.all(missing.slice(index, index + 3).map(async (stop) => {
      const location = await cachedGeocode(tenant, stop.address, deadline);
      if (location) {
        stop.lat = location.lat;
        stop.lng = location.lng;
        await query(
          'UPDATE appointments SET service_lat=$3, service_lng=$4 WHERE tenant_id=$1 AND id=$2',
          [tenant.id, stop.appointmentId, location.lat, location.lng],
        ).catch(() => {});
      }
    }));
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
  const assumptions = routingAssumptions(tenant);
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
  if (invalidTechnicianIds.length) {
    return {
      date, technicians, routes: [], proposals: [], unplaced: [], assumptions, origin: null,
      summary: summarizeEstimatedRoutes([]), invalidTechnicianIds,
    };
  }

  const stops = await dayStops(tenant, date);
  const geocodeDeadline = Date.now() + GEOCODE_PLAN_BUDGET_MS;
  let origin = tenant.address ? { address: tenant.address, ...addressMeta(tenant.address) } : null;
  const originLocation = origin && geocodingConfigured(tenant)
    ? cachedGeocode(tenant, tenant.address, geocodeDeadline)
    : Promise.resolve(null);
  const [, location] = await Promise.all([
    geocodeMissingStops(tenant, stops, geocodeDeadline),
    originLocation,
  ]);
  if (origin) {
    if (location) origin = { ...origin, ...location };
  }
  const publicOrigin = origin ? {
    address: origin.address,
    lat: coordinate(origin)?.lat ?? null,
    lng: coordinate(origin)?.lng ?? null,
  } : null;

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
  const coordinateCount = stops.filter((stop) => coordinate(stop)).length;
  const method = stops.length && coordinateCount === stops.length ? 'coordinates' : coordinateCount ? 'mixed' : 'address';
  const routes = groups.map((group) => {
    const ordered = routeOrder(group.stops, origin);
    const estimate = buildEstimatedRoute(ordered.order, origin, assumptions);
    // Preserve the legacy totalMiles meaning (raw coordinate distance). New
    // road-adjusted estimates live under metrics/estimatedRoadMiles.
    const totalMiles = ordered.totalMiles;
    return {
      technician: group.technician,
      stops: ordered.order.map(({ _addressMeta, assignments, inPlanningDay, ...stop }) => stop),
      assignedCount: group.stops.filter((stop) => stop.assignment === 'existing').length,
      proposedCount: group.stops.filter((stop) => stop.assignment === 'proposed').length,
      optimized: ordered.optimized,
      quality: estimate.quality,
      geometry: estimate.geometry,
      legs: estimate.legs,
      metrics: estimate.metrics,
      // Compatibility totals for the existing route cards and API consumers.
      totalMiles,
      totalDriveMinutes: estimate.metrics.estimatedDriveMinutes,
      totalFuelGallons: estimate.metrics.estimatedFuelGallons,
      totalFuelCostCents: estimate.metrics.estimatedFuelCostCents,
      estimatedRoadMiles: estimate.metrics.estimatedRoadMiles,
      estimatedDriveMinutes: estimate.metrics.estimatedDriveMinutes,
      estimatedFuelGallons: estimate.metrics.estimatedFuelGallons,
      estimatedFuelCostCents: estimate.metrics.estimatedFuelCostCents,
      mapsUrl: mapsUrl(ordered.order, tenant.address || null, assumptions.includeReturnToBase),
    };
  });
  const summary = summarizeEstimatedRoutes(routes);
  return {
    date,
    assumptions,
    origin: publicOrigin,
    technicians,
    routes,
    summary,
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
  const emptyEstimate = buildEstimatedRoute([], null, plan.assumptions);
  const route = plan.routes[0] || {
    stops: [], optimized: false, quality: 'unavailable', geometry: null, legs: [],
    metrics: emptyEstimate.metrics, totalMiles: null, totalDriveMinutes: null,
    totalFuelGallons: null, totalFuelCostCents: null, estimatedRoadMiles: null,
    estimatedDriveMinutes: null, estimatedFuelGallons: null, estimatedFuelCostCents: null,
    mapsUrl: null,
  };
  let reason;
  if (route.stops.length > 1 && plan.method !== 'coordinates') {
    reason = plan.method === 'mixed'
      ? 'Some stops lack coordinates; route order also uses address similarity.'
      : 'Grouped by ZIP, city, and address similarity. Add geocoding for precise mileage.';
  }
  return {
    invalidTechnicianIds: plan.invalidTechnicianIds,
    stops: route.stops,
    optimized: route.optimized,
    reason,
    assumptions: plan.assumptions,
    origin: plan.origin,
    quality: route.quality,
    geometry: route.geometry,
    legs: route.legs,
    metrics: route.metrics,
    totalMiles: route.totalMiles,
    totalDriveMinutes: route.totalDriveMinutes,
    totalFuelGallons: route.totalFuelGallons,
    totalFuelCostCents: route.totalFuelCostCents,
    estimatedRoadMiles: route.estimatedRoadMiles,
    estimatedDriveMinutes: route.estimatedDriveMinutes,
    estimatedFuelGallons: route.estimatedFuelGallons,
    estimatedFuelCostCents: route.estimatedFuelCostCents,
    mapsUrl: route.mapsUrl,
  };
}

export default {
  geocodingConfigured, geocode, mapsUrl, haversine, addressDistance, stopDistance,
  routingAssumptions, buildEstimatedRoute, summarizeEstimatedRoutes,
  assignNearbyStops, planRoutes, applyRouteAssignments, optimizeRoute,
};
