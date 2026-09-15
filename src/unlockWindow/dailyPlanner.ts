/**
 * Pure planner for a daily recurring unlock window (daily-unlock-window spec
 * R2, R3) — the companion to the continuous managed unlock window
 * (planner.ts).
 *
 * `schedule_unlock_window`'s planner turns one [start, end] date-time span
 * into 1-3 segments because a multi-day span's middle days need a full
 * 00:00-23:59 grant. This planner expresses a different shape of request —
 * "unlock these doors from dailyStartTime to dailyEndTime, every day from
 * startDate through endDate" — and always produces exactly **one** segment:
 * a single Holiday spanning the whole date range, paired with a single,
 * partial-day Time Spec (no weekdays, only the daily holiday group ticked).
 *
 * This works because a Time Spec with no weekdays and holiday group G ticked
 * is active during its STARTTIME-ENDTIME on *every* date covered by a
 * holiday in group G (see specs/archive/s2-netbox-mcp-write.md Context,
 * "live: GRAND OPENING, user-confirmed working") — so one holiday + one
 * time spec already expresses "the same partial-day window, every day in
 * the range", with no first/middle/last splitting needed.
 *
 * This module issues no NBAPI calls and reads no clock; everything that
 * needs a controller or the host time lives in dailyExecutor.ts.
 */

export class DailyPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DailyPlanError';
  }
}

export interface LocalDate {
  /** `YYYY-MM-DD` */
  date: string;
  year: number;
  month: number;
  day: number;
}

