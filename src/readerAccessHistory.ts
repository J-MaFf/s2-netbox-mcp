import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { asRecord, asRecordList, text, type XmlRecord } from './paging.js';
import { enrichWithPersonNames, type PersonEnrichment } from './personEnrichment.js';
import { fetchReaderDescriptions } from './readerDescriptions.js';

/**
 * Reader access (grant/deny) history: composite read over the NBAPI's
 * access-history command plus its person-lookup command (see NBAPI_COMMANDS
 * .GET_ACCESS_HISTORY/.GET_PERSON in src/commands.ts).
 *
 * The access-history command has no `READERKEY`/`PORTALKEY` request
 * parameter (see its existing pass-through registration in
 * `src/tools/events.ts`), even though every returned `ACCESS` record already
 * carries both fields — so filtering to one reader is only possible
 * client-side, over every scanned page.
 *
 * This tool does **not** filter by date range (see the spec's Goal revision
 * note: two rounds of live verification found a date-range design
 * unworkable — the live controller doesn't actually filter by
 * `STARTDATE`/`ENDDATE` when paginating via `AFTERLOGID`, and chasing a real
 * date boundary would require unverified `STARTLOGID` binary search).
 * Instead it scans a fixed-size window of the most recent `SCANWINDOW`
 * system-wide records:
 *
 *  - First, one call with `MAXRECORDS: '1'` and no `AFTERLOGID` discovers the
 *    current maximum `LOGID` (`maxLogid`) — calling with `AFTERLOGID` omitted
 *    returns the most recent records, newest `LOGID` first.
 *  - The walk then seeds at `seedLogid = Math.max(0, maxLogid - scanWindow)`
 *    and proceeds forward via `AFTERLOGID`/`NEXTLOGID` (confirmed live:
 *    calling **with `AFTERLOGID` set** returns records in ascending `LOGID`
 *    order, and the response's `NEXTLOGID` equals `max(LOGID in this page) +
 *    1` — safe to pass straight back in as the next call's `AFTERLOGID`, with
 *    no gaps or duplicates). This is the only walk direction available: the
 *    response's own `NEXTLOGID` is confirmed *not* to be a usable backward
 *    cursor.
 *  - There is no `NEXTKEY: '-1'`-style terminal sentinel for this command
 *    (unlike the `STARTFROMKEY`/`NEXTKEY` shape `src/paging.ts` handles), so
 *    this module owns its own, separate `AFTERLOGID`/`NEXTLOGID` pagination
 *    loop rather than reusing `fetchAllPagesWith`.
 */

/** Safety cap on walk calls (the discovery call is separate and not counted
 * here), as defense-in-depth against a misbehaving `NEXTLOGID` sequence —
 * not expected to be reachable in normal operation given the `scanWindow`
 * stop condition below. Named distinctly from `paging.ts`'s `MAX_PAGES` to
 * avoid confusion between the two unrelated pagination shapes. */
export const MAX_ACCESS_HISTORY_PAGES = 50;

/** Page size requested per access-history walk call (implementer's choice —
 * a reasonable bound, not a documented server limit). */
const ACCESS_HISTORY_PAGE_SIZE = '200';

/** Default number of most-recent system-wide records to scan when
 * `scanWindow` is omitted. */
const DEFAULT_SCAN_WINDOW = 2000;
const DEFAULT_MAXMATCHES = 100;

export interface AccessHistoryRecord {
  LOGID: string;
  PERSONID: string;
  READER: string;
  READERKEY: string;
  PORTALKEY: string;
  DTTM: string;
  NODEDTTM: string;
  TYPE: string;
  REASON: string;
}

export type EnrichedAccessHistoryRecord = AccessHistoryRecord & PersonEnrichment;

function toAccessHistoryRecord(raw: XmlRecord): AccessHistoryRecord {
  return {
    LOGID: text(raw.LOGID),
    PERSONID: text(raw.PERSONID),
    READER: text(raw.READER),
    READERKEY: text(raw.READERKEY),
    PORTALKEY: text(raw.PORTALKEY),
    DTTM: text(raw.DTTM),
    NODEDTTM: text(raw.NODEDTTM),
    TYPE: text(raw.TYPE),
    REASON: text(raw.REASON),
  };
}

/** Extracts the `ACCESS` records from an access-history response's DETAILS. */
function accessRecordsFrom(details: XmlRecord): AccessHistoryRecord[] {
  return asRecordList(asRecord(details.ACCESSES).ACCESS).map(toAccessHistoryRecord);
}

/**
 * R1: discovers the current maximum `LOGID` via a single `MAXRECORDS: '1'`
 * call with no `AFTERLOGID` (the most-recent-first order documented in this
 * module's header comment). Returns `0` for an empty table (a `notFound`
 * result, or a response with no records) so R6's clamp still produces a
 * sensible `seedLogid` of `0`.
 */
async function discoverMaxLogId(client: NetboxClient): Promise<number> {
  const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_HISTORY, { MAXRECORDS: '1' });
  if (result.notFound) return 0;
  const [first] = accessRecordsFrom(asRecord(result.data));
  return first ? Number(first.LOGID) : 0;
}

export interface FetchReaderAccessHistoryOptions {
  /** Number of most-recent system-wide records to scan (R5). Default 2000. */
  scanWindow?: number;
  /** Stop the walk early once this many matches have been found (R2c),
   * mirroring the tool's MAXMATCHES (R8). Default 100. */
  maxMatches?: number;
}

