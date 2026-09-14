import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

/**
 * Access level tools: GetAccessLevel, GetAccessLevels, GetAccessLevelGroup,
 * GetAccessLevelGroups. Each is a thin pass-through of that NBAPI command's
 * documented PARAMS and response fields. Field names below are copied
 * verbatim from the spec's "Command reference (verified against the primary
 * source)" section — access levels/groups are keyed by *KEY fields
 * (ACCESSLEVELKEY, ACCESSLEVELGROUPKEY), not *ID.
 */
export function registerAccessLevelTools(server: McpServer, client: NetboxClient): void {
  server.tool(
    'get_access_level',
    'Returns the details of a single access level for a given ACCESSLEVELKEY (wraps NBAPI GetAccessLevel).',
    {
      ACCESSLEVELKEY: z.string().describe('Required. The unique ACCESSLEVELKEY of the access level to retrieve.'),
    },
    async ({ ACCESSLEVELKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELKEY })
  );

  server.tool(
    'get_access_levels',
    'Lists access levels configured on the NetBox system (wraps NBAPI GetAccessLevels).',
    {
      STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor (key) to continue listing from a previous call.'),
      STARTFROMNAME: z.string().optional().describe('Optional. Pagination cursor (name) to continue listing from a previous call.'),
      WANTKEY: z.string().optional().describe('Optional. Per NBAPI GetAccessLevels.'),
    },
    async ({ STARTFROMKEY, STARTFROMNAME, WANTKEY }) =>
      runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVELS, mergeParams({ STARTFROMKEY, STARTFROMNAME, WANTKEY }))
  );

  server.tool(
    'get_access_level_group',
    'Returns the details of a single access level group for a given ACCESSLEVELGROUPKEY (wraps NBAPI GetAccessLevelGroup).',
    {
      ACCESSLEVELGROUPKEY: z.string().describe('Required. The unique ACCESSLEVELGROUPKEY of the access level group to retrieve.'),
    },
    async ({ ACCESSLEVELGROUPKEY }) =>
      runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP, { ACCESSLEVELGROUPKEY })
  );

  server.tool(
    'get_access_level_groups',
    'Lists access level groups configured on the NetBox system (wraps NBAPI GetAccessLevelGroups).',
    {
      STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.'),
    },
    async ({ STARTFROMKEY }) =>
      runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS, mergeParams({ STARTFROMKEY }))
  );
}
