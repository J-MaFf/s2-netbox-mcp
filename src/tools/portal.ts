import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

/**
 * Portal/reader tools: GetPortals, GetReader, GetReaders. Each is a thin
 * pass-through of that NBAPI command's documented PARAMS and response
 * fields.
 *
 * There is deliberately no `get_portal` (singular) tool: per the Command
 * reference, no singular GetPortal command exists on the real NBAPI — only
 * the plural GetPortals command (paginated via STARTFROMKEY/NEXTKEY, no
 * single-portal filter). `get_portals`'s response already nests each
 * portal's readers.
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
}
