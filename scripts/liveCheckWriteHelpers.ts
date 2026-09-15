import { formatLocalDateTime } from '../src/unlockWindow/planner.js';

/**
 * Pure helpers for scripts/live-check-write.ts, kept separate so they can be
 * unit-tested without importing the script (which runs on import).
 */

/** The distinct name prefix every CRUD round-trip object carries (R30 b). */
export const LIVE_PREFIX = 'MCP livecheck';

export class LiveCheckArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCheckArgError';
  }
}

export class LiveAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveAssertionError';
  }
}

export interface LiveCheckWriteArgs {
  /** `--go`: the operator has notified the user and received a go-ahead, so
   * phase (c) — the real 2-minute unlock of the designated portal — may run. */
  go: boolean;
  /** `--start HH:MM`: unlock at this clock time today instead of now + 2 min,
   * so the exact times can be communicated to the user before the go-ahead. */
  start?: string;
}

/** Parses the script's own arguments (everything after `node script`). */
export function parseLiveCheckWriteArgs(argv: readonly string[]): LiveCheckWriteArgs {
  const args: LiveCheckWriteArgs = { go: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--go') {
      args.go = true;
    } else if (arg === '--start' || arg.startsWith('--start=')) {
      const value = arg === '--start' ? argv[++i] : arg.slice('--start='.length);
      if (!value || !/^\d{2}:\d{2}$/.test(value)) {
        throw new LiveCheckArgError('--start requires a clock time in the form HH:MM (e.g. --start 14:30).');
      }
      args.start = value;
    } else {
      throw new LiveCheckArgError(`Unknown argument "${arg}". Usage: npm run test:live:write -- [--go] [--start HH:MM]`);
    }
  }
  return args;
}

export interface TestWindow {
  /** `YYYY-MM-DD HH:MM` */
  start: string;
  /** `YYYY-MM-DD HH:MM` */
  end: string;
  /** `HH:MM` */
  unlockClock: string;
  /** `HH:MM` */
  relockClock: string;
  startMs: number;
  endMs: number;
  /** Poll get_unlock_window until here: end + 1 minute (R30 c). */
  pollUntilMs: number;
}

const MINUTE_MS = 60_000;

export function clockOf(date: Date): string {
  return formatLocalDateTime(date).slice(11);
}

/**
 * The 2-minute test window: start = now + 2 min (seconds dropped) and
 * end = start + 2 min (R30 c). With `startClock`, the window starts at that
 * clock time today instead, which must be 1 to 60 minutes ahead of `now`.
 */
export function computeTestWindow(now: Date, startClock?: string): TestWindow {
  const wholeMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  let start: Date;
  if (startClock === undefined) {
    start = new Date(wholeMinute.getTime() + 2 * MINUTE_MS);
  } else {
    const match = /^(\d{2}):(\d{2})$/.exec(startClock);
    const hour = match ? Number(match[1]) : 99;
    const minute = match ? Number(match[2]) : 99;
    if (!match || hour > 23 || minute > 59) {
      throw new LiveCheckArgError(`--start "${startClock}" is not a valid HH:MM clock time.`);
    }
    start = new Date(wholeMinute.getFullYear(), wholeMinute.getMonth(), wholeMinute.getDate(), hour, minute, 0, 0);
    const aheadMs = start.getTime() - now.getTime();
    if (aheadMs < MINUTE_MS || aheadMs > 60 * MINUTE_MS) {
      throw new LiveCheckArgError(
        `--start ${startClock} must be between 1 and 60 minutes ahead of now (${formatLocalDateTime(now)} on the host clock).`
      );
    }
  }
  const end = new Date(start.getTime() + 2 * MINUTE_MS);
  return {
    start: formatLocalDateTime(start),
    end: formatLocalDateTime(end),
    unlockClock: clockOf(start),
    relockClock: clockOf(end),
    startMs: start.getTime(),
    endMs: end.getTime(),
    pollUntilMs: end.getTime() + MINUTE_MS,
  };
}

