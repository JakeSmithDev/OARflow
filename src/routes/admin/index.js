// Mounts all admin JSON API routers under /api/admin.
import express from 'express';
import authRouter from './auth.js';
import dashboardRouter from './dashboard.js';
import appointmentsRouter from './appointments.js';
import customersRouter from './customers.js';
import invoicesRouter from './invoices.js';
import plansRouter from './plans.js';
import followUpsRouter from './follow_ups.js';
import settingsRouter from './settings.js';
import messagingRouter from './messaging.js';

const router = express.Router();

router.use('/auth', authRouter);
router.use('/dashboard', dashboardRouter);
router.use('/appointments', appointmentsRouter);
router.use('/customers', customersRouter);
router.use('/invoices', invoicesRouter);
router.use('/plans', plansRouter);
router.use('/follow-ups', followUpsRouter);
router.use('/settings', settingsRouter);
router.use('/messaging', messagingRouter);

export default router;
