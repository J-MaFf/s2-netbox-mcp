import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatWriteSuccess, type ToolGateFlags } from '../toolHelpers.js';

/**
 * Hardware tools — Mercury panels, network nodes, and SIOs (serial I/O
 * boards).
 *
 * SOURCE: every command, parameter name, required/optional split, and enum
 * value in this module is taken verbatim from the LenelS2 "NBAPI version 2
 * Guide" for NetBox and NetBox Global, April 2025, document #API2-UG-8
 * (`docs/reference/NetBox_API_V2.pdf`), Command Reference sections
 * GetMercuryPanel(s)/AddMercuryPanel/ModifyMercuryPanel/DeleteMercuryPanel,
 * GetNetworkNode(s)/AddNetworkNode/ModifyNetworkNode/DeleteNetworkNode and
 * GetSio(s)/AddSio/ModifySio/DeleteSio. None of these commands exists in the
 * April-2024 version 1 guide; see `docs/reference/nbapi-command-diff.md`.
 *
 * NOT LIVE-VERIFIED: the reference controller this project is developed
 * against (NetBox 6.2.0) has no Mercury panels, no SIOs, and no separately
 * addressable network nodes, so none of the hardware CRUD tools in this
 * module has ever been exercised against real hardware. `scripts/
 * live-check.ts` drives the read tools only, and they SKIP-pass on that
 * controller because the collections come back empty. The write and
 * destructive tools here are built to the document alone — treat their
 * behaviour on a real Mercury/SIO installation as unverified, and expect the
 * usual undocumented-required-field surprises this controller family has
 * already produced elsewhere (see `modify_threat_level`'s SEQNUM/COLOR
 * notes). Live-exercising hardware CRUD is deliberately out of scope for the
 * spec that added these tools.
 *
 * Two documented example/Calling-Parameters conflicts are resolved in favour
 * of the Calling Parameters list, which the guide's own "Parameters not
 * explicitly specified as 'optional' should be regarded as 'required'" rule
 * makes authoritative:
 *  - GetSio's worked example sends MERCURYKEY; its Calling Parameters list
 *    says SIOKEY. SIOKEY is used here.
 *  - DeleteSio's worked example sends NODEKEY; its Calling Parameters list
 *    says SIOKEY. SIOKEY is used here.
 * A third: ModifyMercuryPanel and ModifyNetworkNode omit their own key from
 * the bullet list but send MERCURYKEY/NODEKEY in the worked example and
 * describe themselves as "specifies the key corresponding to the ... to be
 * updated", so those keys are modelled as required.
 *
 * Booleans: `src/xml.ts` serialises scalars with `String(value)`, so a JS
 * `true` would go on the wire as `true`, not the `TRUE` the controller
 * expects. Every doc-"boolean" parameter is therefore a
 * `z.enum(['TRUE','FALSE'])` string, the same convention the rest of this
 * codebase uses.
 */

/** AddMercuryPanel TYPE — the closed list of panel types the v2 guide documents. */
const MERCURY_TYPE_ENUM = z.enum([
  'EP/LP1501',
  'EP/LP1502',
  'EP/LP2500',
  'EP/LP4502',
  'M5-IC',
  'MP1501',
  'MP1502',
  'MP2500',
  'MP4502',
  'MS-ICS',
  'PIM400-1501',
  'PW6K1IC',
  'Pro4200',
]);

/** AddNetworkNode TYPE — documented as case-sensitive, so spelled exactly as printed. */
const NETWORK_NODE_TYPE_ENUM = z.enum(['M1-3200', 'MicroNode Plus', 'Node', 'MicroNode', 'NanoNode']);

const BOOLEAN_ENUM = z.enum(['TRUE', 'FALSE']);

/**
 * AddMercuryPanel/ModifyMercuryPanel NETWORK block. The guide prints
 * IPADDRESS/TLSSECURE/RETRYCOUNT/POLLDELAY/REPLYTIMEOUT/RETRYINTERVAL as
 * top-level bullets, but its worked example nests them inside a single
 * `<NETWORK>` element — which is also the only reading consistent with the
 * NETWORK bullet's own "Specify the network details" text. Modelled as a
 * nested zod object so `buildParamsXml` emits
 * `<NETWORK><IPADDRESS>…</IPADDRESS>…</NETWORK>`, never flattened siblings.
 */
