import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPortalGroupTools } from '../src/tools/portalGroup.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerPortalGroupTools (R8 reads)', () => {
  it('registers exactly get_portal_group and get_portal_groups when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(['get_portal_group', 'get_portal_groups'].sort());
  });

  it('get_portal_group requires PORTALGROUPKEY', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_portal_group');
    expect(Object.keys(reg.schema)).toEqual(['PORTALGROUPKEY']);
    await reg.handler({ PORTALGROUPKEY: '26' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTAL_GROUP, params: { PORTALGROUPKEY: '26' } }]);
  });

  it('get_portal_groups takes only STARTFROMKEY', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_portal_groups').schema)).toEqual(['STARTFROMKEY']);
  });
});

describe('R13: portal group write tools', () => {
  it('add_portal_group requires NAME + PORTALKEYS and wraps PORTALKEYS as <PORTALKEYS><PORTALKEY>...', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'add_portal_group');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['NAME', 'DESCRIPTION', 'UNLOCKTIMESPECGROUPKEY', 'THREATLEVELGROUPKEY', 'PORTALKEYS'].sort()
    );
    await reg.handler({ NAME: 'LAB ALL ACCESS', PORTALKEYS: ['30', '32'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.ADD_PORTAL_GROUP,
        params: { NAME: 'LAB ALL ACCESS', PORTALKEYS: { PORTALKEY: ['30', '32'] } },
      },
    ]);
  });

  it('modify_portal_group sends PORTALKEYS as repeated top-level PORTALKEY siblings, not wrapped', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'modify_portal_group');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['PORTALGROUPKEY', 'PORTALKEYS', 'NAME', 'DESCRIPTION', 'UNLOCKTIMESPECGROUPKEY', 'THREATLEVELGROUPKEY'].sort()
    );
    await reg.handler({ PORTALGROUPKEY: '56', PORTALKEYS: ['1', '2'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.MODIFY_PORTAL_GROUP,
        params: { PORTALGROUPKEY: '56', PORTALKEY: ['1', '2'] },
      },
    ]);
  });

  it('delete_portal_group is destructive-only', () => {
    const partial = new FakeServer();
    const { client } = fakeClient();
    registerPortalGroupTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_portal_group');

    const full = new FakeServer();
    registerPortalGroupTools(full as unknown as McpServer, client, WRITES_ON);
    const reg = byName(full, 'delete_portal_group');
    expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(reg.schema)).toEqual(['PORTALGROUPKEY']);
  });
});
