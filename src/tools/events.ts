import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

const extraParamsSchema = z
  .record(z.string())
  .optional()
  .describe(
    'Optional. Additional NBAPI PARAMS fields for this command (per the Command Reference) not covered ' +
      'above, as {"FIELDNAME": "value"} pairs passed through verbatim.'
  );

/**
 * Event/history tools: GetEventHistory, ListEvents, GetAccessHistory. Each is
 * a thin pass-through of that NBAPI command's documented PARAMS and response
 * fields.
 */
export function registerEventsTools(server: McpServer, client: NetboxClient): void {
  server.tool(
    'get_event_history',
    'Returns historical NetBox events for an optional date range and/or person (wraps NBAPI GetEventHistory).',
    {
      STARTTIME: z.string().optional().describe('Optional. Start of the date/time range to query (NBAPI-documented format).'),
      ENDTIME: z.string().optional().describe('Optional. End of the date/time range to query (NBAPI-documented format).'),
      PERSONID: z.string().optional().describe('Optional. Restrict results to events for this PERSONID.'),
      extraParams: extraParamsSchema,
    },
    async ({ STARTTIME, ENDTIME, PERSONID, extraParams }) =>
      runNbapiTool(
        client,
        NBAPI_COMMANDS.GET_EVENT_HISTORY,
        mergeParams({ STARTTIME, ENDTIME, PERSONID }, extraParams)
      )
  );

  server.tool(
    'list_events',
    'Lists the event types/definitions known to the NetBox system (wraps NBAPI ListEvents).',
    {
      extraParams: extraParamsSchema,
    },
    async ({ extraParams }) => runNbapiTool(client, NBAPI_COMMANDS.LIST_EVENTS, mergeParams({}, extraParams))
  );

  server.tool(
    'get_access_history',
    'Returns historical access (grant/deny) records for an optional date range and/or person (wraps NBAPI GetAccessHistory).',
    {
      STARTTIME: z.string().optional().describe('Optional. Start of the date/time range to query (NBAPI-documented format).'),
      ENDTIME: z.string().optional().describe('Optional. End of the date/time range to query (NBAPI-documented format).'),
      PERSONID: z.string().optional().describe('Optional. Restrict results to access history for this PERSONID.'),
      extraParams: extraParamsSchema,
    },
    async ({ STARTTIME, ENDTIME, PERSONID, extraParams }) =>
      runNbapiTool(
        client,
        NBAPI_COMMANDS.GET_ACCESS_HISTORY,
        mergeParams({ STARTTIME, ENDTIME, PERSONID }, extraParams)
      )
  );
}
