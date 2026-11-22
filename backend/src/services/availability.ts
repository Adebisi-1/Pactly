/**
 * Issue #65: a break cut out of one day's hours.
 *
 * A weekday's working hours are a continuous range; a break is a
 * `[startMinute, endMinute)` window inside that range, named in the shop's
 * own wall clock. Slots are not offered during it; the hours before and
 * after stay bookable. Everything here is pure -- `services/profile.ts`
 * owns the database writes.
 */
import { zonedClock } from "./timezone.js";

export interface ProviderBreak {
  /** `0` = Sunday .. `6` = Saturday, in the shop's timezone. */
  weekday: number;
  /** Minutes since the shop's midnight (0..1440). */
  startMinute: number;
  endMinute: number;
}

export interface WorkingRange {
  startMinute: number;
  endMinute: number;
}

/** A break that is malformed, overlaps another, or sits outside the day's
 * own working hours. `details` names the offending value(s) -- never a raw
 * error at the HTTP boundary. */
export class InvalidBreaksError extends Error {
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("One or more breaks are invalid.");
    this.name = "InvalidBreaksError";
    this.details = details;
  }
}

const MINUTES_PER_DAY = 24 * 60;

/** Validates the request shape and returns normalized, sorted breaks.
 * Rejects an out-of-range weekday/minute, an empty or inverted window, and
 * two breaks that overlap on the same weekday. */
export function validateBreaks(input: unknown): ProviderBreak[] {
  if (!Array.isArray(input)) {
    throw new InvalidBreaksError({ breaks: "Breaks must be an array." });
  }

  const breaks: ProviderBreak[] = input.map((raw, index) => {
    const value = (raw ?? {}) as Partial<Record<keyof ProviderBreak, unknown>>;
    const weekday = value.weekday;
    const startMinute = value.startMinute;
    const endMinute = value.endMinute;
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new InvalidBreaksError({ [`breaks.${index}.weekday`]: "Weekday must be 0 (Sunday) through 6 (Saturday)." });
    }
    if (
      typeof startMinute !== "number" ||
      !Number.isInteger(startMinute) ||
      startMinute < 0 ||
      startMinute >= MINUTES_PER_DAY
    ) {
      throw new InvalidBreaksError({ [`breaks.${index}.startMinute`]: "Break start must be a minute of the day." });
    }
    if (
      typeof endMinute !== "number" ||
      !Number.isInteger(endMinute) ||
      endMinute <= 0 ||
      endMinute > MINUTES_PER_DAY
    ) {
      throw new InvalidBreaksError({ [`breaks.${index}.endMinute`]: "Break end must be a minute of the day." });
    }
    if (endMinute <= startMinute) {
      throw new InvalidBreaksError({ [`breaks.${index}`]: "A break must end after it starts." });
    }
    return { weekday, startMinute, endMinute };
  });

  const sorted = [...breaks].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute || a.endMinute - b.endMinute,
  );
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (previous.weekday === current.weekday && current.startMinute < previous.endMinute) {
      throw new InvalidBreaksError({ overlapping: [previous, current] });
    }
  }
  return sorted;
}

/** The working range each weekday's own future slots imply -- earliest slot
 * start through the latest slot's end (its start plus one session), in the
 * shop's timezone. Weekdays with no slots have no entry. */
export function workingRangesForSlots(
  slots: number[],
  sessionLengthMinutes: number,
  timeZone: string,
): Map<number, WorkingRange> {
  const ranges = new Map<number, WorkingRange>();
  for (const startsAt of slots) {
    const clock = zonedClock(startsAt, timeZone);
    const endMinute = clock.minuteOfDay + sessionLengthMinutes;
    const existing = ranges.get(clock.weekday);
    if (!existing) {
      ranges.set(clock.weekday, { startMinute: clock.minuteOfDay, endMinute });
    } else {
      existing.startMinute = Math.min(existing.startMinute, clock.minuteOfDay);
      existing.endMinute = Math.max(existing.endMinute, endMinute);
    }
  }
  return ranges;
}

/** Rejects a break that starts before the day's range or ends after it. A
 * weekday with no saved slots has no range to compare against, so its break
 * is accepted as-is. */
export function assertBreaksWithinRanges(
  breaks: ProviderBreak[],
  ranges: Map<number, WorkingRange>,
): void {
  for (const providerBreak of breaks) {
    const range = ranges.get(providerBreak.weekday);
    if (!range) {
      continue;
    }
    if (providerBreak.startMinute < range.startMinute || providerBreak.endMinute > range.endMinute) {
      throw new InvalidBreaksError({
        range: `A break on weekday ${providerBreak.weekday} must start and end inside that day's working hours.`,
      });
    }
  }
}

/** `true` when a slot's own start falls inside one of `breaks` on its
 * weekday (in the shop's timezone). */
export function isSlotInsideBreak(
  startsAt: number,
  timeZone: string,
  breaks: ProviderBreak[],
): boolean {
  if (breaks.length === 0) {
    return false;
  }
  const clock = zonedClock(startsAt, timeZone);
  return breaks.some(
    (providerBreak) =>
      providerBreak.weekday === clock.weekday &&
      clock.minuteOfDay >= providerBreak.startMinute &&
      clock.minuteOfDay < providerBreak.endMinute,
  );
}

/** Every slot outside every break -- what a save actually stores. */
export function filterSlotsOutsideBreaks(
  slots: number[],
  timeZone: string,
  breaks: ProviderBreak[],
): number[] {
  if (breaks.length === 0) {
    return slots;
  }
  return slots.filter((startsAt) => !isSlotInsideBreak(startsAt, timeZone, breaks));
}
