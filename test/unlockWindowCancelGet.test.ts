import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { cancelUnlockWindow, getUnlockWindow, scheduleUnlockWindow, type UnlockWindowSettings } from '../src/unlockWindow/executor.js';
import { registerUnlockWindowTools } from '../src/tools/unlockWindow.js';
import { FakeNetbox } from './fakeNetbox.js';
import { FakeServer, byName } from './testUtils.js';

const C = NBAPI_COMMANDS;
const NOW = new Date(2026, 8, 14, 12, 0);
const SETTINGS: UnlockWindowSettings = { holidayGroups: [8, 7, 6], namePrefix: 'P', now: () => NOW };
const WINDOW_A = { start: '2026-10-02 17:00', end: '2026-10-06 08:30' };

function freshController(): FakeNetbox {
  const fake = FakeNetbox.withBuiltins();
  fake.portals.push({ PORTALKEY: '1', NAME: '01OF01A' }, { PORTALKEY: '2', NAME: '02OF01A' }, { PORTALKEY: '3', NAME: '03OF01A' });
  return fake;
}

/** A controller with WINDOW_A scheduled on portals 1 and 2 (keys: TSG 101, holidays 102/104/106, specs 103/105/107, PG 108). */
async function populatedController(): Promise<FakeNetbox> {
  const fake = freshController();
  const result = await scheduleUnlockWindow(fake.client, { ...WINDOW_A, portalKeys: ['1', '2'] }, SETTINGS);
  expect('verified' in result && result.verified).toBe(true);
  fake.calls = [];
  return fake;
}

function tools(fake: FakeNetbox, settings: UnlockWindowSettings = SETTINGS): FakeServer {
  const server = new FakeServer();
  registerUnlockWindowTools(server as unknown as McpServer, fake.client, { writesEnabled: true, destructiveEnabled: false }, settings);
  return server;
}

