import 'dotenv/config';
import { loadConfigFromEnv, NetboxConfigError } from '../src/config.js';
import { NetboxClient } from '../src/netboxClient.js';
import { NBAPI_COMMANDS, type NbapiCommandName } from '../src/commands.js';
import { findPortals } from '../src/portalSearch.js';
import { getReaderAccessHistory } from '../src/readerAccessHistory.js';
import { asRecord, asRecordList, keyList, text } from '../src/paging.js';
import { enrichWithPersonNames } from '../src/personEnrichment.js';
import { enrichWithReaderDescriptions, fetchReaderDescriptions } from '../src/readerDescriptions.js';
import { fetchTimeSpecGroupNames } from '../src/timeSpecGroupNames.js';
import { fetchTimeSpecNames } from '../src/timeSpecNames.js';
import { fetchReaderGroupNames } from '../src/readerGroupNames.js';
import { fetchPartitionNames } from '../src/partitionNames.js';
import { getUnlockWindow, type UnlockWindowSettings } from '../src/unlockWindow/executor.js';
import { getDailyUnlockWindow, type DailyUnlockWindowSettings } from '../src/unlockWindow/dailyExecutor.js';
import { buildParamsXml, type NbapiParams } from '../src/xml.js';
import { parseCardFormatName } from './liveCheckWriteHelpers.js';

/**
 * Opt-in live-controller smoke test (satisfies acceptance criterion C19/R29).
 * Covers all 50 always-registered read tools and issues no write/control
 * command. (This count has grown since the script's original 34 — most
 * recently by the 12 NBAPI v2 read tools of
 * specs/nbapi-v2-full-conformance.md R8 — and is kept in sync here rather
 * than restated per-addition.) The same spec's R9 adds four checks for read
 * behaviour that shipped unverified in the unreleased batch:
 * get_threat_levels, the PARTITIONKEY filter on get_access_levels and
 * get_access_level_groups, the nine new SearchPersonData filters, and
 * get_holidays' now-empty PARAMS block.
 *
 * `npm test` never runs this file and never requires a `.env` to exist.
 * This script is invoked separately via `npm run test:live`, and only
 * actually talks to a controller when NETBOX_BASE_URL, NETBOX_USERNAME, and
 * NETBOX_PASSWORD are all present (loaded from process.env, or from a local
 * .env file via dotenv if one exists) — otherwise it prints one line and
 * exits 0 without making any network call.
 *
 * SECURITY: this script must never print the value of NETBOX_PASSWORD,
 * under any circumstance, including inside an error message. Every line
 * printed goes through `redact()` as defense in depth on top of the fact
 * that the password never flows anywhere but the Login request body.
 */

let secret = '';

function redact(text: string): string {
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]');
}

function log(line: string): void {
  console.log(redact(line));
}

function logErr(line: string): void {
  console.error(redact(line));
}

/** Recursively searches a parsed NBAPI response for the first value whose
 * key matches `keyPattern` (e.g. /READERKEY/i), to discover a real record ID
 * for chained detail-lookup checks without assuming an exact response shape. */
function findFirstMatchingId(value: unknown, keyPattern: RegExp): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstMatchingId(item, keyPattern);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (keyPattern.test(key) && (typeof val === 'string' || typeof val === 'number') && String(val).length > 0) {
        return String(val);
      }
    }
    for (const val of Object.values(obj)) {
      const found = findFirstMatchingId(val, keyPattern);
      if (found) return found;
    }
  }
  return undefined;
}

interface CheckResult {
  name: string;
  pass: boolean;
  summary: string;
  data?: unknown;
}

/**
 * Chains a singular `GetXxx` check off a previously-fetched `GetXxxs` list
 * response: discovers a real key via findFirstMatchingId and calls the
 * singular command with it. If no key can be found (an empty collection),
 * returns a SKIPPED pass rather than guessing a key that might not exist.
 */
async function chainedSingleCheck(
  client: NetboxClient,
  name: string,
  command: NbapiCommandName,
  keyParam: string,
  listData: unknown,
  options: { acceptEmptyCollectionFail?: boolean } = {}
): Promise<CheckResult> {
  const key = findFirstMatchingId(listData, new RegExp(`^${keyParam}$`, 'i'));
  if (!key) {
    return { name, pass: true, summary: `SKIPPED (no ${keyParam} found in the list response to test against)` };
  }
  return runCheck(client, name, command, { [keyParam]: key }, options);
}

/**
 * GetHolidays' response is documented as a list of HOLIDAYKEY records, but
 * the live NetBox 6.2.0 controller returns HOLIDAYS as a bare
 * comma-separated key string instead (e.g. "1") — see spec Context "Live
 * facts". Handles both shapes and returns the first key, if any.
 */
function holidayKeyFromHolidaysData(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const holidays = (data as Record<string, unknown>).HOLIDAYS;
  if (typeof holidays === 'string' && holidays.trim() !== '') {
    const first = holidays.split(',')[0]?.trim();
    return first || undefined;
  }
  return findFirstMatchingId(data, /^HOLIDAYKEY$/i);
}

async function runCheck(
  client: NetboxClient,
  name: string,
  command: NbapiCommandName,
  params: NbapiParams,
  options: { acceptEmptyCollectionFail?: boolean } = {}
): Promise<CheckResult> {
  try {
    const result = await client.call(command, params);
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND — a valid, documented non-error result)' };
    }
    const json = JSON.stringify(result.data ?? {});
    const short = json.length > 120 ? `${json.slice(0, 120)}...` : json;
    return { name, pass: true, summary: `OK ${short}`, data: result.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Some live controllers (observed: 6.2.0) answer an unconfigured
    // collection with CODE=FAIL/ERRMSG="NOT FOUND" instead of an empty list
    // or the documented CODE=NOT FOUND — e.g. GetAccessLevelGroups on a
    // controller with zero Access Level Groups defined. The client still
    // correctly surfaces that as a tool error per R8 (this smoke test isn't
    // changing that); this flag only tells the *harness* that a bare "NOT
    // FOUND" ERRMSG on this specific command reflects an empty configuration
    // rather than a defect, so it shouldn't fail the live-check run.
    if (options.acceptEmptyCollectionFail && /NOT FOUND/i.test(message)) {
      return {
        name,
        pass: true,
        summary: `OK (controller reports no records configured for this command — CODE=FAIL/ERRMSG="NOT FOUND", not a code defect: ${message})`,
      };
    }
    return { name, pass: false, summary: message };
  }
}

/** find_portals is composite (every page of GetPortals + GetReaders), so it is
 * checked by searching for a real portal by its own name: that portal must
 * come back among the matches. */
