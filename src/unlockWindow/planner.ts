/**
 * Pure planner for a managed unlock window (R23).
 *
 * Turns a controller-local window [start, end] into one to three segments,
 * each realised on the controller as a Holiday (the dates) plus a Time Spec
 * (the clock range, no weekdays, exactly one reserved holiday group):
 *
 *   - same date            -> `first`  = [start time, end time]
 *   - otherwise            -> `first`  = [start time, 23:59] on the start date
 *                             `last`   = [00:00, end time]   on the end date
 *                             `middle` = [00:00, 23:59] on every date strictly
 *                                        between (only if at least one exists)
 *
 * An `end` of 00:00 is first normalised to 23:59 of the previous date, so a
 * window "to midnight" is the same-day plan ending 23:59. Holiday ENDDATE is
 * exclusive (the day *after* the segment's last date, at 00:00) — the doc's
 * one-day Christmas example is 12-25 00:00 -> 12-26 00:00.
 *
 * This module issues no NBAPI calls and reads no clock; everything that
 * needs a controller or the host time lives in executor.ts.
 */

export type SegmentKind = 'first' | 'middle' | 'last';

export const SEGMENT_KINDS: readonly SegmentKind[] = ['first', 'middle', 'last'];

/** End of day on the NBAPI: the built-in *Always* time spec uses 23:59, so a
 * multi-day window may relock for up to 60 s at each midnight (documented). */
export const END_OF_DAY = '23:59';
export const START_OF_DAY = '00:00';

export class UnlockPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockPlanError';
  }
}

