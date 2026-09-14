import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

/**
 * Event/history tools: GetEventHistory, ListEvents, GetAccessHistory. Each is
 * a thin pass-through of that NBAPI command's documented PARAMS and response
 * fields. Field names below are copied verbatim from the spec's "Command
 * reference (verified against the primary source)" section — neither
 * GetEventHistory nor GetAccessHistory has STARTTIME/ENDTIME/PERSONID
 * parameters.
 */
export function registerEventsTools(server: McpServer, client: NetboxClient): void {
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
    'Lists the event types/definitions known to the NetBox system (wraps NBAPI ListEvents). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.LIST_EVENTS, {})
  );

  server.tool(
    'get_access_history',
    'Returns historical access (grant/deny) records for optional filters (wraps NBAPI GetAccessHistory). ' +
      'Identifies a person by ENCODEDNUM/HOTSTAMP, not PERSONID — GetAccessHistory has no PERSONID parameter.',
    {
      STARTLOGID: z.string().optional().describe('Optional. Begin returning records at this LOGID.'),
      AFTERLOGID: z.string().optional().describe('Optional. Return records strictly after this LOGID.'),
      ORDER: z.string().optional().describe('Optional. Sort order for returned records.'),
      MAXRECORDS: z.string().optional().describe('Optional. Maximum number of records to return.'),
      ENCODEDNUM: z.string().optional().describe('Optional. Restrict results to this encoded card number.'),
      HOTSTAMP: z.string().optional().describe('Optional. Restrict results to this hot-stamp number.'),
      CARDFORMAT: z.string().optional().describe('Optional. Card format of ENCODEDNUM/HOTSTAMP.'),
      OLDESTDTTM: z.string().optional().describe('Optional. Oldest date/time to include.'),
      NEWESTDTTM: z.string().optional().describe('Optional. Newest date/time to include.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_HISTORY, mergeParams(args))
  );
}
