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
  const duration = service?.duration_minutes || avail.slotMinutes || 60;
  const step = avail.slotMinutes && avail.slotMinutes < duration ? avail.slotMinutes : duration;
  const capacity = (override && Number.isInteger(override.capacity)) ? override.capacity : (avail.capacityPerSlot || 1);

  const windows = effectiveHours(tenant, dateYmd, override);
  const raw = buildDaySlots(windows, duration, step);
  const leadMs = (booking.leadTimeHours || 0) * 3600_000;
  const earliest = new Date(now.getTime() + leadMs);

  const apptRanges = appointments
    .filter((a) => a.scheduled_start && a.scheduled_end)
    .map((a) => [new Date(a.scheduled_start).getTime(), new Date(a.scheduled_end).getTime()]);
  const blackoutRanges = blackouts.map((b) => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()]);

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
      label: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(startUtc),
      available: !blocked && remaining > 0 && !tooSoon,
      remaining,
    };
  });
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

export default { effectiveHours, buildDaySlots, computeDayAvailability, monthOpenDays, dateWithinBookingWindow };
