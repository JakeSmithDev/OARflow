// Availability engine — pure slot math (no DB access). The router supplies the
// day's appointments, blackouts, and any schedule override; this computes the
// bookable time slots. There is NO technician selection — only time slots with
// a per-slot capacity (how many crews can run at once).
import { zonedWallTimeToUtc, ymdInTimeZone, weekdayInTimeZone, hhmmToMinutes, minutesToHhmm, addDays } from './dates.js';

/** Effective open windows for a date: schedule override wins, else weekly hours. */
export function effectiveHours(tenant, dateYmd, override) {
  if (override) {
    if (override.is_closed) return [];
    if (Array.isArray(override.hours_json) && override.hours_json.length) return override.hours_json;
  }
  const weekday = weekdayInTimeZone(zonedWallTimeToUtc(dateYmd, '12:00', tenant.timezone), tenant.timezone);
  const hours = tenant.settings.availability.hours || {};
  return hours[weekday] || hours[String(weekday)] || [];
}

/** Build back-to-back candidate slot windows (HH:MM) for a set of open windows. */
export function buildDaySlots(windows, durationMin, stepMin) {
  const step = stepMin || durationMin;
  const slots = [];
  for (const w of windows) {
    const start = hhmmToMinutes(w.start);
    const end = hhmmToMinutes(w.end);
    for (let t = start; t + durationMin <= end; t += step) {
      slots.push({ start: minutesToHhmm(t), end: minutesToHhmm(t + durationMin) });
    }
  }
  return slots;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Compute bookable slots for one date.
 * @returns [{ start: ISO, end: ISO, label, available, remaining }]
 */
export function computeDayAvailability({ tenant, service, dateYmd, appointments = [], blackouts = [], override = null, now = new Date() }) {
  const tz = tenant.timezone;
  const booking = tenant.settings.booking;
  const avail = tenant.settings.availability;
  const capacity = (override && Number.isInteger(override.capacity)) ? override.capacity : (avail.capacityPerSlot || 1);
  const isWindows = avail.granularity === 'windows';

  const openWindows = effectiveHours(tenant, dateYmd, override);
  // raw = candidate options as { start:'HH:MM', end:'HH:MM', label? }
  let raw;
  if (isWindows) {
    // Arrival windows are the operator-defined options; only on open days.
    raw = openWindows.length ? (avail.windows || []).map((w) => ({ start: w.start, end: w.end, label: w.label })) : [];
  } else {
    const duration = service?.duration_minutes || avail.slotMinutes || 60;
    const step = avail.slotMinutes && avail.slotMinutes < duration ? avail.slotMinutes : duration;
    raw = buildDaySlots(openWindows, duration, step);
  }

  const leadMs = (booking.leadTimeHours || 0) * 3600_000;
  const earliest = new Date(now.getTime() + leadMs);
  const apptRanges = appointments
    .filter((a) => a.scheduled_start && a.scheduled_end)
    .map((a) => [new Date(a.scheduled_start).getTime(), new Date(a.scheduled_end).getTime()]);
  const blackoutRanges = blackouts.map((b) => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()]);
  const fmt = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);

  return raw.map((s) => {
    const startUtc = zonedWallTimeToUtc(dateYmd, s.start, tz);
    const endUtc = zonedWallTimeToUtc(dateYmd, s.end, tz);
    const st = startUtc.getTime(); const en = endUtc.getTime();
    const blocked = blackoutRanges.some(([bs, be]) => overlaps(st, en, bs, be));
    const taken = apptRanges.filter(([as, ae]) => overlaps(st, en, as, ae)).length;
    const remaining = Math.max(0, capacity - taken);
    const tooSoon = startUtc < earliest;
    return {
      start: startUtc.toISOString(),
      end: endUtc.toISOString(),
      label: s.label || fmt(startUtc),
      rangeLabel: `${fmt(startUtc)}–${fmt(endUtc)}`,
      kind: isWindows ? 'window' : 'slot',
      available: !blocked && remaining > 0 && !tooSoon,
      remaining,
    };
  });
}

