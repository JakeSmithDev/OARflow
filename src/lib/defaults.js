// Default tenant configuration and starter email templates. The seed writes
// these; the admin suite edits them. Centralized so new tenants get sane,
// resale-ready defaults.

export function defaultTenantSettings(overrides = {}) {
  return {
    branding: {
      primaryColor: '#1f8a3d',
      accentColor: '#0a2740',
      logoText: 'Pasternack Pest Management',
      tagline: 'Reliable, friendly pest control — scheduled in seconds.',
      supportEmail: 'office@pasternackpest.com',
      supportPhone: '(410) 446-1169',
    },
    booking: {
      defaultMode: 'instant',       // 'instant' | 'request'
      requestSlotCount: 3,
      leadTimeHours: 24,
      maxDaysOut: 60,
      minimumCancelNoticeHours: 24,
      requireDeposit: false,
      depositType: 'none',          // 'none' | 'fixed' | 'percent'
      depositValueCents: 0,
      depositPercent: 0,
      collectAddress: true,
      confirmationMessage: 'Thanks! We\'ve got your request and will see you soon.',
    },
    availability: {
      slotMinutes: 120,
      capacityPerSlot: 2,           // how many crews can run concurrently
      // 'slots' = precise start times; 'windows' = named arrival windows.
      granularity: 'slots',
      windows: [
        { label: 'Morning', start: '08:00', end: '12:00' },
        { label: 'Afternoon', start: '12:00', end: '16:00' },
        { label: 'Evening', start: '16:00', end: '19:00' },
      ],
      hours: {
        0: [],
        1: [{ start: '08:00', end: '17:00' }],
        2: [{ start: '08:00', end: '17:00' }],
        3: [{ start: '08:00', end: '17:00' }],
        4: [{ start: '08:00', end: '17:00' }],
        5: [{ start: '08:00', end: '17:00' }],
        6: [{ start: '09:00', end: '13:00' }],
      },
    },
    invoicing: {
      taxRatePercent: 6.0,
      terms: 'Payment due upon receipt.',
      footerNote: 'Thank you for trusting us with your home.',
      dueDays: 7,
    },
    notifications: {
      // Upcoming-appointment reminder emails (NOT balance/invoice reminders).
      appointmentReminder: { enabled: true, leadHours: 24 },
      // Transactional SMS (sent only when SMS is connected + the customer consents).
      sms: {
        confirmationEnabled: true,
        reminderEnabled: true,
        templates: {
          confirmation: 'Hi {{CUSTOMER_NAME}}, your {{SERVICE_NAME}} with {{COMPANY_NAME}} is set for {{APPOINTMENT_DATE}} at {{APPOINTMENT_TIME}}. Reply STOP to opt out.',
          reminder: 'Reminder: {{SERVICE_NAME}} with {{COMPANY_NAME}} {{APPOINTMENT_DATE}} at {{APPOINTMENT_TIME}}. See you soon! Reply STOP to opt out.',
          onMyWay: 'Hi {{CUSTOMER_NAME}}, your {{COMPANY_NAME}} technician is on the way for your {{SERVICE_NAME}}. {{ETA}}',
        },
      },
    },
    followups: {
      rules: [
        { id: 'post_service', name: 'Post-service check-in', trigger: 'after_completion', offsetDays: 3, channel: 'email', templateType: 'follow_up', active: true },
        { id: 'annual_renewal', name: 'Annual renewal reminder', trigger: 'after_completion', offsetDays: 330, channel: 'task', templateType: null, active: true },
      ],
    },
    reviews: {
      // Automatically ask for a review after a completed job. We never gate by
      // rating — every customer gets the public-review links regardless of score.
      enabled: true,
      autoRequest: true,
      delayHours: 24,
      channel: 'email',            // 'email' | 'sms'
      platforms: { google: '', yelp: '', facebook: '' },
      smsTemplate: 'Hi {{CUSTOMER_NAME}}, thanks for choosing {{COMPANY_NAME}}! How did we do? {{REVIEW_URL}}',
    },
    integrations: {
      stripe: { secretKey: '', publishableKey: '', webhookSecret: '', mode: 'test' },
      google: { connected: false, calendarId: 'primary', accessToken: '', refreshToken: '', expiryDate: 0, email: '' },
      email: { provider: 'auto', from: '', replyTo: '' },
      sms: {
        provider: 'twilio', credentialMode: 'byo',
        accountSid: '', authToken: '', fromNumber: '', messagingServiceSid: '',
        brandStatus: 'not_started', campaignId: '',
        quietHours: { start: '21:00', end: '08:00' },
        optInText: 'Reply STOP to opt out, HELP for help. Msg & data rates may apply.',
      },
      // AI voice receptionist — SCAFFOLD ONLY (no live telephony is wired yet).
      voice: {
        provider: 'none',          // none|vapi|retell|twilio (scaffold)
        enabled: false,
        accountSid: '', authToken: '', fromNumber: '',
        aiProvider: 'none', transcripts: true,
        greeting: 'Thanks for calling! I can help you book a service or take a message.',
        // Where/when to hand a call off to a human.
        handoff: { transferTo: '', onUrgent: true, onRequest: true, afterHoursVoicemail: true },
        // What to do when a call is missed or goes to voicemail.
        missedCall: { textBack: true, message: 'Sorry we missed your call! Reply here and we\'ll help you book a service.', createFollowUp: true },
      },
      // CSV/IIF export now; a live API sync (e.g. QuickBooks Online) can be added
      // later behind the same accounting provider interface.
      accounting: { provider: 'export', realmId: '', accessToken: '', refreshToken: '', expiryDate: 0 },
      // Geocoding for route optimization. Without a provider, multi-stop map
      // links still work (the map app geocodes the addresses).
      geocoding: { provider: 'none', apiKey: '' }, // none|google|mapbox
    },
    ...overrides,
  };
}

