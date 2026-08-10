/**
 * Scheduling event bus — supports the domain adapters (Tasks T09/T10).
 *
 * The router emits an `AppointmentStatusChangedEvent` whenever an appointment
 * transitions state. Domain adapters subscribe and react (e.g. the healthcare
 * adapter creates a clinical Encounter on CHECKED_IN). Keeping this as an
 * explicit, awaitable bus — rather than Node's EventEmitter — lets callers
 * `await` all listener side effects, which makes request flows and tests
 * deterministic.
 */
import type { AppointmentStatus } from './scheduling.types';

export interface AppointmentStatusChangedEvent {
  appointmentId: string;
  customerId: string;
  resourceId: string;
  previousStatus: AppointmentStatus;
  status: AppointmentStatus;
  at: Date;
}

export type AppointmentListener = (
  event: AppointmentStatusChangedEvent,
) => void | Promise<void>;

export class SchedulingEventBus {
  private readonly listeners = new Set<AppointmentListener>();

  /** Subscribe; returns an unsubscribe function. */
  on(listener: AppointmentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Number of active listeners (useful in tests). */
  get size(): number {
    return this.listeners.size;
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Emit an event to all listeners and await their completion. Listener errors
   * are collected and logged but never prevent other listeners from running.
   */
  async emit(event: AppointmentStatusChangedEvent): Promise<void> {
    const results = await Promise.allSettled(
      [...this.listeners].map((listener) => Promise.resolve(listener(event))),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[SchedulingEventBus] listener failed:', r.reason);
      }
    }
  }
}

/** Process-wide default bus used by the router when none is injected. */
export const schedulingEventBus = new SchedulingEventBus();
