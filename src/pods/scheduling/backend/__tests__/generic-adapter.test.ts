/**
 * Tests for Task T10 — generic.adapter.ts.
 * Acceptance: when domainMode=SALON, check-in is handled without touching
 * healthcare DB tables.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerGenericAdapter, type PaymentGateway } from '../adapters/generic.adapter';
import { registerHealthAdapter } from '../adapters/health.adapter';
import { SchedulingEventBus, type AppointmentStatusChangedEvent } from '../scheduling.events';
import type { SchedulingPrisma } from '../scheduling.types';

function event(overrides: Partial<AppointmentStatusChangedEvent> = {}): AppointmentStatusChangedEvent {
  return {
    appointmentId: 'appt-9',
    customerId: 'cust-9',
    resourceId: 'chair-1',
    previousStatus: 'SCHEDULED',
    status: 'CHECKED_IN',
    at: new Date('2024-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

function fakeGateway() {
  const captureDeposit = vi.fn().mockResolvedValue({ id: 'pi_1', status: 'captured' as const });
  const gateway = { captureDeposit } as PaymentGateway;
  return { gateway, captureDeposit };
}

describe('generic.adapter (T10)', () => {
  it('captures a deposit and fires a webhook on CHECKED_IN (SALON)', async () => {
    const bus = new SchedulingEventBus();
    const { gateway, captureDeposit } = fakeGateway();
    const notify = vi.fn().mockResolvedValue(undefined);
    registerGenericAdapter(bus, {
      getMode: () => 'SALON',
      paymentGateway: gateway,
      webhooks: { notify },
    });

    await bus.emit(event());

    expect(captureDeposit).toHaveBeenCalledWith({ appointmentId: 'appt-9', customerId: 'cust-9' });
    expect(notify).toHaveBeenCalledWith('appointment.checked_in', expect.objectContaining({
      appointmentId: 'appt-9',
    }));
  });

  it('is a no-op in HEALTHCARE mode', async () => {
    const bus = new SchedulingEventBus();
    const { gateway, captureDeposit } = fakeGateway();
    registerGenericAdapter(bus, { getMode: () => 'HEALTHCARE', paymentGateway: gateway });

    await bus.emit(event());

    expect(captureDeposit).not.toHaveBeenCalled();
  });

  it('fires a close webhook on CANCELLED / NO_SHOW', async () => {
    const bus = new SchedulingEventBus();
    const notify = vi.fn().mockResolvedValue(undefined);
    registerGenericAdapter(bus, { getMode: () => 'SALON', webhooks: { notify } });

    await bus.emit(event({ status: 'CANCELLED' }));
    expect(notify).toHaveBeenCalledWith('appointment.closed', expect.objectContaining({
      appointmentId: 'appt-9',
      status: 'CANCELLED',
    }));
  });

  it('in SALON, check-in never writes clinical tables even with both adapters registered', async () => {
    const bus = new SchedulingEventBus();
    const encounterCreate = vi.fn().mockResolvedValue({ id: 'enc-x' });
    const prisma = { encounter: { create: encounterCreate } } as unknown as SchedulingPrisma;
    const { gateway, captureDeposit } = fakeGateway();

    // Both adapters share the bus; only the generic one should act in SALON mode.
    registerHealthAdapter(bus, { prisma, getMode: () => 'SALON' });
    registerGenericAdapter(bus, { getMode: () => 'SALON', paymentGateway: gateway });

    await bus.emit(event());

    expect(captureDeposit).toHaveBeenCalledTimes(1);
    expect(encounterCreate).not.toHaveBeenCalled(); // no healthcare DB write
  });
});
