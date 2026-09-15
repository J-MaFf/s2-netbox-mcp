import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import {
  runNbapiTool,
  mergeParams,
  formatWriteSuccess,
  clientGuardError,
  destructiveFlagRequired,
  wrapList,
  type ToolGateFlags,
} from '../toolHelpers.js';

const listItemSchema = z.object({
  ITEMKEY: z.string().optional().describe('Optional. Existing list item key to modify.'),
  ITEMNAME: z.string().optional().describe('Optional. Display name for the list item.'),
  DELETE: z.enum(['0', '1']).describe('Required. "1" to delete this list item, "0" to add/update it.'),
  CUSTOMKEY: z.string().optional().describe('Optional. Custom key for the list item.'),
});

/**
 * Partition and UDF list tools: the R8 read tools (GetPartitions,
 * GetUDFLists, GetUDFListItems) plus the R20 write tools (AddPartition,
 * SwitchPartition, ModifyUDFListItems). Field names are copied verbatim
 * from the spec's Command reference.
 */
export function registerPartitionTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_partitions',
    'Lists partitions configured on the NetBox system (wraps NBAPI GetPartitions). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_PARTITIONS, {})
  );

  server.tool(
    'get_udf_lists',
    'Lists user-defined field (UDF) lists configured on the NetBox system (wraps NBAPI GetUDFLists). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_UDF_LISTS, {})
  );

  server.tool(
    'get_udf_list_items',
    'Returns the items of a single UDF list for a given UDFLISTKEY (wraps NBAPI GetUDFListItems).',
    { UDFLISTKEY: z.string().describe('Required. The unique UDFLISTKEY of the UDF list to retrieve.') },
    async ({ UDFLISTKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_UDF_LIST_ITEMS, { UDFLISTKEY })
  );

  if (gate.writesEnabled) {
    server.tool(
      'add_partition',
      'WRITE: Creates a new partition (wraps NBAPI AddPartition). Requires full system setup privilege on the NetBox operator account.',
      {
        NAME: z.string().describe('Required. Name of the new partition.'),
        TIMEZONE: z.string().describe('Required. Timezone for the new partition.'),
        DESCRIPTION: z.string().optional().describe('Optional. Description of the partition.'),
      },
      async (args) => runNbapiTool(client, NBAPI_COMMANDS.ADD_PARTITION, mergeParams(args), formatWriteSuccess)
    );

    server.tool(
      'switch_partition',
      'WRITE: Switches the active partition for the current NBAPI session (wraps NBAPI SwitchPartition). ' +
        'Because the session is cached and reused, this affects every later call made by this server process, ' +
        'not just the caller’s next request.',
      { PARTITIONKEY: z.string().describe('Required. The PARTITIONKEY to switch to.') },
      async ({ PARTITIONKEY }) =>
        runNbapiTool(client, NBAPI_COMMANDS.SWITCH_PARTITION, { PARTITIONKEY }, formatWriteSuccess)
    );

    server.tool(
      'modify_udf_list_items',
      'WRITE: Adds, updates, or deletes items in a UDF list (wraps NBAPI ModifyUDFListItems). 1-10 items per call, ' +
        'applied all-or-nothing by the controller. Any item with DELETE="1" requires NETBOX_ENABLE_DESTRUCTIVE.',
      {
        UDFLISTKEY: z.string().describe('Required. The UDFLISTKEY of the UDF list to modify.'),
        LISTITEMS: z.array(listItemSchema).describe('Required. 1-10 list items to add, update, or delete.'),
      },
      async ({ UDFLISTKEY, LISTITEMS }) => {
        if (LISTITEMS.length < 1 || LISTITEMS.length > 10) {
          return clientGuardError('modify_udf_list_items accepts 1-10 LISTITEMS per call.');
        }
        if (!gate.destructiveEnabled && LISTITEMS.some((item) => item.DELETE === '1')) {
          return destructiveFlagRequired('modify_udf_list_items with a LISTITEMS entry whose DELETE is "1"');
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_UDF_LIST_ITEMS,
          mergeParams({ UDFLISTKEY, ...wrapList('LISTITEMS', 'LISTITEM', LISTITEMS) }),
          formatWriteSuccess
        );
      }
    );
  }
}
