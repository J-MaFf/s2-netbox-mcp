import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTimeSpecTools } from '../src/tools/timeSpec.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerTimeSpecTools (R8 reads)', () => {
  it('registers exactly the four read tools when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_time_spec', 'get_time_specs', 'get_time_spec_group', 'get_time_spec_groups'].sort()
    );
  });

  it('get_time_spec requires TIMESPECKEY and calls GetTimeSpec', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec');
    expect(Object.keys(reg.schema)).toEqual(['TIMESPECKEY']);
    await reg.handler({ TIMESPECKEY: '1' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_TIME_SPEC, params: { TIMESPECKEY: '1' } }]);
  });

  it('get_time_specs takes only STARTFROMKEY', async () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_time_specs').schema)).toEqual(['STARTFROMKEY']);
  });

  it('get_time_spec_group requires TIMESPECGROUPKEY', async () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_time_spec_group').schema)).toEqual(['TIMESPECGROUPKEY']);
  });

  it('get_time_spec_groups takes only STARTFROMKEY', async () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_time_spec_groups').schema)).toEqual(['STARTFROMKEY']);
  });
});

describe('R11: time spec write tools', () => {
  it('add_time_spec requires NAME and exposes the documented optionals including MONDAY-SUNDAY and HOLIDAYGROUPS', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    const keys = Object.keys(byName(server, 'add_time_spec').schema);
    expect(keys.sort()).toEqual(
      [
        'NAME',
        'DESCRIPTION',
        'STARTTIME',
        'ENDTIME',
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
        'SATURDAY',
        'SUNDAY',
        'HOLIDAYGROUPS',
      ].sort()
    );
  });

  it('add_time_spec calls AddTimeSpec with the flat PARAMS map', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    await byName(server, 'add_time_spec').handler({ NAME: 'Daytime', STARTTIME: '09:00', ENDTIME: '17:00', MONDAY: '1' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.ADD_TIME_SPEC, params: { NAME: 'Daytime', STARTTIME: '09:00', ENDTIME: '17:00', MONDAY: '1' } },
    ]);
  });

  it('modify_time_spec requires TIMESPECKEY instead of NAME', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    const keys = Object.keys(byName(server, 'modify_time_spec').schema);
    expect(keys).toContain('TIMESPECKEY');
    expect(keys).not.toContain('NAME');
  });

  it('add_time_spec_group requires NAME, DESCRIPTION optional', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    expect(Object.keys(byName(server, 'add_time_spec_group').schema).sort()).toEqual(['NAME', 'DESCRIPTION'].sort());
  });

  it('modify_time_spec_group wraps TIMESPECKEYS as <TIMESPECKEYS><TIMESPECKEY>...', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'modify_time_spec_group');
    expect(Object.keys(reg.schema).sort()).toEqual(['TIMESPECGROUPKEY', 'NAME', 'DESCRIPTION', 'TIMESPECKEYS'].sort());
    await reg.handler({ TIMESPECGROUPKEY: '5', TIMESPECKEYS: ['1', '2'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP,
        params: { TIMESPECGROUPKEY: '5', TIMESPECKEYS: { TIMESPECKEY: ['1', '2'] } },
      },
    ]);
  });

  it('delete_time_spec / delete_time_spec_group are destructive-only', () => {
    const partial = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_time_spec');
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_time_spec_group');

    const full = new FakeServer();
    registerTimeSpecTools(full as unknown as McpServer, client, WRITES_ON);
    expect(byName(full, 'delete_time_spec').description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(byName(full, 'delete_time_spec').schema)).toEqual(['TIMESPECKEY']);
    expect(byName(full, 'delete_time_spec_group').description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(byName(full, 'delete_time_spec_group').schema)).toEqual(['TIMESPECGROUPKEY']);
  });
});
