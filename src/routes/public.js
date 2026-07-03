// Public booking API (no auth). Supports both booking modes:
//   instant  → customer books a specific open slot, confirmed immediately
//   request  → customer proposes up to N slots; staff confirm one later
import express from 'express';
import { asyncHandler, badRequest, notFound, getClientIp } from '../lib/http.js';
import { consumeRateLimit, rateLimit } from '../lib/rate_limit.js';
import { getTenantBySlug, getDefaultTenant } from '../lib/tenants.js';
import { computeDayAvailability, dateWithinBookingWindow, monthOpenDays } from '../lib/availability.js';
import {
  getService, listActiveServices, effectiveBookingMode, findOrCreateCustomer,
  fetchDayConflicts, createAppointment, bookInstant, slotCapacity,
} from '../lib/appointments.js';
import { queryOne, query } from '../lib/db.js';
import { sendTemplated, detailsTable } from '../lib/email_templates.js';
import { sendEmail } from '../lib/email.js';
import { syncAppointment } from '../lib/google_calendar.js';
import { config } from '../config.js';
import { formatDateLabel, formatTimeLabel, ymdInTimeZone } from '../lib/dates.js';
import { emitEvent } from '../lib/events.js';
import { setConsent, normalizeE164 } from '../lib/sms.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
const limitBootstrap = rateLimit({ endpoint: 'public_bootstrap_get', windowMinutes: 10, maxCount: 120 });
const limitCalendarLookup = rateLimit({ endpoint: 'public_calendar_get', windowMinutes: 10, maxCount: 180 });
const limitAppointmentLookup = rateLimit({ endpoint: 'public_appointment_get', windowMinutes: 10, maxCount: 120 });

async function resolveTenant(slug) {
  if (!slug || slug === 'default' || slug === '_') return getDefaultTenant();
  return getTenantBySlug(slug);
}

function publicService(tenant, s) {
  return {
    id: s.id, name: s.name, description: s.description,
    durationMinutes: s.duration_minutes, basePriceCents: s.base_price_cents,
    depositCents: s.deposit_cents, color: s.color,
    mode: effectiveBookingMode(tenant, s),
  };
}

function manageUrl(tenant, token) {
  return `${config.baseUrl}/book?appt=${encodeURIComponent(token)}&t=${encodeURIComponent(tenant.slug)}`;
}

function trimCap(value, max) {
  return String(value || '').trim().slice(0, max);
}

function leadDetailsHtml(lead) {
  return detailsTable([
    ['Name', lead.name],
    ['Phone', lead.phone],
    ['Email', lead.email],
    ['Address', lead.address],
    ['Pest problem', lead.pest],
    ['Notes', lead.notes],
  ]);
}

function leadDetailsText(lead) {
  return [
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    `Email: ${lead.email}`,
    lead.address ? `Address: ${lead.address}` : '',
    lead.pest ? `Pest problem: ${lead.pest}` : '',
    `Notes: ${lead.notes}`,
  ].filter(Boolean).join('\n');
}

// --- Bootstrap ------------------------------------------------------------
router.get('/:slug/bootstrap', limitBootstrap, asyncHandler(async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return notFound(res, 'Business not found.');
  const services = await listActiveServices(tenant.id);
  const b = tenant.settings.booking;
  res.json({
    ok: true,
    tenant: { slug: tenant.slug, name: tenant.name, timezone: tenant.timezone, currency: tenant.currency, branding: tenant.settings.branding },
    booking: {
      defaultMode: b.defaultMode, requestSlotCount: b.requestSlotCount, leadTimeHours: b.leadTimeHours,
      maxDaysOut: b.maxDaysOut, collectAddress: b.collectAddress, confirmationMessage: b.confirmationMessage,
      granularity: tenant.settings.availability.granularity || 'slots',
    },
    services: services.map((s) => publicService(tenant, s)),
  });
}));

// --- Month open-days (for calendar) --------------------------------------
router.get('/:slug/month', limitCalendarLookup, asyncHandler(async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return notFound(res);
  const year = Number(req.query.year); const month = Number(req.query.month);
  if (!year || !month) return badRequest(res, 'year and month required.');
  const { rows } = await query('SELECT service_date, is_closed, hours_json FROM schedule_overrides WHERE tenant_id=$1', [tenant.id]);
  const overrides = {};
  for (const r of rows) overrides[ymdInTimeZone(new Date(r.service_date), 'UTC')] = r;
  res.json({ ok: true, days: monthOpenDays(tenant, year, month, overrides) });
}));

// --- Availability for a date ---------------------------------------------
router.get('/:slug/availability', limitCalendarLookup, asyncHandler(async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return notFound(res);
  const serviceId = Number(req.query.serviceId);
  const date = String(req.query.date || '');
  if (!serviceId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'serviceId and date required.');
  const service = await getService(tenant.id, serviceId);
  if (!service) return notFound(res, 'Service not found.');
  if (!dateWithinBookingWindow(tenant, date)) return res.json({ ok: true, slots: [], outOfWindow: true });

  const { appointments, blackouts, override } = await fetchDayConflicts(tenant, date);
  const slots = computeDayAvailability({ tenant, service, dateYmd: date, appointments, blackouts, override });
  res.json({ ok: true, slots, mode: effectiveBookingMode(tenant, service), granularity: tenant.settings.availability.granularity || 'slots' });
}));

