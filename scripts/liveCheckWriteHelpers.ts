import { formatLocalDateTime } from '../src/unlockWindow/planner.js';
import { NBAPI_COMMANDS, type NbapiCommandName } from '../src/commands.js';
import type { PortalStateAction } from '../src/portalState.js';

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

/** Thrown for the supervised single-action mode's own argument problems —
 * an unknown `--action`, `--action` combined with `--go`, or a missing
 * `--value` a given action requires. The script maps this to exit code 2
 * (distinct from LiveCheckArgError's exit code 1), and every case that can
 * throw it is checked before any network call is made (#12). */
export class LiveCheckActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCheckActionError';
  }
}

export interface LiveCheckWriteArgs {
  /** `--go`: the operator has notified the user and received a go-ahead, so
   * phase (c) — the real 2-minute unlock of the designated portal — may run. */
  go: boolean;
  /** `--start HH:MM`: unlock at this clock time today instead of now + 2 min,
   * so the exact times can be communicated to the user before the go-ahead. */
  start?: string;
  /** `--action <name>`: run exactly one supervised action instead of the
   * full (b)/(b2)/(c) flow (#12). */
  action?: string;
  /** `--value <v>`: extra value some actions require (currently only
   * `set_threat_level`, as the LEVELNAME to set). */
  value?: string;
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
    } else if (arg === '--action' || arg.startsWith('--action=')) {
      const value = arg === '--action' ? argv[++i] : arg.slice('--action='.length);
      if (!value) {
        throw new LiveCheckArgError('--action requires a value (e.g. --action unlock_portal).');
      }
      args.action = value;
    } else if (arg === '--value' || arg.startsWith('--value=')) {
      const value = arg === '--value' ? argv[++i] : arg.slice('--value='.length);
      if (value === undefined || value === '') {
        throw new LiveCheckArgError('--value requires a non-empty value (e.g. --value High).');
      }
      args.value = value;
    } else {
      throw new LiveCheckArgError(
        `Unknown argument "${arg}". Usage: npm run test:live:write -- [--go] [--start HH:MM] | -- --action <name> [--value <v>]`
      );
    }
  }
  if (args.action !== undefined && args.go) {
    throw new LiveCheckActionError(
      '--action cannot be combined with --go: supervised single actions run standalone, skipping phases (b), (b2), and (c) entirely.'
    );
  }
  return args;
}

// ---------------------------------------------------------------------------
// Supervised single-action mode (#12): `--action <name> [--value <v>]`
// ---------------------------------------------------------------------------

export const LIVE_CHECK_ACTION_NAMES = [
  'unlock_portal',
  'lock_portal',
  'momentary_unlock_portal',
  'dog_on_next_exit_portal',
  'activate_output',
  'deactivate_output',
  'set_portals_state_unlock',
  'set_portals_state_lock',
  'set_portals_state_momentary',
  'set_threat_level',
  'trigger_event_activate',
  'trigger_event_deactivate',
] as const;

export type LiveCheckActionName = (typeof LIVE_CHECK_ACTION_NAMES)[number];

export interface LiveCheckActionContext {
  /** The designated portal's NAME (GetPortals). */
  portalName: string;
  /** Present only when `--value` was given. */
  value?: string;
}

export interface LiveCheckActionSpec {
  name: LiveCheckActionName;
  /** 'command': one direct NBAPI command against PORTALKEY, OUTPUTKEY, or
   *  (for set_threat_level) LEVELNAME. 'setPortalsState': routed through the
   *  real `setPortalsState` function (src/portalState.ts) instead. */
  kind: 'command' | 'setPortalsState';
  /** Set for kind 'command'. Always an NBAPI_COMMANDS constant — never a literal. */
  command?: NbapiCommandName;
  /** Set for kind 'setPortalsState': the action passed to setPortalsState(). */
  portalStateAction?: PortalStateAction;
  /** True when this action targets the portal's strike OUTPUTKEY rather than its PORTALKEY. */
  targetsOutput: boolean;
  /** True when this action refuses to run without `--value` (set_threat_level's
   * LEVELNAME, and trigger_event_activate/trigger_event_deactivate's EVENTNAME). */
  requiresValue: boolean;
  /** Builds the "OBSERVE: ..." line printed after the action runs. */
  observe: (ctx: LiveCheckActionContext) => string;
}

/** The supervised single-action table (#12). Every entry uses an
 * NBAPI_COMMANDS constant (or the real setPortalsState function) — never a
 * literal command string — and every action is reversible, as documented in
 * the README's "Supervised single actions" paragraph. */