export function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new LiveAssertionError(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertTrue(label: string, condition: boolean): void {
  if (!condition) throw new LiveAssertionError(label);
}

/**
 * Resolves the first CARDFORMAT name out of GetCardFormats' `CARDFORMATS.CARDFORMAT`
 * field, tolerant of every shape observed: a bare string (a single format), an
 * array of strings (the live 6.2.0 shape, e.g. `["26 bit Wiegand", "..."]`),
 * an object carrying a `NAME` field, or an array of such objects (#13).
 * Returns `''` when no usable name is found.
 */
export function parseCardFormatName(raw: unknown): string {
  const items = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed !== '') return trimmed;
    } else if (item !== null && typeof item === 'object') {
      const name = (item as Record<string, unknown>).NAME;
      if (typeof name === 'string' && name.trim() !== '') return name.trim();
    }
  }
  return '';
}

export function assertSameSet(label: string, actual: readonly string[], expected: readonly string[]): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (left.length !== right.length || left.some((item, index) => item !== right[index])) {
    throw new LiveAssertionError(`${label}: expected [${right.join(',')}], got [${left.join(',')}]`);
  }
}

// ---------------------------------------------------------------------------
// (b2) controller clock estimate, from the newest GetAccessHistory record
// ---------------------------------------------------------------------------

/** Skew above this is a hard [FAIL] that skips phase (c) (R30 b2). There is
 * no "stale record" exemption: a large delta is indistinguishable from a
 * wrong clock, so any delta above this threshold fails closed regardless of
 * how old the newest access record is. */
const SKEW_FAIL_SECONDS = 2 * 60;

export type ClockSkewStatus = 'ok' | 'fail' | 'no-record';

export interface ClockSkewResult {
  status: ClockSkewStatus;
  /** `HH:MM:SS`, host clock at the moment of the check. */
  hostClock: string;
  /** `HH:MM:SS`, parsed from the newest access record's DTTM. Absent for `no-record`. */
  controllerClock?: string;
  /** Absolute difference between the two clocks, in whole seconds. Absent for `no-record`. */
  skewSeconds?: number;
  /** Signed `controller - host`, in whole seconds. Absent for `no-record`. Used to
   * project an estimated controller clock time forward from a later host time
   * (the HEADS-UP line in phase (c), R30 c). */
  offsetSeconds?: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:MM:SS` in the local (host) time zone. */
export function formatClockHMS(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Formats a non-negative duration, in seconds, as `HH:MM:SS`. */
export function formatDurationHMS(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
}

/**
 * Parses a controller DTTM (`YYYY-MM-DD HH:MM:SS`) as host-local wall time —
 * per R30 b2, the controller's clock is compared against the host clock by
 * treating the two as the same time zone, since the whole point of the check
 * is to catch a controller whose clock (not time zone) has drifted.
 */
export function parseControllerDttm(dttm: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dttm.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Estimates controller/host clock skew from the newest access-history
 * record's `DTTM` (R30 b2). `newestDttm` is `undefined` when no record was
 * returned at all.
 *
 * - No record, or a `DTTM` that doesn't parse -> `no-record` (WARN, continue)
 *   — only in this case is the estimate too weak to judge, since there is
 *   nothing to compare against.
 * - Skew beyond `SKEW_FAIL_SECONDS` (2 min) -> `fail` (skip phase (c)). There
 *   is no "stale record" exemption for a large delta: an old newest record
 *   is indistinguishable from a wrong clock, so any delta above the
 *   threshold fails closed no matter how old the record is.
 * - Otherwise -> `ok`.
 */
export function computeClockSkew(hostNow: Date, newestDttm: string | undefined): ClockSkewResult {
  const hostClock = formatClockHMS(hostNow);
  const controllerDate = newestDttm === undefined ? undefined : parseControllerDttm(newestDttm);
  if (!controllerDate) {
    return { status: 'no-record', hostClock };
  }
  const controllerClock = formatClockHMS(controllerDate);
  const offsetSeconds = Math.round((controllerDate.getTime() - hostNow.getTime()) / 1000);
  const skewSeconds = Math.abs(offsetSeconds);
  if (skewSeconds > SKEW_FAIL_SECONDS) {
    return { status: 'fail', hostClock, controllerClock, skewSeconds, offsetSeconds };
  }
  return { status: 'ok', hostClock, controllerClock, skewSeconds, offsetSeconds };
}

/** Projects an estimated controller clock time forward from `offsetSeconds`
 * (as returned by `computeClockSkew`) applied to a later host time — used
 * for the HEADS-UP line in phase (c) (R30 c). */
export function estimateControllerClock(hostNow: Date, offsetSeconds: number): string {
  return formatClockHMS(new Date(hostNow.getTime() + offsetSeconds * 1000));
}
