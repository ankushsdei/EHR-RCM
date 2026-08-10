/**
 * Tests for Task T08 — scheduling.router.ts (Vitest + Supertest).
 * Acceptance: POST /appointments creates a booking; PATCH /status updates state.
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createSchedulingRouter } from '../scheduling.router';
import { SchedulingEventBus, type AppointmentStatusChangedEvent } from '../scheduling.events';
import type {
  AppointmentRecord,
  ResourceRecord,
  SchedulingPrisma,
} from '../scheduling.types';

interface WhereTime {
  gte?: Date;
  lt?: Date;
  gt?: Date;
}

function matches(a: AppointmentRecord, where: Record<string, unknown>): boolean {
  if (where.resourceId && a.resourceId !== where.resourceId) return false;
  const status = where.status as { notIn?: string[] } | undefined;
  if (status?.notIn && status.notIn.includes(a.status)) return false;
  const st = where.startTime as WhereTime | undefined;
  if (st?.gte && a.startTime < st.gte) return false;
  if (st?.lt && !(a.startTime < st.lt)) return false;
  const et = where.endTime as WhereTime | undefined;
  if (et?.gt && !(a.endTime > et.gt)) return false;
  return true;
}

function makeStore(): SchedulingPrisma & { appts: Map<string, AppointmentRecord> } {
  const resource: ResourceRecord = {
    id: 'res-1',
    name: 'Dr. Bones',
    schedule: [{ day: 1, start: '09:00', end: '17:00' }], // Monday
    bufferMinutes: 0,
    isActive: true,
  };
  const appts = new Map<string, AppointmentRecord>();
  let seq = 0;
  return {
    appts,
    resource: {
      async findUnique({ where }) {
        return where.id === resource.id ? resource : null;
      },
    },
    appointment: {
      async findMany({ where }) {
        return [...appts.values()].filter((a) => matches(a, where));
      },
      async findUnique({ where }) {
        return appts.get(where.id) ?? null;
      },
      async create({ data }) {
        const id = `appt-${++seq}`;
        const rec: AppointmentRecord = {
          id,
          customerId: String(data.customerId),
          resourceId: String(data.resourceId),
          serviceItemId: (data.serviceItemId as string | null) ?? null,
          startTime: data.startTime as Date,
          endTime: data.endTime as Date,
          status: (data.status as AppointmentRecord['status']) ?? 'SCHEDULED',
        };
        appts.set(id, rec);
        return rec;
      },
      async update({ where, data }) {
        const rec = appts.get(where.id);
        if (!rec) throw new Error('not found');
        Object.assign(rec, data);
        return rec;
      },
    },
    encounter: { async create() { return { id: 'enc-x' }; } },
  };
}

describe('scheduling.router (T08)', () => {
  let store: ReturnType<typeof makeStore>;
  let bus: SchedulingEventBus;
  let events: AppointmentStatusChangedEvent[];
  let app: Express;

  beforeEach(() => {
    store = makeStore();
    bus = new SchedulingEventBus();
    events = [];
    bus.on((e) => {
      events.push(e);
    });
    app = express();
    app.use(express.json());
    app.use('/api/v1/scheduling', createSchedulingRouter({ prisma: store, bus }));
  });

  describe('GET /slots', () => {
    it('returns available 30-min slots for a resource/day', async () => {
      const res = await request(app).get('/api/v1/scheduling/slots').query({
        resourceId: 'res-1',
        date: '2024-01-01', // Monday
      });
      expect(res.status).toBe(200);
      expect(res.body.slots).toHaveLength(16);
      expect(res.body.slots[0]).toEqual({
        start: '2024-01-01T09:00:00.000Z',
        end: '2024-01-01T09:30:00.000Z',
      });
    });

    it('omits slots overlapping an existing appointment', async () => {
      await store.appointment.create({
        data: {
          customerId: 'c1',
          resourceId: 'res-1',
          startTime: new Date('2024-01-01T10:00:00.000Z'),
          endTime: new Date('2024-01-01T10:30:00.000Z'),
          status: 'SCHEDULED',
        },
      });
      const res = await request(app)
        .get('/api/v1/scheduling/slots')
        .query({ resourceId: 'res-1', date: '2024-01-01' });
      expect(res.status).toBe(200);
      expect(res.body.slots).toHaveLength(15);
      expect(res.body.slots.map((s: { start: string }) => s.start)).not.toContain(
        '2024-01-01T10:00:00.000Z',
      );
    });

    it('404s an unknown resource', async () => {
      const res = await request(app)
        .get('/api/v1/scheduling/slots')
        .query({ resourceId: 'nope', date: '2024-01-01' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /appointments', () => {
    const body = {
      customerId: 'c1',
      resourceId: 'res-1',
      startTime: '2024-01-01T09:00:00.000Z',
      endTime: '2024-01-01T09:30:00.000Z',
    };

    it('creates a booking (201, status SCHEDULED)', async () => {
      const res = await request(app).post('/api/v1/scheduling/appointments').send(body);
      expect(res.status).toBe(201);
      expect(res.body.appointment).toMatchObject({
        customerId: 'c1',
        resourceId: 'res-1',
        status: 'SCHEDULED',
      });
      expect(store.appts.size).toBe(1);
    });

    it('rejects a body where endTime is not after startTime (400)', async () => {
      const res = await request(app)
        .post('/api/v1/scheduling/appointments')
        .send({ ...body, endTime: body.startTime });
      expect(res.status).toBe(400);
    });

    it('rejects a double-booking of the same resource (409)', async () => {
      await request(app).post('/api/v1/scheduling/appointments').send(body);
      const res = await request(app)
        .post('/api/v1/scheduling/appointments')
        .send({ ...body, startTime: '2024-01-01T09:15:00.000Z', endTime: '2024-01-01T09:45:00.000Z' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('SlotUnavailable');
    });
  });

  describe('PATCH /appointments/:id/status', () => {
    async function seedAppt() {
      const created = await request(app).post('/api/v1/scheduling/appointments').send({
        customerId: 'c1',
        resourceId: 'res-1',
        startTime: '2024-01-01T09:00:00.000Z',
        endTime: '2024-01-01T09:30:00.000Z',
      });
      return created.body.appointment.id as string;
    }

    it('transitions a valid status and emits an event (200)', async () => {
      const id = await seedAppt();
      const res = await request(app)
        .patch(`/api/v1/scheduling/appointments/${id}/status`)
        .send({ status: 'CHECKED_IN' });
      expect(res.status).toBe(200);
      expect(res.body.appointment.status).toBe('CHECKED_IN');
      expect(store.appts.get(id)!.status).toBe('CHECKED_IN');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        appointmentId: id,
        previousStatus: 'SCHEDULED',
        status: 'CHECKED_IN',
        customerId: 'c1',
      });
    });

    it('rejects an illegal transition (409) and emits nothing', async () => {
      const id = await seedAppt();
      const res = await request(app)
        .patch(`/api/v1/scheduling/appointments/${id}/status`)
        .send({ status: 'COMPLETED' }); // SCHEDULED cannot jump to COMPLETED
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('InvalidStatusTransition');
      expect(events).toHaveLength(0);
    });

    it('404s an unknown appointment', async () => {
      const res = await request(app)
        .patch('/api/v1/scheduling/appointments/missing/status')
        .send({ status: 'CHECKED_IN' });
      expect(res.status).toBe(404);
    });

    it('400s an invalid status value', async () => {
      const id = await seedAppt();
      const res = await request(app)
        .patch(`/api/v1/scheduling/appointments/${id}/status`)
        .send({ status: 'TELEPORTED' });
      expect(res.status).toBe(400);
    });
  });
});
