#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfigFromEnv, NetboxConfigError } from './config.js';
import { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { runNbapiTool, type ToolGateFlags } from './toolHelpers.js';
import { registerShutdownHandlers } from './shutdown.js';
import { registerPersonTools } from './tools/person.js';
import { registerAccessLevelTools } from './tools/accessLevel.js';
import { registerPortalTools } from './tools/portal.js';
import { registerEventsTools } from './tools/events.js';
import { registerTimeSpecTools } from './tools/timeSpec.js';
import { registerHolidayTools } from './tools/holiday.js';
import { registerPortalGroupTools } from './tools/portalGroup.js';
import { registerReaderGroupTools } from './tools/readerGroup.js';
import { registerThreatLevelTools } from './tools/threatLevel.js';
import { registerPartitionTools } from './tools/partition.js';
import { registerMiscTools } from './tools/misc.js';
import { registerUnlockWindowTools } from './tools/unlockWindow.js';
import { registerDailyUnlockWindowTools } from './tools/dailyUnlockWindow.js';

/**
 * MCP server entrypoint. Registers every NetBox NBAPI tool on a stdio
 * transport and handles graceful shutdown (Logout on SIGINT/SIGTERM).
 *
 * Registration is gated per R1/R2: with NETBOX_ENABLE_WRITES unset/falsy,
 * only the read-only tool surface (16 v0.2.0 tools + the 18 R8 read tools +
 * the read-only composites `get_unlock_window`/`get_daily_unlock_window` =
 * 36 tools) is registered — byte-for-byte the same read-only posture as
 * before, plus the new read tools. With NETBOX_ENABLE_WRITES truthy, the 45
 * R9/R11-R20 write tools and the five composite write tools
 * (`set_portals_state`, `schedule_unlock_window`, `cancel_unlock_window`,
 * `schedule_daily_unlock_window`, `cancel_daily_unlock_window`) are also
 * registered, except the 11 destructive tools, which additionally require
 * NETBOX_ENABLE_DESTRUCTIVE.
 */

let config;
try {
  config = loadConfigFromEnv();
} catch (err) {
  if (err instanceof NetboxConfigError) {
    // One-line, actionable, no stack trace (R3 / C3).
    console.error(`s2-netbox-mcp: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const client = new NetboxClient(config);
const server = new McpServer({ name: 's2-netbox-mcp', version: '0.3.0' });

const gate: ToolGateFlags = {
  writesEnabled: config.enableWrites,
  destructiveEnabled: config.enableDestructive,
};

// check_connection wraps GetAPIVersion. It doesn't fit any one of the
// tool-category modules, so it is registered directly here alongside the
// rest of entrypoint wiring. Always registered (read-only).
server.tool(
  'check_connection',
  'Confirms the server can authenticate to the configured S2 NetBox controller and returns the NBAPI version string (wraps GetAPIVersion). No parameters required.',
  {},
  async () => runNbapiTool(client, NBAPI_COMMANDS.GET_API_VERSION, {})
);

registerPersonTools(server, client, gate);
registerAccessLevelTools(server, client, gate);
registerPortalTools(server, client, gate);
registerEventsTools(server, client, gate);
registerTimeSpecTools(server, client, gate);
registerHolidayTools(server, client, gate);
registerPortalGroupTools(server, client, gate);
registerReaderGroupTools(server, client, gate);
registerThreatLevelTools(server, client, gate);
registerPartitionTools(server, client, gate);
registerMiscTools(server, client);
registerUnlockWindowTools(server, client, gate, {
  holidayGroups: config.unlockHolidayGroups,
  namePrefix: config.unlockNamePrefix,
});
registerDailyUnlockWindowTools(server, client, gate, {
  holidayGroup: config.dailyUnlockHolidayGroup,
  namePrefix: config.dailyUnlockNamePrefix,
});

registerShutdownHandlers(client);

const transport = new StdioServerTransport();
await server.connect(transport);