async function runFindPortalsCheck(client: NetboxClient, portalName: string | undefined): Promise<CheckResult> {
  const name = 'find_portals';
  if (!portalName) {
    return { name, pass: true, summary: 'SKIPPED (no portal NAME found in get_portals results to search for)' };
  }
  try {
    const result = await findPortals(client, portalName);
    const pass = result.matches.some((portal) => portal.NAME === portalName);
    const outcome = `"${portalName}" matched ${result.matchCount} of ${result.portalsSearched} portals`;
    return { name, pass, summary: pass ? `OK ${outcome}` : `portal not found by its own name: ${outcome}` };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/** get_reader_access_history is composite (GetAccessHistory, filtered
 * client-side, enriched with GetPerson), so it is checked by driving it
 * directly against a real READERKEY and asserting the call completes
 * without throwing over the tool's default 2000-record scan window.
 *
 * Also covers RESOLVEDESCRIPTIONS (specs/get-access-history-resolve-
 * descriptions.md R9): getReaderAccessHistory defaults RESOLVEDESCRIPTIONS
 * to true, so this same call already exercises R4's single top-level
 * READERDESCRIPTION field -- asserted present (a defined string, possibly
 * '') here rather than driving a second call. */
async function runGetReaderAccessHistoryCheck(client: NetboxClient, readerKey: string | undefined): Promise<CheckResult> {
  const name = 'get_reader_access_history';
  if (!readerKey) {
    return { name, pass: true, summary: 'SKIPPED (no READERKEY found in get_readers results to test against)' };
  }
  try {
    const result = await getReaderAccessHistory(client, { READERKEY: readerKey });
    if (result.READERDESCRIPTION === undefined) {
      return { name, pass: false, summary: 'RESOLVEDESCRIPTIONS default-true path did not attach a top-level READERDESCRIPTION field' };
    }
    return {
      name,
      pass: true,
      summary:
        `OK ${result.matchCount} match(es) for READERKEY ${readerKey} over the most recent ${result.scanWindow} records ` +
        `(truncated=${result.truncated}), READERDESCRIPTION="${result.READERDESCRIPTION}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/** get_unlock_window is read-only and always registered, but issues no
 * request parameters of its own to drive with `runCheck` -- it's a status
 * report over several paginated Get commands. A managed window may or may
 * not currently exist; both are valid, passing outcomes, so this only
 * asserts the call completes without throwing. */
async function runGetUnlockWindowCheck(client: NetboxClient, settings: UnlockWindowSettings): Promise<CheckResult> {
  const name = 'get_unlock_window';
  try {
    const status = await getUnlockWindow(client, settings);
    return {
      name,
      pass: true,
      summary: `OK configured=${status.configured}, activeNow=${status.activeNow}`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/** Same shape as runGetUnlockWindowCheck, for the daily recurring feature. */
async function runGetDailyUnlockWindowCheck(client: NetboxClient, settings: DailyUnlockWindowSettings): Promise<CheckResult> {
  const name = 'get_daily_unlock_window';
  try {
    const status = await getDailyUnlockWindow(client, settings);
    return {
      name,
      pass: true,
      summary: `OK configured=${status.configured}, activeNow=${status.activeNow}`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * list_events' RESOLVEPARTITIONNAMES: true (default) path is hand-rolled
 * inline in its tool handler (src/tools/events.ts), same pattern as the
 * RESOLVENAMES/RESOLVEDESCRIPTIONS checks below, so this check drives the
 * same two building blocks directly against the live controller: one
 * ListEvents call, then the shared `fetchPartitionNames` helper
 * (src/partitionNames.ts) -- asserting every enriched event carries a
 * non-undefined PARTITIONNAME key, and that at least one event's
 * PARTITIONNAME is non-empty (R9 of specs/archive/list-events-resolve-partition-
 * names.md). On this controller every event's PARTITIONID is "1", which
 * GetPartitions resolves to "Master".
 */
async function runListEventsResolvePartitionNamesCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'list_events (RESOLVEPARTITIONNAMES: true, default)';
  try {
    const result = await client.call(NBAPI_COMMANDS.LIST_EVENTS, {});
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const rawEvents = asRecordList(asRecord(details.EVENTS).EVENT);
    if (rawEvents.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no EVENT records returned to enrich)' };
    }
    const namesByPartitionKey = await fetchPartitionNames(client);
    const enriched = rawEvents.map((raw) => ({
      ...raw,
      PARTITIONNAME: namesByPartitionKey.get(text(raw.PARTITIONID)) ?? '',
    }));
    const missingKey = enriched.find((e) => e.PARTITIONNAME === undefined);
    if (missingKey) {
      return { name, pass: false, summary: `enriched event missing the PARTITIONNAME key: ${JSON.stringify(missingKey)}` };
    }
    const withNonEmptyName = enriched.find((e) => e.PARTITIONNAME !== '');
    if (!withNonEmptyName) {
      return { name, pass: false, summary: `every enriched event's PARTITIONNAME was empty across ${enriched.length} event(s)` };
    }
    return {
      name,
      pass: true,
      summary: `OK enriched ${enriched.length} event(s), e.g. PARTITIONID="${text(withNonEmptyName.PARTITIONID)}" -> PARTITIONNAME="${withNonEmptyName.PARTITIONNAME}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_access_history's RESOLVENAMES: true path is hand-rolled inline in its
 * tool handler (src/tools/events.ts) rather than a separately exported
 * composite function, so this check drives the same two building blocks
 * directly against the live controller: one GetAccessHistory call, then the
 * shared `enrichWithPersonNames` helper (src/personEnrichment.ts) --
 * asserting every enriched record carries non-undefined
 * FIRSTNAME/LASTNAME/FULLNAME/NOTES keys, exactly as RESOLVENAMES: true
 * promises (R11 of specs/archive/get-access-history-resolve-names.md).
 */
async function runGetAccessHistoryResolveNamesCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'get_access_history (RESOLVENAMES: true)';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_HISTORY, {});
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const rawRecords = asRecordList(asRecord(details.ACCESSES).ACCESS);
    if (rawRecords.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no ACCESS records returned to enrich)' };
    }
    const records = rawRecords.map((raw) => ({ ...raw, PERSONID: text(raw.PERSONID) }));
    const enriched = await enrichWithPersonNames(client, records);
    const missingKeys = enriched.find(
      (r) => r.FIRSTNAME === undefined || r.LASTNAME === undefined || r.FULLNAME === undefined || r.NOTES === undefined
    );
    if (missingKeys) {
      return { name, pass: false, summary: `enriched record missing an expected key: ${JSON.stringify(missingKeys)}` };
    }
    return {
      name,
      pass: true,
      summary: `OK enriched ${enriched.length} record(s), e.g. FULLNAME="${enriched[0].FULLNAME}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_access_history's RESOLVEDESCRIPTIONS: true (default) path is
 * hand-rolled inline in its tool handler (src/tools/events.ts), same as
 * RESOLVENAMES above, so this check drives the same two building blocks
 * directly: one GetAccessHistory call, then the shared
 * enrichWithReaderDescriptions helper (src/readerDescriptions.ts) --
 * asserting every enriched record carries a non-undefined READERDESCRIPTION
 * key, and that at least one record's READERDESCRIPTION is non-empty (R9 of
 * specs/archive/get-access-history-resolve-descriptions.md).
 */
async function runGetAccessHistoryResolveDescriptionsCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'get_access_history (RESOLVEDESCRIPTIONS: true, default)';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_HISTORY, {});
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const rawRecords = asRecordList(asRecord(details.ACCESSES).ACCESS);
    if (rawRecords.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no ACCESS records returned to enrich)' };
    }
    const records = rawRecords.map((raw) => ({ ...raw, READERKEY: text(raw.READERKEY) }));
    const enriched = await enrichWithReaderDescriptions(client, records);
    const missingKey = enriched.find((r) => r.READERDESCRIPTION === undefined);
    if (missingKey) {
      return { name, pass: false, summary: `enriched record missing the READERDESCRIPTION key: ${JSON.stringify(missingKey)}` };
    }
    const withNonEmptyDescription = enriched.find((r) => r.READERDESCRIPTION !== '');
    if (!withNonEmptyDescription) {
      return { name, pass: false, summary: `every enriched record's READERDESCRIPTION was empty across ${enriched.length} record(s)` };
    }
    return {
      name,
      pass: true,
      summary: `OK enriched ${enriched.length} record(s), e.g. READERDESCRIPTION="${withNonEmptyDescription.READERDESCRIPTION}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_card_access_details's RESOLVENAMES: true path
 * (specs/archive/get-card-access-details-resolve-names.md). Unlike
 * get_access_history's RESOLVENAMES check above -- which enriches every
 * ACCESS record's own PERSONID -- GetCardAccessDetails' response carries
 * exactly one PERSONID at the top level, so this drives one
 * GetCardAccessDetails call for a real card, then the shared
 * enrichWithPersonNames helper over a single-element array containing just
 * that top-level PERSONID (R3/R4).
 */
async function runGetCardAccessDetailsResolveNamesCheck(
  client: NetboxClient,
  encodedNum: string | undefined,
  cardFormat: string | undefined
): Promise<CheckResult> {
  const name = 'get_card_access_details (RESOLVENAMES: true)';
  if (!encodedNum || !cardFormat) {
    return { name, pass: true, summary: 'SKIPPED (no ENCODEDNUM/CARDFORMAT found in search_person_data results to test against)' };
  }
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, { ENCODEDNUM: encodedNum, CARDFORMAT: cardFormat });
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const personId = text(details.PERSONID);
    const [enriched] = await enrichWithPersonNames(client, [{ PERSONID: personId }]);
    if (
      enriched.FIRSTNAME === undefined ||
      enriched.LASTNAME === undefined ||
      enriched.FULLNAME === undefined ||
      enriched.NOTES === undefined
    ) {
      return { name, pass: false, summary: `enriched top-level result missing an expected key: ${JSON.stringify(enriched)}` };
    }
    return {
      name,
      pass: true,
      summary: `OK PERSONID="${personId}" enriched to FULLNAME="${enriched.FULLNAME}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_card_access_details's RESOLVEDESCRIPTIONS: true (default) path,
 * checked the same way as get_access_history's above: one
 * GetCardAccessDetails call for a real card, then enrichWithReaderDescriptions
 * over its ACCESSES.ACCESS records.
 */
async function runGetCardAccessDetailsResolveDescriptionsCheck(
  client: NetboxClient,
  encodedNum: string | undefined,
  cardFormat: string | undefined
): Promise<CheckResult> {
  const name = 'get_card_access_details (RESOLVEDESCRIPTIONS: true, default)';
  if (!encodedNum || !cardFormat) {
    return { name, pass: true, summary: 'SKIPPED (no ENCODEDNUM/CARDFORMAT found in search_person_data results to test against)' };
  }
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, { ENCODEDNUM: encodedNum, CARDFORMAT: cardFormat });
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const rawRecords = asRecordList(asRecord(details.ACCESSES).ACCESS);
    if (rawRecords.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no ACCESS records returned to enrich)' };
    }
    const records = rawRecords.map((raw) => ({ ...raw, READERKEY: text(raw.READERKEY) }));
    const enriched = await enrichWithReaderDescriptions(client, records);
    const missingKey = enriched.find((r) => r.READERDESCRIPTION === undefined);
    if (missingKey) {
      return { name, pass: false, summary: `enriched record missing the READERDESCRIPTION key: ${JSON.stringify(missingKey)}` };
    }
    const withNonEmptyDescription = enriched.find((r) => r.READERDESCRIPTION !== '');
    if (!withNonEmptyDescription) {
      return { name, pass: false, summary: `every enriched record's READERDESCRIPTION was empty across ${enriched.length} record(s)` };
    }
    return {
      name,
      pass: true,
      summary: `OK enriched ${enriched.length} record(s), e.g. READERDESCRIPTION="${withNonEmptyDescription.READERDESCRIPTION}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_portals's RESOLVEDESCRIPTIONS: true (default) path is hand-rolled
 * inline in its tool handler (src/tools/portal.ts), same as the checks
 * above, so this check drives the same building blocks directly: one
 * GetPortals call, then fetchReaderDescriptions (src/readerDescriptions.ts)
 * -- asserting every nested reader on the page carries a non-undefined
 * DESCRIPTION key (filled in directly on the nested reader object, per
 * specs/archive/get-portals-resolve-descriptions.md R2 -- not a new sibling field
 * the way the ACCESS-record tools above add READERDESCRIPTION), and that at
 * least one nested reader's DESCRIPTION is non-empty (R8).
 */
async function runGetPortalsResolveDescriptionsCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'get_portals (RESOLVEDESCRIPTIONS: true, default)';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_PORTALS, {});
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const rawPortals = asRecordList(asRecord(details.PORTALS).PORTAL);
    if (rawPortals.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no PORTAL records returned to enrich)' };
    }
    const descriptionsByReaderKey = await fetchReaderDescriptions(client);
    const nestedReaders = rawPortals.flatMap((portal) => asRecordList(asRecord(portal.READERS).READER));
    if (nestedReaders.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no nested READER records on this page to enrich)' };
    }
    const enrichedReaders = nestedReaders.map((reader) => ({
      ...reader,
      DESCRIPTION: descriptionsByReaderKey.get(text(reader.READERKEY)) ?? '',
    }));
    const missingKey = enrichedReaders.find((r) => r.DESCRIPTION === undefined);
    if (missingKey) {
      return { name, pass: false, summary: `enriched nested reader missing the DESCRIPTION key: ${JSON.stringify(missingKey)}` };
    }
    const withNonEmptyDescription = enrichedReaders.find((r) => r.DESCRIPTION !== '');
    if (!withNonEmptyDescription) {
      return { name, pass: false, summary: `every nested reader's DESCRIPTION was empty across ${enrichedReaders.length} reader(s)` };
    }
    return {
      name,
      pass: true,
      summary: `OK enriched ${enrichedReaders.length} nested reader(s) across ${rawPortals.length} portal(s), e.g. DESCRIPTION="${withNonEmptyDescription.DESCRIPTION}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_access_level's RESOLVEGROUPNAMES: true (default) path is hand-rolled
 * inline in its tool handler (src/tools/accessLevel.ts), same as the checks
 * above, so this check drives the same building blocks directly: one
 * GetAccessLevel call, then fetchTimeSpecGroupNames/fetchReaderGroupNames
 * (src/timeSpecGroupNames.ts, src/readerGroupNames.ts) -- asserting at
 * least one non-empty resolved group name for whichever axis/axes carry a
 * non-empty key on the real controller (R10 of
 * specs/archive/access-level-resolve-group-names.md). A known-good live case,
 * verified this session: ACCESSLEVELKEY "1" resolves TIMESPECGROUPKEY "1"
 * to "Always" and READERGROUPKEY "22" to "Master Door Access - all doors".
 */
async function runGetAccessLevelResolveGroupNamesCheck(client: NetboxClient, accessLevelKey: string): Promise<CheckResult> {
  const name = 'get_access_level (RESOLVEGROUPNAMES: true, default)';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELKEY: accessLevelKey });
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const timeSpecGroupKey = text(details.TIMESPECGROUPKEY);
    const readerGroupKey = text(details.READERGROUPKEY);
    if (timeSpecGroupKey === '' && readerGroupKey === '') {
      return { name, pass: true, summary: 'SKIPPED (this access level carries neither TIMESPECGROUPKEY nor READERGROUPKEY to resolve)' };
    }
    const timeSpecGroupName =
      timeSpecGroupKey === '' ? '' : ((await fetchTimeSpecGroupNames(client)).get(timeSpecGroupKey) ?? '');
    const readerGroupName = readerGroupKey === '' ? '' : ((await fetchReaderGroupNames(client)).get(readerGroupKey) ?? '');
    if (timeSpecGroupKey !== '' && timeSpecGroupName === '') {
      return { name, pass: false, summary: `TIMESPECGROUPKEY "${timeSpecGroupKey}" did not resolve to a non-empty TIMESPECGROUPNAME` };
    }
    if (readerGroupKey !== '' && readerGroupName === '') {
      return { name, pass: false, summary: `READERGROUPKEY "${readerGroupKey}" did not resolve to a non-empty READERGROUPNAME` };
    }
    return {
      name,
      pass: true,
      summary:
        `OK ACCESSLEVELKEY "${accessLevelKey}": TIMESPECGROUPKEY "${timeSpecGroupKey}" -> TIMESPECGROUPNAME="${timeSpecGroupName}", ` +
        `READERGROUPKEY "${readerGroupKey}" -> READERGROUPNAME="${readerGroupName}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_portal_group's RESOLVEGROUPNAMES: true (default) path is hand-rolled
 * inline in its tool handler (src/tools/portalGroup.ts), same shape as
 * get_access_level's own check above: one GetPortalGroup call, then
 * fetchTimeSpecGroupNames (src/timeSpecGroupNames.ts) -- asserting a
 * non-empty resolved UNLOCKTIMESPECGROUPNAME when the portal group carries a
 * non-empty UNLOCKTIMESPECGROUPKEY (R10 of
 * specs/archive/portal-group-resolve-group-names.md). Known-good live cases,
 * verified this session: PORTALGROUPKEY "26" ("LAB ALL ACCESS") carries
 * UNLOCKTIMESPECGROUPKEY "1" -> "Always"; PORTALGROUPKEY "29" ("GRAND
 * OPENING - All Doors") carries UNLOCKTIMESPECGROUPKEY "28" -> "GRAND
 * OPENING".
 */
async function runGetPortalGroupResolveGroupNamesCheck(client: NetboxClient, portalGroupKey: string): Promise<CheckResult> {
  const name = 'get_portal_group (RESOLVEGROUPNAMES: true, default)';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_PORTAL_GROUP, { PORTALGROUPKEY: portalGroupKey });
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const topLevel = asRecord(result.data);
    // This controller nests a singular GetPortalGroup's fields under a
    // PORTALGROUP key (verified live this session) -- same quirk
    // src/unlockWindow/managed.ts's fetchPortalGroup already handles.
    const details = 'PORTALGROUP' in topLevel ? asRecord(topLevel.PORTALGROUP) : topLevel;
    const unlockTimeSpecGroupKey = text(details.UNLOCKTIMESPECGROUPKEY);
    if (unlockTimeSpecGroupKey === '') {
      return { name, pass: true, summary: 'SKIPPED (this portal group carries no UNLOCKTIMESPECGROUPKEY to resolve)' };
    }
    const unlockTimeSpecGroupName = (await fetchTimeSpecGroupNames(client)).get(unlockTimeSpecGroupKey) ?? '';
    if (unlockTimeSpecGroupName === '') {
      return {
        name,
        pass: false,
        summary: `UNLOCKTIMESPECGROUPKEY "${unlockTimeSpecGroupKey}" did not resolve to a non-empty UNLOCKTIMESPECGROUPNAME`,
      };
    }
    return {
      name,
      pass: true,
      summary:
        `OK PORTALGROUPKEY "${portalGroupKey}": UNLOCKTIMESPECGROUPKEY "${unlockTimeSpecGroupKey}" -> ` +
        `UNLOCKTIMESPECGROUPNAME="${unlockTimeSpecGroupName}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_portal_groups's RESOLVEGROUPNAMES: true (default) path is hand-rolled
 * inline in its tool handler (src/tools/portalGroup.ts), same shape as
 * get_time_spec_groups's RESOLVEMEMBERNAMES check below: one GetPortalGroups
 * call, then fetchTimeSpecGroupNames (src/timeSpecGroupNames.ts) built once
 * for the whole page -- asserting every group on the page carries a
 * non-undefined UNLOCKTIMESPECGROUPNAME key, and that at least one group's
 * UNLOCKTIMESPECGROUPNAME is non-empty (R10 of
 * specs/archive/portal-groups-resolve-group-names.md). Known-good live cases,
 * verified this session: PORTALGROUPKEY "26" ("LAB ALL ACCESS") carries
 * UNLOCKTIMESPECGROUPKEY "1" -> "Always"; PORTALGROUPKEY "29" ("GRAND
 * OPENING - All Doors") carries UNLOCKTIMESPECGROUPKEY "28" -> "GRAND
 * OPENING" -- both on the same page, confirming the shared-fetch-per-page
 * design (exactly one GetTimeSpecGroups call regardless of how many groups
 * are on the page).
 */
async function runGetPortalGroupsResolveGroupNamesCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'get_portal_groups (RESOLVEGROUPNAMES: true, default)';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_PORTAL_GROUPS, {});
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const rawGroups = asRecordList(asRecord(details.PORTALGROUPS).PORTALGROUP);
    if (rawGroups.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no PORTALGROUP records returned to enrich)' };
    }
    const hasAnyKey = rawGroups.some((group) => text(group.UNLOCKTIMESPECGROUPKEY) !== '');
    const namesByTimeSpecGroupKey = hasAnyKey ? await fetchTimeSpecGroupNames(client) : new Map<string, string>();
    const enrichedGroups = rawGroups.map((group) => {
      const unlockTimeSpecGroupKey = text(group.UNLOCKTIMESPECGROUPKEY);
      return {
        ...group,
        UNLOCKTIMESPECGROUPNAME: unlockTimeSpecGroupKey === '' ? '' : (namesByTimeSpecGroupKey.get(unlockTimeSpecGroupKey) ?? ''),
      };
    });
    const missingKey = enrichedGroups.find((g) => g.UNLOCKTIMESPECGROUPNAME === undefined);
    if (missingKey) {
      return { name, pass: false, summary: `enriched group missing the UNLOCKTIMESPECGROUPNAME key: ${JSON.stringify(missingKey)}` };
    }
    const withNonEmptyName = enrichedGroups.find((g) => g.UNLOCKTIMESPECGROUPNAME !== '');
    if (!withNonEmptyName) {
      return { name, pass: true, summary: `SKIPPED (every group's UNLOCKTIMESPECGROUPKEY was empty across ${enrichedGroups.length} group(s) -- nothing to resolve)` };
    }
    return {
      name,
      pass: true,
      summary:
        `OK enriched ${enrichedGroups.length} group(s), e.g. PORTALGROUPKEY "${text(withNonEmptyName.PORTALGROUPKEY)}": ` +
        `UNLOCKTIMESPECGROUPKEY "${text(withNonEmptyName.UNLOCKTIMESPECGROUPKEY)}" -> UNLOCKTIMESPECGROUPNAME="${withNonEmptyName.UNLOCKTIMESPECGROUPNAME}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * get_time_spec_groups's RESOLVEMEMBERNAMES: true (default) path is
 * hand-rolled inline in its tool handler (src/tools/timeSpec.ts), same as
 * the checks above, so this check drives the same building blocks directly:
 * one GetTimeSpecGroups call, then keyList (src/paging.ts -- relocated from
 * src/unlockWindow/managed.ts as part of this spec) + fetchTimeSpecNames
 * (src/timeSpecNames.ts) -- asserting at least one group member on the page
 * resolves to a non-empty NAME (R9 of
 * specs/archive/time-spec-groups-resolve-member-names.md). Known-good live data
 * verified this session: TIMESPECGROUPKEY "1" ("Always") has member
 * TIMESPECKEY "1", which resolves to NAME "Always"; TIMESPECGROUPKEY "28"
 * ("GRAND OPENING") has member TIMESPECKEY "3", which resolves to NAME
 * "GRAND OPENING".
 */
async function runGetTimeSpecGroupsResolveMemberNamesCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'get_time_spec_groups (RESOLVEMEMBERNAMES: true, default)';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, {});
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result; nothing to enrich)' };
    }
    const details = asRecord(result.data);
    const rawGroups = asRecordList(asRecord(details.TIMESPECGROUPS).TIMESPECGROUP);
    if (rawGroups.length === 0) {
      return { name, pass: true, summary: 'SKIPPED (no TIMESPECGROUP records returned to enrich)' };
    }
    const namesByTimeSpecKey = await fetchTimeSpecNames(client);
    const resolvedMembers = rawGroups.flatMap((group) =>
      keyList(group.TIMESPECKEYS, 'TIMESPECKEY').map((key) => ({
        TIMESPECGROUPKEY: text(group.TIMESPECGROUPKEY),
        TIMESPECKEY: key,
        NAME: namesByTimeSpecKey.get(key) ?? '',
      }))
    );
    const namedMember = resolvedMembers.find((member) => member.NAME !== '');
    if (!namedMember) {
      return { name, pass: false, summary: `no group member resolved to a non-empty NAME across ${resolvedMembers.length} member(s)` };
    }
    return {
      name,
      pass: true,
      summary:
        `OK TIMESPECGROUPKEY "${namedMember.TIMESPECGROUPKEY}": member TIMESPECKEY "${namedMember.TIMESPECKEY}" -> ` +
        `NAME="${namedMember.NAME}" (${resolvedMembers.length} member(s) checked)`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// NBAPI v2 full-conformance spec R8/R9
// ---------------------------------------------------------------------------

/**
 * R8: `get_picture`. Drives GetPicture for a real PERSONID and PASSes on
 * either SUCCESS or one of the guide's own documented FAIL messages for a
 * person who simply has no photo on file — a controller whose person records
 * carry no badge photos is a valid configuration, not a defect, and this
 * check must not turn that into a red run.
 */
const GET_PICTURE_DOCUMENTED_FAILS = [
  /No picture URL for this person ID/i,
  /Picture file does not exist/i,
  /Person picture image file size exceeds maximum/i,
  /Error reading picture file/i,
  /NOT FOUND/i,
];

async function runGetPictureCheck(client: NetboxClient, personId: string | undefined): Promise<CheckResult> {
  const name = 'get_picture';
  if (!personId) {
    return { name, pass: true, summary: 'SKIPPED (no PERSONID found in search_person_data results to test against)' };
  }
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_PICTURE, { PERSONID: personId });
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result)' };
    }
    const details = asRecord(result.data);
    const picture = text(details.PICTURE);
    return {
      name,
      pass: true,
      summary: `OK PERSONID ${personId}: PICTUREURL="${text(details.PICTUREURL)}", PICTURE Base64 length ${picture.length}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (GET_PICTURE_DOCUMENTED_FAILS.some((pattern) => pattern.test(message))) {
      return { name, pass: true, summary: `OK (documented FAIL for a person with no photo on file: ${message})` };
    }
    return { name, pass: false, summary: message };
  }
}

/**
 * R8: `get_virtual_credential_request`. Mobile credentials are a licensed
 * NetBox feature, so a controller that has none answers the documented
 * `CARDFORMAT NOT FOUND` FAIL — a passing outcome here, exactly like the
 * empty-collection FAILs accepted elsewhere in this script.
 */
async function runGetVirtualCredentialRequestCheck(
  client: NetboxClient,
  personId: string | undefined,
  cardFormat: string | undefined
): Promise<CheckResult> {
  const name = 'get_virtual_credential_request';
  if (!personId || !cardFormat) {
    return {
      name,
      pass: true,
      summary: 'SKIPPED (needs a PERSONID from search_person_data and a CARDFORMAT name from get_card_formats)',
    };
  }
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_VIRTUAL_CREDENTIAL_REQUEST, { PERSONID: personId, CARDFORMAT: cardFormat });
    if (result.notFound) {
      return { name, pass: true, summary: 'OK (NOT FOUND -- a valid, documented non-error result)' };
    }
    const details = asRecord(result.data);
    return {
      name,
      pass: true,
      summary: `OK PERSONID ${personId}, CARDFORMAT "${cardFormat}": STATUS="${text(details.STATUS)}"`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/CARDFORMAT NOT FOUND/i.test(message) || /NOT FOUND/i.test(message)) {
      return {
        name,
        pass: true,
        summary: `OK (documented FAIL on a controller with no mobile-credential formats configured: ${message})`,
      };
    }
    return { name, pass: false, summary: message };
  }
}

/**
 * R9: `get_threat_levels`. The unreleased batch added this tool but no live
 * check for it. A stock NetBox ships six default threat levels, so this
 * asserts at least one LEVELNAME comes back rather than accepting an empty
 * collection.
 */
async function runGetThreatLevelsCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'get_threat_levels';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_THREAT_LEVELS, {});
    if (result.notFound) {
      return { name, pass: false, summary: 'GetThreatLevels returned NOT FOUND; at least the six default threat levels were expected' };
    }
    const levelName = findFirstMatchingId(result.data, /^LEVELNAME$/i);
    if (!levelName) {
      return { name, pass: false, summary: `no LEVELNAME in the response: ${JSON.stringify(result.data ?? {})}` };
    }
    const details = asRecord(result.data);
    const levels = asRecordList(asRecord(details.THREATLEVELS).THREATLEVEL);
    return {
      name,
      pass: true,
      summary: `OK ${levels.length || 'at least 1'} threat level(s), e.g. LEVELNAME="${levelName}"`,
    };
  } catch (err) {
    return { name, pass: false, summary: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * R9: `get_holidays` with no parameters at all. The unreleased batch made
 * this tool parameterless (its previous STARTFROMKEY was never documented);
 * this asserts the PARAMS block really does go out empty, then that the
 * controller still answers, so a future regression that re-introduces a
 * parameter is caught on the wire rather than only in the schema.
 */
async function runGetHolidaysEmptyParamsCheck(client: NetboxClient): Promise<CheckResult> {
  const name = 'get_holidays (empty PARAMS)';
  const params: NbapiParams = {};
  const serialised = buildParamsXml(params);
  if (serialised !== '') {
    return { name, pass: false, summary: `get_holidays would send a non-empty PARAMS body: <PARAMS>${serialised}</PARAMS>` };
  }
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_HOLIDAYS, params);
    const body = result.notFound ? 'NOT FOUND' : JSON.stringify(result.data ?? {});
    return { name, pass: true, summary: `OK sent <PARAMS></PARAMS> (no child elements); controller answered ${body.slice(0, 80)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/NOT FOUND/i.test(message)) {
      return { name, pass: true, summary: `OK sent <PARAMS></PARAMS>; controller reports no holidays configured (${message})` };
    }
    return { name, pass: false, summary: message };
  }
}

/**
 * R9: the nine SearchPersonData filters the unreleased batch added (the v2
 * guide documents them; the v1 guide does not). Each is issued as its own
 * SearchPersonData call with a harmless value, and the controller must not
 * reject any of them — "zero matches" and "NOT FOUND" are both fine, an
 * "invalid parameter"-style FAIL is not.
 */
const NEW_SEARCH_PERSON_DATA_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ['CARDFORMAT', ''], // filled in from get_card_formats below
  // CARDSTATUS is validated against the controller's configured card
  // statuses -- a made-up value answers FAIL "Card status does not exist",
  // which is a real rejection of the *value*, not of the filter. So this one
  // is filled in from a live person record's own card (see below), which also
  // makes it the only filter here that can actually match something.
  ['CARDSTATUS', ''],
  ['MSUENABLED', 'FALSE'],
  ['BLUEDIAMONDENABLED', 'FALSE'],
  ['CONTACTEMAIL', 'mcp-livecheck@example.invalid'],
  ['MOBILEPHONE', '0000000000'],
  ['NOTES', 'MCP livecheck no-such-note'],
  ['VEHICLELICNUM', 'MCPLC0'],
  ['VEHICLETAGNUM', 'MCPLC0'],
];

async function runSearchPersonDataNewFiltersCheck(
  client: NetboxClient,
  cardFormat: string | undefined,
  cardStatus: string | undefined
): Promise<CheckResult> {
  const name = 'search_person_data (nine new v2 filters)';
  const discovered: Record<string, string | undefined> = { CARDFORMAT: cardFormat, CARDSTATUS: cardStatus };
  const failures: string[] = [];
  const accepted: string[] = [];
  for (const [filter, sample] of NEW_SEARCH_PERSON_DATA_FILTERS) {
    const value = filter in discovered ? (discovered[filter] ?? '') : sample;
    if (value === '') {
      accepted.push(`${filter} (SKIPPED: no live ${filter} value available on this controller)`);
      continue;
    }
    try {
      const result = await client.call(NBAPI_COMMANDS.SEARCH_PERSON_DATA, { [filter]: value });
      accepted.push(`${filter}${result.notFound ? ' (NOT FOUND)' : ''}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A bare NOT FOUND means "no person matched", which is the whole point
      // of sending a deliberately non-matching value.
      if (/NOT FOUND/i.test(message)) {
        accepted.push(`${filter} (FAIL/NOT FOUND)`);
      } else {
        failures.push(`${filter}: ${message}`);
      }
    }
  }
  if (failures.length > 0) {
    return { name, pass: false, summary: `the controller rejected ${failures.length} filter(s): ${failures.join('; ')}` };
  }
  return { name, pass: true, summary: `OK all ${accepted.length} filter(s) accepted: ${accepted.join(', ')}` };
}

