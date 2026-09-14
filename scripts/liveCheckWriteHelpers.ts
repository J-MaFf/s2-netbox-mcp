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

export function assertSameSet(label: string, actual: readonly string[], expected: readonly string[]): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (left.length !== right.length || left.some((item, index) => item !== right[index])) {
    throw new LiveAssertionError(`${label}: expected [${right.join(',')}], got [${left.join(',')}]`);
  }
}
