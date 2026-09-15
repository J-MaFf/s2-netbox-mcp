import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams, formatWriteSuccess, wrapList, type ToolGateFlags } from '../toolHelpers.js';

/**
 * Reader group tools: the R8 read tools (GetReaderGroup(s)) plus the R14
 * write tools (AddReaderGroup, ModifyReaderGroup, DeleteReaderGroup). Field
 * names are copied verbatim from the spec's Command reference.
 */
export function registerReaderGroupTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_reader_group',
    'Returns the details of a single reader group for a given READERGROUPKEY (wraps NBAPI GetReaderGroup).',
    { READERGROUPKEY: z.string().describe('Required. The unique READERGROUPKEY of the reader group to retrieve.') },
    async ({ READERGROUPKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READER_GROUP, { READERGROUPKEY })
  );

  server.tool(
    'get_reader_groups',
    'Lists reader groups configured on the NetBox system (wraps NBAPI GetReaderGroups).',
    { STARTFROMKEY: z.string().optional().describe('Optional. Pagination cursor to continue listing from a previous call.') },
    async ({ STARTFROMKEY }) => runNbapiTool(client, NBAPI_COMMANDS.GET_READER_GROUPS, mergeParams({ STARTFROMKEY }))
  );

  if (gate.writesEnabled) {
    server.tool(
      'add_reader_group',
      'WRITE: Creates a new reader group (wraps NBAPI AddReaderGroup).',
      {
        NAME: z.string().describe('Required. Name of the new reader group.'),
        DESCRIPTION: z.string().optional().describe('Optional. Description of the reader group.'),
        READERKEYS: z.array(z.string()).describe('Required. READERKEY values of the readers in this group.'),
      },
      async ({ READERKEYS, ...rest }) =>
        runNbapiTool(
          client,
          NBAPI_COMMANDS.ADD_READER_GROUP,
          mergeParams({ ...rest, ...wrapList('READERKEYS', 'READERKEY', READERKEYS) }),
          formatWriteSuccess
        )
    );

    server.tool(
      'modify_reader_group',
      'WRITE: Modifies an existing reader group (wraps NBAPI ModifyReaderGroup). READERKEYS is the complete desired membership — omitting it clears the group’s membership on this controller (live, 2026-09-15), so it is required and must carry the complete membership.',
      {
        READERGROUPKEY: z.string().describe('Required. The READERGROUPKEY of the reader group to modify.'),
        NAME: z.string().optional().describe('Optional. New name for the reader group.'),
        DESCRIPTION: z.string().optional().describe('Optional. New description for the reader group.'),
        READERKEYS: z.array(z.string()).describe('Required. Complete replacement list of member READERKEY values.'),
      },
      async ({ READERGROUPKEY, NAME, DESCRIPTION, READERKEYS }) =>
        runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_READER_GROUP,
          mergeParams({ READERGROUPKEY, NAME, DESCRIPTION, ...wrapList('READERKEYS', 'READERKEY', READERKEYS) }),
          formatWriteSuccess
        )
    );

    if (gate.destructiveEnabled) {
      server.tool(
        'delete_reader_group',
        'DESTRUCTIVE: Deletes a reader group (wraps NBAPI DeleteReaderGroup). Requires NETBOX_ENABLE_DESTRUCTIVE. Fails if the group is still referenced by an access level.',
        { READERGROUPKEY: z.string().describe('Required. The READERGROUPKEY of the reader group to delete.') },
        async ({ READERGROUPKEY }) =>
          runNbapiTool(client, NBAPI_COMMANDS.DELETE_READER_GROUP, { READERGROUPKEY }, formatWriteSuccess)
      );
    }
  }
}