// --- Marketing-site lead -------------------------------------------------
router.post('/:slug/lead', asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const rl = await consumeRateLimit({ ip, endpoint: 'public_lead', windowMinutes: 10, maxCount: 12 });
  if (!rl.allowed) return res.status(429).json({ ok: false, error: 'Too many requests. Please try again shortly.' });

  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return notFound(res, 'Business not found.');

  const body = req.body || {};
  const lead = {
    name: trimCap(body.name, 120),
    phone: trimCap(body.phone, 40),
    email: trimCap(body.email, 160).toLowerCase(),
    address: trimCap(body.address, 220),
    pest: trimCap(body.pest, 80),
    notes: trimCap(body.notes, 2000),
  };
  if (!lead.name) return badRequest(res, 'Name is required.');
  if (!lead.phone) return badRequest(res, 'Phone is required.');
  if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return badRequest(res, 'A valid email is required.');
  if (!lead.notes) return badRequest(res, 'Please add a short description.');

  const customerId = await findOrCreateCustomer(tenant.id, {
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    address: lead.address,
    notes: `Website lead${lead.pest ? ` (${lead.pest})` : ''}: ${lead.notes}`,
  });
  const followUp = await queryOne(
    `INSERT INTO follow_ups (tenant_id, customer_id, type, title, channel, due_at, note, created_by)
     VALUES ($1,$2,'task',$3,'task',now(),$4,'public_lead') RETURNING *`,
    [
      tenant.id,
      customerId,
      `Website quote request from ${lead.name}`,
      leadDetailsText(lead),
    ],
  );

  const notifyTo = tenant.contact_email || tenant.settings.branding.supportEmail || tenant.settings.integrations.email.replyTo;
  await sendEmail({
    tenant,
    to: notifyTo,
    subject: `New website lead: ${lead.name}`,
    html: `<p>A new lead was submitted from the Pasternack marketing site.</p>${leadDetailsHtml(lead)}`,
    text: `A new lead was submitted from the Pasternack marketing site.\n\n${leadDetailsText(lead)}`,
    relatedType: 'follow_up',
    relatedId: followUp.id,
  }).catch(() => {});

  await logAudit({
    tenantId: tenant.id,
    action: 'public_lead_create',
    entityType: 'follow_up',
    entityId: followUp.id,
    details: { customerId, ip, pest: lead.pest },
  });

  return res.status(201).json({ ok: true, followUpId: followUp.id, customerId });
}));