const networkBlockSchema = z
  .object({
    IPADDRESS: z.string().describe('Required. IP address of the Mercury panel; unique across Mercury and SIO partitions.'),
    TLSSECURE: BOOLEAN_ENUM.describe('Required. "TRUE" for a TLS-secured transport, "FALSE" for unsecured.'),
    RETRYCOUNT: z.string().optional().describe('Optional. Retry count. The controller defaults to 3.'),
    POLLDELAY: z.string().optional().describe('Optional. Polling delay interval in milliseconds. The controller defaults to 5000.'),
    REPLYTIMEOUT: z.string().optional().describe('Optional. Reply timeout in milliseconds. The controller defaults to 1500.'),
    RETRYINTERVAL: z.string().optional().describe('Optional. Retry interval in milliseconds. The controller defaults to 10000.'),
  })
  .describe('Required. Network details for the panel, sent as a nested <NETWORK> element.');

/**
 * AddMercuryPanel/ModifyMercuryPanel SIOCHANNELSETTINGS block — also nested,
 * per the guide's worked example. Every channel defaults to "MSP1" when the
 * whole block is omitted.
 */
const sioChannelSettingsSchema = z
  .object({
    SIOCHANNEL0: z.string().optional().describe('Optional. Channel 0 setting. Defaults to "MSP1".'),
    SIOCHANNEL1: z.string().optional().describe('Optional. Channel 1 setting. Defaults to "MSP1".'),
    SIOCHANNEL2: z.string().optional().describe('Optional. Channel 2 setting. Defaults to "MSP1".'),
    SIOCHANNEL3: z.string().optional().describe('Optional. Channel 3 setting. Defaults to "MSP1".'),
  })
  .optional()
  .describe('Optional. Serial output channel settings, sent as a nested <SIOCHANNELSETTINGS> element.');

const NOT_LIVE_VERIFIED =
  'NOTE: not live-verified — the reference controller has no Mercury/SIO hardware, so this tool is built to the ' +
  'April-2025 NBAPI v2 guide alone.';

