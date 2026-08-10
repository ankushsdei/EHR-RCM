/**
 * Scheduling router — Task T08.
 *
 * Endpoints (mounted under /api/v1/scheduling):
 *   - GET   /slots?resourceId=&date=YYYY-MM-DD   list available slots
 *   - POST  /appointments                        create a booking
 *   - PATCH /appointments/:id/status             transition appointment state
 *
 * Status transitions are validated against the state machine in
 * scheduling.types, and every successful transition emits an
 * `AppointmentStatusChangedEvent` on the bus so domain adapters (T09/T10) can
 * react. Prisma and the bus are injectable for testing.
 *
 * Acceptance (matrix T08): POST /appointments creates a booking; PATCH /status
 * updates the state.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  calculateAvailableSlots,
  DEFAULT_SLOT_MINUTES,
  toWindows,
} from './slot-calculator.service';
import { schedulingEventBus, type SchedulingEventBus } from './scheduling.events';
import {
  APPOINTMENT_STATUSES,
  canTransition,
  type Booking,
  type SchedulingPrisma,
} from './scheduling.types';

export interface SchedulingRouterDeps {
  prisma?: SchedulingPrisma;
  bus?: SchedulingEventBus;
  slotMinutes?: number;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

const slotsQuerySchema = z.object({
  resourceId: z.string().min(1),
  date: dateOnly,
});

const createApptSchema = z
  .object({
    customerId: z.string().min(1),
    resourceId: z.string().min(1),
    serviceItemId: z.string().min(1).optional(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
  })
  .refine((v) => new Date(v.endTime) > new Date(v.startTime), {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

const statusSchema = z.object({
  status: z.enum(APPOINTMENT_STATUSES),
});

export function createSchedulingRouter(deps: SchedulingRouterDeps = {}): Router {
  const router = Router();
  const bus = deps.bus ?? schedulingEventBus;
  const slotMinutes = deps.slotMinutes ?? DEFAULT_SLOT_MINUTES;

  const getStore = async (): Promise<SchedulingPrisma> => {
    if (deps.prisma) return deps.prisma;
    const { getPrisma } = await import('@/shared/db/prisma');
    return getPrisma() as unknown as SchedulingPrisma;
  };

  // --- GET /slots -----------------------------------------------------------
  router.get('/slots', async (req: Request, res: Response) => {
    const parsed = slotsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const { resourceId, date } = parsed.data;
    const prisma = await getStore();

    const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
    if (!resource || !resource.isActive) {
      return res.status(404).json({ error: 'ResourceNotFound' });
    }

    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T00:00:00.000Z`);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const appts = await prisma.appointment.findMany({
      where: {
        resourceId,
        startTime: { gte: dayStart, lt: dayEnd },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      orderBy: { startTime: 'asc' },
    });

    const bookings: Booking[] = appts.map((a) => ({ start: a.startTime, end: a.endTime }));

    const slots = calculateAvailableSlots({
      date: dayStart,
      windows: toWindows(resource.schedule),
      bookings,
      slotMinutes,
      bufferMinutes: resource.bufferMinutes,
    });

    return res.status(200).json({
      resourceId,
      date,
      slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    });
  });

  // --- POST /appointments ---------------------------------------------------
  router.post('/appointments', async (req: Request, res: Response) => {
    const parsed = createApptSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const { customerId, resourceId, serviceItemId, startTime, endTime } = parsed.data;
    const prisma = await getStore();

    const start = new Date(startTime);
    const end = new Date(endTime);

    // Reject double-booking of the same resource.
    const overlapping = await prisma.appointment.findMany({
      where: {
        resourceId,
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
        startTime: { lt: end },
        endTime: { gt: start },
      },
    });
    if (overlapping.length > 0) {
      return res.status(409).json({ error: 'SlotUnavailable' });
    }

    const appointment = await prisma.appointment.create({
      data: {
        customerId,
        resourceId,
        serviceItemId: serviceItemId ?? null,
        startTime: start,
        endTime: end,
        status: 'SCHEDULED',
      },
    });

    return res.status(201).json({ appointment });
  });

  // --- PATCH /appointments/:id/status --------------------------------------
  router.patch('/appointments/:id/status', async (req: Request, res: Response) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const { status } = parsed.data;
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'ValidationError', issues: ['missing appointment id'] });
    }
    const prisma = await getStore();

    const current = await prisma.appointment.findUnique({ where: { id } });
    if (!current) {
      return res.status(404).json({ error: 'AppointmentNotFound' });
    }

    // Capture the prior status BEFORE the update, so the emitted event reports
    // the correct transition even if the store returns a shared reference.
    const previousStatus = current.status;

    if (previousStatus === status) {
      return res.status(200).json({ appointment: current });
    }
    if (!canTransition(previousStatus, status)) {
      return res.status(409).json({
        error: 'InvalidStatusTransition',
        from: previousStatus,
        to: status,
      });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status },
    });

    // Notify domain adapters; awaited so side effects are observable/deterministic.
    await bus.emit({
      appointmentId: updated.id,
      customerId: updated.customerId,
      resourceId: updated.resourceId,
      previousStatus,
      status: updated.status,
      at: new Date(),
    });

    return res.status(200).json({ appointment: updated });
  });

  return router;
}

export default createSchedulingRouter;
