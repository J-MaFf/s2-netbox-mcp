import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatAsJson, toolErrorResult, type ToolTextResult } from '../toolHelpers.js';
import { findPortals } from '../portalSearch.js';

/**
 * Portal/reader tools: GetPortals, GetReader, GetReaders — each a thin
 * pass-through of that NBAPI command's documented PARAMS and response
 * fields — plus the composite `find_portals` search.
 *
 * There is deliberately no `get_portal` (singular) tool: per the Command
 * reference, no singular GetPortal command exists on the real NBAPI — only
 * the plural GetPortals command (paginated via STARTFROMKEY/NEXTKEY, no
 * single-portal filter). `get_portals`'s response already nests each
 * portal's readers.
 *
 * `find_portals` exists because portal names are site codes and neither
 * GetPortals nor GetReaders takes a filter: it reads both in full and matches
 * the joined names and reader descriptions client-side (see portalSearch.ts),
 * issuing no commands beyond those two.
 */
export function registerPortalTools(server: McpServer, client: NetboxClient): void {
  server.tool(
    'get_portals',
    'Lists portals (doors) configured on the NetBox system, each with its nested readers ' +
      '(wraps NBAPI GetPortals, paginated via STARTFROMKEY/NEXTKEY — there is no single-portal filter).',
    {
      STARTFROMKEY: z
        .string()
        .optional()
        .describe('Optional. Pagination cursor — the NEXTKEY from a previous call, to continue listing.'),
    },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_PORTALS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'get_reader',
    'Returns the details of a single reader for a given READERKEY (wraps NBAPI GetReader).',
    {
      READERKEY: z.string().describe('Required. The unique READERKEY of the reader to retrieve.'),
    },
    async ({ READERKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READER, { READERKEY })
  );

  server.tool(
    'get_readers',
    'Lists readers configured on the NetBox system (wraps NBAPI GetReaders). ' +
      'There is no portal-id filter — use get_portals to see each reader nested under its portal.',
    {
      STARTFROMKEY: z
        .string()
        .optional()
        .describe('Optional. Pagination cursor to continue listing from a previous call.'),
    },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READERS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'find_portals',
    'Finds portals (doors) by location or name. Portal names are site codes (e.g. 01OF05A), so this also ' +
      "searches each portal's reader names and reader descriptions (e.g. 'WORKSHOP TO MAINTENANCE OFFICE'). " +
      'Case-insensitive; a portal matches when every whitespace-separated term appears in its name, a reader ' +
      'name, or a reader description. Reads every page of GetPortals and GetReaders and joins them by READERKEY. ' +
      'The result also lists portals with no reader description, which can only match by name.',
    {
      query: z
        .string()
        .trim()
        .min(1)
        .describe('Required. Search terms, e.g. "maintenance office", "electrical closet", or "01OF05".'),
    },
    async ({ query }): Promise<ToolTextResult> => {
      try {
        return { content: [{ type: 'text', text: formatAsJson(await findPortals(client, query)) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );
}
