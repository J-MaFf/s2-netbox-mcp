import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReaderGroupTools } from '../src/tools/readerGroup.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerReaderGroupTools (R8 reads)', () => {
  it('registers exactly get_reader_group and get_reader_groups when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerReaderGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(['get_reader_group', 'get_reader_groups'].sort());
  });

  it('get_reader_group requires READERGROUPKEY', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerReaderGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_reader_group');
    expect(Object.keys(reg.schema)).toEqual(['READERGROUPKEY']);
    await reg.handler({ READERGROUPKEY: '5' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_READER_GROUP, params: { READERGROUPKEY: '5' } }]);
  });

  it('get_reader_groups takes only STARTFROMKEY', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerReaderGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_reader_groups').schema)).toEqual(['STARTFROMKEY']);
  });
});

describe('R14: reader group write tools', () => {
  it('add_reader_group requires NAME + READERKEYS and wraps READERKEYS as <READERKEYS><READERKEY>...', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerReaderGroupTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'add_reader_group');
    expect(Object.keys(reg.schema).sort()).toEqual(['NAME', 'DESCRIPTION', 'READERKEYS'].sort());
    await reg.handler({ NAME: 'Front Doors', READERKEYS: ['1', '4'] });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.ADD_READER_GROUP, params: { NAME: 'Front Doors', READERKEYS: { READERKEY: ['1', '4'] } } },
    ]);
  });

  it('modify_reader_group makes READERKEYS optional and wraps it the same way', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerReaderGroupTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'modify_reader_group');
    expect(Object.keys(reg.schema).sort()).toEqual(['READERGROUPKEY', 'NAME', 'DESCRIPTION', 'READERKEYS'].sort());
    await reg.handler({ READERGROUPKEY: '5', READERKEYS: ['7'] });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.MODIFY_READER_GROUP, params: { READERGROUPKEY: '5', READERKEYS: { READERKEY: ['7'] } } },
    ]);
  });

  it('delete_reader_group is destructive-only', () => {
    const partial = new FakeServer();
    const { client } = fakeClient();
    registerReaderGroupTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_reader_group');

    const full = new FakeServer();
    registerReaderGroupTools(full as unknown as McpServer, client, WRITES_ON);
    const reg = byName(full, 'delete_reader_group');
    expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(reg.schema)).toEqual(['READERGROUPKEY']);
  });
});
