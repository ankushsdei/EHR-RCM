/**
 * Slot-calculation engine — Task T07.
 *
 * Given a resource's weekly availability windows and its existing bookings,
 * computes the free, bookable time slots for a given day. Pure and
 * deterministic (no clock/IO except an optional injected `now`), so it is fully
 * unit-testable.
 *
 * All times are computed in UTC: window "HH:MM" strings are interpreted against
 * the UTC calendar day of the supplied `date`. Callers working in a local
 * timezone should normalize before/after.
 *
 * Acceptance (matrix T07): generates valid 30-min slots, ignoring booked
 * appointments.
 */
import type { AvailabilityWindow, Booking, Slot } from './scheduling.types';

export const DEFAULT_SLOT_MINUTES = 30;

export interface SlotCalcParams {
  /** The day to compute slots for (its UTC Y/M/D is used). */
  date: Date;
  /** Weekly availability windows for the resource. */
  windows: AvailabilityWindow[];
  /** Existing bookings to avoid. */
  bookings?: Booking[];
  /** Slot length in minutes (default 30). */
  slotMinutes?: number;
  /** Padding applied around each booking, in minutes (default 0). */
  bufferMinutes?: number;
  /** If provided, slots starting at or before `now` are excluded. */
  now?: Date;
}

/** Parse "HH:MM" (24h) into minutes-from-midnight. Throws on malformed input. */
export function parseHHMM(value: string): number {
  const m = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}" (expected HH:MM 24h)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Build a UTC Date at `minutesFromMidnight` on the same UTC day as `date`. */
function atUtcMinutes(date: Date, minutesFromMidnight: number): Date {
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return new Date(base + minutesFromMidnight * 60_000);
}

/** True if [start,end) overlaps any booking expanded by `bufferMs` on each side. */
function conflicts(start: Date, end: Date, bookings: Booking[], bufferMs: number): boolean {
  const s = start.getTime();
  const e = end.getTime();
  for (const b of bookings) {
    const bStart = b.start.getTime() - bufferMs;
    const bEnd = b.end.getTime() + bufferMs;
    // Half-open overlap test.
    if (s < bEnd && e > bStart) return true;
  }
  return false;
}

/**
 * Compute available slots for the given day.
 * Windows whose `day` does not match the date's UTC weekday are ignored.
 */
export function calculateAvailableSlots(params: SlotCalcParams): Slot[] {
  const {
    date,
    windows,
    bookings = [],
    slotMinutes = DEFAULT_SLOT_MINUTES,
    bufferMinutes = 0,
    now,
  } = params;

  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) {
    throw new Error('slotMinutes must be a positive integer');
  }

  const weekday = date.getUTCDay();
  const bufferMs = Math.max(0, bufferMinutes) * 60_000;
  const nowMs = now?.getTime();

  const slots: Slot[] = [];

  for (const window of windows) {
    if (window.day !== weekday) continue;
    const startMin = parseHHMM(window.start);
    const endMin = parseHHMM(window.end);
    if (endMin <= startMin) continue; // ignore empty/inverted windows

    for (let t = startMin; t + slotMinutes <= endMin; t += slotMinutes) {
      const slotStart = atUtcMinutes(date, t);
      const slotEnd = atUtcMinutes(date, t + slotMinutes);

      if (nowMs !== undefined && slotStart.getTime() <= nowMs) continue;
      if (conflicts(slotStart, slotEnd, bookings, bufferMs)) continue;

      slots.push({ start: slotStart, end: slotEnd });
    }
  }

  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return slots;
}

/** Coerce a JSON schedule value into a typed window list (defensive). */
export function toWindows(schedule: unknown): AvailabilityWindow[] {
  if (!Array.isArray(schedule)) return [];
  return schedule.filter(
    (w): w is AvailabilityWindow =>
      !!w &&
      typeof w === 'object' &&
      typeof (w as AvailabilityWindow).day === 'number' &&
      typeof (w as AvailabilityWindow).start === 'string' &&
      typeof (w as AvailabilityWindow).end === 'string',
  );
}
