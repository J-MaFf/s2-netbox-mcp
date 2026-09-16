import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatWriteSuccess, wrapList, type ToolGateFlags } from '../toolHelpers.js';

const COLOR_ENUM = z.enum(['White', 'Green', 'Blue', 'Yellow', 'Orange', 'Red']);

/**
 * Threat level tools (R18): GetThreatLevels (read, always registered) plus
 * the write tools SetThreatLevel, AddThreatLevel, ModifyThreatLevel,
 * RemoveThreatLevel, AddThreatLevelGroup, ModifyThreatLevelGroup,
 * RemoveThreatLevelGroup. No read command for threat level *groups*
 * specifically exists in the Command reference — only for individual
 * levels (GetThreatLevels) — so group membership stays write-only. Field
 * names are copied verbatim from the spec's Command reference.
 */
export function registerThreatLevelTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_threat_levels',
    'Lists threat levels configured on the NetBox system, optionally filtered (wraps NBAPI GetThreatLevels).',
    { ALLPARTITIONS: z.string().optional().describe('Optional. Per NBAPI GetThreatLevels filter.') },
    async ({ ALLPARTITIONS }) => runNbapiTool(client, NBAPI_COMMANDS.GET_THREAT_LEVELS, mergeParams({ ALLPARTITIONS }))
  );

  if (!gate.writesEnabled) return;

  server.tool(
    'set_threat_level',
    'WRITE: Sets the system-wide active threat level (wraps NBAPI SetThreatLevel).',
    { LEVELNAME: z.string().describe('Required. Name of the threat level to activate.') },
    async ({ LEVELNAME }) => runNbapiTool(client, NBAPI_COMMANDS.SET_THREAT_LEVEL, { LEVELNAME }, formatWriteSuccess)
  );

  server.tool(
    'add_threat_level',
    'WRITE: Creates a new threat level (wraps NBAPI AddThreatLevel). Note: a live 6.2.0 controller rejected a long LEVELNAME ' +
      '(#13), so keep it short.',
    {
      LEVELNAME: z.string().describe('Required. Name of the new threat level. Keep it short — a live controller rejected a long name.'),
      SEQNUM: z.string().optional().describe('Optional. Sequence/order number for the threat level.'),
      COLOR: COLOR_ENUM.optional().describe('Optional. Display color for the threat level.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_THREAT_LEVEL, mergeParams(args), formatWriteSuccess)
  );

  server.tool(
    'modify_threat_level',
    'WRITE: Modifies an existing threat level (wraps NBAPI ModifyThreatLevel). Note: a live 6.2.0 controller rejected this ' +
      'call without SEQNUM (#13), so SEQNUM is required here even though the doc does not mark it as such.',
    {
      LEVELNAME: z.string().describe('Required. Name of the threat level to modify.'),
      SEQNUM: z.string().describe('Required. Sequence/order number for the threat level. A live controller rejected the call without it.'),
      COLOR: COLOR_ENUM.optional().describe('Optional. Display color for the threat level.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.MODIFY_THREAT_LEVEL, mergeParams(args), formatWriteSuccess)
  );

  server.tool(
    'add_threat_level_group',
    'WRITE: Creates a new threat level group (wraps NBAPI AddThreatLevelGroup).',
    {
      LEVELGROUPNAME: z.string().describe('Required. Name of the new threat level group.'),
      LEVELNAMES: z.array(z.string()).optional().describe('Optional. Threat level names to include in this group.'),
    },
    async ({ LEVELGROUPNAME, LEVELNAMES }) =>
      runNbapiTool(
        client,
        NBAPI_COMMANDS.ADD_THREAT_LEVEL_GROUP,
        mergeParams({ LEVELGROUPNAME, ...wrapList('LEVELNAMES', 'LEVELNAME', LEVELNAMES) }),
        formatWriteSuccess
      )
  );

  server.tool(
    'modify_threat_level_group',
    'WRITE: Modifies an existing threat level group (wraps NBAPI ModifyThreatLevelGroup). LEVELNAMES replaces the group’s membership.',
    {
      LEVELGROUPNAME: z.string().describe('Required. Name of the threat level group to modify.'),
      LEVELNAMES: z.array(z.string()).describe('Required. Complete replacement list of member threat level names.'),
    },
    async ({ LEVELGROUPNAME, LEVELNAMES }) =>
      runNbapiTool(
        client,
        NBAPI_COMMANDS.MODIFY_THREAT_LEVEL_GROUP,
        mergeParams({ LEVELGROUPNAME, ...wrapList('LEVELNAMES', 'LEVELNAME', LEVELNAMES) }),
        formatWriteSuccess
      )
  );

  if (gate.destructiveEnabled) {
    server.tool(
      'remove_threat_level',
      'DESTRUCTIVE: Removes a threat level (wraps NBAPI RemoveThreatLevel). Requires NETBOX_ENABLE_DESTRUCTIVE.',
      { LEVELNAME: z.string().describe('Required. Name of the threat level to remove.') },
      async ({ LEVELNAME }) => runNbapiTool(client, NBAPI_COMMANDS.REMOVE_THREAT_LEVEL, { LEVELNAME }, formatWriteSuccess)
    );

    server.tool(
      'remove_threat_level_group',
      'DESTRUCTIVE: Removes a threat level group (wraps NBAPI RemoveThreatLevelGroup). Requires NETBOX_ENABLE_DESTRUCTIVE.',
      { LEVELGROUPNAME: z.string().describe('Required. Name of the threat level group to remove.') },
      async ({ LEVELGROUPNAME }) =>
        runNbapiTool(client, NBAPI_COMMANDS.REMOVE_THREAT_LEVEL_GROUP, { LEVELGROUPNAME }, formatWriteSuccess)
    );
  }
}