// Inner email bodies — the renderer wraps these in a branded shell. Placeholders
// use {{UPPER_SNAKE}} and are filled from a per-send variable map.
export function defaultEmailTemplates() {
  return [
    {
      type: 'booking_confirmation',
      subject: 'Your {{SERVICE_NAME}} is booked — {{APPOINTMENT_DATE}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>You're all set! Here are your appointment details:</p>
{{DETAILS}}
<p>Need to make a change? <a href="{{MANAGE_URL}}">Manage your appointment</a>.</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, your {{SERVICE_NAME}} is booked for {{APPOINTMENT_DATE}} at {{APPOINTMENT_TIME}}. Manage it: {{MANAGE_URL}} — {{COMPANY_NAME}}',
    },
    {
      type: 'request_received',
      subject: 'We received your request — {{COMPANY_NAME}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Thanks for your request for <strong>{{SERVICE_NAME}}</strong>. You proposed these times:</p>
{{REQUESTED_SLOTS}}
<p>We'll confirm one of these windows shortly and send you the details.</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, thanks for your request for {{SERVICE_NAME}}. We\'ll confirm one of your proposed times shortly. — {{COMPANY_NAME}}',
    },
    {
      type: 'request_confirmed',
      subject: 'Confirmed: {{SERVICE_NAME}} on {{APPOINTMENT_DATE}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Good news — we've confirmed your appointment:</p>
{{DETAILS}}
<p><a href="{{MANAGE_URL}}">Manage your appointment</a></p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, your {{SERVICE_NAME}} is confirmed for {{APPOINTMENT_DATE}} at {{APPOINTMENT_TIME}}. — {{COMPANY_NAME}}',
    },
    {
      type: 'appointment_reminder',
      subject: 'Reminder: {{SERVICE_NAME}} on {{APPOINTMENT_DATE}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>This is a friendly reminder of your upcoming appointment with {{COMPANY_NAME}}:</p>
{{DETAILS}}
<p>If you need to make a change, just <a href="{{MANAGE_URL}}">manage your appointment</a> or reply to this email.</p>
<p>See you soon!<br>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, a reminder of your {{SERVICE_NAME}} on {{APPOINTMENT_DATE}} at {{APPOINTMENT_TIME}}. Manage it: {{MANAGE_URL}} — {{COMPANY_NAME}}',
    },
    {
      type: 'appointment_rescheduled',
      subject: 'Updated: {{SERVICE_NAME}} on {{APPOINTMENT_DATE}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Your appointment has been updated:</p>
{{DETAILS}}
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, your appointment was updated to {{APPOINTMENT_DATE}} at {{APPOINTMENT_TIME}}. — {{COMPANY_NAME}}',
    },
    {
      type: 'appointment_canceled',
      subject: 'Canceled: {{SERVICE_NAME}} on {{APPOINTMENT_DATE}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Your appointment for {{SERVICE_NAME}} on {{APPOINTMENT_DATE}} has been canceled. If this was a mistake, just reply and we'll get you rebooked.</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, your {{SERVICE_NAME}} on {{APPOINTMENT_DATE}} has been canceled. — {{COMPANY_NAME}}',
    },
    {
      type: 'invoice',
      subject: 'Invoice {{INVOICE_NUMBER}} from {{COMPANY_NAME}} — {{BALANCE_DUE}} due',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Here is your invoice for recent service. Your balance due is <strong>{{BALANCE_DUE}}</strong>.</p>
{{INVOICE_SUMMARY}}
<p style="text-align:center;margin:28px 0;"><a class="btn" href="{{PAY_URL}}">Pay {{BALANCE_DUE}} online</a></p>
<p>{{TERMS}}</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, your invoice {{INVOICE_NUMBER}} balance is {{BALANCE_DUE}}. Pay online: {{PAY_URL}} — {{COMPANY_NAME}}',
    },
    {
      type: 'receipt',
      subject: 'Receipt — {{AMOUNT_PAID}} paid to {{COMPANY_NAME}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Thanks! We received your payment of <strong>{{AMOUNT_PAID}}</strong> toward invoice {{INVOICE_NUMBER}}.</p>
{{INVOICE_SUMMARY}}
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, we received your payment of {{AMOUNT_PAID}} toward invoice {{INVOICE_NUMBER}}. — {{COMPANY_NAME}}',
    },
    {
      type: 'estimate',
      subject: 'Your estimate {{ESTIMATE_NUMBER}} from {{COMPANY_NAME}} — {{ESTIMATE_TOTAL}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Thanks for the opportunity. Here is your estimate, total <strong>{{ESTIMATE_TOTAL}}</strong>.</p>
{{ESTIMATE_SUMMARY}}
<p style="text-align:center;margin:28px 0;"><a class="btn" href="{{ACCEPT_URL}}">Review &amp; approve online</a></p>
<p style="color:#64748b;font-size:13px">Good through {{VALID_UNTIL}}. {{TERMS}}</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, your estimate {{ESTIMATE_NUMBER}} total is {{ESTIMATE_TOTAL}}. Review & approve online: {{ACCEPT_URL}} — {{COMPANY_NAME}}',
    },
    {
      type: 'document_request',
      subject: 'Please review & sign: {{DOCUMENT_TITLE}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>{{COMPANY_NAME}} has a document ready for you to review and sign: <strong>{{DOCUMENT_TITLE}}</strong>.</p>
<p style="text-align:center;margin:28px 0;"><a class="btn" href="{{DOCUMENT_URL}}">Review &amp; sign</a></p>
<p class="muted" style="color:#64748b;font-size:13px">It only takes a minute and is securely recorded.</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, please review & sign "{{DOCUMENT_TITLE}}" from {{COMPANY_NAME}}: {{DOCUMENT_URL}}',
    },
    {
      type: 'portal_link',
      subject: 'Your {{COMPANY_NAME}} account',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Here's your secure link to view appointments, invoices, and saved payment methods with {{COMPANY_NAME}}.</p>
<p style="text-align:center;margin:28px 0;"><a class="btn" href="{{PORTAL_URL}}">Open my account</a></p>
<p class="muted" style="color:#64748b;font-size:13px">For your security, don't share this link. You can request a new one anytime.</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, open your {{COMPANY_NAME}} account: {{PORTAL_URL}}',
    },
    {
      type: 'review_request',
      subject: 'How did we do, {{CUSTOMER_NAME}}?',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>Thanks for choosing {{COMPANY_NAME}} for your {{SERVICE_NAME}}. We'd love a quick word on how it went — it takes about 30 seconds and really helps our small business.</p>
<p style="text-align:center;margin:28px 0;"><a class="btn" href="{{REVIEW_URL}}">Leave a quick review</a></p>
<p>Thank you!<br>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, thanks for choosing {{COMPANY_NAME}}. How did we do? Leave a quick review: {{REVIEW_URL}}',
    },
    {
      type: 'follow_up',
      subject: 'How did everything go? — {{COMPANY_NAME}}',
      html: `<p>Hi {{CUSTOMER_NAME}},</p>
<p>It's been a few days since your {{SERVICE_NAME}}. We wanted to check in and make sure everything is pest-free and you're happy with the service.</p>
<p>If you're seeing any activity, just reply to this email and we'll come back out. We're also happy to set you up on a recurring plan so you never have to think about it again.</p>
<p>— {{COMPANY_NAME}}</p>`,
      text: 'Hi {{CUSTOMER_NAME}}, checking in after your {{SERVICE_NAME}}. Reply anytime if you need us. — {{COMPANY_NAME}}',
    },
  ];
}

export default { defaultTenantSettings, defaultEmailTemplates };
