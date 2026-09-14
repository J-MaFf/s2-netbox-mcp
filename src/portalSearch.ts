import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { MAX_PAGES, asRecord, asRecordList, fetchAllPages, text, type XmlRecord } from './paging.js';

/**
 * Door search over GetPortals + GetReaders.
 *
 * Portal names are site codes (e.g. `01OF05A`), and GetPortals returns only
 * PORTALKEY/NAME plus nested READERS *without* DESCRIPTION (live 6.2.0). The
 * human-readable location ("WORKSHOP TO MAINTENANCE OFFICE") is each reader's
 * DESCRIPTION, which only GetReaders returns — so it is joined in by
 * READERKEY. Neither command takes a filter, so matching is client-side over
 * every page of both.
 *
 * The NEXTKEY paging loop this search introduced now lives in
 * src/paging.ts (`fetchAllPages`), shared with the composite write tools.
 */

export { MAX_PAGES };

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
