import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { computeDailySideEffects, scheduleDailyUnlockWindow, type DailyUnlockWindowSettings } from '../src/unlockWindow/dailyExecutor.js';
import { MANAGED_DESCRIPTION } from '../src/unlockWindow/managed.js';
import { planDailyUnlockWindow } from '../src/unlockWindow/dailyPlanner.js';
import { registerDailyUnlockWindowTools } from '../src/tools/dailyUnlockWindow.js';
import { FakeNetbox } from './fakeNetbox.js';
import { FakeServer, byName, type ToolRegistration } from './testUtils.js';

const C = NBAPI_COMMANDS;

/** Host clock for every test: 2026-09-14 12:00 local. */
const NOW = new Date(2026, 8, 14, 12, 0);
const SETTINGS: DailyUnlockWindowSettings = { holidayGroup: 5, namePrefix: 'P', now: () => NOW };

/** The R2 multi-day window: one segment covering 2026-10-02..2026-10-06. */
const WINDOW_A = { startDate: '2026-10-02', endDate: '2026-10-06', dailyStartTime: '05:00', dailyEndTime: '22:00' };
/** A shorter, same-day window that replaces A with different times. */
const WINDOW_B = { startDate: '2026-10-02', endDate: '2026-10-02', dailyStartTime: '05:00', dailyEndTime: '20:00' };

const WEEKDAYS_OFF = { MONDAY: '0', TUESDAY: '0', WEDNESDAY: '0', THURSDAY: '0', FRIDAY: '0', SATURDAY: '0', SUNDAY: '0' };

/** A controller with the built-ins and three portals, no holidays, no managed objects. */
function freshController(): FakeNetbox {
  const fake = FakeNetbox.withBuiltins();
  fake.portals.push({ PORTALKEY: '1', NAME: '01OF01A' }, { PORTALKEY: '2', NAME: '02OF01A' }, { PORTALKEY: '3', NAME: '03OF01A' });
  return fake;
}

function scheduleTool(fake: FakeNetbox, settings: DailyUnlockWindowSettings = SETTINGS): ToolRegistration {
  const server = new FakeServer();
  registerDailyUnlockWindowTools(server as unknown as McpServer, fake.client, { writesEnabled: true, destructiveEnabled: false }, settings);
  return byName(server, 'schedule_daily_unlock_window');
}

function parseSuccess(text: string): Record<string, unknown> {
  expect(text.startsWith('SUCCESS\n')).toBe(true);
  return JSON.parse(text.slice('SUCCESS\n'.length));
}

describe('schedule_daily_unlock_window registration (R4)', () => {
  it('registers get_daily_unlock_window always and the two write tools only with NETBOX_ENABLE_WRITES', () => {
    const off = new FakeServer();
    registerDailyUnlockWindowTools(off as unknown as McpServer, freshController().client, { writesEnabled: false, destructiveEnabled: true }, SETTINGS);
    expect(off.registrations.map((r) => r.name)).toEqual(['get_daily_unlock_window']);

    const on = new FakeServer();
    registerDailyUnlockWindowTools(on as unknown as McpServer, freshController().client, { writesEnabled: true, destructiveEnabled: false }, SETTINGS);
    expect(on.registrations.map((r) => r.name)).toEqual(['get_daily_unlock_window', 'schedule_daily_unlock_window', 'cancel_daily_unlock_window']);
    expect(byName(on, 'schedule_daily_unlock_window').description.startsWith('WRITE:')).toBe(true);
    expect(byName(on, 'cancel_daily_unlock_window').description.startsWith('WRITE:')).toBe(true);
    expect(byName(on, 'get_daily_unlock_window').description.startsWith('WRITE:')).toBe(false);
  });

  it('schedule_daily_unlock_window declares exactly startDate, endDate, dailyStartTime, dailyEndTime, portalKeys, acknowledgeSideEffects, dryRun', () => {
    expect(Object.keys(scheduleTool(freshController()).schema).sort()).toEqual(
      ['startDate', 'endDate', 'dailyStartTime', 'dailyEndTime', 'portalKeys', 'acknowledgeSideEffects', 'dryRun'].sort()
    );
  });
});

