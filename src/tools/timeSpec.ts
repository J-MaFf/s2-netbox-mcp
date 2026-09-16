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
import { asRecord, asRecordList, keyList } from '../paging.js';
import { fetchTimeSpecNames } from '../timeSpecNames.js';

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;

const weekdayFields: Record<string, z.ZodOptional<z.ZodEnum<['0', '1']>>> = Object.fromEntries(
  WEEKDAYS.map((day) => [day, z.enum(['0', '1']).optional().describe(`Optional. Whether this time spec is active on ${day.toLowerCase()} ("1") or not ("0").`)])
);

const timeSpecWriteFields = {
  DESCRIPTION: z.string().optional().describe('Optional. Description of the time spec.'),
  STARTTIME: z.string().optional().describe('Optional. Start time, HH:MM.'),
  ENDTIME: z.string().optional().describe('Optional. End time, HH:MM.'),
  ...weekdayFields,
  HOLIDAYGROUPS: z.string().optional().describe('Optional. Comma-separated list of holiday group numbers (1-8) this time spec observes.'),
};

/**
 * Time spec / time spec group tools: the R8 read tools (GetTimeSpec(s),
 * GetTimeSpecGroup(s)) plus the R11 write tools (AddTimeSpec,
 * ModifyTimeSpec, AddTimeSpecGroup, ModifyTimeSpecGroup, DeleteTimeSpec,
 * DeleteTimeSpecGroup). Field names are copied verbatim from the spec's
 * Command reference.
 *
 * `get_time_spec_groups`'s `RESOLVEMEMBERNAMES`
 * (specs/archive/time-spec-groups-resolve-member-names.md) resolves each group's
 * bare `TIMESPECKEYS.TIMESPECKEY` member key(s) into `{TIMESPECKEY, NAME}`
 * objects — matching this codebase's established shape for other
 * already-object-typed group-membership sub-lists (`get_access_level_group`'s
 * ACCESSLEVELS, `get_reader_group`'s READERS) — via
 * src/timeSpecNames.ts's `fetchTimeSpecNames` (one full-table GetTimeSpecs
 * fetch per call, never per group/member). Defaults to true (opt-out),
 * matching this codebase's RESOLVEDESCRIPTIONS/RESOLVEGROUPNAMES cost-shape
 * convention. Reuses `keyList` (relocated from
 * src/unlockWindow/managed.ts to src/paging.ts as part of this spec) to
 * normalize the bare-key collection — never the singular
 * `get_time_spec_group`, which is confirmed broken (NOT FOUND) on this
 * controller and out of scope. This bypasses `runNbapiTool` (whose
 * formatSuccess callback is synchronous) the same way `get_portals` and
 * `get_access_level` already do for their own async enrichment paths.
 */
