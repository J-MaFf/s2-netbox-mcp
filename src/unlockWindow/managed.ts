import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { asRecord, asRecordList, fetchAllPages, fetchAllPagesWith, isBareNotFoundFail, splitKeys, text } from '../paging.js';
import { SEGMENT_KINDS, segmentName, type SegmentKind } from './planner.js';

/**
 * Managed-object naming (R27) and typed, normalised readers for the objects
 * the unlock-window tools work with.
 *
 * Names are the identity of every managed object:
 *   - `<prefix>`             the managed portal group
 *   - `<prefix> time specs`  the managed time spec group
 *   - `<prefix> first`       the holiday + time spec of the `first` segment
 *   - `<prefix> middle`      ... `middle`
 *   - `<prefix> last`        ... `last`
 * Nothing here (or in executor.ts) ever modifies or deletes an object whose
 * NAME is not exactly one of those, and a user-created object that happens
 * to carry one of those names is treated as managed.
 *
 * The time spec group is never named exactly `<prefix>` (that name is the
 * portal group's) because group names are unique across group types on this
 * controller (live, 2026-09-15: adding a portal group under an already-used
 * time spec group name failed with ERRMSG "Duplicate Portal Group") — see
 * the spec Context.
 *
 * Read-back normalisation (live 6.2.0): weekday flags come back `TRUE`/`FALSE`
 * (the doc's input format is `1`/`0`); dates come back `YYYY-MM-DD HH:MM:SS`;
 * times may come back with seconds; GetHolidays' HOLIDAYS is a comma string.
 *
 * Time spec group *membership* is read from paginated GetTimeSpecGroups —
 * never from GetTimeSpecGroup, which returns CODE=FAIL/ERRMSG="NOT FOUND"
 * for every key on this controller (verified twice; see the spec Context).
 */

export const MANAGED_DESCRIPTION = 'Managed by s2-netbox-mcp; do not edit';

/** The exact NAME of the built-in time spec group every cancelled window is
 * pointed at (R26). */
export const NEVER_GROUP_NAME = 'Never';

export const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ManagedNames {
  portalGroup: string;
  timeSpecGroup: string;
  segments: Record<SegmentKind, string>;
}

/** The exact NAME of the managed time spec group (R25 step 2, R27): never
 * the same as the portal group's name (see the module doc comment). */
export function timeSpecGroupName(prefix: string): string {
  return `${prefix} time specs`;
}

export function managedNames(prefix: string): ManagedNames {
  return {
    portalGroup: prefix,
    timeSpecGroup: timeSpecGroupName(prefix),
    segments: { first: segmentName(prefix, 'first'), middle: segmentName(prefix, 'middle'), last: segmentName(prefix, 'last') },
  };
}

/** The segment kind a managed holiday/time spec NAME denotes, or undefined
 * for any name that is not exactly `<prefix> first|middle|last`. */
export function segmentKindOf(name: string, prefix: string): SegmentKind | undefined {
  return SEGMENT_KINDS.find((kind) => segmentName(prefix, kind) === name);
}

/** True when a NAME carries the managed prefix (the prefix itself or
 * `<prefix> ...`). Used only to *exclude* our own objects from the R24
 * side-effect report — mutations use the exact names (segmentKindOf). */
