import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import {
  runNbapiTool,
  mergeParams,
  formatAsJson,
  formatWriteSuccess,
  clientGuardError,
  toolErrorResult,
  notFoundResult,
  type ToolTextResult,
  type ToolGateFlags,
} from '../toolHelpers.js';
import { getReaderAccessHistory } from '../readerAccessHistory.js';
import { asRecord, asRecordList, text, type XmlRecord } from '../paging.js';
import { enrichWithPersonNames } from '../personEnrichment.js';
import { enrichWithReaderDescriptions } from '../readerDescriptions.js';
import { fetchPartitionNames } from '../partitionNames.js';

/**
 * Event/history/activity tools: the existing three read tools
 * (GetEventHistory, ListEvents, GetAccessHistory) plus the composite
 * `get_reader_access_history` (GetAccessHistory + GetPerson) and the R19
 * write tools (TriggerEvent, InsertActivity). Field names below are copied
 * verbatim from the spec's Command reference — neither GetEventHistory nor
 * GetAccessHistory has STARTTIME/ENDTIME/PERSONID parameters.
 *
 * `get_reader_access_history` exists because GetAccessHistory has no
 * READERKEY/PORTALKEY filter: it scans the most recent SCANWINDOW
 * system-wide records (client-side, via src/readerAccessHistory.ts) and
 * enriches each match's PERSONID with a name via GetPerson, mirroring
 * find_portals' composite pattern (src/tools/portal.ts).
 *
 * get_access_history's RESOLVENAMES: true path (specs/get-access-history-
 * resolve-names.md) reuses that same person-name enrichment, generalized
 * into src/personEnrichment.ts so both tools share one implementation. It
 * bypasses runNbapiTool (whose formatSuccess callback is synchronous and
 * can't run the async GetPerson lookups inline) and hand-rolls the same
 * not-found/error mapping runNbapiTool does, via notFoundResult()/
 * toolErrorResult() from toolHelpers.ts.
 *
 * get_access_history's RESOLVEDESCRIPTIONS (specs/get-access-history-
 * resolve-descriptions.md, R3) is an independent flag over the same
 * response, backed by src/readerDescriptions.ts's enrichWithReaderDescriptions
 * -- a single full-table GetReaders fetch per call rather than a per-record
 * lookup. Unlike RESOLVENAMES it defaults to true (opt-out, not opt-in): the
 * reader table is small and fixed-size, so the cost doesn't scale with
 * result size the way person lookups do. get_reader_access_history gains the
 * same flag, but attaches only a single top-level READERDESCRIPTION (see
 * readerAccessHistory.ts's own R4 doc comment) since every match there
 * already shares one caller-supplied READERKEY.
 *
 * get_access_history has no date-range filter: NBAPI's real GetAccessHistory
 * date fields are STARTDATE/ENDDATE, not this tool's former OLDESTDTTM/
 * NEWESTDTTM (issue #47) -- and a live controlled A/B test found the
 * controller silently ignores STARTDATE/ENDDATE too, returning identical
 * records regardless of the requested range. Renaming would only trade a
 * loud failure for a silently wrong one, so date-range filtering is removed
 * rather than fixed, for the same reason already true of
 * get_reader_access_history's own record-count-window design.
 *
 * trigger_event is routed to NETBOX_EVENT_API_PATH automatically by
 * NetboxClient (R6) — this module never references a request path itself.
 *
 * list_events' RESOLVEPARTITIONNAMES (specs/archive/list-events-resolve-
 * partition-names.md) resolves each returned event's bare PARTITIONID into a
 * human-readable PARTITIONNAME, backed by src/partitionNames.ts's
 * fetchPartitionNames -- a single GetPartitions call per call to this tool
 * (GetPartitions takes no STARTFROMKEY and already answers every partition
 * in one response, so there is no paginated walk to make here, unlike
 * RESOLVEDESCRIPTIONS' GetReaders fetch above). Defaults to true (opt-out),
 * same inverted default as RESOLVEDESCRIPTIONS, for the same reason: the
 * fetch is fixed-cost and doesn't scale with how many events come back.
 */

