import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { formatAsJson, formatWriteSuccess, toolErrorResult, type ToolGateFlags, type ToolTextResult } from '../toolHelpers.js';
import {
  DailyUnlockWindowError,
  cancelDailyUnlockWindow,
  getDailyUnlockWindow,
  scheduleDailyUnlockWindow,
  type DailyUnlockWindowSettings,
} from '../unlockWindow/dailyExecutor.js';
import { timeSpecGroupName } from '../unlockWindow/managed.js';
import { MAX_DAILY_WINDOW_DAYS } from '../unlockWindow/dailyPlanner.js';

/**
 * The managed daily-recurring-unlock-window tools:
 *
 *  - `get_daily_unlock_window`      read-only; always registered
 *  - `schedule_daily_unlock_window` write; registered only with NETBOX_ENABLE_WRITES
 *  - `cancel_daily_unlock_window`   write; registered only with NETBOX_ENABLE_WRITES
 *
 * The companion to `schedule_unlock_window`/`cancel_unlock_window`/
 * `get_unlock_window` (src/tools/unlockWindow.ts): "unlock these doors from
 * dailyStartTime to dailyEndTime, every day from startDate through endDate"
 * — a single partial-day window that recurs daily across a date range, which
 * the continuous tool cannot express without keeping doors unlocked
 * overnight on the days strictly between the first and last. The two
 * features use disjoint holiday groups and disjoint portal-group/time-spec-
 * group names (different name prefixes), so they may both be active at the
 * same time (see the spec's Design decision 3). All logic lives in
 * src/unlockWindow/; this module only maps results onto MCP tool results.
 */

function dailyUnlockToolError(err: unknown): ToolTextResult {
  if (err instanceof DailyUnlockWindowError) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
  return toolErrorResult(err);
}

export function registerDailyUnlockWindowTools(
  server: McpServer,
  client: NetboxClient,
  gate: ToolGateFlags,
  settings: DailyUnlockWindowSettings
): void {
  const prefix = settings.namePrefix;
  const tsgName = timeSpecGroupName(prefix);

  server.tool(
    'get_daily_unlock_window',
    `Reports the managed daily recurring unlock window, if any: the managed portal group "${prefix}" (key, portals, its unlock ` +
      `time spec group and whether that is the managed time spec group "${tsgName}"), that group and its members (read from ` +
      'paginated GetTimeSpecGroups), the one managed time spec and holiday, the window derived from them, and whether it is ' +
      'active right now on the host clock. Read-only: issues only Get commands. No parameters required.',
    {},
    async (): Promise<ToolTextResult> => {
      try {
        return { content: [{ type: 'text', text: formatAsJson(await getDailyUnlockWindow(client, settings)) }] };
      } catch (err) {
        return dailyUnlockToolError(err);
      }
    }
  );

  if (!gate.writesEnabled) return;

  server.tool(
    'schedule_daily_unlock_window',
    'WRITE: Schedules the managed daily recurring unlock window — unlocks the given portals (default: every portal) from ' +
      'dailyStartTime to dailyEndTime, every day from startDate through endDate, enforced by the controller itself via a ' +
      'Holiday spanning the whole date range plus a single partial-day Time Spec (no weekdays, only the reserved daily ' +
      `holiday group ticked) and a Portal Group it creates or rewrites under the configured name prefix (portal group "${prefix}", ` +
      `time spec group "${tsgName}"). Unlike schedule_unlock_window, this always produces exactly one segment — no first/middle/last ` +
      'splitting — so the doors relock every night outside the daily window. There is one managed daily window: scheduling a new ' +
      `one replaces the previous one. Dates are controller-local "YYYY-MM-DD" and times "HH:MM"; dailyEndTime must be later than ` +
      'dailyStartTime (an overnight-crossing daily window, e.g. 22:00 to 05:00, is not supported); the window must end in the ' +
      `future and span at most ${MAX_DAILY_WINDOW_DAYS} days. Before writing, it reports time specs that would be suppressed on ` +
      "the window's dates (they do not tick the reserved daily holiday group) and refuses unless acknowledgeSideEffects=true; " +
      'dryRun=true returns the plan and that report without writing. After writing it reads everything back and fails if anything ' +
      'differs from the plan. If any step fails, the managed holiday and time spec written so far are rolled back (deleted) before ' +
      'the error is returned, so no partial window can remain active. This tool and schedule_unlock_window may both be active at ' +
      'the same time — they use disjoint holiday groups and disjoint managed-object names. Use cancel_daily_unlock_window to cancel.',
    {
      startDate: z.string().describe('Required. First date to unlock, controller-local "YYYY-MM-DD".'),
      endDate: z.string().describe('Required. Last date to unlock (inclusive), controller-local "YYYY-MM-DD".'),
      dailyStartTime: z.string().describe('Required. Daily unlock start time, controller-local "HH:MM".'),
      dailyEndTime: z
        .string()
        .describe('Required. Daily unlock end time, controller-local "HH:MM" — must be later than dailyStartTime (same-day only).'),
      portalKeys: z
        .array(z.string())
        .optional()
        .describe('Optional. PORTALKEY values to unlock; omitted = every portal returned by GetPortals. Keys only — use get_portals/find_portals to map names.'),
      acknowledgeSideEffects: z
        .boolean()
        .optional()
        .describe('Optional (default false). Set true to proceed even though other time specs would be suppressed on the window\'s dates.'),
      dryRun: z.boolean().optional().describe('Optional (default false). Return the plan and the side-effect report without writing anything.'),
    },
    async ({ startDate, endDate, dailyStartTime, dailyEndTime, portalKeys, acknowledgeSideEffects, dryRun }): Promise<ToolTextResult> => {
      try {
        const result = await scheduleDailyUnlockWindow(
          client,
          { startDate, endDate, dailyStartTime, dailyEndTime, portalKeys, acknowledgeSideEffects, dryRun },
          settings
        );
        if ('dryRun' in result) {
          return { content: [{ type: 'text', text: `DRY RUN (nothing written)\n${formatAsJson(result)}` }] };
        }
        return { content: [{ type: 'text', text: formatWriteSuccess(result) }] };
      } catch (err) {
        return dailyUnlockToolError(err);
      }
    }
  );

  server.tool(
    'cancel_daily_unlock_window',
    `WRITE: Cancels the managed daily recurring unlock window: if the managed portal group "${prefix}" exists, points it at the ` +
      'built-in "Never" time spec group; then, regardless, deletes the managed holiday if it exists, and empties the managed time ' +
      `spec group ("${tsgName}") and deletes the managed time spec if it exists (those last two are best-effort — anything the ` +
      'controller refuses is listed under leftBehind, and nothing can unlock once the portal group, if any, is on Never with no ' +
      'managed holiday). The managed portal group and time spec group are kept for reuse. Returns a normal (non-error) "nothing to ' +
      'cancel" result only when no managed object of any kind (portal group, time spec group, holiday, or time spec) exists. Only ' +
      'objects named exactly with the managed prefix are ever touched. No parameters required.',
    {},
    async (): Promise<ToolTextResult> => {
      try {
        return { content: [{ type: 'text', text: formatWriteSuccess(await cancelDailyUnlockWindow(client, settings)) }] };
      } catch (err) {
        return dailyUnlockToolError(err);
      }
    }
  );
}