export function carriesManagedPrefix(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(`${prefix} `);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** `HH:MM:SS` / `H:MM` -> `HH:MM`; anything unrecognised is returned trimmed. */
export function normalizeTime(value: unknown): string {
  const raw = text(value).trim();
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : raw;
}

/** `YYYY-MM-DD HH:MM:SS` / `YYYY-MM-DD` -> `YYYY-MM-DD HH:MM`. */
export function normalizeDateTime(value: unknown): string {
  const raw = text(value).trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(raw);
  if (!match) return raw;
  const [, date, hour, minute] = match;
  return hour === undefined ? `${date} 00:00` : `${date} ${hour.padStart(2, '0')}:${minute}`;
}

/** `TRUE`/`1`/`true` -> '1'; everything else (FALSE, 0, '', missing) -> '0'. */
export function normalizeFlag(value: unknown): '0' | '1' {
  return /^(true|1)$/i.test(text(value).trim()) ? '1' : '0';
}

/** Comma-split holiday groups, trimmed, de-duplicated, numerically sorted. */
export function normalizeGroups(value: unknown): string[] {
  return [...new Set(splitKeys(value))].sort((a, b) => Number(a) - Number(b));
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** A key list that may arrive as `<KEYS><KEY>k</KEY>...</KEYS>` (object with
 * a single or repeated child), as a bare comma string, or as '' when empty. */
export function keyList(container: unknown, item: string): string[] {
  if (typeof container === 'string' || typeof container === 'number') return splitKeys(container);
  const inner = asRecord(container)[item];
  if (Array.isArray(inner)) return inner.map(text).filter((key) => key !== '');
  const single = text(inner);
  return single === '' ? [] : [single];
}

// ---------------------------------------------------------------------------
// Typed records
// ---------------------------------------------------------------------------

export interface PortalRecord {
  PORTALKEY: string;
  NAME: string;
}

export interface TimeSpecRecord {
  TIMESPECKEY: string;
  NAME: string;
  DESCRIPTION: string;
  /** `HH:MM` */
  STARTTIME: string;
  /** `HH:MM` */
  ENDTIME: string;
  /** Normalised to '0'/'1' per weekday. */
  weekdays: Record<Weekday, '0' | '1'>;
  /** Normalised, sorted holiday group numbers as strings. */
  HOLIDAYGROUPS: string[];
}

export interface TimeSpecGroupRecord {
  TIMESPECGROUPKEY: string;
  NAME: string;
  DESCRIPTION: string;
  TIMESPECKEYS: string[];
}

export interface HolidayRecord {
  HOLIDAYKEY: string;
  NAME: string;
  HOLIDAYGROUPS: string[];
  /** `YYYY-MM-DD HH:MM` (inclusive) */
  STARTDATE: string;
  /** `YYYY-MM-DD HH:MM` (exclusive) */
  ENDDATE: string;
}

export interface PortalGroupSummary {
  PORTALGROUPKEY: string;
  NAME: string;
}

export interface PortalGroupRecord extends PortalGroupSummary {
  DESCRIPTION: string;
  PORTALS: PortalRecord[];
  UNLOCKTIMESPECGROUPKEY: string;
  THREATLEVELGROUPKEY: string;
}

function toTimeSpecRecord(raw: Record<string, unknown>): TimeSpecRecord {
  const weekdays = Object.fromEntries(WEEKDAYS.map((day) => [day, normalizeFlag(raw[day])])) as Record<Weekday, '0' | '1'>;
  return {
    TIMESPECKEY: text(raw.TIMESPECKEY),
    NAME: text(raw.NAME),
    DESCRIPTION: text(raw.DESCRIPTION),
    STARTTIME: normalizeTime(raw.STARTTIME),
    ENDTIME: normalizeTime(raw.ENDTIME),
    weekdays,
    HOLIDAYGROUPS: normalizeGroups(raw.HOLIDAYGROUPS),
  };
}

function toTimeSpecGroupRecord(raw: Record<string, unknown>): TimeSpecGroupRecord {
  return {
    TIMESPECGROUPKEY: text(raw.TIMESPECGROUPKEY),
    NAME: text(raw.NAME),
    DESCRIPTION: text(raw.DESCRIPTION),
    TIMESPECKEYS: keyList(raw.TIMESPECKEYS, 'TIMESPECKEY'),
  };
}

function toPortalRecord(raw: Record<string, unknown>): PortalRecord {
  return { PORTALKEY: text(raw.PORTALKEY), NAME: text(raw.NAME) };
}

/** Singular Get commands answer NOT FOUND (or, on 6.2.0, FAIL/"NOT FOUND")
 * for an unknown key — both mean "no such object" to the composite tools. */
async function callSingular(client: NetboxClient, command: Parameters<NetboxClient['call']>[0], params: Record<string, string>) {
  try {
    const result = await client.call(command, params);
    return result.notFound ? undefined : asRecord(result.data);
  } catch (err) {
    if (isBareNotFoundFail(err)) return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Readers (every list read is fully paginated — see src/paging.ts)
// ---------------------------------------------------------------------------

const LIST_OPTIONS = { emptyOnNotFoundFail: true };

export async function fetchPortals(client: NetboxClient): Promise<PortalRecord[]> {
  const portals = await fetchAllPages(client, NBAPI_COMMANDS.GET_PORTALS, 'PORTALS', 'PORTAL', LIST_OPTIONS);
  return portals.map(toPortalRecord);
}

export async function fetchTimeSpecs(client: NetboxClient): Promise<TimeSpecRecord[]> {
  const specs = await fetchAllPages(client, NBAPI_COMMANDS.GET_TIME_SPECS, 'TIMESPECS', 'TIMESPEC', LIST_OPTIONS);
  return specs.map(toTimeSpecRecord);
}

export async function fetchTimeSpec(client: NetboxClient, TIMESPECKEY: string): Promise<TimeSpecRecord | undefined> {
  const details = await callSingular(client, NBAPI_COMMANDS.GET_TIME_SPEC, { TIMESPECKEY });
  if (!details) return undefined;
  // Live: DETAILS.TIMESPEC{...}; tolerate the fields sitting directly in DETAILS.
  const record = toTimeSpecRecord('TIMESPEC' in details ? asRecord(details.TIMESPEC) : details);
  return { ...record, TIMESPECKEY: record.TIMESPECKEY || TIMESPECKEY };
}

export async function fetchTimeSpecGroups(client: NetboxClient): Promise<TimeSpecGroupRecord[]> {
  const groups = await fetchAllPages(client, NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, 'TIMESPECGROUPS', 'TIMESPECGROUP', LIST_OPTIONS);
  return groups.map(toTimeSpecGroupRecord);
}

/** GetHolidays' HOLIDAYS is a comma-separated key string on the live
 * controller; the doc's record shape (HOLIDAY{HOLIDAYKEY}) is also accepted. */
export async function fetchHolidayKeys(client: NetboxClient): Promise<string[]> {
  return fetchAllPagesWith(
    client,
    NBAPI_COMMANDS.GET_HOLIDAYS,
    (details) => {
      const holidays = details.HOLIDAYS;
      if (typeof holidays === 'string' || typeof holidays === 'number') return splitKeys(holidays);
      return asRecordList(asRecord(holidays).HOLIDAY)
        .map((record) => text(record.HOLIDAYKEY))
        .filter((key) => key !== '');
    },
    LIST_OPTIONS
  );
}

export async function fetchHoliday(client: NetboxClient, HOLIDAYKEY: string): Promise<HolidayRecord | undefined> {
  const details = await callSingular(client, NBAPI_COMMANDS.GET_HOLIDAY, { HOLIDAYKEY });
  if (!details) return undefined;
  const raw = 'HOLIDAY' in details ? asRecord(details.HOLIDAY) : details;
  return {
    HOLIDAYKEY,
    NAME: text(raw.NAME),
    HOLIDAYGROUPS: normalizeGroups(raw.HOLIDAYGROUPS),
    STARTDATE: normalizeDateTime(raw.STARTDATE),
    ENDDATE: normalizeDateTime(raw.ENDDATE),
  };
}

/** Every holiday: GetHolidays for the keys, then GetHoliday per key (R24). */
export async function fetchHolidays(client: NetboxClient): Promise<HolidayRecord[]> {
  const holidays: HolidayRecord[] = [];
  for (const key of await fetchHolidayKeys(client)) {
    const holiday = await fetchHoliday(client, key);
    if (holiday) holidays.push(holiday);
  }
  return holidays;
}

export async function fetchPortalGroups(client: NetboxClient): Promise<PortalGroupSummary[]> {
  const groups = await fetchAllPages(client, NBAPI_COMMANDS.GET_PORTAL_GROUPS, 'PORTALGROUPS', 'PORTALGROUP', LIST_OPTIONS);
  return groups.map((raw) => ({ PORTALGROUPKEY: text(raw.PORTALGROUPKEY), NAME: text(raw.NAME) }));
}

export async function fetchPortalGroup(client: NetboxClient, PORTALGROUPKEY: string): Promise<PortalGroupRecord | undefined> {
  const details = await callSingular(client, NBAPI_COMMANDS.GET_PORTAL_GROUP, { PORTALGROUPKEY });
  if (!details) return undefined;
  const raw = 'PORTALGROUP' in details ? asRecord(details.PORTALGROUP) : details;
  return {
    PORTALGROUPKEY: text(raw.PORTALGROUPKEY) || PORTALGROUPKEY,
    NAME: text(raw.NAME),
    DESCRIPTION: text(raw.DESCRIPTION),
    PORTALS: asRecordList(asRecord(raw.PORTALS).PORTAL).map(toPortalRecord),
    UNLOCKTIMESPECGROUPKEY: text(raw.UNLOCKTIMESPECGROUPKEY),
    THREATLEVELGROUPKEY: text(raw.THREATLEVELGROUPKEY),
  };
}
