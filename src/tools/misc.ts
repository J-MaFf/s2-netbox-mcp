import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

/**
 * Miscellaneous read-only utility tools (R8): GetElevators, GetFloors,
 * PingApp. None of these three commands has a corresponding write/control
 * command in the spec, so this module is always registered and takes no
 * gating flags.
 */
export function registerMiscTools(server: McpServer, client: NetboxClient): void {
  server.tool(
    'get_elevators',
    'Lists elevators configured on the NetBox system (wraps NBAPI GetElevators).',
    { STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.') },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_ELEVATORS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'get_floors',
    'Lists floors configured on the NetBox system (wraps NBAPI GetFloors).',
    { STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.') },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_FLOORS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'ping_app',
    'Pings the NetBox NBAPI application to confirm it is responsive (wraps NBAPI PingApp). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.PING_APP, {})
  );
}
