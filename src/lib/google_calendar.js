// Google Calendar sync. Token management + OAuth lives in routes/google_oauth.js
// and the integrations settings; this module pushes/updates/deletes events for
// appointments. It is a safe no-op until the tenant connects Google Calendar.
import { config } from '../config.js';
import { updateTenantSettings, getTenantById } from './tenants.js';
import { query } from './db.js';

function googleCfg(tenant) {
  return tenant?.settings?.integrations?.google || {};
}

export function isConnected(tenant) {
  const g = googleCfg(tenant);
  return Boolean(g.connected && g.refreshToken);
}

/** Exchange the stored refresh token for a fresh access token (cached on settings). */
async function getAccessToken(tenant) {
  const g = googleCfg(tenant);
  if (g.accessToken && g.expiryDate && g.expiryDate - Date.now() > 60_000) return g.accessToken;
  if (!g.refreshToken || !config.google.clientId) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: g.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const expiryDate = Date.now() + (data.expires_in || 3600) * 1000;
  await updateTenantSettings(tenant.id, { integrations: { google: { accessToken: data.access_token, expiryDate } } });
  return data.access_token;
}

function eventBody(tenant, appt) {
  return {
    summary: `${appt.service_name || 'Service'} — ${appt.customer_name || ''}`.trim(),
    description: [appt.notes, appt.service_address, appt.customer_phone].filter(Boolean).join('\n'),
    location: appt.service_address || undefined,
    start: { dateTime: new Date(appt.scheduled_start).toISOString() },
    end: { dateTime: new Date(appt.scheduled_end).toISOString() },
  };
}

/** Create or update the calendar event for a scheduled appointment. No-op if not connected. */
export async function syncAppointment(tenantOrId, appt) {
  try {
    const tenant = typeof tenantOrId === 'object' ? tenantOrId : await getTenantById(tenantOrId);
    if (!isConnected(tenant) || !appt?.scheduled_start) return null;
    const token = await getAccessToken(tenant);
    if (!token) return null;
    const calId = encodeURIComponent(googleCfg(tenant).calendarId || 'primary');
    const base = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`;
    const method = appt.google_event_id ? 'PATCH' : 'POST';
    const url = appt.google_event_id ? `${base}/${appt.google_event_id}` : base;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody(tenant, appt)),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.id && data.id !== appt.google_event_id) {
      await query('UPDATE appointments SET google_event_id=$2 WHERE id=$1', [appt.id, data.id]);
    }
    return data.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('google sync failed', err.message);
    return null;
  }
}

export async function deleteAppointmentEvent(tenantOrId, appt) {
  try {
    const tenant = typeof tenantOrId === 'object' ? tenantOrId : await getTenantById(tenantOrId);
    if (!isConnected(tenant) || !appt?.google_event_id) return;
    const token = await getAccessToken(tenant);
    if (!token) return;
    const calId = encodeURIComponent(googleCfg(tenant).calendarId || 'primary');
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${appt.google_event_id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
  } catch { /* ignore */ }
}

export default { isConnected, syncAppointment, deleteAppointmentEvent, getAccessToken };
