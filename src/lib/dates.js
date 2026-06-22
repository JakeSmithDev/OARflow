// Timezone-aware date helpers. All timestamps are stored as UTC (TIMESTAMPTZ);
// these helpers convert between a tenant's local "wall clock" time and UTC, and
// format instants for display in a given IANA timezone — no external library.

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function offsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - date.getTime();
}

/** Convert a local wall-clock time (YYYY-MM-DD, HH:MM) in `timeZone` to a UTC Date. */
export function zonedWallTimeToUtc(ymd, hhmm, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off1 = offsetMs(new Date(guess), timeZone);
  let result = guess - off1;
  const off2 = offsetMs(new Date(result), timeZone);
  if (off2 !== off1) result = guess - off2; // DST boundary refinement
  return new Date(result);
}

/** YYYY-MM-DD for an instant as seen in `timeZone`. */
export function ymdInTimeZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return dtf.format(date); // en-CA yields YYYY-MM-DD
}

/** Day of week (0=Sun … 6=Sat) for an instant as seen in `timeZone`. */
export function weekdayInTimeZone(date, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name];
}

export function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(date);
}

export function formatTimeLabel(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

export function formatDateTimeLabel(date, timeZone) {
  if (!date) return '';
  return `${formatDateLabel(date, timeZone)} · ${formatTimeLabel(date, timeZone)}`;
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Today's YYYY-MM-DD in a timezone. */
export function todayYmd(timeZone) {
  return ymdInTimeZone(new Date(), timeZone);
}

/** Minutes since midnight for "HH:MM". */
export function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToHhmm(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default {
  zonedWallTimeToUtc, ymdInTimeZone, weekdayInTimeZone,
  formatDateLabel, formatTimeLabel, formatDateTimeLabel,
  addMinutes, addDays, todayYmd, hhmmToMinutes, minutesToHhmm,
};