async function main(): Promise<number> {
  const baseUrl = process.env.NETBOX_BASE_URL;
  const username = process.env.NETBOX_USERNAME;
  const password = process.env.NETBOX_PASSWORD;

  if (!baseUrl || !username || !password) {
    console.log('s2-netbox-mcp live-check: skipped (no NETBOX_BASE_URL/NETBOX_USERNAME/NETBOX_PASSWORD configured).');
    return 0;
  }

  let config;
  try {
    config = loadConfigFromEnv();
  } catch (err) {
    if (err instanceof NetboxConfigError) {
      console.error(`s2-netbox-mcp live-check: ${err.message}`);
      return 1;
    }
    throw err;
  }

  secret = config.password;

  const client = new NetboxClient(config);
  const results: CheckResult[] = [];

  results.push(await runCheck(client, 'check_connection', NBAPI_COMMANDS.GET_API_VERSION, {}));

  const accessLevels = await runCheck(client, 'get_access_levels', NBAPI_COMMANDS.GET_ACCESS_LEVELS, {});
  results.push(accessLevels);
  const accessLevelKey = findFirstMatchingId(accessLevels.data, /ACCESSLEVELKEY/i) ?? '1';
  results.push(
    await runCheck(client, 'get_access_level', NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELKEY: accessLevelKey })
  );
  results.push(await runGetAccessLevelResolveGroupNamesCheck(client, accessLevelKey));

  const accessLevelGroups = await runCheck(
    client,
    'get_access_level_groups',
    NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS,
    {},
    { acceptEmptyCollectionFail: true }
  );
  results.push(accessLevelGroups);
  const accessLevelGroupKey = findFirstMatchingId(accessLevelGroups.data, /ACCESSLEVELGROUPKEY/i) ?? '1';
  results.push(
    await runCheck(
      client,
      'get_access_level_group',
      NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP,
      { ACCESSLEVELGROUPKEY: accessLevelGroupKey },
      { acceptEmptyCollectionFail: true }
    )
  );

  // No `get_portal` (singular) check: per the Command reference, only the
  // plural GetPortals command exists — it cannot be filtered to a single
  // portal, and its response already nests each portal's readers.
  const portals = await runCheck(client, 'get_portals', NBAPI_COMMANDS.GET_PORTALS, {});
  results.push(portals);
  results.push(await runGetPortalsResolveDescriptionsCheck(client));

  const readers = await runCheck(client, 'get_readers', NBAPI_COMMANDS.GET_READERS, {});
  results.push(readers);
  const readerKey = findFirstMatchingId(readers.data, /READERKEY/i) ?? '1';
  results.push(await runCheck(client, 'get_reader', NBAPI_COMMANDS.GET_READER, { READERKEY: readerKey }));

  results.push(await runFindPortalsCheck(client, findFirstMatchingId(portals.data, /^NAME$/i)));

  results.push(await runGetReaderAccessHistoryCheck(client, findFirstMatchingId(readers.data, /READERKEY/i)));

  const cardFormats = await runCheck(client, 'get_card_formats', NBAPI_COMMANDS.GET_CARD_FORMATS, {});
  results.push(cardFormats);
  // Reused by the R8 get_virtual_credential_request check and the R9
  // SearchPersonData CARDFORMAT filter check further down. parseCardFormatName
  // tolerates every response shape observed live (bare string, array of
  // strings, object with NAME) -- see scripts/liveCheckWriteHelpers.ts.
  const firstCardFormatName = parseCardFormatName(asRecord(asRecord(cardFormats.data).CARDFORMATS).CARDFORMAT) || undefined;

  const searchPersonData = await runCheck(client, 'search_person_data', NBAPI_COMMANDS.SEARCH_PERSON_DATA, {});
  results.push(searchPersonData);
  const personId = findFirstMatchingId(searchPersonData.data, /PERSONID/i) ?? '1';
  results.push(await runCheck(client, 'get_person', NBAPI_COMMANDS.GET_PERSON, { PERSONID: personId }));

  // GetCardAccessDetails has no PERSONID parameter — it identifies a card by
  // ENCODEDNUM + CARDFORMAT. Discover a real card from the search results
  // rather than guessing; skip cleanly if the test person has no card on file.
  const encodedNum = findFirstMatchingId(searchPersonData.data, /^ENCODEDNUM$/i);
  const cardFormat = findFirstMatchingId(searchPersonData.data, /^CARDFORMAT$/i);
  if (encodedNum && cardFormat) {
    results.push(
      await runCheck(client, 'get_card_access_details', NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, {
        ENCODEDNUM: encodedNum,
        CARDFORMAT: cardFormat,
      })
    );
  } else {
    results.push({
      name: 'get_card_access_details',
      pass: true,
      summary: 'SKIPPED (no ENCODEDNUM/CARDFORMAT found in search_person_data results to test against)',
    });
  }
  results.push(await runGetCardAccessDetailsResolveDescriptionsCheck(client, encodedNum, cardFormat));
  results.push(await runGetCardAccessDetailsResolveNamesCheck(client, encodedNum, cardFormat));

  results.push(await runCheck(client, 'get_event_history', NBAPI_COMMANDS.GET_EVENT_HISTORY, {}));
  results.push(await runCheck(client, 'list_events', NBAPI_COMMANDS.LIST_EVENTS, {}));
  results.push(await runListEventsResolvePartitionNamesCheck(client));
  results.push(await runCheck(client, 'get_access_history', NBAPI_COMMANDS.GET_ACCESS_HISTORY, {}));
  results.push(await runGetAccessHistoryResolveNamesCheck(client));
  results.push(await runGetAccessHistoryResolveDescriptionsCheck(client));

  // --- R29: the 18 additional read tools added in this stage ---------------

  const timeSpecs = await runCheck(client, 'get_time_specs', NBAPI_COMMANDS.GET_TIME_SPECS, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(timeSpecs);
  results.push(await chainedSingleCheck(client, 'get_time_spec', NBAPI_COMMANDS.GET_TIME_SPEC, 'TIMESPECKEY', timeSpecs.data));

  const timeSpecGroups = await runCheck(client, 'get_time_spec_groups', NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(timeSpecGroups);
  results.push(await runGetTimeSpecGroupsResolveMemberNamesCheck(client));
  results.push(
    // Live-observed quirk on this 6.2.0 controller: GetTimeSpecGroup returns
    // CODE=FAIL/ERRMSG="NOT FOUND" for every key, including keys that
    // GetTimeSpecGroups just listed (1/Always, 2/Never, 28/GRAND OPENING) —
    // the same class of quirk already accepted for GetAccessLevelGroup above.
    await chainedSingleCheck(
      client,
      'get_time_spec_group',
      NBAPI_COMMANDS.GET_TIME_SPEC_GROUP,
      'TIMESPECGROUPKEY',
      timeSpecGroups.data,
      { acceptEmptyCollectionFail: true }
    )
  );

  // GetHolidays' response is documented as HOLIDAYKEY records, but the live
  // controller returns HOLIDAYS as a bare comma-separated key string instead
  // (see spec Context "Live facts") — handled by holidayKeyFromHolidaysData.
  const holidays = await runCheck(client, 'get_holidays', NBAPI_COMMANDS.GET_HOLIDAYS, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(holidays);
  const holidayKey = holidayKeyFromHolidaysData(holidays.data);
  results.push(
    holidayKey
      ? await runCheck(client, 'get_holiday', NBAPI_COMMANDS.GET_HOLIDAY, { HOLIDAYKEY: holidayKey })
      : { name: 'get_holiday', pass: true, summary: 'SKIPPED (no HOLIDAYKEY found in get_holidays results to test against)' }
  );

  const portalGroups = await runCheck(client, 'get_portal_groups', NBAPI_COMMANDS.GET_PORTAL_GROUPS, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(portalGroups);
  results.push(await runGetPortalGroupsResolveGroupNamesCheck(client));
  results.push(
    await chainedSingleCheck(client, 'get_portal_group', NBAPI_COMMANDS.GET_PORTAL_GROUP, 'PORTALGROUPKEY', portalGroups.data)
  );
  const portalGroupKey = findFirstMatchingId(portalGroups.data, /PORTALGROUPKEY/i);
  results.push(
    portalGroupKey
      ? await runGetPortalGroupResolveGroupNamesCheck(client, portalGroupKey)
      : {
          name: 'get_portal_group (RESOLVEGROUPNAMES: true, default)',
          pass: true,
          summary: 'SKIPPED (no PORTALGROUPKEY found in get_portal_groups results to test against)',
        }
  );

  const readerGroups = await runCheck(client, 'get_reader_groups', NBAPI_COMMANDS.GET_READER_GROUPS, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(readerGroups);
  results.push(
    await chainedSingleCheck(client, 'get_reader_group', NBAPI_COMMANDS.GET_READER_GROUP, 'READERGROUPKEY', readerGroups.data)
  );

  results.push(await runCheck(client, 'get_outputs', NBAPI_COMMANDS.GET_OUTPUTS, {}));
  results.push(
    await runCheck(client, 'get_access_level_names', NBAPI_COMMANDS.GET_ACCESS_LEVEL_NAMES, {}, {
      acceptEmptyCollectionFail: true,
    })
  );
  results.push(await runCheck(client, 'get_partitions', NBAPI_COMMANDS.GET_PARTITIONS, {}));

  const udfLists = await runCheck(client, 'get_udf_lists', NBAPI_COMMANDS.GET_UDF_LISTS, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(udfLists);
  results.push(
    await chainedSingleCheck(client, 'get_udf_list_items', NBAPI_COMMANDS.GET_UDF_LIST_ITEMS, 'UDFLISTKEY', udfLists.data)
  );

  results.push(
    await runCheck(client, 'get_elevators', NBAPI_COMMANDS.GET_ELEVATORS, {}, { acceptEmptyCollectionFail: true })
  );
  results.push(await runCheck(client, 'get_floors', NBAPI_COMMANDS.GET_FLOORS, {}, { acceptEmptyCollectionFail: true }));
  results.push(await runCheck(client, 'ping_app', NBAPI_COMMANDS.PING_APP, {}));

  // --- NBAPI v2 full-conformance spec R8: the 12 new read tools -----------
  // Collection reads use acceptEmptyCollectionFail because this 6.2.0
  // controller answers an unconfigured collection with CODE=FAIL/
  // ERRMSG="NOT FOUND"; the singular reads chain off their own list and
  // SKIP-pass when the list is empty (no Mercury/SIO hardware exists here).

  results.push(
    await runCheck(client, 'get_portal_states', NBAPI_COMMANDS.GET_PORTAL_STATES, {}, { acceptEmptyCollectionFail: true })
  );
  results.push(
    await runCheck(client, 'get_portal_statuses', NBAPI_COMMANDS.GET_PORTAL_STATUSES, {}, { acceptEmptyCollectionFail: true })
  );
  results.push(
    await runCheck(client, 'get_locations', NBAPI_COMMANDS.GET_LOCATIONS, {}, { acceptEmptyCollectionFail: true })
  );
  results.push(await runCheck(client, 'get_alarms', NBAPI_COMMANDS.GET_ALARMS, {}, { acceptEmptyCollectionFail: true }));

  const mercuryPanels = await runCheck(client, 'get_mercury_panels', NBAPI_COMMANDS.GET_MERCURY_PANELS, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(mercuryPanels);
  results.push(
    await chainedSingleCheck(client, 'get_mercury_panel', NBAPI_COMMANDS.GET_MERCURY_PANEL, 'MERCURYKEY', mercuryPanels.data, {
      acceptEmptyCollectionFail: true,
    })
  );

  // GetSios has no unfiltered listing: it is keyed by MERCURYKEY, so it too
  // chains off get_mercury_panels and SKIP-passes with no Mercury hardware.
  const sios = await chainedSingleCheck(client, 'get_sios', NBAPI_COMMANDS.GET_SIOS, 'MERCURYKEY', mercuryPanels.data, {
    acceptEmptyCollectionFail: true,
  });
  results.push(sios);
  results.push(
    await chainedSingleCheck(client, 'get_sio', NBAPI_COMMANDS.GET_SIO, 'SIOKEY', sios.data, { acceptEmptyCollectionFail: true })
  );

  const networkNodes = await runCheck(client, 'get_network_nodes', NBAPI_COMMANDS.GET_NETWORK_NODES, {}, {
    acceptEmptyCollectionFail: true,
  });
  results.push(networkNodes);
  results.push(
    await chainedSingleCheck(client, 'get_network_node', NBAPI_COMMANDS.GET_NETWORK_NODE, 'NODEKEY', networkNodes.data, {
      acceptEmptyCollectionFail: true,
    })
  );

  results.push(await runGetPictureCheck(client, personId));
  results.push(await runGetVirtualCredentialRequestCheck(client, personId, firstCardFormatName));

  // --- NBAPI v2 full-conformance spec R9: the unreleased read gaps --------

  results.push(await runGetThreatLevelsCheck(client));
  results.push(
    await runCheck(
      client,
      'get_access_levels (PARTITIONKEY)',
      NBAPI_COMMANDS.GET_ACCESS_LEVELS,
      { PARTITIONKEY: '0' },
      { acceptEmptyCollectionFail: true }
    )
  );
  results.push(
    await runCheck(
      client,
      'get_access_level_groups (PARTITIONKEY)',
      NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS,
      { PARTITIONKEY: '0' },
      { acceptEmptyCollectionFail: true }
    )
  );
  // CARDSTATUS is validated against the controller's configured statuses, so
  // it has to come from a real card rather than a made-up string; GetPerson's
  // response carries it on each of the person's access cards.
  const liveCardStatus = findFirstMatchingId(searchPersonData.data, /^CARDSTATUS$/i);
  results.push(await runSearchPersonDataNewFiltersCheck(client, firstCardFormatName, liveCardStatus));
  results.push(await runGetHolidaysEmptyParamsCheck(client));

  results.push(
    await runGetUnlockWindowCheck(client, { holidayGroups: config.unlockHolidayGroups, namePrefix: config.unlockNamePrefix })
  );
  results.push(
    await runGetDailyUnlockWindowCheck(client, {
      holidayGroup: config.dailyUnlockHolidayGroup,
      namePrefix: config.dailyUnlockNamePrefix,
    })
  );

  await client.logout();

  for (const result of results) {
    const status = result.pass ? 'PASS' : 'FAIL';
    log(`[${status}] ${result.name}: ${result.summary}`);
  }

  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;
  log(`Summary: ${results.length} tools checked, ${passCount} passed, ${failCount} failed.`);

  return failCount > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`s2-netbox-mcp live-check: unexpected error: ${message}`);
    process.exit(1);
  });
