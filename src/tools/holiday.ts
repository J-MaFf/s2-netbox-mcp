import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatWriteSuccess, type ToolGateFlags } from '../toolHelpers.js';

const DATE_NOTE =
  'Dates are the controller’s local time, formatted "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" (time defaults to 00:00). ' +
  'ENDDATE is exclusive — a one-day holiday runs STARTDATE 00:00 to (STARTDATE + 1 day) 00:00.';

/**
 * Holiday tools: the R8 read tools (GetHoliday, GetHolidays) plus the R12
 * write tools (AddHoliday, ModifyHoliday, DeleteHoliday). Field names are
 * copied verbatim from the spec's Command reference.
 */
export function registerHolidayTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_holiday',
    'Returns the details of a single holiday for a given HOLIDAYKEY (wraps NBAPI GetHoliday).',
    { HOLIDAYKEY: z.string().describe('Required. The unique HOLIDAYKEY of the holiday to retrieve.') },
    async ({ HOLIDAYKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_HOLIDAY, { HOLIDAYKEY })
  );

  server.tool(
    'get_holidays',
    'Lists holiday keys configured on the NetBox system (wraps NBAPI GetHolidays). Returns a comma-separated key string, not a ' +
      'list of records — use get_holiday per key for details. GetHolidays has no documented calling parameters (no pagination).',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_HOLIDAYS, {})
  );

  if (gate.writesEnabled) {
    server.tool(
      'add_holiday',
      `WRITE: Creates a new holiday (wraps NBAPI AddHoliday). ${DATE_NOTE} Holidays are capped at 30 per partition.`,
      {
        HOLIDAYNAME: z.string().describe('Required. Name of the new holiday (max 64 characters).'),
        STARTDATE: z.string().describe('Required. Start date/time (inclusive).'),
        ENDDATE: z.string().describe('Required. End date/time (exclusive).'),
        HOLIDAYGROUPS: z
          .string()
          .describe(
            'Required. Comma-separated list of holiday group numbers (1-8) this holiday belongs to. A live ' +
              'controller rejected AddHoliday without it ("At least one holiday group must be selected.").'
          ),
      },
      async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_HOLIDAY, mergeParams(args), formatWriteSuccess)
    );

    server.tool(
      'modify_holiday',
      `WRITE: Modifies an existing holiday (wraps NBAPI ModifyHoliday). ${DATE_NOTE}`,
      {
        HOLIDAYKEY: z.string().describe('Required. The HOLIDAYKEY of the holiday to modify.'),
        HOLIDAYNAME: z.string().optional().describe('Optional. New name for the holiday.'),
        HOLIDAYGROUPS: z.string().optional().describe('Optional. Comma-separated list of holiday group numbers (1-8) this holiday belongs to.'),
        STARTDATE: z.string().optional().describe('Optional. New start date/time (inclusive).'),
        ENDDATE: z.string().optional().describe('Optional. New end date/time (exclusive).'),
      },
      async (args) => runNbapiTool(client, NBAPI_COMMANDS.MODIFY_HOLIDAY, mergeParams(args), formatWriteSuccess)
    );

    if (gate.destructiveEnabled) {
      server.tool(
        'delete_holiday',
        'DESTRUCTIVE: Deletes a holiday (wraps NBAPI DeleteHoliday). Requires NETBOX_ENABLE_DESTRUCTIVE.',
        { HOLIDAYKEY: z.string().describe('Required. The HOLIDAYKEY of the holiday to delete.') },
        async ({ HOLIDAYKEY }) => runNbapiTool(client, NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY }, formatWriteSuccess)
      );
    }
  }
}
