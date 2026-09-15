import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatWriteSuccess, wrapList, type ToolGateFlags } from '../toolHelpers.js';

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
    'Lists time spec groups configured on the NetBox system (wraps NBAPI GetTimeSpecGroups).',
    { STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.') },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, mergeParams({ STARTFROMKEY }))
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
