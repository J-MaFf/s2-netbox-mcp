import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { cancelDailyUnlockWindow, getDailyUnlockWindow, scheduleDailyUnlockWindow, type DailyUnlockWindowSettings } from '../src/unlockWindow/dailyExecutor.js';
import { registerDailyUnlockWindowTools } from '../src/tools/dailyUnlockWindow.js';
import { FakeNetbox } from './fakeNetbox.js';
import { FakeServer, byName } from './testUtils.js';

const C = NBAPI_COMMANDS;
const NOW = new Date(2026, 8, 14, 12, 0);
const SETTINGS: DailyUnlockWindowSettings = { holidayGroup: 5, namePrefix: 'P', now: () => NOW };
const WINDOW_A = { startDate: '2026-10-02', endDate: '2026-10-06', dailyStartTime: '05:00', dailyEndTime: '22:00' };

function freshController(): FakeNetbox {
  const fake = FakeNetbox.withBuiltins();
  fake.portals.push({ PORTALKEY: '1', NAME: '01OF01A' }, { PORTALKEY: '2', NAME: '02OF01A' }, { PORTALKEY: '3', NAME: '03OF01A' });
  return fake;
}

/** A controller with WINDOW_A scheduled on portals 1 and 2 (keys: TSG 101, holiday 102, spec 103, PG 104). */
async function populatedController(): Promise<FakeNetbox> {
  const fake = freshController();
  const result = await scheduleDailyUnlockWindow(fake.client, { ...WINDOW_A, portalKeys: ['1', '2'] }, SETTINGS);
  expect('verified' in result && result.verified).toBe(true);
  fake.calls = [];
  return fake;
}

function tools(fake: FakeNetbox, settings: DailyUnlockWindowSettings = SETTINGS): FakeServer {
  const server = new FakeServer();
  registerDailyUnlockWindowTools(server as unknown as McpServer, fake.client, { writesEnabled: true, destructiveEnabled: false }, settings);
  return server;
}

