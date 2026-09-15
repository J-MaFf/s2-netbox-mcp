import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import {
  runNbapiTool,
  mergeParams,
  formatAsJson,
  formatWriteSuccess,
  toolErrorResult,
  type ToolTextResult,
  type ToolGateFlags,
} from '../toolHelpers.js';
import { findPortals } from '../portalSearch.js';
import { PORTAL_STATE_ACTIONS, setPortalsState } from '../portalState.js';

/**
 * Portal/reader/output tools: GetPortals, GetReader, GetReaders, GetOutputs
 * (R8) — each a thin pass-through of that NBAPI command's documented PARAMS
 * and response fields — plus the composite `find_portals` search and the R9
 * portal/output action tools (LockPortal, UnlockPortal,
 * MomentaryUnlockPortal, DogOnNextExitPortal, ActivateOutput,
 * DeactivateOutput).
 *
 * There is deliberately no `get_portal` (singular) tool: per the Command
 * reference, no singular GetPortal command exists on the real NBAPI — only
 * the plural GetPortals command (paginated via STARTFROMKEY/NEXTKEY, no
 * single-portal filter). `get_portals`'s response already nests each
 * portal's readers.
 *
 * `find_portals` exists because portal names are site codes and neither
 * GetPortals nor GetReaders takes a filter: it reads both in full and matches
 * the joined names and reader descriptions client-side (see portalSearch.ts),
 * issuing no commands beyond those two.
 */
