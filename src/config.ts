/**
 * Environment-variable configuration for the NetBox NBAPI client.
 *
 * IMPORTANT: nothing in this module (or anywhere else in src/) may write the
 * value of NETBOX_PASSWORD to a log, console, or error message (see R19).
 * Error messages below only ever reference environment variable *names*.
 */
export interface NetboxConfig {
  baseUrl: string;
  username: string;
  password: string;
  allowInsecureTls: boolean;
  apiPath: string;
  /** Resolved per R6: NETBOX_EVENT_API_PATH unset/empty -> apiPath; a
   * non-empty override is used verbatim (leading `/` added if missing). */
  eventApiPath: string;
  /** R7/R1: gates every write tool (R9-R20). */
  enableWrites: boolean;
  /** R7/R2: additionally gates the 11 destructive tools. */
  enableDestructive: boolean;
  /** R7/R23: the three reserved holiday groups used by the (stage-2) managed
   * unlock window planner, in [first, middle, last] order. */
  unlockHolidayGroups: [number, number, number] | [number, number] | [number];
  /** R7/R25/R27: name prefix for the (stage-2) managed unlock-window objects. */
  unlockNamePrefix: string;
  /** R7/R30 (stage-2 live write check only): the PORTALKEY the operator has
   * designated safe to physically unlock during a live write smoke test. */
  liveTestPortalKey: string | undefined;
}

export class NetboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetboxConfigError';
  }
}

/**
 * The NBAPI path on NetBox 6.x, verified live against a real 6.2.0
 * controller (see spec Context). The pre-6.x doc's `/goforms/nbapi` path
 * returns HTTP 410 Gone on 6.x and is available only as an explicit
 * `NETBOX_API_PATH` override for pre-6.x controllers (R20).
 */
export const DEFAULT_NETBOX_API_PATH = '/nbws/goforms/nbapi';

/**
 * Resolves NETBOX_API_PATH per R20: unset/empty defaults to
 * DEFAULT_NETBOX_API_PATH; a non-empty override is used verbatim except that
 * a missing leading `/` is added.
 */
function resolveApiPath(raw: string | undefined): string {
  if (!raw) return DEFAULT_NETBOX_API_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Resolves NETBOX_EVENT_API_PATH per R6: unset/empty resolves to the
 * already-resolved NETBOX_API_PATH; a non-empty override is used verbatim
 * with a missing leading `/` added (same rule as NETBOX_API_PATH itself).
 * `/appd/nbapi` is the pre-6.x documented value for this override.
 */
function resolveEventApiPath(raw: string | undefined, apiPath: string): string {
  if (!raw) return apiPath;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

const TRUTHY = /^(1|true|yes)$/i;

/** Explicit opt-in only; any value other than 1/true/yes (case-insensitive)
 * is falsy, per the spec's "no silent fallback" constraint. */
function parseBool(raw: string | undefined): boolean {
  return TRUTHY.test(raw ?? '');
}

export const DEFAULT_UNLOCK_HOLIDAY_GROUPS = '8,7,6';
export const DEFAULT_UNLOCK_NAME_PREFIX = 'MCP Unlock Window';

/**
 * Validates and parses NETBOX_UNLOCK_HOLIDAY_GROUPS per R7: 1-3 distinct
 * integers in 1..8, comma-separated. Throws a one-line NetboxConfigError
 * naming the variable and the rule on any violation.
 */
function resolveUnlockHolidayGroups(raw: string | undefined): [number, number, number] | [number, number] | [number] {
  const value = raw && raw.trim() !== '' ? raw : DEFAULT_UNLOCK_HOLIDAY_GROUPS;
  const rule =
    'NETBOX_UNLOCK_HOLIDAY_GROUPS must be 1-3 distinct integers in 1..8, separated by commas (e.g. "8,7,6").';
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^[1-8]$/.test(part))) {
    throw new NetboxConfigError(rule);
  }
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (new Set(numbers).size !== numbers.length) {
    throw new NetboxConfigError(rule);
  }
  return numbers as [number, number, number] | [number, number] | [number];
}

/**
 * Validates NETBOX_UNLOCK_NAME_PREFIX per R7: 1-40 characters, so
 * `<prefix> time specs` (the longest managed-object NAME this prefix
 * produces) still fits the NBAPI's 64-character NAME limit.
 */
function resolveUnlockNamePrefix(raw: string | undefined): string {
  const value = raw && raw.trim() !== '' ? raw : DEFAULT_UNLOCK_NAME_PREFIX;
  if (value.length < 1 || value.length > 40) {
    throw new NetboxConfigError(
      'NETBOX_UNLOCK_NAME_PREFIX must be 1-40 characters (so "<prefix> time specs" fits the 64-character NAME limit).'
    );
  }
  return value;
}

/**
 * Reads and validates NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD, and
 * the optional NETBOX_ALLOW_INSECURE_TLS, NETBOX_API_PATH, NETBOX_EVENT_API_PATH,
 * NETBOX_ENABLE_WRITES, NETBOX_ENABLE_DESTRUCTIVE, NETBOX_UNLOCK_HOLIDAY_GROUPS,
 * NETBOX_UNLOCK_NAME_PREFIX, and NETBOX_LIVE_TEST_PORTALKEY from the given
 * environment (defaults to `process.env`). Throws NetboxConfigError with a
 * single-line, actionable message (naming only the missing/invalid variable
 * name, never any value) if any required variable is missing or any
 * optional variable's value is invalid.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NetboxConfig {
  const baseUrl = env.NETBOX_BASE_URL;
  const username = env.NETBOX_USERNAME;
  const password = env.NETBOX_PASSWORD;

  const missing: string[] = [];
  if (!baseUrl) missing.push('NETBOX_BASE_URL');
  if (!username) missing.push('NETBOX_USERNAME');
  if (!password) missing.push('NETBOX_PASSWORD');

  if (missing.length > 0) {
    throw new NetboxConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in your environment (or a .env file — see .env.example) before starting the server.'
    );
  }

  const allowInsecureTls = parseBool(env.NETBOX_ALLOW_INSECURE_TLS);
  const apiPath = resolveApiPath(env.NETBOX_API_PATH);

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ''),
    username: username!,
    password: password!,
    allowInsecureTls,
    apiPath,
    eventApiPath: resolveEventApiPath(env.NETBOX_EVENT_API_PATH, apiPath),
    enableWrites: parseBool(env.NETBOX_ENABLE_WRITES),
    enableDestructive: parseBool(env.NETBOX_ENABLE_DESTRUCTIVE),
    unlockHolidayGroups: resolveUnlockHolidayGroups(env.NETBOX_UNLOCK_HOLIDAY_GROUPS),
    unlockNamePrefix: resolveUnlockNamePrefix(env.NETBOX_UNLOCK_NAME_PREFIX),
    liveTestPortalKey: env.NETBOX_LIVE_TEST_PORTALKEY || undefined,
  };
}
