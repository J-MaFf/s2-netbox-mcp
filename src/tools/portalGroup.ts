import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatWriteSuccess, wrapList, type ToolGateFlags } from '../toolHelpers.js';

/**
 * Portal group tools: the R8 read tools (GetPortalGroup(s)) plus the R13
 * write tools (AddPortalGroup, ModifyPortalGroup, DeletePortalGroup). Field
 * names are copied verbatim from the spec's Command reference.
 *
 * `add_portal_group`'s and `modify_portal_group`'s PORTALKEYS both wrap into
 * `<PORTALKEYS><PORTALKEY>...</PORTALKEY>...</PORTALKEYS>`. The doc's
 * ModifyPortalGroup example uses repeated top-level `<PORTALKEY>` siblings,
 * but that shape is not parsed by this controller and leaves the group
 * empty (live, 2026-09-15) — so modify uses the same wrapped shape as add
 * (R13).
 */
export function registerPortalGroupTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_portal_group',
    'Returns the details of a single portal group for a given PORTALGROUPKEY (wraps NBAPI GetPortalGroup).',
    { PORTALGROUPKEY: z.string().describe('Required. The unique PORTALGROUPKEY of the portal group to retrieve.') },
    async ({ PORTALGROUPKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_PORTAL_GROUP, { PORTALGROUPKEY })
  );

  server.tool(
    'get_portal_groups',
    'Lists portal groups configured on the NetBox system (wraps NBAPI GetPortalGroups).',
    { STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.') },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_PORTAL_GROUPS, mergeParams({ STARTFROMKEY }))
  );

  if (gate.writesEnabled) {
    server.tool(
      'add_portal_group',
      'WRITE: Creates a new portal group (wraps NBAPI AddPortalGroup).',
      {
        NAME: z.string().describe('Required. Name of the new portal group (max 64 characters).'),
        DESCRIPTION: z.string().optional().describe('Optional. Description of the portal group.'),
        UNLOCKTIMESPECGROUPKEY: z.string().optional().describe('Optional. Time spec group controlling when member portals unlock.'),
        THREATLEVELGROUPKEY: z.string().optional().describe('Optional. Threat level group this portal group is scoped to.'),
        PORTALKEYS: z.array(z.string()).describe('Required. PORTALKEY values of the portals in this group.'),
      },
      async ({ PORTALKEYS, ...rest }) =>
        runNbapiTool(
          client,
          NBAPI_COMMANDS.ADD_PORTAL_GROUP,
          mergeParams({ ...rest, ...wrapList('PORTALKEYS', 'PORTALKEY', PORTALKEYS) }),
          formatWriteSuccess
        )
    );

    server.tool(
      'modify_portal_group',
      'WRITE: Modifies an existing portal group (wraps NBAPI ModifyPortalGroup). PORTALKEYS is the complete desired membership — an omitted or unparsed list empties the group on this controller, so always send the complete membership.',
      {
        PORTALGROUPKEY: z.string().describe('Required. The PORTALGROUPKEY of the portal group to modify.'),
        PORTALKEYS: z.array(z.string()).describe('Required. Complete replacement list of member PORTALKEY values.'),
        NAME: z.string().optional().describe('Optional. New name for the portal group.'),
        DESCRIPTION: z.string().optional().describe('Optional. New description for the portal group.'),
        UNLOCKTIMESPECGROUPKEY: z.string().optional().describe('Optional. Time spec group controlling when member portals unlock.'),
        THREATLEVELGROUPKEY: z.string().optional().describe('Optional. Threat level group this portal group is scoped to.'),
      },
      async ({ PORTALGROUPKEY, PORTALKEYS, NAME, DESCRIPTION, UNLOCKTIMESPECGROUPKEY, THREATLEVELGROUPKEY }) =>
        runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_PORTAL_GROUP,
          mergeParams({
            PORTALGROUPKEY,
            NAME,
            DESCRIPTION,
            ...wrapList('PORTALKEYS', 'PORTALKEY', PORTALKEYS),
            UNLOCKTIMESPECGROUPKEY,
            THREATLEVELGROUPKEY,
          }),
          formatWriteSuccess
        )
    );

    if (gate.destructiveEnabled) {
      server.tool(
        'delete_portal_group',
        'DESTRUCTIVE: Deletes a portal group (wraps NBAPI DeletePortalGroup). Requires NETBOX_ENABLE_DESTRUCTIVE.',
        { PORTALGROUPKEY: z.string().describe('Required. The PORTALGROUPKEY of the portal group to delete.') },
        async ({ PORTALGROUPKEY }) =>
          runNbapiTool(client, NBAPI_COMMANDS.DELETE_PORTAL_GROUP, { PORTALGROUPKEY }, formatWriteSuccess)
      );
    }
  }
}
