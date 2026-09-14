import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

/**
 * Portal/reader tools: GetPortal, GetPortals, GetReader, GetReaders. Each is
 * a thin pass-through of that NBAPI command's documented PARAMS and response
 * fields.
 */
export function registerPortalTools(server: McpServer, client: NetboxClient): void {
  server.tool(
    'get_portal',
    'Returns the details of a single portal (door) for a given PORTALID (wraps NBAPI GetPortal).',
    {
      PORTALID: z.string().describe('Required. The unique ID of the portal/door to retrieve.'),
    },
    async ({ PORTALID }) => runNbapiTool(client, NBAPI_COMMANDS.GET_PORTAL, { PORTALID })
  );

  server.tool(
    'get_portals',
    'Lists all portals (doors) configured on the NetBox system (wraps NBAPI GetPortals). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_PORTALS, {})
  );

  server.tool(
    'get_reader',
    'Returns the details of a single reader for a given READERID (wraps NBAPI GetReader).',
    {
      READERID: z.string().describe('Required. The unique ID of the reader to retrieve.'),
    },
    async ({ READERID }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READER, { READERID })
  );

  server.tool(
    'get_readers',
    'Lists readers configured on the NetBox system, optionally scoped to one portal (wraps NBAPI GetReaders).',
    {
      PORTALID: z.string().optional().describe('Optional. Restrict results to readers belonging to this portal/door.'),
    },
    async ({ PORTALID }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READERS, mergeParams({ PORTALID }))
  );
}
