import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHolidayTools } from '../src/tools/holiday.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerHolidayTools (R8 reads)', () => {
  it('registers exactly get_holiday and get_holidays when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerHolidayTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(['get_holiday', 'get_holidays'].sort());
  });

  it('get_holiday requires HOLIDAYKEY and calls GetHoliday', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerHolidayTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_holiday');
    expect(Object.keys(reg.schema)).toEqual(['HOLIDAYKEY']);
    await reg.handler({ HOLIDAYKEY: '1' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_HOLIDAY, params: { HOLIDAYKEY: '1' } }]);
  });

  it('get_holidays takes only STARTFROMKEY', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerHolidayTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_holidays').schema)).toEqual(['STARTFROMKEY']);
  });
});

describe('R12: holiday write tools', () => {
  it('add_holiday requires HOLIDAYNAME/STARTDATE/ENDDATE, HOLIDAYGROUPS optional, and describes ENDDATE as exclusive', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerHolidayTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'add_holiday');
    expect(Object.keys(reg.schema).sort()).toEqual(['HOLIDAYNAME', 'STARTDATE', 'ENDDATE', 'HOLIDAYGROUPS'].sort());
    expect(reg.description).toContain('exclusive');
    expect(reg.description.startsWith('WRITE:')).toBe(true);
  });

  it('add_holiday calls AddHoliday with the flat PARAMS map', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerHolidayTools(server as unknown as McpServer, client, WRITES_ON);
    await byName(server, 'add_holiday').handler({ HOLIDAYNAME: 'GRAND OPENING', STARTDATE: '2026-09-11 00:00', ENDDATE: '2026-09-21 00:00' });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.ADD_HOLIDAY,
        params: { HOLIDAYNAME: 'GRAND OPENING', STARTDATE: '2026-09-11 00:00', ENDDATE: '2026-09-21 00:00' },
      },
    ]);
  });

  it('modify_holiday requires HOLIDAYKEY, everything else optional, and describes ENDDATE as exclusive', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerHolidayTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'modify_holiday');
    expect(Object.keys(reg.schema).sort()).toEqual(['HOLIDAYKEY', 'HOLIDAYNAME', 'HOLIDAYGROUPS', 'STARTDATE', 'ENDDATE'].sort());
    expect(reg.description).toContain('exclusive');
  });

  it('delete_holiday is destructive-only', () => {
    const partial = new FakeServer();
    const { client } = fakeClient();
    registerHolidayTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_holiday');

    const full = new FakeServer();
    registerHolidayTools(full as unknown as McpServer, client, WRITES_ON);
    const reg = byName(full, 'delete_holiday');
    expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(reg.schema)).toEqual(['HOLIDAYKEY']);
  });
});