// --- Create a booking -----------------------------------------------------
router.post('/:slug/book', asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const rl = await consumeRateLimit({ ip, endpoint: 'public_book', windowMinutes: 10, maxCount: 20 });
  if (!rl.allowed) return res.status(429).json({ ok: false, error: 'Too many requests. Please try again shortly.' });

  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return notFound(res);
  const body = req.body || {};
  const service = await getService(tenant.id, Number(body.serviceId));
  if (!service || !service.is_active) return badRequest(res, 'That service is unavailable.');

  const customer = body.customer || {};
  if (!customer.name || !customer.email) return badRequest(res, 'Name and email are required.');
  if (tenant.settings.booking.collectAddress && !customer.address) return badRequest(res, 'Service address is required.');

  const mode = effectiveBookingMode(tenant, service);
  const company = tenant.settings.branding.logoText || tenant.name;
  const customerId = await findOrCreateCustomer(tenant.id, customer);
  // Capture transactional SMS consent provenance when a phone is provided.
  if (customer.phone) {
    await setConsent(tenant.id, {
      customerId, phone: normalizeE164(customer.phone), status: 'opted_in', purpose: 'transactional',
      source: 'booking_form', consentText: 'Booked online and agreed to receive transactional service texts.',
      ip: getClientIp(req), ua: req.headers['user-agent'],
    }).catch(() => {});
  }

  if (mode === 'instant') {
    const slot = body.slot || {};
    if (!slot.start || !slot.end) return badRequest(res, 'Please choose a time slot.');
    const dateYmd = ymdInTimeZone(new Date(slot.start), tenant.timezone);
    const { appointments, blackouts, override } = await fetchDayConflicts(tenant, dateYmd);
    const slots = computeDayAvailability({ tenant, service, dateYmd, appointments, blackouts, override });
    const match = slots.find((s) => s.start === slot.start && s.available);
    if (!match) return res.status(409).json({ ok: false, error: 'That time was just taken. Please pick another.' });

    let appt;
    try {
      appt = await bookInstant(tenant, {
        customerId, serviceTypeId: service.id, status: 'scheduled', source: 'online',
        scheduledStart: slot.start, scheduledEnd: match.end, serviceAddress: customer.address || null,
        notes: customer.notes || null, priceCents: service.base_price_cents,
      }, { dateYmd, capacity: slotCapacity(tenant, override) });
    } catch (err) {
      if (err.code === 'SLOT_TAKEN') return res.status(409).json({ ok: false, error: 'That time was just taken. Please pick another.' });
      throw err;
    }
    syncAppointment(tenant, { ...appt, service_name: service.name, customer_name: customer.name, customer_phone: customer.phone }).catch(() => {});
    await sendTemplated(tenant, 'booking_confirmation', customer.email, {
      CUSTOMER_NAME: customer.name, COMPANY_NAME: company, SERVICE_NAME: service.name,
      APPOINTMENT_DATE: formatDateLabel(new Date(slot.start), tenant.timezone),
      APPOINTMENT_TIME: formatTimeLabel(new Date(slot.start), tenant.timezone),
      DETAILS: detailsTable([
        ['Service', service.name],
        ['When', `${formatDateLabel(new Date(slot.start), tenant.timezone)} · ${formatTimeLabel(new Date(slot.start), tenant.timezone)}`],
        ['Address', customer.address || ''],
      ]),
      MANAGE_URL: manageUrl(tenant, appt.access_token),
    }, { type: 'appointment', id: appt.id }).catch(() => {});

    emitEvent('appointment.scheduled', { tenantId: tenant.id, appointmentId: appt.id, customerId, source: 'online' }).catch(() => {});
    return res.json({ ok: true, status: 'scheduled', appointmentId: appt.id, token: appt.access_token, mode });
  }

  // request mode
  const slots = Array.isArray(body.requestedSlots) ? body.requestedSlots.filter((s) => s && s.start && s.end) : [];
  const max = tenant.settings.booking.requestSlotCount || 3;
  if (!slots.length) return badRequest(res, 'Please propose at least one preferred time.');
  const requested = slots.slice(0, max);

  // Validate each proposed slot is real: within the booking window and an
  // actually-available slot for this service on that date.
  const availByDate = new Map();
  for (const s of requested) {
    const start = new Date(s.start);
    if (Number.isNaN(start.getTime()) || new Date(s.end) <= start) return badRequest(res, 'One of the proposed times is invalid.');
    const dYmd = ymdInTimeZone(start, tenant.timezone);
    if (!dateWithinBookingWindow(tenant, dYmd)) return badRequest(res, 'One of the proposed times is outside our booking window.');
    if (!availByDate.has(dYmd)) {
      const conf = await fetchDayConflicts(tenant, dYmd);
      availByDate.set(dYmd, computeDayAvailability({ tenant, service, dateYmd: dYmd, ...conf }));
    }
    const ok = availByDate.get(dYmd).some((x) => x.start === s.start && x.available);
    if (!ok) return badRequest(res, 'One of the proposed times is no longer available. Please pick from the open times.');
  }

  const appt = await createAppointment(tenant.id, {
    customerId, serviceTypeId: service.id, status: 'requested', bookingMode: 'request', source: 'online',
    requestedSlots: requested, serviceAddress: customer.address || null,
    notes: customer.notes || null, priceCents: service.base_price_cents,
  });
  const slotsHtml = '<ul style="margin:8px 0;padding-left:18px">' + requested.map((s) =>
    `<li>${formatDateLabel(new Date(s.start), tenant.timezone)} · ${formatTimeLabel(new Date(s.start), tenant.timezone)}</li>`).join('') + '</ul>';
  await sendTemplated(tenant, 'request_received', customer.email, {
    CUSTOMER_NAME: customer.name, COMPANY_NAME: company, SERVICE_NAME: service.name,
    REQUESTED_SLOTS: slotsHtml, MANAGE_URL: manageUrl(tenant, appt.access_token),
  }, { type: 'appointment', id: appt.id }).catch(() => {});

  emitEvent('appointment.requested', { tenantId: tenant.id, appointmentId: appt.id, customerId, source: 'online' }).catch(() => {});
  return res.json({ ok: true, status: 'requested', appointmentId: appt.id, token: appt.access_token, mode });
}));

// --- Fetch a booking by token (confirmation page) ------------------------
router.get('/:slug/appointment/:token', limitAppointmentLookup, asyncHandler(async (req, res) => {
  const tenant = await resolveTenant(req.params.slug);
  if (!tenant) return notFound(res);
  const a = await queryOne(
    `SELECT a.*, s.name AS service_name, c.name AS customer_name, c.email AS customer_email
       FROM appointments a LEFT JOIN service_types s ON s.id=a.service_type_id
       JOIN customers c ON c.id=a.customer_id
      WHERE a.tenant_id=$1 AND a.access_token=$2`,
    [tenant.id, req.params.token],
  );
  if (!a) return notFound(res, 'Appointment not found.');
  res.json({
    ok: true,
    appointment: {
      id: a.id, status: a.status, mode: a.booking_mode, serviceName: a.service_name,
      customerName: a.customer_name, scheduledStart: a.scheduled_start, scheduledEnd: a.scheduled_end,
      requestedSlots: a.requested_slots, serviceAddress: a.service_address, priceCents: a.price_cents,
    },
    tenant: { name: tenant.name, branding: tenant.settings.branding, timezone: tenant.timezone },
  });
}));

export default router;
