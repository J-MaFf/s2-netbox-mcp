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
  clientGuardError,
  wrapList,
  type ToolTextResult,
  type ToolGateFlags,
} from '../toolHelpers.js';
import { asRecord, text } from '../paging.js';
import { fetchTimeSpecGroupNames } from '../timeSpecGroupNames.js';
import { fetchReaderGroupNames } from '../readerGroupNames.js';

const accessLevelGroupItemSchema = z.object({
  NAME: z.string().optional(),
  KEY: z.string().optional(),
  PARTITIONKEY: z.string().optional(),
});

const accessLevelsGroupField = z
  .array(accessLevelGroupItemSchema)
  .optional()
  .describe('Optional. Access levels to include, each identified by NAME and/or KEY (with an optional PARTITIONKEY).');

/**
 * Access level tools: the existing four read tools (GetAccessLevel(s),
 * GetAccessLevelGroup(s)) plus GetAccessLevelNames (R8) and the R15 write
 * tools (AddAccessLevel, ModifyAccessLevel, DeleteAccessLevel,
 * AddAccessLevelGroup, ModifyAccessLevelGroup, DeleteAccessLevelGroup).
 * Field names below are copied verbatim from the spec's Command reference —
 * access levels/groups are keyed by *KEY fields (ACCESSLEVELKEY,
 * ACCESSLEVELGROUPKEY), not *ID.
 *
 * get_access_level's RESOLVEGROUPNAMES (specs/access-level-resolve-group-
 * names.md) resolves the raw response's bare TIMESPECGROUPKEY/READERGROUPKEY
 * foreign keys into new sibling TIMESPECGROUPNAME/READERGROUPNAME fields.
 * Defaults to true (opt-out), matching this codebase's RESOLVEDESCRIPTIONS
 * cost-shape convention (get_portals, get_reader_access_history, etc.): a
 * single GetAccessLevel response carries exactly one of each key, so
 * resolving both always costs exactly one fixed-size GetTimeSpecGroups fetch
 * and one fixed-size GetReaderGroups fetch, never scaling with anything.
 * Each axis is resolved via its own full paginated list
 * (src/timeSpecGroupNames.ts, src/readerGroupNames.ts) and skipped
 * independently when that axis's key is empty/absent — never the singular
 * GetTimeSpecGroup command, which is verified broken (NOT FOUND) on this
 * controller even for a genuinely existing group. THREATLEVELGROUPKEY is
 * never resolved: no NBAPI read command for threat level groups exists in
 * this server's command surface at all. This bypasses runNbapiTool (whose
 * formatSuccess callback is synchronous) the same way get_portals and
 * get_card_access_details already do for their own async enrichment paths.
 */