/**
 * Precise start-time choices for the admin appointment form. Unlike public
 * booking availability, these ignore lead/max-booking windows and arrival-
 * window mode, but still honor the operational calendar and capacity.
 */
export function computeAdminStartTimeAvailability({
  tenant, service, dateYmd, appointments = [], blackouts = [], override = null,
  stepMinutes = 30,
}) {
  const tz = tenant.timezone;
  const avail = tenant.settings.availability;
  const duration = Math.max(1, Number(service?.duration_minutes || avail.slotMinutes || 60));
  const step = Math.max(1, Number(stepMinutes) || 30);
  const capacity = (override && Number.isInteger(override.capacity)) ? override.capacity : (avail.capacityPerSlot || 1);
  const raw = buildDaySlots(effectiveHours(tenant, dateYmd, override), duration, step);
  const appointmentRanges = appointments
    .filter((row) => row.scheduled_start && row.scheduled_end)
    .map((row) => [new Date(row.scheduled_start).getTime(), new Date(row.scheduled_end).getTime()]);
  const blackoutRanges = blackouts
    .map((row) => [new Date(row.starts_at).getTime(), new Date(row.ends_at).getTime()]);
  const fmt = (date) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit',
  }).format(date);
  const localParts = (date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  };
  const seenStarts = new Set();
  const slots = [];

  for (const slot of raw) {
    const startUtc = zonedWallTimeToUtc(dateYmd, slot.start, tz);
    const roundTrip = localParts(startUtc);
    // Spring-forward wall times (for example 02:30 when the clock jumps to
    // 03:00) normalize to another instant. Never present those as choices.
    if (roundTrip.date !== dateYmd || roundTrip.time !== slot.start) continue;
    // Appointment creation derives the end from elapsed service duration, so
    // suggestions must do the same across DST transitions.
    const endUtc = new Date(startUtc.getTime() + duration * 60_000);
    const startMs = startUtc.getTime(); const endMs = endUtc.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const dedupeKey = startUtc.toISOString();
    if (seenStarts.has(dedupeKey)) continue;
    seenStarts.add(dedupeKey);
    const blocked = blackoutRanges.some(([start, end]) => overlaps(startMs, endMs, start, end));
    const taken = appointmentRanges.filter(([start, end]) => overlaps(startMs, endMs, start, end)).length;
    const remaining = Math.max(0, capacity - taken);
    slots.push({
      time: slot.start,
      start: startUtc.toISOString(),
      end: endUtc.toISOString(),
      label: fmt(startUtc),
      rangeLabel: `${fmt(startUtc)}–${fmt(endUtc)}`,
      available: !blocked && remaining > 0,
      remaining,
      unavailableReason: blocked ? 'blackout' : remaining < 1 ? 'capacity' : null,
    });
  }
  return slots;
}

/** Quick per-day open/closed map for a month (calendar coloring). */
export function monthOpenDays(tenant, year, month /* 1-12 */, overridesByDate = {}) {
  const tz = tenant.timezone;
  const days = {};
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const ymd = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const windows = effectiveHours(tenant, ymd, overridesByDate[ymd]);
    days[ymd] = windows.length > 0;
  }
  return days;
}

/** Bound a requested date within [today+lead, today+maxDaysOut]. */
export function dateWithinBookingWindow(tenant, dateYmd, now = new Date()) {
  const tz = tenant.timezone;
  const todayYmd = ymdInTimeZone(now, tz);
  const maxYmd = ymdInTimeZone(addDays(now, tenant.settings.booking.maxDaysOut || 60), tz);
  return dateYmd >= todayYmd && dateYmd <= maxYmd;
}

export default { effectiveHours, buildDaySlots, computeDayAvailability, computeAdminStartTimeAvailability, monthOpenDays, dateWithinBookingWindow };
