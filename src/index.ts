import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfigFromEnv, NetboxConfigError } from './config.js';
import { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { runNbapiTool } from './toolHelpers.js';
import { registerShutdownHandlers } from './shutdown.js';
import { registerPersonTools } from './tools/person.js';
import { registerAccessLevelTools } from './tools/accessLevel.js';
import { registerPortalTools } from './tools/portal.js';
import { registerEventsTools } from './tools/events.js';

/**
 * MCP server entrypoint. Registers all 16 read-only NetBox NBAPI tools on a
 * stdio transport and handles graceful shutdown (Logout on SIGINT/SIGTERM).
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
const server = new McpServer({ name: 's2-netbox-mcp', version: '0.1.0' });

// check_connection wraps GetAPIVersion. It doesn't fit any one of the four
// tool-category modules (person/accessLevel/portal/events), so it is
// registered directly here alongside the rest of entrypoint wiring.
server.tool(
  'check_connection',
  'Confirms the server can authenticate to the configured S2 NetBox controller and returns the NBAPI version string (wraps GetAPIVersion). No parameters required.',
  {},
  async () => runNbapiTool(client, NBAPI_COMMANDS.GET_API_VERSION, {})
);

registerPersonTools(server, client);
registerAccessLevelTools(server, client);
registerPortalTools(server, client);
registerEventsTools(server, client);

registerShutdownHandlers(client);

const transport = new StdioServerTransport();
await server.connect(transport);