export function registerAccessLevelTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_access_level',
    'Returns the details of a single access level for a given ACCESSLEVELKEY (wraps NBAPI GetAccessLevel). ' +
      'RESOLVEGROUPNAMES defaults to true — an inverted, opt-*out* default (unlike most optional booleans in this ' +
      'codebase): the raw response carries only bare TIMESPECGROUPKEY/READERGROUPKEY/THREATLEVELGROUPKEY foreign ' +
      'keys, so this resolves TIMESPECGROUPKEY and READERGROUPKEY into new sibling TIMESPECGROUPNAME/READERGROUPNAME ' +
      'fields via one full-table GetTimeSpecGroups fetch and one full-table GetReaderGroups fetch per call — a ' +
      "fixed cost regardless of anything else, since a single access level carries exactly one of each key. " +
      'THREATLEVELGROUPKEY is never resolved (no NBAPI read command exists for threat level groups). Set ' +
      'RESOLVEGROUPNAMES: false to skip both fetches and return the response exactly as GetAccessLevel provides it.',
    {
      ACCESSLEVELKEY: z.string().describe('Required. The unique ACCESSLEVELKEY of the access level to retrieve.'),
      RESOLVEGROUPNAMES: z
        .boolean()
        .optional()
        .describe(
          'Optional (default true — on by default; the inverse of this codebase\'s usual optional-boolean ' +
            'default). Resolves TIMESPECGROUPKEY/READERGROUPKEY into new TIMESPECGROUPNAME/READERGROUPNAME sibling ' +
            "fields via one full-table GetTimeSpecGroups fetch and one full-table GetReaderGroups fetch per call " +
            "(each made only when that axis's key is non-empty; an empty/absent key on one axis yields '' for " +
            "that axis's name without affecting the other). THREATLEVELGROUPKEY is never resolved — no NBAPI read " +
            'command exists for threat level groups. Set to false to skip both fetches and return the response ' +
            'exactly as GetAccessLevel provides it.'
        ),
    },
    async ({ ACCESSLEVELKEY, RESOLVEGROUPNAMES }): Promise<ToolTextResult> => {
      if (RESOLVEGROUPNAMES === false) {
        return runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELKEY });
      }
      try {
        const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELKEY });
        if (result.notFound) {
          return notFoundResult();
        }
        const details = asRecord(result.data);
        const timeSpecGroupKey = text(details.TIMESPECGROUPKEY);
        const readerGroupKey = text(details.READERGROUPKEY);
        const timeSpecGroupName =
          timeSpecGroupKey === '' ? '' : ((await fetchTimeSpecGroupNames(client)).get(timeSpecGroupKey) ?? '');
        const readerGroupName = readerGroupKey === '' ? '' : ((await fetchReaderGroupNames(client)).get(readerGroupKey) ?? '');
        const responseData = { ...details, TIMESPECGROUPNAME: timeSpecGroupName, READERGROUPNAME: readerGroupName };
        return { content: [{ type: 'text', text: formatAsJson(responseData) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
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

  server.tool(
    'get_access_level_names',
    'Lists access level names configured on the NetBox system (wraps NBAPI GetAccessLevelNames).',
    {
      PARTITIONKEY: z.string().optional().describe('Optional. Per NBAPI GetAccessLevelNames — only "0" is documented as allowed.'),
      STARTFROMNAME: z.string().optional().describe('Optional. Pagination cursor (name) to continue listing from a previous call.'),
    },
    async ({ PARTITIONKEY, STARTFROMNAME }) =>
      runNbapiTool(client, NBAPI_COMMANDS.GET_ACCESS_LEVEL_NAMES, mergeParams({ PARTITIONKEY, STARTFROMNAME }))
  );

  if (gate.writesEnabled) {
    server.tool(
      'add_access_level',
      'WRITE: Creates a new access level (wraps NBAPI AddAccessLevel).',
      {
        ACCESSLEVELNAME: z.string().describe('Required. Name of the new access level.'),
        TIMESPECGROUPKEY: z.string().describe('Required. TIMESPECGROUPKEY controlling when this access level is active.'),
        ACCESSLEVELDESCRIPTION: z.string().optional().describe('Optional. Description of the access level.'),
        READERKEY: z.string().optional().describe('Optional. A single reader this access level applies to. Mutually exclusive with READERGROUPKEY.'),
        READERGROUPKEY: z.string().optional().describe('Optional. A reader group this access level applies to. Mutually exclusive with READERKEY.'),
        THREATLEVELGROUPKEY: z.string().optional().describe('Optional. Threat level group this access level is scoped to.'),
      },
      async ({ READERKEY, READERGROUPKEY, ...rest }) => {
        if (READERKEY && READERGROUPKEY) {
          return clientGuardError('add_access_level accepts READERKEY or READERGROUPKEY, not both, in the same call.');
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.ADD_ACCESS_LEVEL,
          mergeParams({ ...rest, READERKEY, READERGROUPKEY }),
          formatWriteSuccess
        );
      }
    );

    server.tool(
      'modify_access_level',
      'WRITE: Modifies an existing access level (wraps NBAPI ModifyAccessLevel).',
      {
        ACCESSLEVELKEY: z.string().describe('Required. The ACCESSLEVELKEY of the access level to modify.'),
        ACCESSLEVELNAME: z.string().optional().describe('Optional. New name for the access level.'),
        ACCESSLEVELDESCRIPTION: z.string().optional().describe('Optional. Description of the access level.'),
        READERKEY: z.string().optional().describe('Optional. A single reader this access level applies to. Mutually exclusive with READERGROUPKEY.'),
        READERGROUPKEY: z.string().optional().describe('Optional. A reader group this access level applies to. Mutually exclusive with READERKEY.'),
        TIMESPECGROUPKEY: z
          .string()
          .describe('Required. The controller rejects ModifyAccessLevel without it ("Time spec group id is a required parameter"), even though the NBAPI doc\'s own example omits it.'),
        THREATLEVELGROUPKEY: z.string().optional().describe('Optional. Threat level group this access level is scoped to.'),
      },
      async ({ READERKEY, READERGROUPKEY, ...rest }) => {
        if (READERKEY && READERGROUPKEY) {
          return clientGuardError('modify_access_level accepts READERKEY or READERGROUPKEY, not both, in the same call.');
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_ACCESS_LEVEL,
          mergeParams({ ...rest, READERKEY, READERGROUPKEY }),
          formatWriteSuccess
        );
      }
    );

    server.tool(
      'add_access_level_group',
      'WRITE: Creates a new access level group (wraps NBAPI AddAccessLevelGroup).',
      {
        NAME: z.string().describe('Required. Name of the new access level group.'),
        DESCRIPTION: z.string().optional().describe('Optional. Description of the access level group.'),
        PARTITIONKEY: z.string().optional().describe('Optional. Partition to create the group in. Mutually exclusive with SYSTEMGROUP in practice.'),
        SYSTEMGROUP: z.string().optional().describe('Optional. Set to "1" to create a system (cross-partition) group.'),
        ACCESSLEVELS: accessLevelsGroupField,
      },
      async ({ ACCESSLEVELS, ...rest }) =>
        runNbapiTool(
          client,
          NBAPI_COMMANDS.ADD_ACCESS_LEVEL_GROUP,
          mergeParams({ ...rest, ...wrapList('ACCESSLEVELS', 'ACCESSLEVEL', ACCESSLEVELS) }),
          formatWriteSuccess
        )
    );

    server.tool(
      'modify_access_level_group',
      'WRITE: Modifies an existing access level group (wraps NBAPI ModifyAccessLevelGroup). ACCESSLEVELS, if given, replaces the group’s membership.',
      {
        ACCESSLEVELGROUPKEY: z.string().describe('Required. The ACCESSLEVELGROUPKEY of the access level group to modify.'),
        NAME: z.string().optional().describe('Optional. New name for the access level group.'),
        DESCRIPTION: z.string().optional().describe('Optional. New description for the access level group.'),
        ACCESSLEVELS: accessLevelsGroupField,
      },
      async ({ ACCESSLEVELS, ...rest }) =>
        runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_ACCESS_LEVEL_GROUP,
          mergeParams({ ...rest, ...wrapList('ACCESSLEVELS', 'ACCESSLEVEL', ACCESSLEVELS) }),
          formatWriteSuccess
        )
    );

    if (gate.destructiveEnabled) {
      server.tool(
        'delete_access_level',
        'DESTRUCTIVE: Deletes an access level (wraps NBAPI DeleteAccessLevel). Requires NETBOX_ENABLE_DESTRUCTIVE.',
        {
          ACCESSLEVELKEY: z.string().describe('Required. The ACCESSLEVELKEY of the access level to delete.'),
        },
        async ({ ACCESSLEVELKEY }) =>
          runNbapiTool(client, NBAPI_COMMANDS.DELETE_ACCESS_LEVEL, { ACCESSLEVELKEY }, formatWriteSuccess)
      );

      server.tool(
        'delete_access_level_group',
        'DESTRUCTIVE: Deletes an access level group (wraps NBAPI DeleteAccessLevelGroup). Requires NETBOX_ENABLE_DESTRUCTIVE.',
        {
          ACCESSLEVELGROUPKEY: z.string().describe('Required. The ACCESSLEVELGROUPKEY of the access level group to delete.'),
        },
        async ({ ACCESSLEVELGROUPKEY }) =>
          runNbapiTool(client, NBAPI_COMMANDS.DELETE_ACCESS_LEVEL_GROUP, { ACCESSLEVELGROUPKEY }, formatWriteSuccess)
      );
    }
  }
}