/**
 * R1-R6: seeds the walk near the current end of the access-history table
 * (`seedLogid = Math.max(0, maxLogid - scanWindow)`), then walks forward via
 * `AFTERLOGID`/`NEXTLOGID`, keeping only records whose `READERKEY` exactly
 * matches `readerKey` (R4). Stops at whichever happens first (R2): the total
 * number of records scanned reaches `scanWindow`, a page comes back short of
 * the requested `MAXRECORDS` (or empty — the live edge of history), or the
 * number of matches found reaches `maxMatches`. `MAX_ACCESS_HISTORY_PAGES`
 * bounds the total number of walk calls regardless of `scanWindow` (R3).
 */
export async function fetchReaderAccessHistory(
  client: NetboxClient,
  readerKey: string,
  options: FetchReaderAccessHistoryOptions = {}
): Promise<AccessHistoryRecord[]> {
  const scanWindow = options.scanWindow ?? DEFAULT_SCAN_WINDOW;
  const maxMatches = options.maxMatches ?? DEFAULT_MAXMATCHES;
  const pageSize = Number(ACCESS_HISTORY_PAGE_SIZE);

  const maxLogid = await discoverMaxLogId(client);
  const seedLogid = Math.max(0, maxLogid - scanWindow);

  const matches: AccessHistoryRecord[] = [];
  let afterLogId = String(seedLogid);
  let scanned = 0;

  for (let page = 0; page < MAX_ACCESS_HISTORY_PAGES; page++) {
    const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_HISTORY, {
      AFTERLOGID: afterLogId,
      MAXRECORDS: ACCESS_HISTORY_PAGE_SIZE,
    });

    if (result.notFound) return matches;

    const details = asRecord(result.data);
    const records = accessRecordsFrom(details);
    scanned += records.length;

    for (const record of records) {
      if (record.READERKEY === readerKey) matches.push(record);
    }

    // (c) matches cap reached.
    if (matches.length >= maxMatches) return matches;
    // (a) scan window exhausted.
    if (scanned >= scanWindow) return matches;
    // (b) short/empty page: the live edge of history.
    if (records.length < pageSize) return matches;

    afterLogId = text(details.NEXTLOGID);
  }

  throw new Error(
    `${NBAPI_COMMANDS.GET_ACCESS_HISTORY} was still returning pages after ${MAX_ACCESS_HISTORY_PAGES} requests; stopped to avoid an unbounded scan.`
  );
}

export interface GetReaderAccessHistoryParams {
  READERKEY: string;
  SCANWINDOW?: string;
  MAXMATCHES?: string;
  /** R4: defaults to `true` when omitted (opt-*out*, not opt-in). */
  RESOLVEDESCRIPTIONS?: boolean;
}

export interface GetReaderAccessHistoryResult {
  READERKEY: string;
  scanWindow: number;
  matchCount: number;
  truncated: boolean;
  matches: EnrichedAccessHistoryRecord[];
  /** R4: the description for this result's own `READERKEY` -- a single
   * top-level field, never duplicated onto each `matches` entry, since every
   * match already shares this identical `READERKEY` by construction. Present
   * (possibly `''` for an unknown/deleted reader) only when
   * `RESOLVEDESCRIPTIONS` was effectively true; genuinely absent (not `''`)
   * when explicitly `false`, so a caller can distinguish "not requested"
   * from "requested but reader unknown". */
  READERDESCRIPTION?: string;
}

/**
 * Top-level driver behind the `get_reader_access_history` tool: walks and
 * filters the most recent `SCANWINDOW` system-wide access-history records
 * (R1-R6), caps the result at `MAXMATCHES` in chronological order (R8 —
 * `matches` is already ascending, so "first MAXMATCHES" is
 * `slice(0, MAXMATCHES)`), and enriches only the returned matches with
 * person names (R7).
 *
 * R4: when `RESOLVEDESCRIPTIONS` is effectively true (omitted or explicitly
 * `true` -- the default), also looks up the description for the tool's own
 * `READERKEY` input (not each match's, since every match already carries
 * that identical `READERKEY` by construction) via `fetchReaderDescriptions`
 * and attaches it as a single top-level `READERDESCRIPTION` field. When
 * explicitly `false`, no reader-list call is made and the field is omitted
 * entirely.
 */
export async function getReaderAccessHistory(
  client: NetboxClient,
  params: GetReaderAccessHistoryParams
): Promise<GetReaderAccessHistoryResult> {
  const scanWindow = params.SCANWINDOW !== undefined ? Number(params.SCANWINDOW) : DEFAULT_SCAN_WINDOW;
  const maxMatches = params.MAXMATCHES !== undefined ? Number(params.MAXMATCHES) : DEFAULT_MAXMATCHES;
  const resolveDescriptions = params.RESOLVEDESCRIPTIONS !== false;

  const allMatches = await fetchReaderAccessHistory(client, params.READERKEY, { scanWindow, maxMatches });

  const truncated = allMatches.length > maxMatches;
  const limited = truncated ? allMatches.slice(0, maxMatches) : allMatches;

  const result: GetReaderAccessHistoryResult = {
    READERKEY: params.READERKEY,
    scanWindow,
    matchCount: limited.length,
    truncated,
    matches: await enrichWithPersonNames(client, limited),
  };

  if (resolveDescriptions) {
    const descriptionsByReaderKey = await fetchReaderDescriptions(client);
    result.READERDESCRIPTION = descriptionsByReaderKey.get(params.READERKEY) ?? '';
  }

  return result;
}
