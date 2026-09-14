import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool } from '../toolHelpers.js';

/**
 * Access level tools: GetAccessLevel, GetAccessLevels, GetAccessLevelGroup,
 * GetAccessLevelGroups. Each is a thin pass-through of that NBAPI command's
 * documented PARAMS and response fields.
 */
export function registerAccessLevelTools(server: McpServer, client: NetboxClient): void {
  server.tool(
    'get_access_level',
    'Returns the details of a single access level for a given ACCESSLEVELID (wraps NBAPI GetAccessLevel).',
    {
      ACCESSLEVELID: z.string().describe('Required. The unique ID of the access level to retrieve.'),
    },
    async ({ ACCESSLEVELID }) => runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELID })
  );

  server.tool(
    'get_access_levels',
    'Lists all access levels configured on the NetBox system (wraps NBAPI GetAccessLevels). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVELS, {})
  );

  server.tool(
    'get_access_level_group',
    'Returns the details of a single access level group for a given ACCESSLEVELGROUPID (wraps NBAPI GetAccessLevelGroup).',
    {
      ACCESSLEVELGROUPID: z.string().describe('Required. The unique ID of the access level group to retrieve.'),
    },
    async ({ ACCESSLEVELGROUPID }) =>
      runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP, { ACCESSLEVELGROUPID })
  );

  server.tool(
    'get_access_level_groups',
    'Lists all access level groups configured on the NetBox system (wraps NBAPI GetAccessLevelGroups). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS, {})
  );
}