/** Normalizes an ACCESS record's PERSONID to a definite string (satisfying
 * enrichWithPersonNames's `T extends { PERSONID: string }` constraint) while
 * preserving every other original field untouched (R3) — the raw NBAPI
 * response already carries PERSONID as a string (see the spec's Context),
 * this just makes that fact visible to the type checker. */
function withStringPersonId(raw: XmlRecord): XmlRecord & { PERSONID: string } {
  return { ...raw, PERSONID: text(raw.PERSONID) };
}

/** Same normalization as withStringPersonId above, but for READERKEY
 * (satisfying enrichWithReaderDescriptions's `T extends { READERKEY: string }`
 * constraint) -- used by RESOLVEDESCRIPTIONS' enrichment path. */
function withStringReaderKey(raw: XmlRecord): XmlRecord & { READERKEY: string } {
  return { ...raw, READERKEY: text(raw.READERKEY) };
}

export function registerEventsTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_event_history',
    'Returns historical NetBox events for an optional event name/date range (wraps NBAPI GetEventHistory).',
    {
      EVENTNAME: z.string().optional().describe('Optional. Restrict results to this event name.'),
      STARTDTTM: z.string().optional().describe('Optional. Start of the date/time range to query (NBAPI-documented format).'),
      ENDDTTM: z.string().optional().describe('Optional. End of the date/time range to query (NBAPI-documented format).'),
      NEXTKEY: z.string().optional().describe('Optional. Pagination continuation cursor from a previous call.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.GET_EVENT_HISTORY, mergeParams(args))
  );

  server.tool(
    'list_events',
    'Lists the event types/definitions known to the NetBox system (wraps NBAPI ListEvents). ' +
      'RESOLVEPARTITIONNAMES defaults to true — on by default, the same inverted opt-out default used by this ' +
      "codebase's other fixed-cost enrichments: each returned event is enriched with a PARTITIONNAME field " +
      "resolved from its PARTITIONID via one GetPartitions fetch per call, not per event (GetPartitions costs " +
      'the same whether it resolves one event or a thousand). Set RESOLVEPARTITIONNAMES: false to skip it.',
    {
      RESOLVEPARTITIONNAMES: z
        .boolean()
        .optional()
        .describe(
          'Optional (default true — on by default; an opt-out, not opt-in, default). Enriches each returned ' +
            'event with PARTITIONNAME resolved from its PARTITIONID via one GetPartitions fetch per call (not ' +
            'per event). Set to false to skip it and get the plain ListEvents response.'
        ),
    },
    async ({ RESOLVEPARTITIONNAMES }): Promise<ToolTextResult> => {
      const resolvePartitionNames = RESOLVEPARTITIONNAMES !== false;
      if (!resolvePartitionNames) {
        return runNbapiTool(client, NBAPI_COMMANDS.LIST_EVENTS, {});
      }
      try {
        const result = await client.call(NBAPI_COMMANDS.LIST_EVENTS, {});
        if (result.notFound) {
          return notFoundResult();
        }
        const details = asRecord(result.data);
        const events = asRecord(details.EVENTS);
        const records: XmlRecord[] = asRecordList(events.EVENT);
        const namesByPartitionKey = await fetchPartitionNames(client);
        const enriched = records.map((record) => ({
          ...record,
          PARTITIONNAME: namesByPartitionKey.get(text(record.PARTITIONID)) ?? '',
        }));
        const responseData = { ...details, EVENTS: { ...events, EVENT: enriched } };
        return { content: [{ type: 'text', text: formatAsJson(responseData) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );

  server.tool(
    'get_access_history',
    'Returns historical access (grant/deny) records for optional filters (wraps NBAPI GetAccessHistory). ' +
      'Identifies a person by ENCODEDNUM/HOTSTAMP, not PERSONID — GetAccessHistory has no PERSONID parameter. ' +
      "Set RESOLVENAMES: true to enrich each returned record with the badge-holder's " +
      'FIRSTNAME/LASTNAME/FULLNAME/NOTES (default false — off); enabling it costs one extra GetPerson call ' +
      'per distinct person found in the result, which is why it is opt-in rather than on by default. ' +
      'RESOLVEDESCRIPTIONS defaults to true — the only default-on optional boolean in this codebase (an ' +
      'inverted, opt-*out* default, unlike RESOLVENAMES/dryRun-style flags elsewhere): each returned record is ' +
      "enriched with the reader's human-readable READERDESCRIPTION via one GetReaders full-table fetch per " +
      'call (not per record, since the reader table is small and fixed-size); set RESOLVEDESCRIPTIONS: false ' +
      'to skip it.',
    {
      STARTLOGID: z.string().optional().describe('Optional. Begin returning records at this LOGID.'),
      AFTERLOGID: z.string().optional().describe('Optional. Return records strictly after this LOGID.'),
      ORDER: z.string().optional().describe('Optional. Sort order for returned records.'),
      MAXRECORDS: z.string().optional().describe('Optional. Maximum number of records to return.'),
      ENCODEDNUM: z.string().optional().describe('Optional. Restrict results to this encoded card number.'),
      HOTSTAMP: z.string().optional().describe('Optional. Restrict results to this hot-stamp number.'),
      CARDFORMAT: z.string().optional().describe('Optional. Card format of ENCODEDNUM/HOTSTAMP.'),
      RESOLVENAMES: z
        .boolean()
        .optional()
        .describe(
          "Optional (default false). Enrich each returned record with the badge-holder's FIRSTNAME/LASTNAME/" +
            'FULLNAME/NOTES via one extra GetPerson call per distinct person found in the result.'
        ),
      RESOLVEDESCRIPTIONS: z
        .boolean()
        .optional()
        .describe(
          'Optional (default true — on by default; the inverse of this codebase\'s usual optional-boolean ' +
            "default). Enrich each returned record with the reader's human-readable READERDESCRIPTION via one " +
            'GetReaders full-table fetch per call (not per record). Set to false to skip it.'
        ),
    },
    async ({ RESOLVENAMES, RESOLVEDESCRIPTIONS, ...otherParams }): Promise<ToolTextResult> => {
      const resolveDescriptions = RESOLVEDESCRIPTIONS !== false;
      if (!RESOLVENAMES && !resolveDescriptions) {
        return runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_HISTORY, mergeParams(otherParams));
      }
      try {
        const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_HISTORY, mergeParams(otherParams));
        if (result.notFound) {
          return notFoundResult();
        }
        const details = asRecord(result.data);
        const accesses = asRecord(details.ACCESSES);
        let records: XmlRecord[] = asRecordList(accesses.ACCESS);
        if (RESOLVENAMES) {
          records = await enrichWithPersonNames(client, records.map(withStringPersonId));
        }
        if (resolveDescriptions) {
          records = await enrichWithReaderDescriptions(client, records.map(withStringReaderKey));
        }
        const responseData = { ...details, ACCESSES: { ...accesses, ACCESS: records } };
        return { content: [{ type: 'text', text: formatAsJson(responseData) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );

  server.tool(
    'get_reader_access_history',
    "Returns a single reader's access (grant/deny) history for a given READERKEY, with each match's " +
      'PERSONID enriched to a name (composite: wraps NBAPI GetAccessHistory + GetPerson). GetAccessHistory has ' +
      'no server-side reader filter, so this reads and filters client-side. Rather than a date range, it scans ' +
      'the most recent SCANWINDOW system-wide records (default 2000). RESOLVEDESCRIPTIONS defaults to true — ' +
      "an inverted, opt-*out* default like get_access_history's own RESOLVEDESCRIPTIONS: it attaches a single " +
      'top-level READERDESCRIPTION field for the given READERKEY (not one per match — every match already ' +
      'shares this identical READERKEY by construction) via one GetReaders full-table fetch; set to false to ' +
      'omit it entirely.',
    {
      READERKEY: z.string().describe('Required. Only access records for this reader are returned.'),
      SCANWINDOW: z
        .string()
        .optional()
        .describe('Optional. Number of most-recent system-wide access records to scan. Defaults to 2000.'),
      MAXMATCHES: z
        .string()
        .optional()
        .describe('Optional. Maximum number of matches to include, in chronological order. Defaults to 100.'),
      RESOLVEDESCRIPTIONS: z
        .boolean()
        .optional()
        .describe(
          'Optional (default true — on by default). Attaches a single top-level READERDESCRIPTION field (the ' +
            "description for this call's own READERKEY, not one per match) via one GetReaders full-table " +
            'fetch. Set to false to omit the field entirely.'
        ),
    },
    async ({ READERKEY, SCANWINDOW, MAXMATCHES, RESOLVEDESCRIPTIONS }): Promise<ToolTextResult> => {
      try {
        const result = await getReaderAccessHistory(client, { READERKEY, SCANWINDOW, MAXMATCHES, RESOLVEDESCRIPTIONS });
        return { content: [{ type: 'text', text: formatAsJson(result) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );

  if (gate.writesEnabled) {
    server.tool(
      'trigger_event',
      'WRITE: Triggers (activates/deactivates) a defined NetBox event (wraps NBAPI TriggerEvent). ' +
        'Unverified live on 6.x; NETBOX_EVENT_API_PATH override available (defaults to the main NBAPI path; ' +
        'override if your controller serves the Event API separately, e.g. /appd/nbapi).',
      {
        EVENTNAME: z.string().describe('Required. Name of the defined event to trigger.'),
        EVENTACTION: z.enum(['ACTIVATE', 'DEACTIVATE']).describe('Required. Whether to activate or deactivate the event.'),
        PARTITIONID: z.string().optional().describe('Optional. Partition the event belongs to (defaults to Master).'),
      },
      async (args) => runNbapiTool(client, NBAPI_COMMANDS.TRIGGER_EVENT, mergeParams(args), formatWriteSuccess)
    );

    server.tool(
      'insert_activity',
      'WRITE: Inserts a manual activity/log record (wraps NBAPI InsertActivity).',
      {
        ACTIVITYTYPE: z.enum(['ACCESSGRANTED', 'ACCESSDENIED', 'USERACTIVITY']).describe('Required. The type of activity to record.'),
        DETAILS: z
          .enum(['DISABLED', 'EXPIRED', 'LOCATION', 'PIN', 'TIME', 'UNKNOWN'])
          .optional()
          .describe('Optional. Reason/detail code for the activity.'),
        PORTALKEY: z.string().optional().describe('Optional. Portal the activity applies to. Mutually exclusive with ELEVATORKEY.'),
        ELEVATORKEY: z.string().optional().describe('Optional. Elevator the activity applies to. Mutually exclusive with PORTALKEY.'),
        FLOORKEY: z.string().optional().describe('Optional. Floor the activity applies to (used with ELEVATORKEY).'),
        READERKEY: z.string().optional().describe('Optional. Reader the activity applies to.'),
        PERSONID: z.string().optional().describe('Optional. Person the activity applies to.'),
        CARDFORMAT: z.string().optional().describe('Optional. Card format of ENCODEDNUM.'),
        ENCODEDNUM: z.string().optional().describe('Optional. Encoded card number involved in the activity.'),
        ACTIVITYTEXT: z.string().optional().describe('Optional. Free-text description of the activity (max 255 characters).'),
      },
      async ({ PORTALKEY, ELEVATORKEY, ...rest }) => {
        if (PORTALKEY && ELEVATORKEY) {
          return clientGuardError('insert_activity accepts PORTALKEY or ELEVATORKEY, not both, in the same call.');
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.INSERT_ACTIVITY,
          mergeParams({ ...rest, PORTALKEY, ELEVATORKEY }),
          formatWriteSuccess
        );
      }
    );
  }
}
