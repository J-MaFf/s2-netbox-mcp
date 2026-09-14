import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS, type NbapiCommandName } from './commands.js';

/**
 * Door search over GetPortals + GetReaders.
 *
 * Portal names are site codes (e.g. `01OF05A`), and GetPortals returns only
 * PORTALKEY/NAME plus nested READERS *without* DESCRIPTION (live 6.2.0). The
 * human-readable location ("WORKSHOP TO MAINTENANCE OFFICE") is each reader's
 * DESCRIPTION, which only GetReaders returns — so it is joined in by
 * READERKEY. Neither command takes a filter, so matching is client-side over
 * every page of both.
 */

export interface PortalSearchReader {
  READERKEY: string;
  NAME: string;
  DESCRIPTION: string;
}

export interface PortalSearchPortal {
  PORTALKEY: string;
  NAME: string;
  READERS: PortalSearchReader[];
}

export interface PortalSearchResult {
  query: string;
  portalsSearched: number;
  matchCount: number;
  matches: PortalSearchPortal[];
  /** Portals none of whose readers has a description — these can only match by portal or reader name. */
  portalsWithoutDescriptions: string[];
}

/** Safety cap on pages fetched per command, in case a controller never returns a terminal NEXTKEY. */
export const MAX_PAGES = 100;

type XmlRecord = Record<string, unknown>;

function asRecord(value: unknown): XmlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as XmlRecord) : {};
}

/** fast-xml-parser collapses a one-child collection to a bare object and an
 * empty one to '' — normalize both to a list of records. */
function asRecordList(value: unknown): XmlRecord[] {
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item): item is XmlRecord => item !== null && typeof item === 'object');
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Reads every page of a STARTFROMKEY/NEXTKEY-paginated list command. The
 * live controller ends pagination with NEXTKEY "-1"; a missing or repeated
 * key also ends it. */
async function fetchAllPages(
  client: NetboxClient,
  command: NbapiCommandName,
  collection: string,
  item: string
): Promise<XmlRecord[]> {
  const items: XmlRecord[] = [];
  const seenKeys = new Set<string>();
  let startFromKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.call(command, startFromKey === undefined ? {} : { STARTFROMKEY: startFromKey });
    if (result.notFound) return items;
    const details = asRecord(result.data);
    items.push(...asRecordList(asRecord(details[collection])[item]));
    const nextKey = text(details.NEXTKEY);
    if (nextKey === '' || nextKey === '-1' || seenKeys.has(nextKey)) return items;
    seenKeys.add(nextKey);
    startFromKey = nextKey;
  }
  throw new Error(`${command} was still returning pages after ${MAX_PAGES} requests; stopped to avoid an unbounded scan.`);
}

/**
 * Joins portals to their readers' descriptions and keeps the portals where
 * every whitespace-separated term of `query` appears (case-insensitive) in the
 * portal name, a reader name, or a reader description.
 */
export function searchPortals(portals: XmlRecord[], readers: XmlRecord[], query: string): PortalSearchResult {
  const readersByKey = new Map(readers.map((reader) => [text(reader.READERKEY), reader]));
  const joined = portals.map(
    (portal): PortalSearchPortal => ({
      PORTALKEY: text(portal.PORTALKEY),
      NAME: text(portal.NAME),
      READERS: asRecordList(asRecord(portal.READERS).READER).map((nested) => {
        const full = readersByKey.get(text(nested.READERKEY)) ?? {};
        return {
          READERKEY: text(nested.READERKEY),
          NAME: text(full.NAME) || text(nested.NAME),
          DESCRIPTION: text(full.DESCRIPTION) || text(nested.DESCRIPTION),
        };
      }),
    })
  );

  const terms = query.toUpperCase().split(/\s+/).filter((term) => term !== '');
  const matches = joined.filter((portal) => {
    const haystack = [portal.NAME, ...portal.READERS.flatMap((reader) => [reader.NAME, reader.DESCRIPTION])]
      .join('\n')
      .toUpperCase();
    return terms.every((term) => haystack.includes(term));
  });

  return {
    query,
    portalsSearched: joined.length,
    matchCount: matches.length,
    matches,
    portalsWithoutDescriptions: joined
      .filter((portal) => portal.READERS.every((reader) => reader.DESCRIPTION.trim() === ''))
      .map((portal) => portal.NAME),
  };
}

/** Fetches every portal and reader, then searches them (see searchPortals). */
export async function findPortals(client: NetboxClient, query: string): Promise<PortalSearchResult> {
  const portals = await fetchAllPages(client, NBAPI_COMMANDS.GET_PORTALS, 'PORTALS', 'PORTAL');
  const readers = await fetchAllPages(client, NBAPI_COMMANDS.GET_READERS, 'READERS', 'READER');
  return searchPortals(portals, readers, query);
}