export interface LocalDateTime {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM` */
  time: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Strictly parses `YYYY-MM-DD HH:MM` as a real calendar date-time (R22);
 * returns undefined for anything else (wrong shape, month 13, Feb 30, 24:00…). */
export function parseLocalDateTime(value: string): LocalDateTime | undefined {
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return undefined;
  const [, y, mo, d, h, mi] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59) return undefined;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, year, month, day, hour, minute };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Adds `days` (may be negative) to a `YYYY-MM-DD` date using UTC arithmetic,
 * so DST transitions on the host can never shift the result. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Minutes since the Unix epoch treating the value as UTC — a DST-proof way
 * to measure a window's length and compare two controller-local instants. */
export function minutesOf(dt: LocalDateTime): number {
  return Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute) / 60_000;
}

/** Formats a host `Date` as controller-local `YYYY-MM-DD HH:MM` (the host and
 * the controller are assumed to share a timezone — see the README). */
export function formatLocalDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

export interface PlannedSegment {
  kind: SegmentKind;
  /** `<prefix> <kind>` — the NAME of both the holiday and the time spec. */
  name: string;
  /** The reserved holiday group this segment's holiday and time spec share. */
  holidayGroup: number;
  /** Holiday STARTDATE: the segment's first date at 00:00 (inclusive). */
  STARTDATE: string;
  /** Holiday ENDDATE: the day after the segment's last date at 00:00 (exclusive). */
  ENDDATE: string;
  /** Time spec STARTTIME, `HH:MM`. */
  STARTTIME: string;
  /** Time spec ENDTIME, `HH:MM`. */
  ENDTIME: string;
}

export interface UnlockPlan {
  /** The window as requested (end un-normalised). */
  window: { start: string; end: string };
  /** The window with an `end` of 00:00 normalised to 23:59 of the previous date. */
  effective: { start: LocalDateTime; end: LocalDateTime };
  segments: PlannedSegment[];
  /** The reserved holiday groups this plan actually uses, in segment order. */
  holidayGroupsUsed: number[];
  /** `[first segment STARTDATE, last segment ENDDATE)` — the plan's date coverage. */
  coverage: { STARTDATE: string; ENDDATE: string };
}

export function segmentName(prefix: string, kind: SegmentKind): string {
  return `${prefix} ${kind}`;
}

/**
 * Plans a managed unlock window (R23). Pure: same inputs, same plan.
 *
 * @param groups the reserved holiday groups in [first, middle, last] order
 *   (NETBOX_UNLOCK_HOLIDAY_GROUPS). A plan that needs a segment whose group
 *   is not configured is refused rather than doubling up a group, because two
 *   segments sharing a group would each unlock on the other's dates.
 * @throws UnlockPlanError when either bound is not a real `YYYY-MM-DD HH:MM`
 *   date-time, when `end` <= `start`, or when the groups can't cover the plan.
 */
export function planUnlockWindow(start: string, end: string, groups: readonly number[], prefix: string): UnlockPlan {
  const startDt = parseLocalDateTime(start);
  if (!startDt) {
    throw new UnlockPlanError(`start must be a real calendar date-time in the form YYYY-MM-DD HH:MM (got "${start}").`);
  }
  const endDtRaw = parseLocalDateTime(end);
  if (!endDtRaw) {
    throw new UnlockPlanError(`end must be a real calendar date-time in the form YYYY-MM-DD HH:MM (got "${end}").`);
  }
  if (minutesOf(endDtRaw) <= minutesOf(startDt)) {
    throw new UnlockPlanError(`end (${end}) must be later than start (${start}).`);
  }

  // An end of 00:00 means "up to midnight": 23:59 of the previous date.
  const endDt: LocalDateTime =
    endDtRaw.time === START_OF_DAY ? parseLocalDateTime(`${addDays(endDtRaw.date, -1)} ${END_OF_DAY}`)! : endDtRaw;

  const wanted: Array<{ kind: SegmentKind; firstDate: string; lastDate: string; STARTTIME: string; ENDTIME: string }> = [];
  if (startDt.date === endDt.date) {
    wanted.push({ kind: 'first', firstDate: startDt.date, lastDate: startDt.date, STARTTIME: startDt.time, ENDTIME: endDt.time });
  } else {
    wanted.push({ kind: 'first', firstDate: startDt.date, lastDate: startDt.date, STARTTIME: startDt.time, ENDTIME: END_OF_DAY });
    const firstMiddle = addDays(startDt.date, 1);
    if (firstMiddle < endDt.date) {
      wanted.push({
        kind: 'middle',
        firstDate: firstMiddle,
        lastDate: addDays(endDt.date, -1),
        STARTTIME: START_OF_DAY,
        ENDTIME: END_OF_DAY,
      });
    }
    wanted.push({ kind: 'last', firstDate: endDt.date, lastDate: endDt.date, STARTTIME: START_OF_DAY, ENDTIME: endDt.time });
  }

  const segments: PlannedSegment[] = wanted.map((segment) => {
    const groupIndex = SEGMENT_KINDS.indexOf(segment.kind);
    const holidayGroup = groups[groupIndex];
    if (holidayGroup === undefined) {
      throw new UnlockPlanError(
        `This window needs a "${segment.kind}" segment, which uses reserved holiday group #${groupIndex + 1}, ` +
          `but NETBOX_UNLOCK_HOLIDAY_GROUPS only configures ${groups.length} group(s) (${groups.join(',')}).`
      );
    }
    return {
      kind: segment.kind,
      name: segmentName(prefix, segment.kind),
      holidayGroup,
      STARTDATE: `${segment.firstDate} ${START_OF_DAY}`,
      ENDDATE: `${addDays(segment.lastDate, 1)} ${START_OF_DAY}`,
      STARTTIME: segment.STARTTIME,
      ENDTIME: segment.ENDTIME,
    };
  });

  return {
    window: { start, end },
    effective: { start: startDt, end: endDt },
    segments,
    holidayGroupsUsed: segments.map((segment) => segment.holidayGroup),
    coverage: { STARTDATE: segments[0].STARTDATE, ENDDATE: segments[segments.length - 1].ENDDATE },
  };
}

/** The longest window schedule_unlock_window accepts (R22). */
export const MAX_WINDOW_DAYS = 31;

/**
 * The two R22 checks that need the clock or the cap rather than the plan:
 * the window must end in the future (host clock) and be at most 31 days
 * long (measured on the requested, un-normalised bounds).
 * @throws UnlockPlanError
 */
export function checkWindowLimits(start: string, end: string, now: Date): void {
  const startDt = parseLocalDateTime(start);
  const endDt = parseLocalDateTime(end);
  if (!startDt || !endDt) throw new UnlockPlanError('start and end must be YYYY-MM-DD HH:MM date-times.');
  const endLocal = new Date(endDt.year, endDt.month - 1, endDt.day, endDt.hour, endDt.minute);
  if (endLocal.getTime() <= now.getTime()) {
    throw new UnlockPlanError(
      `end (${end}) is not later than the current time (${formatLocalDateTime(now)} on the host clock).`
    );
  }
  const lengthMinutes = minutesOf(endDt) - minutesOf(startDt);
  if (lengthMinutes > MAX_WINDOW_DAYS * 24 * 60) {
    throw new UnlockPlanError(`The window is longer than ${MAX_WINDOW_DAYS} days (${start} to ${end}).`);
  }
}