describe('cancel_unlock_window (R26)', () => {
  it('issues exactly: reads, ModifyPortalGroup -> Never, DeleteHoliday per managed holiday, ModifyTimeSpecGroup([]), DeleteTimeSpec per managed spec', async () => {
    const fake = await populatedController();

    const result = await byName(tools(fake), 'cancel_unlock_window').handler({});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.startsWith('SUCCESS\n')).toBe(true);
    expect(fake.calls).toEqual([
      { command: C.GET_TIME_SPEC_GROUPS, params: {} },
      { command: C.GET_PORTAL_GROUPS, params: {} },
      { command: C.GET_PORTAL_GROUP, params: { PORTALGROUPKEY: '108' } },
      { command: C.GET_HOLIDAYS, params: {} },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '102' } },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '104' } },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '106' } },
      { command: C.GET_TIME_SPECS, params: {} },
      {
        command: C.MODIFY_PORTAL_GROUP,
        params: { PORTALGROUPKEY: '108', PORTALKEYS: { PORTALKEY: ['1', '2'] }, UNLOCKTIMESPECGROUPKEY: '2' },
      },
      { command: C.DELETE_HOLIDAY, params: { HOLIDAYKEY: '102' } },
      { command: C.DELETE_HOLIDAY, params: { HOLIDAYKEY: '104' } },
      { command: C.DELETE_HOLIDAY, params: { HOLIDAYKEY: '106' } },
      { command: C.MODIFY_TIME_SPEC_GROUP, params: { TIMESPECGROUPKEY: '101', TIMESPECKEYS: { TIMESPECKEY: [] } } },
      { command: C.DELETE_TIME_SPEC, params: { TIMESPECKEY: '103' } },
      { command: C.DELETE_TIME_SPEC, params: { TIMESPECKEY: '105' } },
      { command: C.DELETE_TIME_SPEC, params: { TIMESPECKEY: '107' } },
    ]);
    expect(fake.commands()).not.toContain(C.GET_TIME_SPEC_GROUP);

    const json = JSON.parse(result.content[0].text.slice('SUCCESS\n'.length));
    expect(json).toMatchObject({
      cancelled: true,
      portalGroup: { PORTALGROUPKEY: '108', NAME: 'P', portals: [{ PORTALKEY: '1', NAME: '01OF01A' }, { PORTALKEY: '2', NAME: '02OF01A' }] },
      unlockTimeSpecGroup: { TIMESPECGROUPKEY: '2', NAME: 'Never' },
      deletedHolidays: [
        { HOLIDAYKEY: '102', NAME: 'P first' },
        { HOLIDAYKEY: '104', NAME: 'P middle' },
        { HOLIDAYKEY: '106', NAME: 'P last' },
      ],
      timeSpecGroup: { TIMESPECGROUPKEY: '101', NAME: 'P', emptied: true },
      deletedTimeSpecs: [
        { TIMESPECKEY: '103', NAME: 'P first' },
        { TIMESPECKEY: '105', NAME: 'P middle' },
        { TIMESPECKEY: '107', NAME: 'P last' },
      ],
      leftBehind: [],
    });

    // Controller state: portal group on Never, no managed holiday, the managed groups kept for reuse.
    expect(fake.portalGroups).toEqual([
      expect.objectContaining({ PORTALGROUPKEY: '108', NAME: 'P', PORTALKEYS: ['1', '2'], UNLOCKTIMESPECGROUPKEY: '2' }),
    ]);
    expect(fake.holidays).toEqual([]);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never']);
    expect(fake.timeSpecGroups.find((group) => group.TIMESPECGROUPKEY === '101')).toEqual(
      expect.objectContaining({ NAME: 'P', TIMESPECKEYS: [] })
    );
  });

  it('tolerates the controller refusing to empty the group or delete the specs: still success, with leftBehind listing them', async () => {
    const fake = await populatedController();
    fake.refuse(C.MODIFY_TIME_SPEC_GROUP, 'Cannot modify group', (params) => params.TIMESPECGROUPKEY === '101');
    fake.refuse(C.DELETE_TIME_SPEC, 'Delete Failed: May be referenced elsewhere');

    const result = await byName(tools(fake), 'cancel_unlock_window').handler({});

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text.slice('SUCCESS\n'.length));
    expect(json.cancelled).toBe(true);
    expect(json.unlockTimeSpecGroup).toEqual({ TIMESPECGROUPKEY: '2', NAME: 'Never' });
    expect(json.deletedHolidays).toHaveLength(3);
    expect(json.timeSpecGroup).toEqual({ TIMESPECGROUPKEY: '101', NAME: 'P', emptied: false });
    expect(json.deletedTimeSpecs).toEqual([]);
    expect(json.leftBehind).toEqual([
      { type: 'timeSpecGroup', key: '101', NAME: 'P', error: 'NetBox NBAPI command failed: Cannot modify group' },
      { type: 'timeSpec', key: '103', NAME: 'P first', error: 'NetBox NBAPI command failed: Delete Failed: May be referenced elsewhere' },
      { type: 'timeSpec', key: '105', NAME: 'P middle', error: 'NetBox NBAPI command failed: Delete Failed: May be referenced elsewhere' },
      { type: 'timeSpec', key: '107', NAME: 'P last', error: 'NetBox NBAPI command failed: Delete Failed: May be referenced elsewhere' },
    ]);
    // It still attempted every one of them, in order.
    expect(fake.writeCalls().map((call) => call.command)).toEqual([
      C.MODIFY_PORTAL_GROUP,
      C.DELETE_HOLIDAY,
      C.DELETE_HOLIDAY,
      C.DELETE_HOLIDAY,
      C.MODIFY_TIME_SPEC_GROUP,
      C.DELETE_TIME_SPEC,
      C.DELETE_TIME_SPEC,
      C.DELETE_TIME_SPEC,
    ]);
    expect(fake.portalGroups[0].UNLOCKTIMESPECGROUPKEY).toBe('2');
    expect(fake.holidays).toEqual([]);
  });

  it('returns a normal (non-error) result saying there was nothing to cancel when no managed portal group exists, writing nothing', async () => {
    const fake = freshController();
    const result = await byName(tools(fake), 'cancel_unlock_window').handler({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Nothing to cancel');
    expect(JSON.parse(result.content[0].text.slice('SUCCESS\n'.length))).toMatchObject({ cancelled: false, deletedHolidays: [], leftBehind: [] });
    expect(fake.writeCalls()).toEqual([]);
  });

  it('fails clearly, before any write, when no time spec group named "Never" exists', async () => {
    const fake = await populatedController();
    fake.timeSpecGroups = fake.timeSpecGroups.filter((group) => group.NAME !== 'Never');
    const result = await byName(tools(fake), 'cancel_unlock_window').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no time spec group named "Never"');
    expect(fake.writeCalls()).toEqual([]);
  });

  it('a refused DeleteHoliday is NOT tolerated: isError naming the step', async () => {
    const fake = await populatedController();
    fake.refuse(C.DELETE_HOLIDAY, 'Permission denied', (params) => params.HOLIDAYKEY === '104');
    const result = await byName(tools(fake), 'cancel_unlock_window').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Step 3 .*"P middle".* failed: NetBox NBAPI command failed: Permission denied/);
    // The portal group had already been pointed at Never before the failure.
    expect(fake.portalGroups[0].UNLOCKTIMESPECGROUPKEY).toBe('2');
  });

  it('only ever deletes managed-named holidays and time specs (R27)', async () => {
    const fake = await populatedController();
    const otherHoliday = fake.seedHoliday({ NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-10-04 00:00', ENDDATE: '2026-10-05 00:00' });
    const otherSpec = fake.seedTimeSpec({ NAME: 'P-ish but not managed', HOLIDAYGROUPS: '8' });
    await cancelUnlockWindow(fake.client, SETTINGS);
    expect(fake.holidays.map((holiday) => holiday.HOLIDAYKEY)).toEqual([otherHoliday]);
    expect(fake.timeSpecs.map((spec) => spec.TIMESPECKEY)).toContain(otherSpec);
  });
});

describe('get_unlock_window (R26)', () => {
  it('is registered even with writes off and only issues Get commands', async () => {
    const fake = await populatedController();
    const server = new FakeServer();
    registerUnlockWindowTools(server as unknown as McpServer, fake.client, { writesEnabled: false, destructiveEnabled: false }, SETTINGS);
    const reg = byName(server, 'get_unlock_window');
    expect(Object.keys(reg.schema)).toEqual([]);
    const result = await reg.handler({});
    expect(result.isError).toBeUndefined();
    expect(fake.writeCalls()).toEqual([]);
    expect(fake.commands()).not.toContain(C.GET_TIME_SPEC_GROUP);
    expect(JSON.parse(result.content[0].text).configured).toBe(true);
  });

  it('on a populated controller reports the managed objects, the derived window, and activeNow against the host clock', async () => {
    const fake = await populatedController();
    const at = (date: Date) => getUnlockWindow(fake.client, { ...SETTINGS, now: () => date });

    const status = await at(new Date(2026, 9, 4, 12, 0)); // 2026-10-04 12:00, inside the middle segment
    expect(status).toMatchObject({
      prefix: 'P',
      configured: true,
      portalGroup: {
        PORTALGROUPKEY: '108',
        NAME: 'P',
        portals: [
          { PORTALKEY: '1', NAME: '01OF01A' },
          { PORTALKEY: '2', NAME: '02OF01A' },
        ],
        UNLOCKTIMESPECGROUPKEY: '101',
        unlockTimeSpecGroupName: 'P',
        pointsAtManagedTimeSpecGroup: true,
      },
      timeSpecGroup: { TIMESPECGROUPKEY: '101', NAME: 'P', TIMESPECKEYS: ['103', '105', '107'] },
      window: { start: '2026-10-02 17:00', end: '2026-10-06 08:30' },
      activeNow: true,
      checkedAt: '2026-10-04 12:00',
    });
    expect(status.timeSpecs).toEqual([
      { kind: 'first', TIMESPECKEY: '103', NAME: 'P first', STARTTIME: '17:00', ENDTIME: '23:59', HOLIDAYGROUPS: '8', inManagedGroup: true },
      { kind: 'middle', TIMESPECKEY: '105', NAME: 'P middle', STARTTIME: '00:00', ENDTIME: '23:59', HOLIDAYGROUPS: '7', inManagedGroup: true },
      { kind: 'last', TIMESPECKEY: '107', NAME: 'P last', STARTTIME: '00:00', ENDTIME: '08:30', HOLIDAYGROUPS: '6', inManagedGroup: true },
    ]);
    expect(status.holidays).toEqual([
      { kind: 'first', HOLIDAYKEY: '102', NAME: 'P first', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-03 00:00', HOLIDAYGROUPS: '8' },
      { kind: 'middle', HOLIDAYKEY: '104', NAME: 'P middle', STARTDATE: '2026-10-03 00:00', ENDDATE: '2026-10-06 00:00', HOLIDAYGROUPS: '7' },
      { kind: 'last', HOLIDAYKEY: '106', NAME: 'P last', STARTDATE: '2026-10-06 00:00', ENDDATE: '2026-10-07 00:00', HOLIDAYGROUPS: '6' },
    ]);

    expect((await at(new Date(2026, 9, 2, 16, 59))).activeNow).toBe(false); // before the first segment
    expect((await at(new Date(2026, 9, 2, 17, 0))).activeNow).toBe(true); // first segment starts
    expect((await at(new Date(2026, 9, 6, 8, 30))).activeNow).toBe(true); // last minute of the last segment
    expect((await at(new Date(2026, 9, 6, 8, 31))).activeNow).toBe(false); // relocked
    expect((await at(new Date(2026, 8, 14, 12, 0))).activeNow).toBe(false); // today, long before the window
  });

  it('after cancellation the group still exists but points at Never: configured, no window, not active', async () => {
    const fake = await populatedController();
    await cancelUnlockWindow(fake.client, SETTINGS);
    const status = await getUnlockWindow(fake.client, { ...SETTINGS, now: () => new Date(2026, 9, 4, 12, 0) });
    expect(status).toMatchObject({
      configured: true,
      portalGroup: { UNLOCKTIMESPECGROUPKEY: '2', unlockTimeSpecGroupName: 'Never', pointsAtManagedTimeSpecGroup: false },
      timeSpecGroup: { TIMESPECGROUPKEY: '101', TIMESPECKEYS: [] },
      timeSpecs: [],
      holidays: [],
      window: null,
      activeNow: false,
    });
  });

  it('on an empty controller reports nothing configured', async () => {
    const fake = freshController();
    const status = await getUnlockWindow(fake.client, SETTINGS);
    expect(status).toEqual({
      prefix: 'P',
      configured: false,
      portalGroup: null,
      timeSpecGroup: null,
      timeSpecs: [],
      holidays: [],
      window: null,
      activeNow: false,
      checkedAt: '2026-09-14 12:00',
    });
    expect(fake.writeCalls()).toEqual([]);
  });

  it('derives the window from a single-segment (same-day) configuration too', async () => {
    const fake = freshController();
    await scheduleUnlockWindow(fake.client, { start: '2026-10-03 09:00', end: '2026-10-03 17:00', portalKeys: ['3'] }, SETTINGS);
    const status = await getUnlockWindow(fake.client, { ...SETTINGS, now: () => new Date(2026, 9, 3, 12, 0) });
    expect(status.window).toEqual({ start: '2026-10-03 09:00', end: '2026-10-03 17:00' });
    expect(status.activeNow).toBe(true);
  });
});