describe('cancel_daily_unlock_window (R8)', () => {
  it('issues exactly: reads, ModifyPortalGroup -> Never, DeleteHoliday, ModifyTimeSpecGroup([]), DeleteTimeSpec', async () => {
    const fake = await populatedController();

    const result = await byName(tools(fake), 'cancel_daily_unlock_window').handler({});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.startsWith('SUCCESS\n')).toBe(true);
    expect(fake.calls).toEqual([
      { command: C.GET_TIME_SPEC_GROUPS, params: {} },
      { command: C.GET_PORTAL_GROUPS, params: {} },
      { command: C.GET_PORTAL_GROUP, params: { PORTALGROUPKEY: '104' } },
      { command: C.GET_HOLIDAYS, params: {} },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '102' } },
      { command: C.GET_TIME_SPECS, params: {} },
      {
        command: C.MODIFY_PORTAL_GROUP,
        params: { PORTALGROUPKEY: '104', PORTALKEYS: { PORTALKEY: ['1', '2'] }, UNLOCKTIMESPECGROUPKEY: '2' },
      },
      { command: C.DELETE_HOLIDAY, params: { HOLIDAYKEY: '102' } },
      { command: C.MODIFY_TIME_SPEC_GROUP, params: { TIMESPECGROUPKEY: '101', TIMESPECKEYS: { TIMESPECKEY: [] } } },
      { command: C.DELETE_TIME_SPEC, params: { TIMESPECKEY: '103' } },
    ]);
    expect(fake.commands()).not.toContain(C.GET_TIME_SPEC_GROUP);

    const json = JSON.parse(result.content[0].text.slice('SUCCESS\n'.length));
    expect(json).toMatchObject({
      cancelled: true,
      portalGroup: { PORTALGROUPKEY: '104', NAME: 'P', portals: [{ PORTALKEY: '1', NAME: '01OF01A' }, { PORTALKEY: '2', NAME: '02OF01A' }] },
      unlockTimeSpecGroup: { TIMESPECGROUPKEY: '2', NAME: 'Never' },
      deletedHoliday: { HOLIDAYKEY: '102', NAME: 'P schedule' },
      timeSpecGroup: { TIMESPECGROUPKEY: '101', NAME: 'P time specs', emptied: true },
      deletedTimeSpec: { TIMESPECKEY: '103', NAME: 'P schedule' },
      leftBehind: [],
    });

    // Controller state: portal group on Never, no managed holiday, the managed groups kept for reuse.
    expect(fake.portalGroups).toEqual([
      expect.objectContaining({ PORTALGROUPKEY: '104', NAME: 'P', PORTALKEYS: ['1', '2'], UNLOCKTIMESPECGROUPKEY: '2' }),
    ]);
    expect(fake.holidays).toEqual([]);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never']);
    expect(fake.timeSpecGroups.find((group) => group.TIMESPECGROUPKEY === '101')).toEqual(
      expect.objectContaining({ NAME: 'P time specs', TIMESPECKEYS: [] })
    );
  });

  it('tolerates the controller refusing to empty the group or delete the spec: still success, with leftBehind listing them', async () => {
    const fake = await populatedController();
    fake.refuse(C.MODIFY_TIME_SPEC_GROUP, 'Cannot modify group', (params) => params.TIMESPECGROUPKEY === '101');
    fake.refuse(C.DELETE_TIME_SPEC, 'Delete Failed: May be referenced elsewhere');

    const result = await byName(tools(fake), 'cancel_daily_unlock_window').handler({});

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text.slice('SUCCESS\n'.length));
    expect(json.cancelled).toBe(true);
    expect(json.unlockTimeSpecGroup).toEqual({ TIMESPECGROUPKEY: '2', NAME: 'Never' });
    expect(json.deletedHoliday).toEqual({ HOLIDAYKEY: '102', NAME: 'P schedule' });
    expect(json.timeSpecGroup).toEqual({ TIMESPECGROUPKEY: '101', NAME: 'P time specs', emptied: false });
    expect(json.deletedTimeSpec).toBeUndefined();
    expect(json.leftBehind).toEqual([
      { type: 'timeSpecGroup', key: '101', NAME: 'P time specs', error: 'NetBox NBAPI command failed: Cannot modify group' },
      { type: 'timeSpec', key: '103', NAME: 'P schedule', error: 'NetBox NBAPI command failed: Delete Failed: May be referenced elsewhere' },
    ]);
    expect(fake.writeCalls().map((call) => call.command)).toEqual([
      C.MODIFY_PORTAL_GROUP,
      C.DELETE_HOLIDAY,
      C.MODIFY_TIME_SPEC_GROUP,
      C.DELETE_TIME_SPEC,
    ]);
    expect(fake.portalGroups[0].UNLOCKTIMESPECGROUPKEY).toBe('2');
    expect(fake.holidays).toEqual([]);
  });

  it('returns a normal (non-error) result saying there was nothing to cancel when no managed object exists, writing nothing', async () => {
    const fake = freshController();
    const result = await byName(tools(fake), 'cancel_daily_unlock_window').handler({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Nothing to cancel');
    expect(JSON.parse(result.content[0].text.slice('SUCCESS\n'.length))).toMatchObject({ cancelled: false, leftBehind: [] });
    expect(fake.writeCalls()).toEqual([]);
  });

  it('R10: cancels a holiday/time spec left behind with no managed portal group (e.g. a run that failed after step 3 but before step 6)', async () => {
    const fake = freshController();
    const holidayKey = fake.seedHoliday({ NAME: 'P schedule', HOLIDAYGROUPS: '5', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-07 00:00' });
    const specKey = fake.seedTimeSpec({ NAME: 'P schedule', HOLIDAYGROUPS: '5' });
    const groupKey = fake.seedTimeSpecGroup({ NAME: 'P time specs', TIMESPECKEYS: [specKey] });

    const result = await byName(tools(fake), 'cancel_daily_unlock_window').handler({});

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text.slice('SUCCESS\n'.length));
    expect(json.cancelled).toBe(true);
    expect(json.portalGroup).toBeUndefined();
    expect(json.deletedHoliday).toEqual({ HOLIDAYKEY: holidayKey, NAME: 'P schedule' });
    expect(json.deletedTimeSpec).toEqual({ TIMESPECKEY: specKey, NAME: 'P schedule' });
    expect(json.timeSpecGroup).toEqual({ TIMESPECGROUPKEY: groupKey, NAME: 'P time specs', emptied: true });
    expect(json.leftBehind).toEqual([]);
    expect(fake.commands()).not.toContain(C.MODIFY_PORTAL_GROUP);
    expect(fake.holidays).toEqual([]);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never']);
  });

  it('fails clearly, before any write, when no time spec group named "Never" exists', async () => {
    const fake = await populatedController();
    fake.timeSpecGroups = fake.timeSpecGroups.filter((group) => group.NAME !== 'Never');
    const result = await byName(tools(fake), 'cancel_daily_unlock_window').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no time spec group named "Never"');
    expect(fake.writeCalls()).toEqual([]);
  });

  it('a refused DeleteHoliday is NOT tolerated: isError naming the step', async () => {
    const fake = await populatedController();
    fake.refuse(C.DELETE_HOLIDAY, 'Permission denied');
    const result = await byName(tools(fake), 'cancel_daily_unlock_window').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Step 3 .* failed: NetBox NBAPI command failed: Permission denied/);
    // The portal group had already been pointed at Never before the failure.
    expect(fake.portalGroups[0].UNLOCKTIMESPECGROUPKEY).toBe('2');
  });

  it('only ever deletes managed-named holidays and time specs (R10)', async () => {
    const fake = await populatedController();
    const otherHoliday = fake.seedHoliday({ NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-10-04 00:00', ENDDATE: '2026-10-05 00:00' });
    const otherSpec = fake.seedTimeSpec({ NAME: 'P-ish but not managed', HOLIDAYGROUPS: '5' });
    await cancelDailyUnlockWindow(fake.client, SETTINGS);
    expect(fake.holidays.map((holiday) => holiday.HOLIDAYKEY)).toEqual([otherHoliday]);
    expect(fake.timeSpecs.map((spec) => spec.TIMESPECKEY)).toContain(otherSpec);
  });
});

describe('get_daily_unlock_window (R9)', () => {
  it('is registered even with writes off and only issues Get commands', async () => {
    const fake = await populatedController();
    const server = new FakeServer();
    registerDailyUnlockWindowTools(server as unknown as McpServer, fake.client, { writesEnabled: false, destructiveEnabled: false }, SETTINGS);
    const reg = byName(server, 'get_daily_unlock_window');
    expect(Object.keys(reg.schema)).toEqual([]);
    const result = await reg.handler({});
    expect(result.isError).toBeUndefined();
    expect(fake.writeCalls()).toEqual([]);
    expect(fake.commands()).not.toContain(C.GET_TIME_SPEC_GROUP);
    expect(JSON.parse(result.content[0].text).configured).toBe(true);
  });

  it('on a populated controller reports the managed objects, the derived window, and activeNow against the host clock', async () => {
    const fake = await populatedController();
    const at = (date: Date) => getDailyUnlockWindow(fake.client, { ...SETTINGS, now: () => date });

    const status = await at(new Date(2026, 9, 4, 12, 0)); // 2026-10-04 12:00, inside the range and the daily time-of-day
    expect(status).toMatchObject({
      prefix: 'P',
      configured: true,
      portalGroup: {
        PORTALGROUPKEY: '104',
        NAME: 'P',
        portals: [
          { PORTALKEY: '1', NAME: '01OF01A' },
          { PORTALKEY: '2', NAME: '02OF01A' },
        ],
        UNLOCKTIMESPECGROUPKEY: '101',
        unlockTimeSpecGroupName: 'P time specs',
        pointsAtManagedTimeSpecGroup: true,
      },
      timeSpecGroup: { TIMESPECGROUPKEY: '101', NAME: 'P time specs', TIMESPECKEYS: ['103'] },
      timeSpec: { TIMESPECKEY: '103', NAME: 'P schedule', STARTTIME: '05:00', ENDTIME: '22:00', HOLIDAYGROUPS: '5', inManagedGroup: true },
      holiday: { HOLIDAYKEY: '102', NAME: 'P schedule', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-07 00:00', HOLIDAYGROUPS: '5' },
      window: { startDate: '2026-10-02', endDate: '2026-10-06', dailyStartTime: '05:00', dailyEndTime: '22:00' },
      activeNow: true,
      checkedAt: '2026-10-04 12:00',
    });

    // Outside the daily time-of-day, but within the date range: not active.
    expect((await at(new Date(2026, 9, 4, 4, 59))).activeNow).toBe(false);
    expect((await at(new Date(2026, 9, 4, 5, 0))).activeNow).toBe(true);
    expect((await at(new Date(2026, 9, 4, 22, 0))).activeNow).toBe(true); // last minute of the daily window, inclusive
    expect((await at(new Date(2026, 9, 4, 22, 1))).activeNow).toBe(false);
    // Outside the date range entirely (relocked overnight every night is the point of this feature).
    expect((await at(new Date(2026, 9, 1, 12, 0))).activeNow).toBe(false);
    expect((await at(new Date(2026, 9, 7, 12, 0))).activeNow).toBe(false);
  });

  it('after cancellation the group still exists but points at Never: configured, no window, not active', async () => {
    const fake = await populatedController();
    await cancelDailyUnlockWindow(fake.client, SETTINGS);
    const status = await getDailyUnlockWindow(fake.client, { ...SETTINGS, now: () => new Date(2026, 9, 4, 12, 0) });
    expect(status).toMatchObject({
      configured: true,
      portalGroup: { UNLOCKTIMESPECGROUPKEY: '2', unlockTimeSpecGroupName: 'Never', pointsAtManagedTimeSpecGroup: false },
      timeSpecGroup: { TIMESPECGROUPKEY: '101', TIMESPECKEYS: [] },
      timeSpec: null,
      holiday: null,
      window: null,
      activeNow: false,
    });
  });

  it('on an empty controller reports nothing configured', async () => {
    const fake = freshController();
    const status = await getDailyUnlockWindow(fake.client, SETTINGS);
    expect(status).toEqual({
      prefix: 'P',
      configured: false,
      portalGroup: null,
      timeSpecGroup: null,
      timeSpec: null,
      holiday: null,
      window: null,
      activeNow: false,
      checkedAt: '2026-09-14 12:00',
    });
    expect(fake.writeCalls()).toEqual([]);
  });

  it('derives the window from a single-day configuration too', async () => {
    const fake = freshController();
    await scheduleDailyUnlockWindow(fake.client, { startDate: '2026-10-03', endDate: '2026-10-03', dailyStartTime: '09:00', dailyEndTime: '17:00', portalKeys: ['3'] }, SETTINGS);
    const status = await getDailyUnlockWindow(fake.client, { ...SETTINGS, now: () => new Date(2026, 9, 3, 12, 0) });
    expect(status.window).toEqual({ startDate: '2026-10-03', endDate: '2026-10-03', dailyStartTime: '09:00', dailyEndTime: '17:00' });
    expect(status.activeNow).toBe(true);
  });
});
