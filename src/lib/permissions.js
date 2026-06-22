// Granular capabilities layered over roles. Owner has everything ('*').
// requirePermission(cap) is additive — existing requireRole('owner') still works.
import { unauthorized, sendError } from './http.js';

// Capability vocabulary (extend as features are added).
export const CAPS = [
  'schedule.view', 'appointments.manage', 'requests.manage', 'customers.manage',
  'invoices.manage', 'payments.manage', 'estimates.manage', 'plans.manage',
  'messaging.use', 'followups.manage', 'reports.view', 'reviews.manage',
  'settings.manage', 'team.manage', 'integrations.manage', 'compliance.manage',
  'dispatch.manage', 'field.work', 'documents.manage',
];

// Default capabilities by role.
const ROLE_CAPS = {
  owner: ['*'],
  manager: ['schedule.view', 'appointments.manage', 'requests.manage', 'customers.manage', 'invoices.manage', 'payments.manage', 'estimates.manage', 'plans.manage', 'messaging.use', 'followups.manage', 'reports.view', 'reviews.manage', 'dispatch.manage', 'documents.manage'],
  staff: ['schedule.view', 'appointments.manage', 'requests.manage', 'customers.manage', 'invoices.manage', 'estimates.manage', 'messaging.use', 'followups.manage', 'documents.manage'],
  tech: ['schedule.view', 'field.work'],
};

export function capabilitiesFor(admin) {
  const base = ROLE_CAPS[admin?.role] || ROLE_CAPS.staff;
  const extra = Array.isArray(admin?.capabilities) ? admin.capabilities : [];
  return [...new Set([...base, ...extra])];
}

export function hasCapability(admin, cap) {
  if (!admin) return false;
  const caps = capabilitiesFor(admin);
  return caps.includes('*') || caps.includes(cap);
}

/** Middleware: require a capability. Use after requireAdmin. */
export function requirePermission(cap) {
  return (req, res, next) => {
    if (!req.admin) return unauthorized(res, 'Please sign in.');
    if (!hasCapability(req.admin, cap)) return sendError(res, 403, 'You do not have permission for this action.');
    next();
  };
}

export default { CAPS, capabilitiesFor, hasCapability, requirePermission };
