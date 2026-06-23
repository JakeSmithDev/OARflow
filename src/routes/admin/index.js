// Mounts all admin JSON API routers under /api/admin.
import express from 'express';
import authRouter from './auth.js';
import dashboardRouter from './dashboard.js';
import appointmentsRouter from './appointments.js';
import customersRouter from './customers.js';
import invoicesRouter from './invoices.js';
import estimatesRouter from './estimates.js';
import plansRouter from './plans.js';
import followUpsRouter from './follow_ups.js';
import settingsRouter from './settings.js';
import messagingRouter from './messaging.js';
import reportsRouter from './reports.js';
import reviewsRouter from './reviews.js';
import techniciansRouter from './technicians.js';
import accountingRouter from './accounting.js';
import routingRouter from './routing.js';
import documentsRouter from './documents.js';
import complianceRouter from './compliance.js';
import devicesRouter from './devices.js';
import voiceRouter from './voice.js';
import developerRouter from './developer.js';

const router = express.Router();

router.use('/auth', authRouter);
router.use('/dashboard', dashboardRouter);
router.use('/appointments', appointmentsRouter);
router.use('/customers', customersRouter);
router.use('/invoices', invoicesRouter);
router.use('/estimates', estimatesRouter);
router.use('/plans', plansRouter);
router.use('/follow-ups', followUpsRouter);
router.use('/settings', settingsRouter);
router.use('/messaging', messagingRouter);
router.use('/reports', reportsRouter);
router.use('/reviews', reviewsRouter);
router.use('/technicians', techniciansRouter);
router.use('/accounting', accountingRouter);
router.use('/routing', routingRouter);
router.use('/documents', documentsRouter);
router.use('/compliance', complianceRouter);
router.use('/devices', devicesRouter);
router.use('/voice', voiceRouter);
router.use('/developer', developerRouter);

export default router;
