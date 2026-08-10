/**
 * Tests for Task T07 — slot-calculator.service.ts.
 * Acceptance: generates valid 30-min slots, ignoring booked appointments.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateAvailableSlots,
  parseHHMM,
  toWindows,
} from '../slot-calculator.service';
import type { AvailabilityWindow } from '../scheduling.types';

// 2024-01-01 is a Monday (UTC weekday 1).
const MONDAY = new Date('2024-01-01T00:00:00.000Z');
const nineToFive: AvailabilityWindow[] = [{ day: 1, start: '09:00', end: '17:00' }];

const overlaps = (aS: Date, aE: Date, bS: Date, bE: Date) =>
  aS.getTime() < bE.getTime() && aE.getTime() > bS.getTime();

describe('slot-calculator (T07)', () => {
  it('produces contiguous 30-min slots across the window', () => {
    const slots = calculateAvailableSlots({ date: MONDAY, windows: nineToFive });
    expect(slots).toHaveLength(16); // 8h / 30m
    expect(slots[0]!.start.toISOString()).toBe('2024-01-01T09:00:00.000Z');
    expect(slots[0]!.end.toISOString()).toBe('2024-01-01T09:30:00.000Z');
    expect(slots.at(-1)!.end.toISOString()).toBe('2024-01-01T17:00:00.000Z');
    // Every slot is exactly 30 minutes.
    for (const s of slots) {
      expect(s.end.getTime() - s.start.getTime()).toBe(30 * 60_000);
    }
  });

  it('excludes slots that overlap a booked appointment', () => {
    const booking = {
      start: new Date('2024-01-01T10:00:00.000Z'),
      end: new Date('2024-01-01T10:30:00.000Z'),
    };
    const slots = calculateAvailableSlots({
      date: MONDAY,
      windows: nineToFive,
      bookings: [booking],
    });
    expect(slots).toHaveLength(15);
    for (const s of slots) {
      expect(overlaps(s.start, s.end, booking.start, booking.end)).toBe(false);
    }
  });

  it('applies a buffer around bookings', () => {
    const booking = {
      start: new Date('2024-01-01T10:00:00.000Z'),
      end: new Date('2024-01-01T10:30:00.000Z'),
    };
    // 30-min buffer removes 09:30, 10:00, and 10:30 start slots.
    const slots = calculateAvailableSlots({
      date: MONDAY,
      windows: nineToFive,
      bookings: [booking],
      bufferMinutes: 30,
    });
    expect(slots).toHaveLength(13);
    const starts = slots.map((s) => s.start.toISOString());
    expect(starts).not.toContain('2024-01-01T09:30:00.000Z');
    expect(starts).not.toContain('2024-01-01T10:00:00.000Z');
    expect(starts).not.toContain('2024-01-01T10:30:00.000Z');
  });

  it('ignores windows for other weekdays', () => {
    const tuesdayOnly: AvailabilityWindow[] = [{ day: 2, start: '09:00', end: '17:00' }];
    expect(calculateAvailableSlots({ date: MONDAY, windows: tuesdayOnly })).toHaveLength(0);
  });

  it('honors an injected `now`, excluding past slots', () => {
    const now = new Date('2024-01-01T12:00:00.000Z');
    const slots = calculateAvailableSlots({ date: MONDAY, windows: nineToFive, now });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.start.getTime()).toBeGreaterThan(now.getTime());
    }
    expect(slots[0]!.start.toISOString()).toBe('2024-01-01T12:30:00.000Z');
  });

  it('supports a custom slot length', () => {
    const slots = calculateAvailableSlots({
      date: MONDAY,
      windows: nineToFive,
      slotMinutes: 60,
    });
    expect(slots).toHaveLength(8);
  });

  it('ignores inverted / empty windows', () => {
    const bad: AvailabilityWindow[] = [{ day: 1, start: '17:00', end: '09:00' }];
    expect(calculateAvailableSlots({ date: MONDAY, windows: bad })).toHaveLength(0);
  });

  it('parseHHMM parses and rejects bad input', () => {
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('00:00')).toBe(0);
    expect(() => parseHHMM('25:00')).toThrow();
    expect(() => parseHHMM('9:00')).toThrow();
    expect(() => parseHHMM('noon')).toThrow();
  });

  it('toWindows defensively filters malformed JSON schedules', () => {
    expect(toWindows(null)).toEqual([]);
    expect(toWindows('nope')).toEqual([]);
    expect(toWindows([{ day: 1, start: '09:00', end: '17:00' }, { bad: true }])).toHaveLength(1);
  });
});
