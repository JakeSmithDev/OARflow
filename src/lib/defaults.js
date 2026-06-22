// Default tenant configuration and starter email templates. The seed writes
// these; the admin suite edits them. Centralized so new tenants get sane,
// resale-ready defaults.

export function defaultTenantSettings(overrides = {}) {
  return {
    branding: {
      primaryColor: '#0e7c4b',
      accentColor: '#10b981',
      logoText: 'Pasternack Pest Management',
      tagline: 'Reliable pest control — scheduled in seconds.',
      supportEmail: 'office@pasternackpest.com',
      supportPhone: '(410) 555-0142',
    },
    booking: {
      defaultMode: 'instant',       // 'instant' | 'request'
      requestSlotCount: 3,
      leadTimeHours: 24,
      maxDaysOut: 60,
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
    followups: {
      rules: [
        { id: 'post_service', name: 'Post-service check-in', trigger: 'after_completion', offsetDays: 3, channel: 'email', templateType: 'follow_up', active: true },
        { id: 'annual_renewal', name: 'Annual renewal reminder', trigger: 'after_completion', offsetDays: 330, channel: 'task', templateType: null, active: true },
      ],
    },
    integrations: {
      stripe: { secretKey: '', publishableKey: '', webhookSecret: '', mode: 'test' },
      google: { connected: false, calendarId: 'primary', accessToken: '', refreshToken: '', expiryDate: 0, email: '' },
      email: { provider: 'auto', from: '', replyTo: '' },
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