export function registerPortalTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_portals',
    'Lists portals (doors) configured on the NetBox system, each with its nested readers ' +
      '(wraps NBAPI GetPortals, paginated via STARTFROMKEY/NEXTKEY — there is no single-portal filter).',
    {
      STARTFROMKEY: z
        .string()
        .optional()
        .describe('Optional. Pagination cursor — the NEXTKEY from a previous call, to continue listing.'),
    },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_PORTALS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'get_reader',
    'Returns the details of a single reader for a given READERKEY (wraps NBAPI GetReader).',
    {
      READERKEY: z.string().describe('Required. The unique READERKEY of the reader to retrieve.'),
    },
    async ({ READERKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READER, { READERKEY })
  );

  server.tool(
    'get_readers',
    'Lists readers configured on the NetBox system (wraps NBAPI GetReaders). ' +
      'There is no portal-id filter — use get_portals to see each reader nested under its portal.',
    {
      STARTFROMKEY: z
        .string()
        .optional()
        .describe('Optional. Pagination cursor to continue listing from a previous call.'),
    },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READERS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'get_outputs',
    'Lists auxiliary outputs configured on the NetBox system (wraps NBAPI GetOutputs).',
    {
      STARTFROMKEY: z
        .string()
        .optional()
        .describe('Optional. Pagination cursor to continue listing from a previous call.'),
    },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_OUTPUTS, mergeParams({ STARTFROMKEY }))
  );

  server.tool(
    'find_portals',
    'Finds portals (doors) by location or name. Portal names are site codes (e.g. 01OF05A), so this also ' +
      "searches each portal's reader names and reader descriptions (e.g. 'WORKSHOP TO MAINTENANCE OFFICE'). " +
      'Case-insensitive; a portal matches when every whitespace-separated term appears in its name, a reader ' +
      'name, or a reader description. Reads every page of GetPortals and GetReaders and joins them by READERKEY. ' +
      'The result also lists portals with no reader description, which can only match by name.',
    {
      query: z
        .string()
        .trim()
        .min(1)
        .describe('Required. Search terms, e.g. "maintenance office", "electrical closet", or "01OF05".'),
    },
    async ({ query }): Promise<ToolTextResult> => {
      try {
        return { content: [{ type: 'text', text: formatAsJson(await findPortals(client, query)) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );

  if (gate.writesEnabled) {
    server.tool(
      'lock_portal',
      'WRITE: Locks a portal (door), ending any Extended Unlock (wraps NBAPI LockPortal).',
      { PORTALKEY: z.string().describe('Required. The PORTALKEY of the portal to lock.') },
      async ({ PORTALKEY }) => runNbapiTool(client, NBAPI_COMMANDS.LOCK_PORTAL, { PORTALKEY }, formatWriteSuccess)
    );

    server.tool(
      'unlock_portal',
      'WRITE: Puts a portal (door) into Extended Unlock until lock_portal is called (wraps NBAPI UnlockPortal).',
      { PORTALKEY: z.string().describe('Required. The PORTALKEY of the portal to unlock.') },
      async ({ PORTALKEY }) => runNbapiTool(client, NBAPI_COMMANDS.UNLOCK_PORTAL, { PORTALKEY }, formatWriteSuccess)
    );

    server.tool(
      'momentary_unlock_portal',
      'WRITE: Momentarily unlocks a portal (door) for its configured unlock duration (wraps NBAPI MomentaryUnlockPortal).',
      { PORTALKEY: z.string().describe('Required. The PORTALKEY of the portal to momentarily unlock.') },
      async ({ PORTALKEY }) =>
        runNbapiTool(client, NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL, { PORTALKEY }, formatWriteSuccess)
    );

    server.tool(
      'dog_on_next_exit_portal',
      'WRITE: Arms "dog on next exit" on a portal, so the door unlocks on the next valid exit request (wraps NBAPI DogOnNextExitPortal). Not supported on every device type.',
      { PORTALKEY: z.string().describe('Required. The PORTALKEY of the portal.') },
      async ({ PORTALKEY }) =>
        runNbapiTool(client, NBAPI_COMMANDS.DOG_ON_NEXT_EXIT_PORTAL, { PORTALKEY }, formatWriteSuccess)
    );

    server.tool(
      'activate_output',
      'WRITE: Activates an auxiliary output (wraps NBAPI ActivateOutput).',
      { OUTPUTKEY: z.string().describe('Required. The OUTPUTKEY of the output to activate.') },
      async ({ OUTPUTKEY }) => runNbapiTool(client, NBAPI_COMMANDS.ACTIVATE_OUTPUT, { OUTPUTKEY }, formatWriteSuccess)
    );

    server.tool(
      'deactivate_output',
      'WRITE: Deactivates an auxiliary output (wraps NBAPI DeactivateOutput).',
      { OUTPUTKEY: z.string().describe('Required. The OUTPUTKEY of the output to deactivate.') },
      async ({ OUTPUTKEY }) =>
        runNbapiTool(client, NBAPI_COMMANDS.DEACTIVATE_OUTPUT, { OUTPUTKEY }, formatWriteSuccess)
    );

    // Composite (R10): one LockPortal/UnlockPortal/MomentaryUnlockPortal per
    // portal, sequentially, never aborting on a single failure. UNLOCK is an
    // Extended Unlock that lasts until LOCK — for a timed window that the
    // controller enforces itself, use schedule_unlock_window instead.
    server.tool(
      'set_portals_state',
      'WRITE: Locks, unlocks (Extended Unlock until locked again), or momentarily unlocks many portals in one call — ' +
        'the given PORTALKEYs, or every portal from a fully paginated GetPortals when portalKeys is omitted. Issues ' +
        'LockPortal/UnlockPortal/MomentaryUnlockPortal per portal sequentially and never stops on a single failure; ' +
        'the result partitions portals into succeeded, alreadyInState ("Portal state not changed") and failed, and is an ' +
        'error only when failed is non-empty. For a scheduled, self-relocking window use schedule_unlock_window.',
      {
        action: z.enum(PORTAL_STATE_ACTIONS).describe('Required. LOCK, UNLOCK (Extended Unlock), or MOMENTARY_UNLOCK.'),
        portalKeys: z
          .array(z.string())
          .optional()
          .describe('Optional. PORTALKEY values to act on; omitted = every portal returned by GetPortals.'),
      },
      async ({ action, portalKeys }): Promise<ToolTextResult> => {
        try {
          const result = await setPortalsState(client, action, portalKeys);
          if (result.failed.length > 0) {
            return {
              content: [{ type: 'text', text: `${result.failed.length} of ${result.requested} portal(s) failed\n${formatAsJson(result)}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: formatWriteSuccess(result) }] };
        } catch (err) {
          return toolErrorResult(err);
        }
      }
    );
  }
}
