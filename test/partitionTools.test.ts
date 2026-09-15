import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPartitionTools } from '../src/tools/partition.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerPartitionTools (R8 reads)', () => {
  it('registers exactly the three read tools when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPartitionTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_partitions', 'get_udf_lists', 'get_udf_list_items'].sort()
    );
  });

  it('get_partitions and get_udf_lists take no parameters', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPartitionTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_partitions').schema)).toEqual([]);
    expect(Object.keys(byName(server, 'get_udf_lists').schema)).toEqual([]);
  });

  it('get_udf_list_items requires UDFLISTKEY', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPartitionTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_udf_list_items');
    expect(Object.keys(reg.schema)).toEqual(['UDFLISTKEY']);
    await reg.handler({ UDFLISTKEY: '1' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_UDF_LIST_ITEMS, params: { UDFLISTKEY: '1' } }]);
  });
});

describe('R20: partition / UDF list write tools', () => {
  it('add_partition requires NAME + TIMEZONE, DESCRIPTION optional', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPartitionTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'add_partition');
    expect(Object.keys(reg.schema).sort()).toEqual(['NAME', 'TIMEZONE', 'DESCRIPTION'].sort());
    await reg.handler({ NAME: 'East Campus', TIMEZONE: 'America/New_York' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.ADD_PARTITION, params: { NAME: 'East Campus', TIMEZONE: 'America/New_York' } },
    ]);
  });

  it('switch_partition requires only PARTITIONKEY and describes the process-wide effect', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPartitionTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'switch_partition');
    expect(Object.keys(reg.schema)).toEqual(['PARTITIONKEY']);
    expect(reg.description).toContain('every later call');
    await reg.handler({ PARTITIONKEY: '2' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.SWITCH_PARTITION, params: { PARTITIONKEY: '2' } }]);
  });

  describe('modify_udf_list_items', () => {
    it('requires UDFLISTKEY + LISTITEMS and wraps LISTITEMS as <LISTITEMS><LISTITEM>...', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPartitionTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'modify_udf_list_items');
      expect(Object.keys(reg.schema).sort()).toEqual(['UDFLISTKEY', 'LISTITEMS'].sort());
      await reg.handler({
        UDFLISTKEY: '3',
        LISTITEMS: [
          { ITEMKEY: '1', DELETE: '1' },
          { DELETE: '0', ITEMNAME: 'X', CUSTOMKEY: '_3' },
        ],
      });
      expect(calls).toEqual([
        {
          command: NBAPI_COMMANDS.MODIFY_UDF_LIST_ITEMS,
          params: {
            UDFLISTKEY: '3',
            LISTITEMS: {
              LISTITEM: [
                { ITEMKEY: '1', DELETE: '1' },
                { DELETE: '0', ITEMNAME: 'X', CUSTOMKEY: '_3' },
              ],
            },
          },
        },
      ]);
    });

    it('rejects 0 items and more than 10 items without calling the client', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPartitionTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'modify_udf_list_items');

      const empty = await reg.handler({ UDFLISTKEY: '3', LISTITEMS: [] });
      expect(empty.isError).toBe(true);

      const tooMany = await reg.handler({
        UDFLISTKEY: '3',
        LISTITEMS: Array.from({ length: 11 }, (_, i) => ({ ITEMKEY: String(i), DELETE: '0' as const })),
      });
      expect(tooMany.isError).toBe(true);
      expect(calls).toEqual([]);
    });

    it('R2: refuses a DELETE="1" item without NETBOX_ENABLE_DESTRUCTIVE, naming the flag and sending nothing', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPartitionTools(server as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
      const reg = byName(server, 'modify_udf_list_items');
      const result = await reg.handler({ UDFLISTKEY: '3', LISTITEMS: [{ ITEMKEY: '1', DELETE: '1' }] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('NETBOX_ENABLE_DESTRUCTIVE');
      expect(calls).toEqual([]);
    });

    it('allows a DELETE="1" item when NETBOX_ENABLE_DESTRUCTIVE is on', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPartitionTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'modify_udf_list_items');
      const result = await reg.handler({ UDFLISTKEY: '3', LISTITEMS: [{ ITEMKEY: '1', DELETE: '1' }] });
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
    });
  });
});
