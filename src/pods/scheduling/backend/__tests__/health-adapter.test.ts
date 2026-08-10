/**
 * Tests for Task T09 — health.adapter.ts.
 * Acceptance: when domainMode=HEALTHCARE, status CHECKED_IN creates an
 * Encounter in the DB.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerHealthAdapter, mockEdi270Check } from '../adapters/health.adapter';
import { SchedulingEventBus, type AppointmentStatusChangedEvent } from '../scheduling.events';
import type { SchedulingPrisma } from '../scheduling.types';

function event(overrides: Partial<AppointmentStatusChangedEvent> = {}): AppointmentStatusChangedEvent {
  return {
    appointmentId: 'appt-1',
    customerId: 'cust-1',
    resourceId: 'res-1',
    previousStatus: 'SCHEDULED',
    status: 'CHECKED_IN',
    at: new Date('2024-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

function fakePrisma() {
  const create = vi.fn().mockResolvedValue({ id: 'enc-1' });
  const prisma = { encounter: { create } } as unknown as SchedulingPrisma;
  return { prisma, create };
}

describe('health.adapter (T09)', () => {
  it('creates an Encounter on CHECKED_IN in HEALTHCARE mode', async () => {
    const bus = new SchedulingEventBus();
    const { prisma, create } = fakePrisma();
    registerHealthAdapter(bus, { prisma, getMode: () => 'HEALTHCARE' });

    await bus.emit(event());

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      customerId: 'cust-1',
      appointmentId: 'appt-1',
      status: 'OPEN',
    });
    // Eligibility from the mock EDI 270 check is attached.
    expect((data.soapNote as { eligibility: { eligible: boolean } }).eligibility.eligible).toBe(
      true,
    );
  });

  it('does nothing for non-CHECKED_IN transitions', async () => {
    const bus = new SchedulingEventBus();
    const { prisma, create } = fakePrisma();
    registerHealthAdapter(bus, { prisma, getMode: () => 'HEALTHCARE' });

    await bus.emit(event({ status: 'CONFIRMED' }));
    await bus.emit(event({ status: 'CANCELLED' }));

    expect(create).not.toHaveBeenCalled();
  });

  it('is a no-op outside HEALTHCARE mode', async () => {
    const bus = new SchedulingEventBus();
    const { prisma, create } = fakePrisma();
    registerHealthAdapter(bus, { prisma, getMode: () => 'SALON' });

    await bus.emit(event());

    expect(create).not.toHaveBeenCalled();
  });

  it('mockEdi270Check returns a deterministic, traceable eligibility result', () => {
    const result = mockEdi270Check(event());
    expect(result.eligible).toBe(true);
    expect(result.payerId).toBe('MOCK-PAYER');
    expect(result.traceNumber).toContain('appt-1');
  });
});