describe('schedule_daily_unlock_window (R3): the eight rejections issue no write', () => {
  const cases: Array<{
    name: string;
    args: Record<string, unknown>;
    setup?: (fake: FakeNetbox) => void;
    reason: RegExp;
  }> = [
    { name: 'wrong startDate/endDate format', args: { ...WINDOW_A, startDate: '2026/10/02' }, reason: /YYYY-MM-DD/ },
    { name: 'wrong dailyStartTime/dailyEndTime format', args: { ...WINDOW_A, dailyStartTime: '5:00' }, reason: /HH:MM/ },
    { name: 'endDate earlier than startDate', args: { ...WINDOW_A, startDate: '2026-10-06', endDate: '2026-10-02' }, reason: /must not be earlier than startDate/ },
    { name: 'dailyEndTime <= dailyStartTime (overnight-crossing)', args: { ...WINDOW_A, dailyStartTime: '22:00', dailyEndTime: '05:00' }, reason: /overnight-crossing/ },
    {
      name: 'the window has already elapsed (host clock)',
      args: { startDate: '2026-09-10', endDate: '2026-09-14', dailyStartTime: '09:00', dailyEndTime: '11:00' },
      reason: /not later than the current time/,
    },
    { name: 'longer than 31 days', args: { startDate: '2026-10-01', endDate: '2026-11-02', dailyStartTime: '05:00', dailyEndTime: '22:00' }, reason: /longer than 31 days/ },
    {
      name: 'the planned holiday would exceed 30',
      args: { ...WINDOW_A },
      setup: (fake) => {
        for (let i = 0; i < 30; i++) fake.seedHoliday({ NAME: `Holiday ${i}`, STARTDATE: '2030-01-01 00:00', ENDDATE: '2030-01-02 00:00' });
      },
      reason: /exceed the controller's limit of 30/,
    },
    { name: 'a portalKey not returned by GetPortals', args: { ...WINDOW_A, portalKeys: ['1', '99'] }, reason: /not returned by GetPortals: 99/ },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name} with isError and zero write commands`, async () => {
      const fake = freshController();
      testCase.setup?.(fake);
      const result = await scheduleTool(fake).handler(testCase.args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(testCase.reason);
      expect(fake.writeCalls()).toEqual([]);
    });
  }

  it('also refuses when GetPortals returns no portals at all (nothing to unlock), without writing', async () => {
    const fake = FakeNetbox.withBuiltins();
    const result = await scheduleTool(fake).handler({ ...WINDOW_A });
    expect(result.isError).toBe(true);
    expect(fake.writeCalls()).toEqual([]);
  });
});

describe('schedule_daily_unlock_window (R5): side-effect check', () => {
  function withBusinessHours(): FakeNetbox {
    const fake = freshController();
    fake.seedTimeSpec({ TIMESPECKEY: '5', NAME: 'Business Hours', STARTTIME: '08:00', ENDTIME: '18:00', MONDAY: 'TRUE', HOLIDAYGROUPS: '1,2' });
    return fake;
  }

  it('computeDailySideEffects lists time specs lacking the daily group (not Never, not managed) and overlapping non-managed holidays; a concurrently-active continuous-window time spec is reported like any other foreign one', () => {
    const fake = withBusinessHours();
    fake.seedTimeSpec({ NAME: 'P schedule', HOLIDAYGROUPS: '5' });
    // A simulated foreign continuous-window time spec (different prefix, ticks its own reserved groups only) — not excluded.
    fake.seedTimeSpec({ NAME: 'MCP Unlock Window first', HOLIDAYGROUPS: '8' });
    const plan = planDailyUnlockWindow(WINDOW_A.startDate, WINDOW_A.endDate, WINDOW_A.dailyStartTime, WINDOW_A.dailyEndTime, 5, 'P');
    const report = computeDailySideEffects(
      plan,
      fake.timeSpecs.map((spec) => ({
        TIMESPECKEY: spec.TIMESPECKEY,
        NAME: spec.NAME,
        DESCRIPTION: '',
        STARTTIME: spec.STARTTIME,
        ENDTIME: spec.ENDTIME,
        weekdays: { MONDAY: '0', TUESDAY: '0', WEDNESDAY: '0', THURSDAY: '0', FRIDAY: '0', SATURDAY: '0', SUNDAY: '0' },
        HOLIDAYGROUPS: spec.HOLIDAYGROUPS.split(',').filter(Boolean),
      })),
      [
        { HOLIDAYKEY: '1', NAME: 'GRAND OPENING', HOLIDAYGROUPS: ['1'], STARTDATE: '2026-10-05 00:00', ENDDATE: '2026-10-08 00:00' },
        { HOLIDAYKEY: '2', NAME: 'Christmas', HOLIDAYGROUPS: ['1'], STARTDATE: '2026-12-25 00:00', ENDDATE: '2026-12-26 00:00' },
        { HOLIDAYKEY: '3', NAME: 'MCP Unlock Window first', HOLIDAYGROUPS: ['8'], STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-03 00:00' },
      ],
      'P'
    );
    // Always ticks 1..8 (nothing missing); Never is skipped; the managed-prefixed spec is skipped.
    // Business Hours and the foreign continuous-window spec both lack group 5 -> both suppressed.
    expect(report.suppressedTimeSpecs).toEqual([
      { TIMESPECKEY: '5', NAME: 'Business Hours', HOLIDAYGROUPS: '1,2', missingGroup: 5 },
      { TIMESPECKEY: expect.any(String), NAME: 'MCP Unlock Window first', HOLIDAYGROUPS: '8', missingGroup: 5 },
    ]);
    expect(report.overlappingHolidays).toEqual([
      { HOLIDAYKEY: '1', NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-10-05 00:00', ENDDATE: '2026-10-08 00:00' },
      { HOLIDAYKEY: '3', NAME: 'MCP Unlock Window first', HOLIDAYGROUPS: '8', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-03 00:00' },
    ]);
  });

  it('blocks the call (isError listing key, name, groups) and writes nothing without acknowledgeSideEffects', async () => {
    const fake = withBusinessHours();
    const result = await scheduleTool(fake).handler({ ...WINDOW_A });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('5 "Business Hours" (HOLIDAYGROUPS: 1,2');
    expect(result.content[0].text).toContain('acknowledgeSideEffects=true');
    expect(fake.writeCalls()).toEqual([]);
  });

  it('proceeds with acknowledgeSideEffects=true and still reports the side effects in the result', async () => {
    const fake = withBusinessHours();
    const result = await scheduleTool(fake).handler({ ...WINDOW_A, acknowledgeSideEffects: true });
    expect(result.isError).toBeUndefined();
    const json = parseSuccess(result.content[0].text);
    expect(json.verified).toBe(true);
    expect(json.sideEffects).toEqual({
      suppressedTimeSpecs: [{ TIMESPECKEY: '5', NAME: 'Business Hours', HOLIDAYGROUPS: '1,2', missingGroup: 5 }],
      overlappingHolidays: [],
    });
  });

  it('dryRun=true returns the plan and the report without writing, regardless of acknowledgement', async () => {
    const fake = withBusinessHours();
    fake.seedHoliday({ NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-10-04 00:00', ENDDATE: '2026-10-05 00:00' });
    const result = await scheduleTool(fake).handler({ ...WINDOW_A, dryRun: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.startsWith('DRY RUN')).toBe(true);
    const json = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('\n') + 1));
    expect(json.dryRun).toBe(true);
    expect(json.requiresAcknowledgement).toBe(true);
    expect(json.name).toBe('P schedule');
    expect(json.sideEffects.suppressedTimeSpecs).toHaveLength(1);
    expect(json.sideEffects.overlappingHolidays.map((holiday: { NAME: string }) => holiday.NAME)).toEqual(['GRAND OPENING']);
    expect(json.holidays).toEqual({ existing: 1, toAdd: 1, limit: 30 });
    expect(fake.writeCalls()).toEqual([]);
  });

  it('R10: a non-managed holiday overlapping the window is reported but never modified or deleted', async () => {
    const fake = freshController();
    const grandOpeningKey = fake.seedHoliday({ NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-10-04 00:00', ENDDATE: '2026-10-05 00:00' });
    const before = JSON.stringify(fake.holidays.find((holiday) => holiday.HOLIDAYKEY === grandOpeningKey));

    const result = await scheduleTool(fake).handler({ ...WINDOW_A });

    const json = parseSuccess(result.content[0].text);
    expect(json.sideEffects).toEqual({
      suppressedTimeSpecs: [],
      overlappingHolidays: [
        { HOLIDAYKEY: grandOpeningKey, NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-10-04 00:00', ENDDATE: '2026-10-05 00:00' },
      ],
    });
    expect(JSON.stringify(fake.holidays.find((holiday) => holiday.HOLIDAYKEY === grandOpeningKey))).toBe(before);
    const touched = fake.writeCalls().filter(
      (call) => (call.command === C.MODIFY_HOLIDAY || call.command === C.DELETE_HOLIDAY) && call.params.HOLIDAYKEY === grandOpeningKey
    );
    expect(touched).toEqual([]);
  });
});

describe('schedule_daily_unlock_window (R6): the eight-step apply order', () => {
  it('first run on a fresh controller: adds everything, in exactly this order', async () => {
    const fake = freshController();
    const result = await scheduleTool(fake).handler({ ...WINDOW_A, portalKeys: ['1', '2'] });

    expect(result.isError).toBeUndefined();
    expect(fake.commands()).toEqual([
      C.GET_PORTALS, // step 1
      C.GET_HOLIDAYS, // R3/R5 pre-reads
      C.GET_TIME_SPECS,
      C.GET_TIME_SPEC_GROUPS, // step 2
      C.ADD_TIME_SPEC_GROUP,
      C.ADD_HOLIDAY, // step 3
      C.ADD_TIME_SPEC, // step 4
      C.MODIFY_TIME_SPEC_GROUP, // step 5
      C.GET_PORTAL_GROUPS, // step 6
      C.ADD_PORTAL_GROUP,
      C.GET_PORTAL_GROUP, // step 7
      C.GET_TIME_SPEC_GROUPS,
      C.GET_TIME_SPEC,
      C.GET_HOLIDAY,
    ]);
    expect(fake.commands()).not.toContain(C.GET_TIME_SPEC_GROUP);

    const params = (command: string) => fake.calls.filter((call) => call.command === command).map((call) => call.params);
    expect(params(C.ADD_TIME_SPEC_GROUP)).toEqual([{ NAME: 'P time specs', DESCRIPTION: MANAGED_DESCRIPTION }]);
    expect(params(C.ADD_HOLIDAY)).toEqual([
      { HOLIDAYNAME: 'P schedule', HOLIDAYGROUPS: '5', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-07 00:00' },
    ]);
    expect(params(C.ADD_TIME_SPEC)).toEqual([
      { NAME: 'P schedule', DESCRIPTION: MANAGED_DESCRIPTION, STARTTIME: '05:00', ENDTIME: '22:00', ...WEEKDAYS_OFF, HOLIDAYGROUPS: '5' },
    ]);
    expect(params(C.MODIFY_TIME_SPEC_GROUP)).toEqual([{ TIMESPECGROUPKEY: '101', TIMESPECKEYS: { TIMESPECKEY: ['103'] } }]);
    expect(params(C.ADD_PORTAL_GROUP)).toEqual([
      { NAME: 'P', DESCRIPTION: MANAGED_DESCRIPTION, UNLOCKTIMESPECGROUPKEY: '101', PORTALKEYS: { PORTALKEY: ['1', '2'] } },
    ]);

    const json = parseSuccess(result.content[0].text);
    expect(json).toEqual({
      window: WINDOW_A,
      holidayKey: '102',
      timeSpecKey: '103',
      timeSpecGroupKey: '101',
      portalGroupKey: '104',
      holidayGroup: 5,
      portals: [
        { PORTALKEY: '1', NAME: '01OF01A' },
        { PORTALKEY: '2', NAME: '02OF01A' },
      ],
      replacedPreviousWindow: false,
      sideEffects: { suppressedTimeSpecs: [], overlappingHolidays: [] },
      verified: true,
    });
  });

  it('second run with different (shorter) times: modifies only (no Add, no Delete), in exactly this order', async () => {
    const fake = freshController();
    await scheduleTool(fake).handler({ ...WINDOW_A, portalKeys: ['1', '2'] });
    fake.calls = [];

    const result = await scheduleTool(fake).handler({ ...WINDOW_B, portalKeys: ['1', '2'] });

    expect(result.isError).toBeUndefined();
    expect(fake.calls).toEqual([
      { command: C.GET_PORTALS, params: {} },
      { command: C.GET_HOLIDAYS, params: {} },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '102' } },
      { command: C.GET_TIME_SPECS, params: {} },
      { command: C.GET_TIME_SPEC_GROUPS, params: {} }, // step 2: found, no add
      {
        command: C.MODIFY_HOLIDAY, // step 3
        params: { HOLIDAYKEY: '102', HOLIDAYNAME: 'P schedule', HOLIDAYGROUPS: '5', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-03 00:00' },
      },
      {
        command: C.MODIFY_TIME_SPEC, // step 4
        params: { TIMESPECKEY: '103', NAME: 'P schedule', DESCRIPTION: MANAGED_DESCRIPTION, STARTTIME: '05:00', ENDTIME: '20:00', ...WEEKDAYS_OFF, HOLIDAYGROUPS: '5' },
      },
      { command: C.MODIFY_TIME_SPEC_GROUP, params: { TIMESPECGROUPKEY: '101', TIMESPECKEYS: { TIMESPECKEY: ['103'] } } }, // step 5
      { command: C.GET_PORTAL_GROUPS, params: {} }, // step 6: found, modify
      {
        command: C.MODIFY_PORTAL_GROUP,
        params: { PORTALGROUPKEY: '104', PORTALKEYS: { PORTALKEY: ['1', '2'] }, UNLOCKTIMESPECGROUPKEY: '101' },
      },
      { command: C.GET_PORTAL_GROUP, params: { PORTALGROUPKEY: '104' } }, // step 7
      { command: C.GET_TIME_SPEC_GROUPS, params: {} },
      { command: C.GET_TIME_SPEC, params: { TIMESPECKEY: '103' } },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '102' } },
    ]);

    const json = parseSuccess(result.content[0].text);
    expect(json).toMatchObject({
      window: WINDOW_B,
      holidayKey: '102',
      timeSpecKey: '103',
      timeSpecGroupKey: '101',
      portalGroupKey: '104',
      replacedPreviousWindow: true,
      verified: true,
    });
    expect(fake.holidays.map((holiday) => holiday.NAME)).toEqual(['P schedule']);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never', 'P schedule']);
  });

  it('with portalKeys omitted, the managed portal group gets every portal from GetPortals', async () => {
    const fake = freshController();
    const result = await scheduleTool(fake).handler({ ...WINDOW_B });
    const json = parseSuccess(result.content[0].text);
    expect(json.portals).toEqual(fake.portals);
    expect(fake.portalGroups[0].PORTALKEYS).toEqual(['1', '2', '3']);
  });

  it('a failing step returns isError naming the step and the controller message, rolls back, and stops', async () => {
    const fake = freshController();
    fake.refuse(C.ADD_TIME_SPEC, 'Duplicate');
    const result = await scheduleTool(fake).handler({ ...WINDOW_A });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Step 4 .* failed: NetBox NBAPI command failed: Duplicate/);
    expect(fake.commands()).not.toContain(C.ADD_PORTAL_GROUP);
    // Rollback removed the holiday added in step 3; the time spec never got created.
    expect(fake.holidays.map((holiday) => holiday.NAME)).toEqual([]);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never']);
  });

  it('a read-back mismatch (controller returns a different STARTTIME) is isError describing the field', async () => {
    const fake = freshController();
    fake.override(C.GET_TIME_SPEC, (_params, respond) => {
      const normal = respond();
      const data = normal.data as { TIMESPEC: Record<string, string> };
      return { notFound: false, data: { TIMESPEC: { ...data.TIMESPEC, STARTTIME: '10:00' } } };
    });
    const result = await scheduleTool(fake).handler({ ...WINDOW_B, portalKeys: ['1'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Step 7 (read-back)');
    expect(result.content[0].text).toContain('time spec "P schedule" STARTTIME: expected "05:00", got "10:00"');
  });
});

describe('schedule_daily_unlock_window (R7): idempotency', () => {
  it('a second identical call issues only Modify/Get commands (no Add, no Delete) and returns the same keys', async () => {
    const fake = freshController();
    const first = parseSuccess((await scheduleTool(fake).handler({ ...WINDOW_A, portalKeys: ['1', '2'] })).content[0].text);
    fake.calls = [];

    const second = parseSuccess((await scheduleTool(fake).handler({ ...WINDOW_A, portalKeys: ['1', '2'] })).content[0].text);

    const commands = fake.commands();
    expect(commands.some((command) => command.startsWith('Add') || command.startsWith('Delete'))).toBe(false);
    expect(commands.filter((command) => command.startsWith('Modify'))).toEqual([
      C.MODIFY_HOLIDAY,
      C.MODIFY_TIME_SPEC,
      C.MODIFY_TIME_SPEC_GROUP,
      C.MODIFY_PORTAL_GROUP,
    ]);
    expect(second.holidayKey).toBe(first.holidayKey);
    expect(second.timeSpecKey).toBe(first.timeSpecKey);
    expect(second.timeSpecGroupKey).toBe(first.timeSpecGroupKey);
    expect(second.portalGroupKey).toBe(first.portalGroupKey);
    expect(second.replacedPreviousWindow).toBe(true);
    expect(fake.holidays).toHaveLength(1);
    expect(fake.timeSpecs).toHaveLength(3);
    expect(fake.timeSpecGroups).toHaveLength(3);
    expect(fake.portalGroups).toHaveLength(1);
  });
});