export function registerHardwareTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  // --- Reads (6) -----------------------------------------------------------

  server.tool(
    'get_mercury_panels',
    'Lists the Mercury panels configured on the NetBox system, optionally filtered (wraps NBAPI GetMercuryPanels). ' +
      'Returns an empty collection (or a FAIL/"NOT FOUND") on a system with no Mercury hardware.',
    {
      ALLPARTITIONS: BOOLEAN_ENUM.optional().describe('Optional. "TRUE" to list Mercury panels across all partitions.'),
      PARTITIONKEY: z.string().optional().describe('Optional. Restrict the listing to this partition key.'),
      MERCURYKEY: z.string().optional().describe('Optional. Restrict the listing to this Mercury panel key.'),
      NAME: z.string().optional().describe('Optional. Restrict the listing to Mercury panels with this name.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.GET_MERCURY_PANELS, mergeParams(args))
  );

  server.tool(
    'get_mercury_panel',
    'Returns the details of a single Mercury panel for a given MERCURYKEY (wraps NBAPI GetMercuryPanel).',
    {
      MERCURYKEY: z.string().describe('Required. The key of the Mercury panel to retrieve. Use get_mercury_panels to discover keys.'),
    },
    async ({ MERCURYKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_MERCURY_PANEL, { MERCURYKEY })
  );

  server.tool(
    'get_network_nodes',
    'Lists the network nodes configured on the NetBox system, optionally filtered (wraps NBAPI GetNetworkNodes).',
    {
      ALLPARTITIONS: BOOLEAN_ENUM.optional().describe('Optional. "TRUE" to list network nodes across all partitions.'),
      PARTITIONKEY: z.string().optional().describe('Optional. Restrict the listing to this partition key.'),
      NODEKEY: z.string().optional().describe('Optional. Restrict the listing to this network node key.'),
      UNIQUEIDENTIFIER: z.string().optional().describe('Optional. Restrict the listing to the node with this 16-hex-digit unique identifier.'),
      NAME: z.string().optional().describe('Optional. Restrict the listing to network nodes with this name.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.GET_NETWORK_NODES, mergeParams(args))
  );

  server.tool(
    'get_network_node',
    'Returns the details of a single network node for a given NODEKEY (wraps NBAPI GetNetworkNode).',
    {
      NODEKEY: z.string().describe('Required. The key of the network node to retrieve. Use get_network_nodes to discover keys.'),
      PARTITIONKEY: z.string().optional().describe('Optional. Key of the partition the node belongs to.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.GET_NETWORK_NODE, mergeParams(args))
  );

  server.tool(
    'get_sios',
    'Lists the SIOs (serial I/O boards) attached to one Mercury panel (wraps NBAPI GetSios). ' +
      'There is no unfiltered "all SIOs" listing — MERCURYKEY is required; the response carries a NEXTKEY pagination cursor.',
    {
      MERCURYKEY: z.string().describe('Required. The Mercury panel key whose SIOs should be listed. Use get_mercury_panels to discover keys.'),
    },
    async ({ MERCURYKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_SIOS, { MERCURYKEY })
  );

  server.tool(
    'get_sio',
    'Returns the details of a single SIO for a given SIOKEY (wraps NBAPI GetSio). ' +
      "Note: the v2 guide's worked example for GetSio sends MERCURYKEY, but its Calling Parameters list — which the " +
      "guide makes authoritative — specifies SIOKEY, so SIOKEY is what this tool sends.",
    {
      SIOKEY: z.string().describe('Required. The key of the SIO to retrieve. Use get_sios to discover keys.'),
    },
    async ({ SIOKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_SIO, { SIOKEY })
  );

  if (!gate.writesEnabled) return;

  // --- Non-destructive writes (6) -----------------------------------------

  server.tool(
    'add_mercury_panel',
    `WRITE: Creates a new Mercury panel (wraps NBAPI AddMercuryPanel). Returns the new MERCURYKEY. ${NOT_LIVE_VERIFIED}`,
    {
      NAME: z.string().describe('Required. Mercury panel name; must be unique across all partitions.'),
      TYPE: MERCURY_TYPE_ENUM.describe('Required. Mercury panel type. Values are not case sensitive but must be one of the documented types.'),
      ENABLED: BOOLEAN_ENUM.describe('Required. "TRUE" to enable the panel, "FALSE" to leave it disabled.'),
      PARTITIONKEY: z.string().describe('Required. Key of the partition the panel belongs to.'),
      NETWORK: networkBlockSchema,
      TIMEZONE: z
        .string()
        .optional()
        .describe('Optional. Panel time zone, e.g. "America/New_York" (the controller default). Valid values come from Configuration : Time : Network Controller.'),
      SIOCHANNELSETTINGS: sioChannelSettingsSchema,
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_MERCURY_PANEL, mergeParams(args), formatWriteSuccess)
  );

  server.tool(
    'modify_mercury_panel',
    'WRITE: Modifies an existing Mercury panel (wraps NBAPI ModifyMercuryPanel). TYPE and PARTITIONKEY are documented ' +
      'as unchangeable during an update — they are accepted (and optional) here only so the full record can be resent ' +
      `unchanged. ${NOT_LIVE_VERIFIED}`,
    {
      MERCURYKEY: z
        .string()
        .describe(
          'Required. The key of the Mercury panel to modify. (The v2 guide omits it from the bullet list but sends it in the worked example.)'
        ),
      NAME: z.string().describe('Required. Mercury panel name; must be unique across all partitions.'),
      ENABLED: BOOLEAN_ENUM.describe('Required. "TRUE" to enable the panel, "FALSE" to disable it.'),
      NETWORK: networkBlockSchema,
      TYPE: MERCURY_TYPE_ENUM.optional().describe('Optional. Documented as unchangeable during an update; resend the existing value or omit it.'),
      PARTITIONKEY: z.string().optional().describe('Optional. Documented as unchangeable during an update; resend the existing value or omit it.'),
      TIMEZONE: z.string().optional().describe('Optional. Panel time zone, e.g. "America/New_York".'),
      SIOCHANNELSETTINGS: sioChannelSettingsSchema,
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.MODIFY_MERCURY_PANEL, mergeParams(args), formatWriteSuccess)
  );

  server.tool(
    'add_network_node',
    `WRITE: Creates a new network node (wraps NBAPI AddNetworkNode). Returns the new NODEKEY. ${NOT_LIVE_VERIFIED}`,
    {
      NAME: z.string().describe('Required. Network node name; must be unique across all partitions.'),
      TYPE: NETWORK_NODE_TYPE_ENUM.describe('Required. Network node type. These values are case sensitive.'),
      ENABLED: BOOLEAN_ENUM.describe('Required. "TRUE" to enable the node, "FALSE" to leave it disabled.'),
      PARTITIONKEY: z.string().describe('Required. Key of the partition the node belongs to.'),
      UNIQUEIDENTIFIER: z.string().describe('Required. The 16-digit hexadecimal unique identifier of the network node.'),
      DHCPENABLED: BOOLEAN_ENUM.describe('Required. "TRUE" for DHCP; with "FALSE", supply IPADDRESS/NETMASK/GATEWAY.'),
      TIMEZONE: z.string().optional().describe('Optional. Node time zone, e.g. "America/New_York" (the controller default).'),
      REALTIMEDISKPOLICYENABLED: BOOLEAN_ENUM.optional().describe('Optional. Real-time disk policy; applies to M1-3200, MicroNode Plus and NanoNode.'),
      IPADDRESS: z.string().optional().describe('Optional. IP address of the node. Required in practice when DHCPENABLED is "FALSE".'),
      NETMASK: z.string().optional().describe('Optional. Network mask. Used when DHCPENABLED is "FALSE".'),
      GATEWAY: z.string().optional().describe('Optional. Default gateway. Used when DHCPENABLED is "FALSE".'),
      CONFIGLOCKEDENABLED: BOOLEAN_ENUM.optional().describe('Optional. Locks the node configuration. Applies to Node and MicroNode types only.'),
      AUTODISCOVERENABLED: BOOLEAN_ENUM.optional().describe('Optional. Allows network controller auto-discovery. Applies to Node and MicroNode types only.'),
      NETWORKCONTROLLERIPADDRESS: z.string().optional().describe('Optional. NetBox network controller IP address. Not applicable when AUTODISCOVERENABLED is "TRUE".'),
      SECONDARYCONTROLLERIPADDRESS: z.string().optional().describe('Optional. Secondary NetBox controller IP address.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_NETWORK_NODE, mergeParams(args), formatWriteSuccess)
  );

  server.tool(
    'modify_network_node',
    'WRITE: Modifies an existing network node (wraps NBAPI ModifyNetworkNode). UNIQUEIDENTIFIER, TYPE and ' +
      'PARTITIONKEY are not documented as modifiable and are therefore not exposed here — every other AddNetworkNode ' +
      `field is optional. ${NOT_LIVE_VERIFIED}`,
    {
      NODEKEY: z
        .string()
        .describe('Required. The key of the network node to modify. Use get_network_nodes to discover keys.'),
      NAME: z.string().optional().describe('Optional. New network node name; must stay unique across all partitions.'),
      ENABLED: BOOLEAN_ENUM.optional().describe('Optional. "TRUE" to enable the node, "FALSE" to disable it.'),
      TIMEZONE: z.string().optional().describe('Optional. Node time zone, e.g. "America/New_York".'),
      REALTIMEDISKPOLICYENABLED: BOOLEAN_ENUM.optional().describe('Optional. Real-time disk policy; applies to M1-3200, MicroNode Plus and NanoNode.'),
      DHCPENABLED: BOOLEAN_ENUM.optional().describe('Optional. "TRUE" for DHCP; with "FALSE", supply IPADDRESS/NETMASK/GATEWAY.'),
      IPADDRESS: z.string().optional().describe('Optional. IP address of the node.'),
      NETMASK: z.string().optional().describe('Optional. Network mask.'),
      GATEWAY: z.string().optional().describe('Optional. Default gateway.'),
      CONFIGLOCKEDENABLED: BOOLEAN_ENUM.optional().describe('Optional. Locks the node configuration. Applies to Node and MicroNode types only.'),
      AUTODISCOVERENABLED: BOOLEAN_ENUM.optional().describe('Optional. Allows network controller auto-discovery. Applies to Node and MicroNode types only.'),
      NETWORKCONTROLLERIPADDRESS: z.string().optional().describe('Optional. NetBox network controller IP address. Not applicable when AUTODISCOVERENABLED is "TRUE".'),
      SECONDARYCONTROLLERIPADDRESS: z.string().optional().describe('Optional. Secondary NetBox controller IP address.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.MODIFY_NETWORK_NODE, mergeParams(args), formatWriteSuccess)
  );

  server.tool(
    'add_sio',
    'WRITE: Adds an SIO (serial I/O board) to a Mercury panel (wraps NBAPI AddSio). Valid MODEL/CHANNEL combinations ' +
      `depend on the panel's TYPE — see the "Mercury TYPE with MODEL supported" table in the v2 guide. ${NOT_LIVE_VERIFIED}`,
    {
      MERCURYKEY: z.string().describe('Required. Key of the Mercury panel the SIO is attached to.'),
      NAME: z.string().describe('Required. Name for the SIO.'),
      MODEL: z.string().describe('Required. SIO model, valid for the parent panel\'s TYPE (e.g. "MS-ICS", "Aperio AH40", "Dormakaba WQXM-PG").'),
      CHANNEL: z.string().describe("Required. Channel for the SIO, valid for the parent panel's TYPE and the chosen MODEL."),
      ADDRESS: z.string().describe('Required. SIO address; the allowed range is 0 to 31.'),
      REVINPUT: BOOLEAN_ENUM.describe('Required. "TRUE" to enable reverse input processing, "FALSE" otherwise.'),
      IPADDRESS: z.string().optional().describe('Optional overall, but required for MODEL "Aperio AH40".'),
      HOSTNAME: z.string().optional().describe('Optional. Applies to MODEL "Dormakaba WQXM-PG".'),
      USERNAME: z.string().optional().describe('Optional. Applies to MODEL "Dormakaba WQXM-PG"; a 3-character username.'),
      PASSWORD: z.string().optional().describe('Optional. Applies to MODEL "Dormakaba WQXM-PG".'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_SIO, mergeParams(args), formatWriteSuccess)
  );

  server.tool(
    'modify_sio',
    'WRITE: Modifies an existing SIO (wraps NBAPI ModifySio). MODEL is documented as unchangeable ("You cannot change ' +
      `the model type") and is therefore not exposed here. ${NOT_LIVE_VERIFIED}`,
    {
      SIOKEY: z.string().describe('Required. The key of the SIO to modify. Use get_sios to discover keys.'),
      NAME: z.string().describe('Required. Name for the SIO; the controller rejects the call when it is absent or blank.'),
      REVINPUT: BOOLEAN_ENUM.describe('Required. "TRUE" to enable reverse input processing, "FALSE" otherwise. The controller rejects the call when it is absent.'),
      CHANNEL: z.string().optional().describe("Optional. Channel for the SIO, valid for the parent panel's TYPE and the SIO's MODEL."),
      ADDRESS: z.string().optional().describe('Optional. SIO address; the allowed range is 0 to 31.'),
      IPADDRESS: z.string().optional().describe('Optional overall, but required for MODEL "Aperio AH40".'),
      HOSTNAME: z.string().optional().describe('Optional. Host name for the SIO.'),
      USERNAME: z.string().optional().describe('Optional. Username for the SIO.'),
      PASSWORD: z.string().optional().describe('Optional. Password for the SIO.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.MODIFY_SIO, mergeParams(args), formatWriteSuccess)
  );

  if (!gate.destructiveEnabled) return;

  // --- Destructive (3) -----------------------------------------------------

  server.tool(
    'delete_mercury_panel',
    'DESTRUCTIVE: Deletes a Mercury panel and everything attached to it (wraps NBAPI DeleteMercuryPanel). ' +
      `Requires NETBOX_ENABLE_DESTRUCTIVE. ${NOT_LIVE_VERIFIED}`,
    { MERCURYKEY: z.string().describe('Required. The key of the Mercury panel to delete.') },
    async ({ MERCURYKEY }) => runNbapiTool(client, NBAPI_COMMANDS.DELETE_MERCURY_PANEL, { MERCURYKEY }, formatWriteSuccess)
  );

  server.tool(
    'delete_network_node',
    'DESTRUCTIVE: Deletes a network node (wraps NBAPI DeleteNetworkNode). Requires NETBOX_ENABLE_DESTRUCTIVE. ' +
      `${NOT_LIVE_VERIFIED}`,
    { NODEKEY: z.string().describe('Required. The key of the network node to delete.') },
    async ({ NODEKEY }) => runNbapiTool(client, NBAPI_COMMANDS.DELETE_NETWORK_NODE, { NODEKEY }, formatWriteSuccess)
  );

  server.tool(
    'delete_sio',
    'DESTRUCTIVE: Deletes an SIO (wraps NBAPI DeleteSio). Requires NETBOX_ENABLE_DESTRUCTIVE. ' +
      "Note: the v2 guide's worked example for DeleteSio sends NODEKEY, but its Calling Parameters list — which the " +
      `guide makes authoritative — specifies SIOKEY, so SIOKEY is what this tool sends. ${NOT_LIVE_VERIFIED}`,
    { SIOKEY: z.string().describe('Required. The key of the SIO to delete.') },
    async ({ SIOKEY }) => runNbapiTool(client, NBAPI_COMMANDS.DELETE_SIO, { SIOKEY }, formatWriteSuccess)
  );
}