export function registerTimeSpecTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_time_spec',
    'Returns the details of a single time spec for a given TIMESPECKEY (wraps NBAPI GetTimeSpec).',
    { TIMESPECKEY: z.string().describe('Required. The unique TIMESPECKEY of the time spec to retrieve.') },
    async ({ TIMESPECKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_TIME_SPEC, { TIMESPECKEY })
  );

  server.tool(
    'get_time_specs',
    'Lists time specs configured on the NetBox system (wraps NBAPI GetTimeSpecs).',
    { STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.') },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_TIME_SPECS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'get_time_spec_group',
    'Returns the details of a single time spec group for a given TIMESPECGROUPKEY (wraps NBAPI GetTimeSpecGroup).',
    { TIMESPECGROUPKEY: z.string().describe('Required. The unique TIMESPECGROUPKEY of the time spec group to retrieve.') },
    async ({ TIMESPECGROUPKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_TIME_SPEC_GROUP, { TIMESPECGROUPKEY })
  );

  server.tool(
    'get_time_spec_groups',
    'Lists time spec groups configured on the NetBox system (wraps NBAPI GetTimeSpecGroups). ' +
      'RESOLVEMEMBERNAMES defaults to true — an inverted, opt-*out* default (unlike most optional booleans in this ' +
      "codebase): GetTimeSpecGroups' TIMESPECKEYS.TIMESPECKEY member field carries only bare TIMESPECKEY strings, " +
      'so this replaces each group member with a {TIMESPECKEY, NAME} object via one GetTimeSpecs full-table fetch ' +
      "per call (not per group/member). An unmatched (unknown/deleted) member key resolves to NAME: ''. Applies " +
      'only to this plural tool, not the singular get_time_spec_group (confirmed broken/NOT FOUND on this ' +
      'controller — out of scope). Set RESOLVEMEMBERNAMES: false to skip the fetch and return TIMESPECKEYS exactly ' +
      'as GetTimeSpecGroups provides it (bare string or array of strings).',
    {
      STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.'),
      RESOLVEMEMBERNAMES: z
        .boolean()
        .optional()
        .describe(
          'Optional (default true — on by default; the inverse of this codebase\'s usual optional-boolean ' +
            "default). Replaces each group's TIMESPECKEYS.TIMESPECKEY bare member key(s) with {TIMESPECKEY, NAME} " +
            'objects via one GetTimeSpecs full-table fetch per call (not per group/member); an unmatched key ' +
            "resolves to NAME: ''. Set to false to skip the fetch and return TIMESPECKEYS exactly as " +
            'GetTimeSpecGroups provides it (bare string or array of strings).'
        ),
    },
    async ({ STARTFROMKEY, RESOLVEMEMBERNAMES }): Promise<ToolTextResult> => {
      if (RESOLVEMEMBERNAMES === false) {
        return runNbapiTool(client, NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, mergeParams({ STARTFROMKEY }));
      }
      try {
        const result = await client.call(NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, mergeParams({ STARTFROMKEY }));
        if (result.notFound) {
          return notFoundResult();
        }
        const details = asRecord(result.data);
        const groupsWrapper = asRecord(details.TIMESPECGROUPS);
        const namesByTimeSpecKey = await fetchTimeSpecNames(client);
        const groups = asRecordList(groupsWrapper.TIMESPECGROUP).map((group) => {
          const members = keyList(group.TIMESPECKEYS, 'TIMESPECKEY').map((key) => ({
            TIMESPECKEY: key,
            NAME: namesByTimeSpecKey.get(key) ?? '',
          }));
          return { ...group, TIMESPECKEYS: { TIMESPECKEY: members } };
        });
        const responseData = { ...details, TIMESPECGROUPS: { ...groupsWrapper, TIMESPECGROUP: groups } };
        return { content: [{ type: 'text', text: formatAsJson(responseData) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );

  if (gate.writesEnabled) {
    server.tool(
      'add_time_spec',
      'WRITE: Creates a new time spec (wraps NBAPI AddTimeSpec).',
      { NAME: z.string().describe('Required. Name of the new time spec.'), ...timeSpecWriteFields },
      async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_TIME_SPEC, mergeParams(args), formatWriteSuccess)
    );

    server.tool(
      'modify_time_spec',
      'WRITE: Modifies an existing time spec (wraps NBAPI ModifyTimeSpec). The built-in Always/Never time specs cannot be modified.',
      { TIMESPECKEY: z.string().describe('Required. The TIMESPECKEY of the time spec to modify.'), ...timeSpecWriteFields },
      async (args) => runNbapiTool(client, NBAPI_COMMANDS.MODIFY_TIME_SPEC, mergeParams(args), formatWriteSuccess)
    );

    server.tool(
      'add_time_spec_group',
      'WRITE: Creates a new time spec group (wraps NBAPI AddTimeSpecGroup).',
      {
        NAME: z.string().describe('Required. Name of the new time spec group.'),
        DESCRIPTION: z.string().optional().describe('Optional. Description of the time spec group.'),
      },
      async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP, mergeParams(args), formatWriteSuccess)
    );

    server.tool(
      'modify_time_spec_group',
      'WRITE: Modifies an existing time spec group (wraps NBAPI ModifyTimeSpecGroup). TIMESPECKEYS, if given, replaces the group’s membership.',
      {
        TIMESPECGROUPKEY: z.string().describe('Required. The TIMESPECGROUPKEY of the time spec group to modify.'),
        NAME: z.string().optional().describe('Optional. New name for the time spec group.'),
        DESCRIPTION: z.string().optional().describe('Optional. New description for the time spec group.'),
        TIMESPECKEYS: z.array(z.string()).optional().describe('Optional. Complete replacement list of member TIMESPECKEY values.'),
      },
      async ({ TIMESPECGROUPKEY, NAME, DESCRIPTION, TIMESPECKEYS }) =>
        runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP,
          mergeParams({ TIMESPECGROUPKEY, NAME, DESCRIPTION, ...wrapList('TIMESPECKEYS', 'TIMESPECKEY', TIMESPECKEYS) }),
          formatWriteSuccess
        )
    );

    if (gate.destructiveEnabled) {
      server.tool(
        'delete_time_spec',
        'DESTRUCTIVE: Deletes a time spec (wraps NBAPI DeleteTimeSpec). Requires NETBOX_ENABLE_DESTRUCTIVE. The built-in Always/Never time specs cannot be deleted.',
        { TIMESPECKEY: z.string().describe('Required. The TIMESPECKEY of the time spec to delete.') },
        async ({ TIMESPECKEY }) =>
          runNbapiTool(client, NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY }, formatWriteSuccess)
      );

      server.tool(
        'delete_time_spec_group',
        'DESTRUCTIVE: Deletes a time spec group (wraps NBAPI DeleteTimeSpecGroup). Requires NETBOX_ENABLE_DESTRUCTIVE.',
        { TIMESPECGROUPKEY: z.string().describe('Required. The TIMESPECGROUPKEY of the time spec group to delete.') },
        async ({ TIMESPECGROUPKEY }) =>
          runNbapiTool(client, NBAPI_COMMANDS.DELETE_TIME_SPEC_GROUP, { TIMESPECGROUPKEY }, formatWriteSuccess)
      );
    }
  }
}
