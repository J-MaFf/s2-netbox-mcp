import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMiscTools } from '../src/tools/misc.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

describe('registerMiscTools (R8 reads: GetElevators, GetFloors, PingApp)', () => {
  it('registers exactly get_elevators, get_floors, ping_app', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerMiscTools(server as unknown as McpServer, client);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(['get_elevators', 'get_floors', 'ping_app'].sort());
  });

  it('get_elevators takes only STARTFROMKEY and calls GetElevators', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerMiscTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_elevators');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ELEVATORS, params: {} }]);
  });

  it('get_floors takes only STARTFROMKEY and calls GetFloors', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerMiscTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_floors');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_FLOORS, params: {} }]);
  });

  it('ping_app takes no parameters and calls PingApp', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerMiscTools(server as unknown as McpServer, client);
    const reg = byName(server, 'ping_app');
    expect(Object.keys(reg.schema)).toEqual([]);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.PING_APP, params: {} }]);
  });
});
