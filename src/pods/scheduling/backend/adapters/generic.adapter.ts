/**
 * Generic (non-healthcare) scheduling adapter — Task T10.
 *
 * Handles appointment status changes for SALON / GENERIC modes. On CHECKED_IN
 * it settles any booking deposit through a payment gateway (Stripe, mocked) and
 * emits webhook-style notifications. It deliberately has NO access to clinical
 * tables — it cannot and does not touch Encounter/EHR data — which keeps a
 * salon deployment cleanly separated from PHI.
 *
 * In HEALTHCARE mode it is a no-op (the health adapter owns that path).
 *
 * Acceptance (matrix T10): when domainMode=SALON, check-in is handled without
 * touching healthcare DB tables.
 */
import { podConfig } from '@/config/pod.config';
import type { DomainMode } from '@/config/pod.config';
import type {
  AppointmentStatusChangedEvent,
  SchedulingEventBus,
} from '../scheduling.events';

/** Minimal payment gateway surface (Stripe-like), injectable for testing. */
export interface PaymentGateway {
  captureDeposit(input: {
    appointmentId: string;
    customerId: string;
  }): Promise<{ id: string; status: 'captured' | 'skipped' }>;
}

/** Outbound webhook notifier surface. */
export interface WebhookNotifier {
  notify(event: string, payload: Record<string, unknown>): Promise<void> | void;
}

export interface GenericAdapterDeps {
  /** Override the active domain mode (defaults to podConfig.domainMode). */
  getMode?: () => DomainMode;
  paymentGateway?: PaymentGateway;
  webhooks?: WebhookNotifier;
}

/**
 * Register the generic adapter on the bus. Returns the unsubscribe fn.
 */
export function registerGenericAdapter(
  bus: SchedulingEventBus,
  deps: GenericAdapterDeps = {},
): () => void {
  const getMode = deps.getMode ?? (() => podConfig.domainMode);

  return bus.on(async (event: AppointmentStatusChangedEvent) => {
    // Healthcare is handled by the health adapter; skip to avoid double-handling.
    if (getMode() === 'HEALTHCARE') return;

    if (event.status === 'CHECKED_IN') {
      // Settle the deposit (no clinical/PHI tables involved).
      const capture = await deps.paymentGateway?.captureDeposit({
        appointmentId: event.appointmentId,
        customerId: event.customerId,
      });
      await deps.webhooks?.notify('appointment.checked_in', {
        appointmentId: event.appointmentId,
        deposit: capture ?? null,
      });
      return;
    }

    if (event.status === 'CANCELLED' || event.status === 'NO_SHOW') {
      await deps.webhooks?.notify('appointment.closed', {
        appointmentId: event.appointmentId,
        status: event.status,
      });
    }
  });
}