export interface LocalTime {
  /** `HH:MM` */
  time: string;
  hour: number;
  minute: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Strictly parses `YYYY-MM-DD` as a real calendar date (R3); returns
 * undefined for anything else (wrong shape, month 13, Feb 30, ...). */
export function parseLocalDate(value: string): LocalDate | undefined {
  const match = DATE_PATTERN.exec(value);
  if (!match) return undefined;
  const [, y, mo, d] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return { date: `${y}-${mo}-${d}`, year, month, day };
}

/** Strictly parses `HH:MM` as a real clock time (R3); returns undefined for
 * anything else (wrong shape, hour > 23, minute > 59, single-digit hour...). */
export function parseLocalTime(value: string): LocalTime | undefined {
  const match = TIME_PATTERN.exec(value);
  if (!match) return undefined;
  const [, h, mi] = match;
  const hour = Number(h);
  const minute = Number(mi);
  if (hour > 23 || minute > 59) return undefined;
  return { time: `${h}:${mi}`, hour, minute };
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

/** Whole days between two `YYYY-MM-DD` dates (`endDate` - `startDate`),
 * DST-proof (UTC arithmetic). Assumes both are already-valid dates. */
export function daysBetween(startDate: string, endDate: string): number {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000);
}

/** Minutes since midnight. */
export function minutesOfTime(time: LocalTime): number {
  return time.hour * 60 + time.minute;
}

/** Formats a host `Date` as controller-local `YYYY-MM-DD HH:MM` (the host and
 * the controller are assumed to share a timezone — see the README). */
export function formatLocalDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

export interface DailyPlan {
  window: { startDate: string; endDate: string; dailyStartTime: string; dailyEndTime: string };
  /** `<dailyPrefix> schedule` — the NAME of both the managed holiday and the managed time spec. */
  name: string;
  /** The reserved holiday group this plan's holiday and time spec share. */
  holidayGroup: number;
  /** Holiday STARTDATE: `startDate` at 00:00 (inclusive). */
  STARTDATE: string;
  /** Holiday ENDDATE: the day after `endDate` at 00:00 (exclusive). */
  ENDDATE: string;
  /** Time spec STARTTIME, `HH:MM`. */
  STARTTIME: string;
  /** Time spec ENDTIME, `HH:MM`. */
  ENDTIME: string;
}

/** The exact NAME of the one managed holiday and the one managed time spec
 * (R2) — mirrors `segmentName` in planner.ts, but for the single-segment
 * scheme (there is no "kind" to distinguish, since this plan is always
 * exactly one segment). */
export function dailyScheduleName(prefix: string): string {
  return `${prefix} schedule`;
}

/** The longest date range planDailyUnlockWindow accepts (R3; mirrors the
 * continuous feature's MAX_WINDOW_DAYS). */
export const MAX_DAILY_WINDOW_DAYS = 31;

/**
 * Plans a daily recurring unlock window (R2). Pure: same inputs, same plan.
 * Always produces exactly one segment — no first/middle/last splitting.
 *
 * @throws DailyPlanError when `startDate`/`endDate` is not a real `YYYY-MM-DD`
 *   date, `dailyStartTime`/`dailyEndTime` is not a real `HH:MM` time,
 *   `endDate` is earlier than `startDate`, or `dailyEndTime` is not later
 *   than `dailyStartTime` (same-day time-of-day only — an
 *   overnight-crossing daily window, e.g. `22:00` to `05:00`, is rejected;
 *   see the spec's Out of scope).
 */
export function planDailyUnlockWindow(
  startDate: string,
  endDate: string,
  dailyStartTime: string,
  dailyEndTime: string,
  dailyGroup: number,
  dailyPrefix: string
): DailyPlan {
  const start = parseLocalDate(startDate);
  if (!start) {
    throw new DailyPlanError(`startDate must be a real calendar date in the form YYYY-MM-DD (got "${startDate}").`);
  }
  const end = parseLocalDate(endDate);
  if (!end) {
    throw new DailyPlanError(`endDate must be a real calendar date in the form YYYY-MM-DD (got "${endDate}").`);
  }
  const startTime = parseLocalTime(dailyStartTime);
  if (!startTime) {
    throw new DailyPlanError(`dailyStartTime must be a real clock time in the form HH:MM (got "${dailyStartTime}").`);
  }
  const endTime = parseLocalTime(dailyEndTime);
  if (!endTime) {
    throw new DailyPlanError(`dailyEndTime must be a real clock time in the form HH:MM (got "${dailyEndTime}").`);
  }
  if (end.date < start.date) {
    throw new DailyPlanError(`endDate (${endDate}) must not be earlier than startDate (${startDate}).`);
  }
  if (minutesOfTime(endTime) <= minutesOfTime(startTime)) {
    throw new DailyPlanError(
      `dailyEndTime (${dailyEndTime}) must be later than dailyStartTime (${dailyStartTime}) — an overnight-crossing daily window is not supported.`
    );
  }

  return {
    window: { startDate: start.date, endDate: end.date, dailyStartTime: startTime.time, dailyEndTime: endTime.time },
    name: dailyScheduleName(dailyPrefix),
    holidayGroup: dailyGroup,
    STARTDATE: `${start.date} 00:00`,
    ENDDATE: `${addDays(end.date, 1)} 00:00`,
    STARTTIME: startTime.time,
    ENDTIME: endTime.time,
  };
}

/**
 * The two R3 checks that need the clock or the cap rather than the plan
 * itself: the window's last instant (`endDate` at `dailyEndTime`,
 * controller-local) must be later than the host's current time, and the
 * date range must be at most `MAX_DAILY_WINDOW_DAYS` days.
 * @throws DailyPlanError
 */
export function checkDailyWindowLimits(startDate: string, endDate: string, dailyEndTime: string, now: Date): void {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  const endTime = parseLocalTime(dailyEndTime);
  if (!start || !end || !endTime) {
    throw new DailyPlanError('startDate/endDate must be YYYY-MM-DD dates and dailyEndTime must be an HH:MM time.');
  }
  const lastInstant = new Date(end.year, end.month - 1, end.day, endTime.hour, endTime.minute);
  if (lastInstant.getTime() <= now.getTime()) {
    throw new DailyPlanError(
      `The window's last instant (${endDate} ${dailyEndTime}) is not later than the current time (${formatLocalDateTime(now)} on the host clock).`
    );
  }
  const rangeDays = daysBetween(start.date, end.date);
  if (rangeDays > MAX_DAILY_WINDOW_DAYS) {
    throw new DailyPlanError(`The date range is longer than ${MAX_DAILY_WINDOW_DAYS} days (${startDate} to ${endDate}).`);
  }
}