export const LIVE_CHECK_ACTIONS: Readonly<Record<LiveCheckActionName, LiveCheckActionSpec>> = {
  unlock_portal: {
    name: 'unlock_portal',
    kind: 'command',
    command: NBAPI_COMMANDS.UNLOCK_PORTAL,
    targetsOutput: false,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: ${portalName} should be unlocked now (Extended Unlock) until lock_portal is run`,
  },
  lock_portal: {
    name: 'lock_portal',
    kind: 'command',
    command: NBAPI_COMMANDS.LOCK_PORTAL,
    targetsOutput: false,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: ${portalName} should be locked now`,
  },
  momentary_unlock_portal: {
    name: 'momentary_unlock_portal',
    kind: 'command',
    command: NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL,
    targetsOutput: false,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: ${portalName} should have unlocked briefly and relocked on its own (Momentary Unlock)`,
  },
  dog_on_next_exit_portal: {
    name: 'dog_on_next_exit_portal',
    kind: 'command',
    command: NBAPI_COMMANDS.DOG_ON_NEXT_EXIT_PORTAL,
    targetsOutput: false,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: ${portalName} should unlock (Dog) on its next REX/exit until lock_portal is run`,
  },
  activate_output: {
    name: 'activate_output',
    kind: 'command',
    command: NBAPI_COMMANDS.ACTIVATE_OUTPUT,
    targetsOutput: true,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: the strike output for ${portalName} should be active (energized) now until deactivate_output is run`,
  },
  deactivate_output: {
    name: 'deactivate_output',
    kind: 'command',
    command: NBAPI_COMMANDS.DEACTIVATE_OUTPUT,
    targetsOutput: true,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: the strike output for ${portalName} should be inactive (de-energized) now`,
  },
  set_portals_state_unlock: {
    name: 'set_portals_state_unlock',
    kind: 'setPortalsState',
    portalStateAction: 'UNLOCK',
    targetsOutput: false,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: ${portalName} should be unlocked now (Extended Unlock) until set_portals_state_lock is run`,
  },
  set_portals_state_lock: {
    name: 'set_portals_state_lock',
    kind: 'setPortalsState',
    portalStateAction: 'LOCK',
    targetsOutput: false,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: ${portalName} should be locked now`,
  },
  set_portals_state_momentary: {
    name: 'set_portals_state_momentary',
    kind: 'setPortalsState',
    portalStateAction: 'MOMENTARY_UNLOCK',
    targetsOutput: false,
    requiresValue: false,
    observe: ({ portalName }) => `OBSERVE: ${portalName} should have unlocked briefly and relocked on its own (Momentary Unlock)`,
  },
  set_threat_level: {
    name: 'set_threat_level',
    kind: 'command',
    command: NBAPI_COMMANDS.SET_THREAT_LEVEL,
    targetsOutput: false,
    requiresValue: true,
    observe: ({ value }) =>
      `OBSERVE: the system-wide threat level should now show "${value}" on Monitor — set it back with ` +
      '--action set_threat_level --value Default when done',
  },
  // The only way TriggerEvent is reachable from this script (#12): the target
  // event must already exist in the NetBox UI (events cannot be created via
  // the NBAPI), and EVENTNAME (--value) identifies it. Routed through the
  // real NetboxClient.call, so NETBOX_EVENT_API_PATH still applies (R6).
  trigger_event_activate: {
    name: 'trigger_event_activate',
    kind: 'command',
    command: NBAPI_COMMANDS.TRIGGER_EVENT,
    targetsOutput: false,
    requiresValue: true,
    observe: ({ portalName, value }) =>
      `OBSERVE: event ${value} activated — if its action is Unlock Portal, ${portalName} should be unlocked ` +
      'until trigger_event_deactivate; if Momentary Unlock, a brief release',
  },
  trigger_event_deactivate: {
    name: 'trigger_event_deactivate',
    kind: 'command',
    command: NBAPI_COMMANDS.TRIGGER_EVENT,
    targetsOutput: false,
    requiresValue: true,
    observe: ({ portalName, value }) =>
      `OBSERVE: event ${value} deactivated — if its action is Unlock Portal, ${portalName} should now be locked; ` +
      'a Momentary Unlock event has already relocked itself',
  },
};

/** Resolves `--action <name>` against LIVE_CHECK_ACTIONS, throwing
 * LiveCheckActionError with the full supported list on an unknown name. */
export function resolveLiveCheckAction(name: string): LiveCheckActionSpec {
  const spec = (LIVE_CHECK_ACTIONS as Record<string, LiveCheckActionSpec | undefined>)[name];
  if (!spec) {
    throw new LiveCheckActionError(`Unknown --action "${name}". Supported actions: ${LIVE_CHECK_ACTION_NAMES.join(', ')}.`);
  }
  return spec;
}

export interface LiveCheckOutputRef {
  NAME: string;
  OUTPUTKEY: string;
}

/** Finds the GetOutputs entry whose NAME starts with the designated portal's
 * NAME (e.g. portal "02OF01A" -> output "02OF01A EL"), per #12. Returns the
 * first match in list order. */
export function findStrikeOutput(portalName: string, outputs: readonly LiveCheckOutputRef[]): LiveCheckOutputRef | undefined {
  return outputs.find((output) => output.NAME.startsWith(portalName));
}

/** The controller's ERRMSG when a lock/unlock/momentary/dog command is a
 * no-op (mirrors src/portalState.ts's ALREADY_IN_STATE, kept local here so
 * this file stays independently unit-testable). */
const PORTAL_STATE_NOT_CHANGED = /Portal state not changed/i;

/** True when a FAIL's ERRMSG is the controller's "no-op" answer, which #12
 * reports as PASS-with-note (already in that state) rather than a failure. */
export function isPortalStateNotChangedError(errmsg: string | undefined): boolean {
  return PORTAL_STATE_NOT_CHANGED.test(errmsg ?? '');
}

/** Builds the params sent for a kind:'command' action (#12). Never called for
 * kind:'setPortalsState', which goes through the real setPortalsState()
 * function and its own PORTALKEY list instead. */
export function buildActionParams(
  spec: LiveCheckActionSpec,
  target: { PORTALKEY: string; OUTPUTKEY?: string },
  value: string | undefined
): Record<string, string> {
  if (spec.name === 'set_threat_level') {
    return { LEVELNAME: value ?? '' };
  }
  if (spec.name === 'trigger_event_activate' || spec.name === 'trigger_event_deactivate') {
    return {
      EVENTNAME: value ?? '',
      EVENTACTION: spec.name === 'trigger_event_activate' ? 'ACTIVATE' : 'DEACTIVATE',
      PARTITIONID: '1',
    };
  }
  if (spec.targetsOutput) {
    return { OUTPUTKEY: target.OUTPUTKEY ?? '' };
  }
  return { PORTALKEY: target.PORTALKEY };
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
