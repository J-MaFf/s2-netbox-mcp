import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerThreatLevelTools } from '../src/tools/threatLevel.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerThreatLevelTools (R18)', () => {
  it('registers only get_threat_levels when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name)).toEqual(['get_threat_levels']);
  });

  it('get_threat_levels takes an optional ALLPARTITIONS filter and calls GetThreatLevels', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_threat_levels');
    expect(Object.keys(reg.schema)).toEqual(['ALLPARTITIONS']);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_THREAT_LEVELS, params: {} }]);
  });

  it('registers get_threat_levels plus the five non-destructive write tools when writes are on and destructive is off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      [
        'get_threat_levels',
        'set_threat_level',
        'add_threat_level',
        'modify_threat_level',
        'add_threat_level_group',
        'modify_threat_level_group',
      ].sort()
    );
  });

  it('registers get_threat_levels plus all seven write tools (plus the two destructive removes) when both flags are on', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_ON);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      [
        'get_threat_levels',
        'set_threat_level',
        'add_threat_level',
        'modify_threat_level',
        'remove_threat_level',
        'add_threat_level_group',
        'modify_threat_level_group',
        'remove_threat_level_group',
      ].sort()
    );
  });

  it('set_threat_level requires LEVELNAME, takes an optional LOCATIONKEYS, and calls SetThreatLevel', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'set_threat_level');
    expect(Object.keys(reg.schema).sort()).toEqual(['LEVELNAME', 'LOCATIONKEYS'].sort());
    await reg.handler({ LEVELNAME: 'High' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.SET_THREAT_LEVEL, params: { LEVELNAME: 'High' } }]);
    await reg.handler({ LEVELNAME: 'High', LOCATIONKEYS: '3,7' });
    expect(calls[1]).toEqual({ command: NBAPI_COMMANDS.SET_THREAT_LEVEL, params: { LEVELNAME: 'High', LOCATIONKEYS: '3,7' } });
  });

  it('add_threat_level exposes LEVELNAME/SEQNUM/COLOR with COLOR as a closed enum', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'add_threat_level');
    expect(Object.keys(reg.schema).sort()).toEqual(['LEVELNAME', 'SEQNUM', 'COLOR'].sort());
    await reg.handler({ LEVELNAME: 'High', COLOR: 'Red' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.ADD_THREAT_LEVEL, params: { LEVELNAME: 'High', COLOR: 'Red' } }]);
  });

  it('add_threat_level_group wraps optional LEVELNAMES as <LEVELNAMES><LEVELNAME>...', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'add_threat_level_group');
    expect(Object.keys(reg.schema).sort()).toEqual(['LEVELGROUPNAME', 'LEVELNAMES'].sort());
    await reg.handler({ LEVELGROUPNAME: 'Elevated', LEVELNAMES: ['High', 'Severe'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.ADD_THREAT_LEVEL_GROUP,
        params: { LEVELGROUPNAME: 'Elevated', LEVELNAMES: { LEVELNAME: ['High', 'Severe'] } },
      },
    ]);
  });

  it('modify_threat_level exposes LEVELNAME/SEQNUM/COLOR, with SEQNUM and COLOR both required (unlike add_threat_level)', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'modify_threat_level');
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    expect(Object.keys(schema).sort()).toEqual(['LEVELNAME', 'SEQNUM', 'COLOR'].sort());
    expect(schema.SEQNUM.isOptional()).toBe(false);
    expect(schema.COLOR.isOptional()).toBe(false);
    await reg.handler({ LEVELNAME: 'High', SEQNUM: '7', COLOR: 'Red' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.MODIFY_THREAT_LEVEL, params: { LEVELNAME: 'High', SEQNUM: '7', COLOR: 'Red' } },
    ]);
  });

  it('modify_threat_level_group requires LEVELNAMES (not optional)', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_ON);
    expect(Object.keys(byName(server, 'modify_threat_level_group').schema).sort()).toEqual(
      ['LEVELGROUPNAME', 'LEVELNAMES'].sort()
    );
  });

  it('remove_threat_level / remove_threat_level_group are destructive, each keyed by exactly one field', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerThreatLevelTools(server as unknown as McpServer, client, WRITES_ON);
    const removeLevel = byName(server, 'remove_threat_level');
    expect(removeLevel.description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(removeLevel.schema)).toEqual(['LEVELNAME']);
    const removeGroup = byName(server, 'remove_threat_level_group');
    expect(removeGroup.description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(removeGroup.schema)).toEqual(['LEVELGROUPNAME']);
  });
});
