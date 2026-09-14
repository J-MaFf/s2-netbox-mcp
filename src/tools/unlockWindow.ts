import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { formatAsJson, formatWriteSuccess, toolErrorResult, type ToolGateFlags, type ToolTextResult } from '../toolHelpers.js';
import {
  UnlockWindowError,
  cancelUnlockWindow,
  getUnlockWindow,
  scheduleUnlockWindow,
  type UnlockWindowSettings,
} from '../unlockWindow/executor.js';
import { MAX_WINDOW_DAYS } from '../unlockWindow/planner.js';

/**
 * The managed unlock-window tools (R22-R28):
 *
 *  - `get_unlock_window`      read-only; always registered
 *  - `schedule_unlock_window` write; registered only with NETBOX_ENABLE_WRITES
 *  - `cancel_unlock_window`   write; registered only with NETBOX_ENABLE_WRITES
 *
 * "Unlock all doors from <date-time> to <date-time>" becomes one call whose
 * schedule the controller itself enforces (holiday + time spec + portal
 * group — the same objects an operator would create by hand), so no process
 * has to stay alive to relock the doors. All logic lives in
 * src/unlockWindow/; this module only maps results onto MCP tool results.
 */

function unlockToolError(err: unknown): ToolTextResult {
  if (err instanceof UnlockWindowError) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
  return toolErrorResult(err);
}

export function registerUnlockWindowTools(
  server: McpServer,
  client: NetboxClient,
  gate: ToolGateFlags,
  settings: UnlockWindowSettings
): void {
  const prefix = settings.namePrefix;

  server.tool(
    'get_unlock_window',
    `Reports the managed unlock window, if any: the managed portal group "${prefix}" (key, portals, its unlock time spec group ` +
      'and whether that is the managed group), the managed time spec group and its members (read from paginated ' +
      'GetTimeSpecGroups), the managed time specs and holidays, the window derived from them, and whether it is active ' +
      'right now on the host clock. Read-only: issues only Get commands. No parameters required.',
    {},
    async (): Promise<ToolTextResult> => {
      try {
        return { content: [{ type: 'text', text: formatAsJson(await getUnlockWindow(client, settings)) }] };
      } catch (err) {
        return unlockToolError(err);
      }
    }
  );

  if (!gate.writesEnabled) return;

  server.tool(
    'schedule_unlock_window',
    'WRITE: Schedules the managed unlock window — unlocks the given portals (default: every portal) from start to end, ' +
      'enforced by the controller itself via a Holiday + Time Spec + Portal Group it creates or rewrites under the ' +
      `configured name prefix ("${prefix}"). There is one managed window: scheduling a new one replaces the previous one. ` +
      `Times are controller-local YYYY-MM-DD HH:MM; the window must end in the future and be at most ${MAX_WINDOW_DAYS} days long; ` +
      'a multi-day window may relock for up to 60 s at each midnight. Before writing, it reports time specs that would be ' +
      "suppressed on the window's dates (they do not tick the reserved holiday groups) and refuses unless " +
      'acknowledgeSideEffects=true; dryRun=true returns the plan and that report without writing. After writing it reads ' +
      'everything back and fails if anything differs from the plan. Use cancel_unlock_window to cancel.',
    {
      start: z.string().describe('Required. Window start, controller-local "YYYY-MM-DD HH:MM".'),
      end: z.string().describe('Required. Window end, controller-local "YYYY-MM-DD HH:MM" (an end of 00:00 means up to 23:59 of the previous day).'),
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
    async ({ start, end, portalKeys, acknowledgeSideEffects, dryRun }): Promise<ToolTextResult> => {
      try {
        const result = await scheduleUnlockWindow(client, { start, end, portalKeys, acknowledgeSideEffects, dryRun }, settings);
        if ('dryRun' in result) {
          return { content: [{ type: 'text', text: `DRY RUN (nothing written)\n${formatAsJson(result)}` }] };
        }
        return { content: [{ type: 'text', text: formatWriteSuccess(result) }] };
      } catch (err) {
        return unlockToolError(err);
      }
    }
  );

  server.tool(
    'cancel_unlock_window',
    `WRITE: Cancels the managed unlock window: points the managed portal group "${prefix}" at the built-in "Never" time spec ` +
      'group, deletes the managed holidays, then empties the managed time spec group and deletes the managed time specs ' +
      '(those last two are best-effort — anything the controller refuses is listed under leftBehind, and nothing can unlock ' +
      'once the portal group is on Never with no managed holiday). The managed portal group and time spec group are kept ' +
      'for reuse. Only objects named exactly with the managed prefix are ever touched. No parameters required.',
    {},
    async (): Promise<ToolTextResult> => {
      try {
        return { content: [{ type: 'text', text: formatWriteSuccess(await cancelUnlockWindow(client, settings)) }] };
      } catch (err) {
        return unlockToolError(err);
      }
    }
  );
}
