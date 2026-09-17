import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatWriteSuccess, type ToolGateFlags } from '../toolHelpers.js';

/**
 * Alarm and duty-log tools: `get_alarms` (GetAlarms, read) and `add_duty_log`
 * (AddDutyLog, write).
 *
 * SOURCE: both commands, their parameter names and their required/optional
 * split are taken verbatim from the LenelS2 "NBAPI version 2 Guide" for
 * NetBox and NetBox Global, April 2025, document #API2-UG-8
 * (`docs/reference/NetBox_API_V2.pdf`), Command Reference sections GetAlarms
 * and AddDutyLog. Neither command exists in the April-2024 version 1 guide;
 * see `docs/reference/nbapi-command-diff.md`.
 *
 * NOT LIVE-VERIFIED (writes): `scripts/live-check.ts` drives `get_alarms`
 * read-only against the reference controller, but `add_duty_log` writes a
 * duty-log entry and is therefore exercised only by
 * `scripts/live-check-write.ts`, which the maintainer runs by hand — the
 * automated loop never runs a write live script. As with the hardware module,
 * treat the write path as document-derived until that run is recorded.
 *
 * Deliberately NOT wired here: the v2 guide also documents AckAlarm,
 * AckEvent, AlarmClearActions, AlarmSetOwner and EventClearActions. Those are
 * alarm/event *workflow* commands that mutate an operator's alarm queue;
 * they are out of scope for the spec that added this module and are recorded
 * as unimplemented in `docs/reference/nbapi-command-diff.md` instead of being
 * silently forgotten.
 */
export function registerAlarmTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_alarms',
    'Returns alarm information from the NetBox system, optionally filtered by partition, alarm ID, event ID, ' +
      'activity ID or owner (wraps NBAPI GetAlarms). Responds with an ALARMS/ALARM collection; a system with no ' +
      'active alarms answers with an empty collection or a documented NOT FOUND.',
    {
      ALLPARTITIONS: z.enum(['TRUE', 'FALSE']).optional().describe('Optional. "TRUE" to return alarms across all partitions.'),
      PARTITIONKEY: z.string().optional().describe('Optional. Return alarms for this partition key only.'),
      ID: z.string().optional().describe('Optional. Return the alarm with this alarm ID.'),
      EVENTID: z.string().optional().describe('Optional. Return alarms raised by this event ID.'),
      ACTIVITYID: z.string().optional().describe('Optional. Return alarms for this activity ID.'),
      OWNERID: z.string().optional().describe('Optional. Return alarms owned by this operator/person ID.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.GET_ALARMS, mergeParams(args))
  );

  if (!gate.writesEnabled) return;

  server.tool(
    'add_duty_log',
    'WRITE: Adds a duty log entry attributed to a person (wraps NBAPI AddDutyLog). PARTITIONKEY is only necessary ' +
      'when ACTIVITYID is omitted.',
    {
      PERSONID: z.string().describe('Required. ID number of the person adding the duty log entry.'),
      LOGTEXT: z.string().describe('Required. The text added to the duty log.'),
      ACTIVITYID: z.string().optional().describe('Optional. ID number of the activity the duty log entry relates to.'),
      PARTITIONKEY: z.string().optional().describe('Optional. Key of the partition. Only necessary if ACTIVITYID is not supplied.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_DUTY_LOG, mergeParams(args), formatWriteSuccess)
  );
}
