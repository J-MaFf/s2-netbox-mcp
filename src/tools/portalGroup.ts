import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import {
  runNbapiTool,
  mergeParams,
  formatAsJson,
  formatWriteSuccess,
  notFoundResult,
  toolErrorResult,
  wrapList,
  type ToolTextResult,
  type ToolGateFlags,
} from '../toolHelpers.js';
import { asRecord, text } from '../paging.js';
import { fetchTimeSpecGroupNames } from '../timeSpecGroupNames.js';

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
 *
 * get_portal_group's RESOLVEGROUPNAMES (specs/portal-group-resolve-group-
 * names.md) resolves the raw response's bare UNLOCKTIMESPECGROUPKEY foreign
 * key into a new sibling UNLOCKTIMESPECGROUPNAME field. Defaults to true
 * (opt-out), matching get_access_level's own RESOLVEGROUPNAMES cost-shape
 * convention: a single GetPortalGroup response carries exactly one
 * UNLOCKTIMESPECGROUPKEY, so resolving it always costs exactly one
 * fixed-size GetTimeSpecGroups fetch, never scaling with anything. Resolved
 * via the same shared src/timeSpecGroupNames.ts module get_access_level
 * uses — never the singular GetTimeSpecGroup command, which is verified
 * broken (NOT FOUND) on this controller even for a genuinely existing
 * group. THREATLEVELGROUPKEY is never resolved: no NBAPI read command for
 * threat level groups exists in this server's command surface. The PORTALS
 * sub-list (already `{PORTALKEY, NAME}` per portal) is left unchanged. This
 * bypasses runNbapiTool (whose formatSuccess callback is synchronous) the
 * same way get_access_level already does for its own async enrichment path.
 *
 * Unlike GetAccessLevel's flat DETAILS, this controller nests a singular
 * GetPortalGroup's fields one level deeper, under a `PORTALGROUP` key
 * (verified live this session — DETAILS is `{PORTALGROUP: {PORTALGROUPKEY,
 * NAME, ...}}`, not the fields directly), the same quirk already handled
 * defensively in src/unlockWindow/managed.ts's own fetchPortalGroup
 * (`'PORTALGROUP' in details ? asRecord(details.PORTALGROUP) : details`).
 * This mirrors that same defensive unwrap so UNLOCKTIMESPECGROUPKEY is read
 * from, and UNLOCKTIMESPECGROUPNAME is added onto, the actual inner record
 * — not a sibling of the outer `PORTALGROUP` wrapper — while leaving the
 * overall response shape (wrapped or not) exactly as GetPortalGroup gave it.
 */
export function registerPortalGroupTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_portal_group',
    'Returns the details of a single portal group for a given PORTALGROUPKEY (wraps NBAPI GetPortalGroup). ' +
      'RESOLVEGROUPNAMES defaults to true — an inverted, opt-*out* default (unlike most optional booleans in this ' +
      'codebase): the raw response carries only a bare UNLOCKTIMESPECGROUPKEY foreign key, so this resolves it ' +
      'into a new sibling UNLOCKTIMESPECGROUPNAME field via one full-table GetTimeSpecGroups fetch per call — a ' +
      'fixed cost regardless of anything else, since a single portal group carries exactly one ' +
      'UNLOCKTIMESPECGROUPKEY. THREATLEVELGROUPKEY is never resolved (no NBAPI read command exists for threat ' +
      'level groups). Set RESOLVEGROUPNAMES: false to skip the fetch and return the response exactly as ' +
      'GetPortalGroup provides it.',
    {
      PORTALGROUPKEY: z.string().describe('Required. The unique PORTALGROUPKEY of the portal group to retrieve.'),
      RESOLVEGROUPNAMES: z
        .boolean()
        .optional()
        .describe(
          'Optional (default true — on by default; the inverse of this codebase\'s usual optional-boolean ' +
            'default). Resolves UNLOCKTIMESPECGROUPKEY into a new UNLOCKTIMESPECGROUPNAME sibling field via one ' +
            'full-table GetTimeSpecGroups fetch per call (skipped when UNLOCKTIMESPECGROUPKEY is empty/absent, ' +
            "yielding '' for the name). THREATLEVELGROUPKEY is never resolved — no NBAPI read command exists for " +
            'threat level groups. Set to false to skip the fetch and return the response exactly as ' +
            'GetPortalGroup provides it.'
        ),
    },
    async ({ PORTALGROUPKEY, RESOLVEGROUPNAMES }): Promise<ToolTextResult> => {
      if (RESOLVEGROUPNAMES === false) {
        return runNbapiTool(client, NBAPI_COMMANDS.GET_PORTAL_GROUP, { PORTALGROUPKEY });
      }
      try {
        const result = await client.call(NBAPI_COMMANDS.GET_PORTAL_GROUP, { PORTALGROUPKEY });
        if (result.notFound) {
          return notFoundResult();
        }
        const topLevel = asRecord(result.data);
        // Same defensive unwrap as src/unlockWindow/managed.ts's fetchPortalGroup:
        // this controller nests a singular GetPortalGroup's fields under a
        // PORTALGROUP key rather than returning them flat.
        const wrapped = 'PORTALGROUP' in topLevel;
        const details = wrapped ? asRecord(topLevel.PORTALGROUP) : topLevel;
        const unlockTimeSpecGroupKey = text(details.UNLOCKTIMESPECGROUPKEY);
        const unlockTimeSpecGroupName =
          unlockTimeSpecGroupKey === '' ? '' : ((await fetchTimeSpecGroupNames(client)).get(unlockTimeSpecGroupKey) ?? '');
        const enrichedDetails = { ...details, UNLOCKTIMESPECGROUPNAME: unlockTimeSpecGroupName };
        const responseData = wrapped ? { ...topLevel, PORTALGROUP: enrichedDetails } : enrichedDetails;
        return { content: [{ type: 'text', text: formatAsJson(responseData) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
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
