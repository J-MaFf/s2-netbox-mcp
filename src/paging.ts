import type { NetboxClient } from './netboxClient.js';
import type { NbapiCommandName } from './commands.js';
import { NbapiFailError } from './errors.js';

/**
 * Shared "fully paginated" read helpers.
 *
 * Every NBAPI list command that takes STARTFROMKEY answers with a NEXTKEY:
 * the live 6.2.0 controller ends pagination with NEXTKEY "-1"; a missing or
 * repeated key also ends it, and MAX_PAGES caps a runaway scan. These stop
 * rules were first written for `find_portals` (src/portalSearch.ts) and are
 * generalised here so the composite tools (set_portals_state and the managed
 * unlock window) reuse one loop for GetPortals, GetTimeSpecs,
 * GetTimeSpecGroups, GetPortalGroups, and GetHolidays instead of each
 * growing a second one.
 */

export type XmlRecord = Record<string, unknown>;

/** Safety cap on pages fetched per command, in case a controller never returns a terminal NEXTKEY. */
export const MAX_PAGES = 100;

export function asRecord(value: unknown): XmlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as XmlRecord) : {};
}

/** fast-xml-parser collapses a one-child collection to a bare object and an
 * empty one to '' — normalize both to a list of records. */
export function asRecordList(value: unknown): XmlRecord[] {
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item): item is XmlRecord => item !== null && typeof item === 'object');
}

export function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Splits a comma-separated key string (the live shape of GetHolidays'
 * HOLIDAYS field, e.g. "1,4") into trimmed, non-empty keys. */
export function splitKeys(value: unknown): string[] {
  return text(value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export interface FetchAllPagesOptions {
  /** Some live controllers (observed: 6.2.0) answer an *unconfigured*
   * collection with CODE=FAIL/ERRMSG="NOT FOUND" instead of an empty list.
   * When true, that exact failure is treated as "no records" rather than
   * thrown, so a composite tool can run against a controller with, say, no
   * portal groups yet. Any other FAIL still throws. */
  emptyOnNotFoundFail?: boolean;
}

/** True for the 6.2.0 controller's bare CODE=FAIL/ERRMSG="NOT FOUND" answer. */
export function isBareNotFoundFail(err: unknown): boolean {
  return err instanceof NbapiFailError && /^\s*NOT FOUND\s*$/i.test(err.errmsg ?? '');
}

/**
 * Reads every page of a STARTFROMKEY/NEXTKEY-paginated command, extracting
 * that page's items with `extract`. The live controller ends pagination
 * with NEXTKEY "-1"; a missing or repeated key also ends it.
 */
export async function fetchAllPagesWith<T>(
  client: NetboxClient,
  command: NbapiCommandName,
  extract: (details: XmlRecord) => T[],
  options: FetchAllPagesOptions = {}
): Promise<T[]> {
  const items: T[] = [];
  const seenKeys = new Set<string>();
  let startFromKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let result;
    try {
      result = await client.call(command, startFromKey === undefined ? {} : { STARTFROMKEY: startFromKey });
    } catch (err) {
      if (options.emptyOnNotFoundFail && isBareNotFoundFail(err)) return items;
      throw err;
    }
    if (result.notFound) return items;
    const details = asRecord(result.data);
    items.push(...extract(details));
    const nextKey = text(details.NEXTKEY);
    if (nextKey === '' || nextKey === '-1' || seenKeys.has(nextKey)) return items;
    seenKeys.add(nextKey);
    startFromKey = nextKey;
  }
  throw new Error(`${command} was still returning pages after ${MAX_PAGES} requests; stopped to avoid an unbounded scan.`);
}

/** Reads every page of a list command whose items live at
 * `DETAILS.<collection>.<item>` (e.g. PORTALS/PORTAL, TIMESPECS/TIMESPEC). */
export async function fetchAllPages(
  client: NetboxClient,
  command: NbapiCommandName,
  collection: string,
  item: string,
  options: FetchAllPagesOptions = {}
): Promise<XmlRecord[]> {
  return fetchAllPagesWith(client, command, (details) => asRecordList(asRecord(details[collection])[item]), options);
}
