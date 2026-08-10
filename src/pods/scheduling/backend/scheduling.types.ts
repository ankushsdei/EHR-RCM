/**
 * Shared scheduling-pod types — Tasks T07–T10.
 *
 * `AppointmentStatus` mirrors the Prisma enum in prisma/schema.prisma and is
 * redeclared here so the pod compiles/tests without a generated client.
 */

export const APPOINTMENT_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export function isAppointmentStatus(v: unknown): v is AppointmentStatus {
  return typeof v === 'string' && (APPOINTMENT_STATUSES as readonly string[]).includes(v);
}

/** Allowed status transitions (state machine). */
export const STATUS_TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> =
  Object.freeze({
    SCHEDULED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
    CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
    CHECKED_IN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
    NO_SHOW: [],
  });

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** A weekly availability window for a resource. `day`: 0=Sunday … 6=Saturday. */
export interface AvailabilityWindow {
  day: number;
  start: string; // "HH:MM" 24h
  end: string; // "HH:MM" 24h
}

/** An occupied time range (existing booking). */
export interface Booking {
  start: Date;
  end: Date;
}

/** A free, bookable time slot. */
export interface Slot {
  start: Date;
  end: Date;
}

// --- Minimal persisted-record shapes the pod relies on ----------------------

export interface ResourceRecord {
  id: string;
  name: string;
  schedule: unknown; // AvailabilityWindow[] as JSON
  bufferMinutes: number;
  isActive: boolean;
}

export interface AppointmentRecord {
  id: string;
  customerId: string;
  resourceId: string;
  serviceItemId: string | null;
  startTime: Date;
  endTime: Date;
  status: AppointmentStatus;
}

/** Minimal structural subset of the Prisma client used by the scheduling pod. */
export interface SchedulingPrisma {
  resource: {
    findUnique(args: { where: { id: string } }): Promise<ResourceRecord | null>;
  };
  appointment: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<AppointmentRecord[]>;
    findUnique(args: { where: { id: string } }): Promise<AppointmentRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<AppointmentRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<AppointmentRecord>;
  };
  encounter: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}
