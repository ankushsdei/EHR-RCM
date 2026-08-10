/**
 * Healthcare scheduling adapter — Task T09.
 *
 * Subscribes to appointment status changes. When running in HEALTHCARE mode and
 * an appointment transitions to CHECKED_IN, it:
 *   1. runs a (mocked) EDI 270 eligibility check, and
 *   2. auto-creates a clinical `Encounter` row for the visit.
 *
 * In non-healthcare modes it is a no-op, so it is safe to register regardless
 * of `domainMode` (the generic adapter handles those modes).
 *
 * Acceptance (matrix T09): when domainMode=HEALTHCARE, status CHECKED_IN
 * creates an Encounter in the DB.
 */
import { podConfig } from '@/config/pod.config';
import type { DomainMode } from '@/config/pod.config';
import type {
  AppointmentStatusChangedEvent,
  SchedulingEventBus,
} from '../scheduling.events';
import type { SchedulingPrisma } from '../scheduling.types';

/** Result of a (mocked) EDI 270/271 eligibility inquiry. */
export interface EligibilityResult {
  eligible: boolean;
  payerId: string;
  traceNumber: string;
  checkedAt: Date;
}

/**
 * Stubbed EDI 270 eligibility check. A real implementation would build an X12
 * 270 inquiry and parse the 271 response; here we deterministically approve so
 * downstream flows can proceed in dev/test.
 */
export function mockEdi270Check(event: AppointmentStatusChangedEvent): EligibilityResult {
  return {
    eligible: true,
    payerId: 'MOCK-PAYER',
    traceNumber: `270-${event.appointmentId}`,
    checkedAt: event.at,
  };
}

export interface HealthAdapterDeps {
  prisma: SchedulingPrisma;
  /** Override the active domain mode (defaults to podConfig.domainMode). */
  getMode?: () => DomainMode;
  /** Eligibility checker (injectable for testing). */
  eligibilityCheck?: (e: AppointmentStatusChangedEvent) => EligibilityResult;
}

/**
 * Register the healthcare adapter on the bus. Returns the unsubscribe fn.
 */
export function registerHealthAdapter(
  bus: SchedulingEventBus,
  deps: HealthAdapterDeps,
): () => void {
  const getMode = deps.getMode ?? (() => podConfig.domainMode);
  const eligibilityCheck = deps.eligibilityCheck ?? mockEdi270Check;

  return bus.on(async (event) => {
    if (getMode() !== 'HEALTHCARE') return;
    if (event.status !== 'CHECKED_IN') return;

    // 1) Eligibility (mock EDI 270). Non-fatal if ineligible — still open a chart.
    const eligibility = eligibilityCheck(event);

    // 2) Create the clinical encounter for this visit.
    await deps.prisma.encounter.create({
      data: {
        customerId: event.customerId,
        appointmentId: event.appointmentId,
        status: 'OPEN',
        soapNote: {
          eligibility: {
            eligible: eligibility.eligible,
            payerId: eligibility.payerId,
            traceNumber: eligibility.traceNumber,
          },
        },
      },
    });
  });
}
