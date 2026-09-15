import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { computeSideEffects, scheduleUnlockWindow, type UnlockWindowSettings } from '../src/unlockWindow/executor.js';
import { MANAGED_DESCRIPTION } from '../src/unlockWindow/managed.js';
import { planUnlockWindow } from '../src/unlockWindow/planner.js';
import { registerUnlockWindowTools } from '../src/tools/unlockWindow.js';
import { FakeNetbox } from './fakeNetbox.js';
import { FakeServer, byName, type ToolRegistration } from './testUtils.js';

const C = NBAPI_COMMANDS;

/** Host clock for every test: 2026-09-14 12:00 local. */
const NOW = new Date(2026, 8, 14, 12, 0);
const SETTINGS: UnlockWindowSettings = { holidayGroups: [8, 7, 6], namePrefix: 'P', now: () => NOW };

/** The R23 multi-day window: first (10-02), middle (10-03..10-05), last (10-06). */
const WINDOW_A = { start: '2026-10-02 17:00', end: '2026-10-06 08:30' };
/** A shorter, same-day window that replaces A with one segment. */
const WINDOW_B = { start: '2026-10-02 17:00', end: '2026-10-02 20:00' };

const WEEKDAYS_OFF = { MONDAY: '0', TUESDAY: '0', WEDNESDAY: '0', THURSDAY: '0', FRIDAY: '0', SATURDAY: '0', SUNDAY: '0' };

/** A controller with the built-ins and three portals, no holidays, no managed objects. */
function freshController(): FakeNetbox {
  const fake = FakeNetbox.withBuiltins();
  fake.portals.push({ PORTALKEY: '1', NAME: '01OF01A' }, { PORTALKEY: '2', NAME: '02OF01A' }, { PORTALKEY: '3', NAME: '03OF01A' });
  return fake;
}

function scheduleTool(fake: FakeNetbox, settings: UnlockWindowSettings = SETTINGS): ToolRegistration {
  const server = new FakeServer();
  registerUnlockWindowTools(server as unknown as McpServer, fake.client, { writesEnabled: true, destructiveEnabled: false }, settings);
  return byName(server, 'schedule_unlock_window');
}

function parseSuccess(text: string): Record<string, unknown> {
  expect(text.startsWith('SUCCESS\n')).toBe(true);
  return JSON.parse(text.slice('SUCCESS\n'.length));
}

describe('schedule_unlock_window registration', () => {
  it('registers get_unlock_window always and the two write tools only with NETBOX_ENABLE_WRITES', () => {
    const off = new FakeServer();
    registerUnlockWindowTools(off as unknown as McpServer, freshController().client, { writesEnabled: false, destructiveEnabled: true }, SETTINGS);
    expect(off.registrations.map((r) => r.name)).toEqual(['get_unlock_window']);

    const on = new FakeServer();
    registerUnlockWindowTools(on as unknown as McpServer, freshController().client, { writesEnabled: true, destructiveEnabled: false }, SETTINGS);
    expect(on.registrations.map((r) => r.name)).toEqual(['get_unlock_window', 'schedule_unlock_window', 'cancel_unlock_window']);
    expect(byName(on, 'schedule_unlock_window').description.startsWith('WRITE:')).toBe(true);
    expect(byName(on, 'cancel_unlock_window').description.startsWith('WRITE:')).toBe(true);
    expect(byName(on, 'get_unlock_window').description.startsWith('WRITE:')).toBe(false);
  });

  it('schedule_unlock_window declares exactly start, end, portalKeys, acknowledgeSideEffects, dryRun', () => {
    expect(Object.keys(scheduleTool(freshController()).schema).sort()).toEqual(
      ['start', 'end', 'portalKeys', 'acknowledgeSideEffects', 'dryRun'].sort()
    );
  });
});

describe('schedule_unlock_window (R22): the seven rejections issue no write', () => {
  const cases: Array<{
    name: string;
    args: Record<string, unknown>;
    setup?: (fake: FakeNetbox) => void;
    settings?: UnlockWindowSettings;
    reason: RegExp;
  }> = [
    { name: 'wrong format', args: { start: '2026/10/02 17:00', end: WINDOW_A.end }, reason: /YYYY-MM-DD HH:MM/ },
    { name: 'end <= start', args: { start: '2026-10-02 17:00', end: '2026-10-02 17:00' }, reason: /must be later than start/ },
    { name: 'end not later than now', args: { start: '2026-09-14 09:00', end: '2026-09-14 11:00' }, reason: /not later than the current time/ },
    { name: 'longer than 31 days', args: { start: '2026-10-01 00:00', end: '2026-11-01 00:01' }, reason: /longer than 31 days/ },
    { name: 'a portalKey not returned by GetPortals', args: { ...WINDOW_A, portalKeys: ['1', '99'] }, reason: /not returned by GetPortals: 99/ },
    {
      name: 'the planned holidays would exceed 30',
      args: { ...WINDOW_A },
      setup: (fake) => {
        for (let i = 0; i < 28; i++) fake.seedHoliday({ NAME: `Holiday ${i}`, STARTDATE: '2030-01-01 00:00', ENDDATE: '2030-01-02 00:00' });
      },
      reason: /exceed the controller's limit of 30/,
    },
    {
      name: 'a segment kind with no configured holiday group',
      // Only one reserved group configured, but a window spanning two
      // calendar dates needs a `first` and a `last` segment (R23) — the
      // `last` segment's reserved group (#2) is not configured, so the
      // plan is rejected before any NBAPI call is made (mirrors the pure
      // planner case in test/unlockWindowPlanner.test.ts).
      args: { start: '2026-10-03 18:00', end: '2026-10-04 09:00' },
      settings: { holidayGroups: [8], namePrefix: 'P', now: () => NOW },
      reason: /"last" segment.*NETBOX_UNLOCK_HOLIDAY_GROUPS/,
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name} with isError and zero write commands`, async () => {
      const fake = freshController();
      testCase.setup?.(fake);
      const result = await scheduleTool(fake, testCase.settings ?? SETTINGS).handler(testCase.args);
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

describe('schedule_unlock_window (R24): side-effect check', () => {
  function withBusinessHours(): FakeNetbox {
    const fake = freshController();
    fake.seedTimeSpec({ TIMESPECKEY: '5', NAME: 'Business Hours', STARTTIME: '08:00', ENDTIME: '18:00', MONDAY: 'TRUE', HOLIDAYGROUPS: '1,2' });
    return fake;
  }

  it('computeSideEffects lists time specs lacking a used group (not Never, not managed) and overlapping non-managed holidays', () => {
    const fake = withBusinessHours();
    fake.seedTimeSpec({ NAME: 'P first', HOLIDAYGROUPS: '8' });
    fake.seedTimeSpec({ NAME: 'P leftover thing', HOLIDAYGROUPS: '' });
    const plan = planUnlockWindow(WINDOW_A.start, WINDOW_A.end, [8, 7, 6], 'P');
    const report = computeSideEffects(
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
        { HOLIDAYKEY: '3', NAME: 'Ends exactly at coverage start', HOLIDAYGROUPS: ['1'], STARTDATE: '2026-10-01 00:00', ENDDATE: '2026-10-02 00:00' },
        { HOLIDAYKEY: '4', NAME: 'P middle', HOLIDAYGROUPS: ['7'], STARTDATE: '2026-10-03 00:00', ENDDATE: '2026-10-06 00:00' },
      ],
      'P'
    );
    // Always ticks 1..8 (nothing missing); Never is skipped; the managed-prefixed specs are skipped.
    expect(report.suppressedTimeSpecs).toEqual([{ TIMESPECKEY: '5', NAME: 'Business Hours', HOLIDAYGROUPS: '1,2', missingGroups: [8, 7, 6] }]);
    expect(report.overlappingHolidays).toEqual([
      { HOLIDAYKEY: '1', NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-10-05 00:00', ENDDATE: '2026-10-08 00:00' },
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
      suppressedTimeSpecs: [{ TIMESPECKEY: '5', NAME: 'Business Hours', HOLIDAYGROUPS: '1,2', missingGroups: [8, 7, 6] }],
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
    expect(json.segments.map((segment: { kind: string }) => segment.kind)).toEqual(['first', 'middle', 'last']);
    expect(json.sideEffects.suppressedTimeSpecs).toHaveLength(1);
    expect(json.sideEffects.overlappingHolidays.map((holiday: { NAME: string }) => holiday.NAME)).toEqual(['GRAND OPENING']);
    expect(json.holidays).toEqual({ existing: 1, toAdd: 3, limit: 30 });
    expect(fake.writeCalls()).toEqual([]);
  });

  it('R27: a non-managed holiday overlapping the window is reported but never modified or deleted', async () => {
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

describe('schedule_unlock_window (R25): the eight-step apply order', () => {
  it('first run on a fresh controller: adds everything, in exactly this order', async () => {
    const fake = freshController();
    const result = await scheduleTool(fake).handler({ ...WINDOW_A, portalKeys: ['1', '2'] });

    expect(result.isError).toBeUndefined();
    expect(fake.commands()).toEqual([
      C.GET_PORTALS, // step 1
      C.GET_TIME_SPECS, // R24 pre-reads
      C.GET_HOLIDAYS,
      C.GET_TIME_SPEC_GROUPS, // step 2
      C.ADD_TIME_SPEC_GROUP,
      C.ADD_HOLIDAY, // step 3: first
      C.ADD_TIME_SPEC,
      C.ADD_HOLIDAY, // middle
      C.ADD_TIME_SPEC,
      C.ADD_HOLIDAY, // last
      C.ADD_TIME_SPEC,
      C.MODIFY_TIME_SPEC_GROUP, // step 4
      // step 5: nothing to delete
      C.GET_PORTAL_GROUPS, // step 6
      C.ADD_PORTAL_GROUP,
      C.GET_PORTAL_GROUP, // step 7
      C.GET_TIME_SPEC_GROUPS,
      C.GET_TIME_SPEC,
      C.GET_HOLIDAY,
      C.GET_TIME_SPEC,
      C.GET_HOLIDAY,
      C.GET_TIME_SPEC,
      C.GET_HOLIDAY,
    ]);
    expect(fake.commands()).not.toContain(C.GET_TIME_SPEC_GROUP);

    const params = (command: string) => fake.calls.filter((call) => call.command === command).map((call) => call.params);
    expect(params(C.ADD_TIME_SPEC_GROUP)).toEqual([{ NAME: 'P time specs', DESCRIPTION: MANAGED_DESCRIPTION }]);
    expect(params(C.ADD_HOLIDAY)).toEqual([
      { HOLIDAYNAME: 'P first', HOLIDAYGROUPS: '8', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-03 00:00' },
      { HOLIDAYNAME: 'P middle', HOLIDAYGROUPS: '7', STARTDATE: '2026-10-03 00:00', ENDDATE: '2026-10-06 00:00' },
      { HOLIDAYNAME: 'P last', HOLIDAYGROUPS: '6', STARTDATE: '2026-10-06 00:00', ENDDATE: '2026-10-07 00:00' },
    ]);
    expect(params(C.ADD_TIME_SPEC)).toEqual([
      { NAME: 'P first', DESCRIPTION: MANAGED_DESCRIPTION, STARTTIME: '17:00', ENDTIME: '23:59', ...WEEKDAYS_OFF, HOLIDAYGROUPS: '8' },
      { NAME: 'P middle', DESCRIPTION: MANAGED_DESCRIPTION, STARTTIME: '00:00', ENDTIME: '23:59', ...WEEKDAYS_OFF, HOLIDAYGROUPS: '7' },
      { NAME: 'P last', DESCRIPTION: MANAGED_DESCRIPTION, STARTTIME: '00:00', ENDTIME: '08:30', ...WEEKDAYS_OFF, HOLIDAYGROUPS: '6' },
    ]);
    expect(params(C.MODIFY_TIME_SPEC_GROUP)).toEqual([{ TIMESPECGROUPKEY: '101', TIMESPECKEYS: { TIMESPECKEY: ['103', '105', '107'] } }]);
    expect(params(C.ADD_PORTAL_GROUP)).toEqual([
      { NAME: 'P', DESCRIPTION: MANAGED_DESCRIPTION, UNLOCKTIMESPECGROUPKEY: '101', PORTALKEYS: { PORTALKEY: ['1', '2'] } },
    ]);

    const json = parseSuccess(result.content[0].text);
    expect(json).toEqual({
      window: WINDOW_A,
      segments: [
        { kind: 'first', holidayKey: '102', timeSpecKey: '103', holidayGroup: 8, STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-03 00:00', STARTTIME: '17:00', ENDTIME: '23:59' },
        { kind: 'middle', holidayKey: '104', timeSpecKey: '105', holidayGroup: 7, STARTDATE: '2026-10-03 00:00', ENDDATE: '2026-10-06 00:00', STARTTIME: '00:00', ENDTIME: '23:59' },
        { kind: 'last', holidayKey: '106', timeSpecKey: '107', holidayGroup: 6, STARTDATE: '2026-10-06 00:00', ENDDATE: '2026-10-07 00:00', STARTTIME: '00:00', ENDTIME: '08:30' },
      ],
      timeSpecGroupKey: '101',
      portalGroupKey: '108',
      portals: [
        { PORTALKEY: '1', NAME: '01OF01A' },
        { PORTALKEY: '2', NAME: '02OF01A' },
      ],
      replacedPreviousWindow: false,
      sideEffects: { suppressedTimeSpecs: [], overlappingHolidays: [] },
      verified: true,
    });
  });

  it('second run with a shorter window: modifies the kept segment, then deletes the leftover ones after step 4, in exactly this order', async () => {
    const fake = freshController();
    await scheduleTool(fake).handler({ ...WINDOW_A, portalKeys: ['1', '2'] });
    fake.calls = [];

    const result = await scheduleTool(fake).handler({ ...WINDOW_B, portalKeys: ['1', '2'] });

    expect(result.isError).toBeUndefined();
    expect(fake.calls).toEqual([
      { command: C.GET_PORTALS, params: {} },
      { command: C.GET_TIME_SPECS, params: {} },
      { command: C.GET_HOLIDAYS, params: {} },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '102' } },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '104' } },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '106' } },
      { command: C.GET_TIME_SPEC_GROUPS, params: {} }, // step 2: found, no add
      {
        command: C.MODIFY_HOLIDAY, // step 3: the kept `first` segment
        params: { HOLIDAYKEY: '102', HOLIDAYNAME: 'P first', HOLIDAYGROUPS: '8', STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-03 00:00' },
      },
      {
        command: C.MODIFY_TIME_SPEC,
        params: { TIMESPECKEY: '103', NAME: 'P first', DESCRIPTION: MANAGED_DESCRIPTION, STARTTIME: '17:00', ENDTIME: '20:00', ...WEEKDAYS_OFF, HOLIDAYGROUPS: '8' },
      },
      { command: C.MODIFY_TIME_SPEC_GROUP, params: { TIMESPECGROUPKEY: '101', TIMESPECKEYS: { TIMESPECKEY: ['103'] } } }, // step 4
      { command: C.DELETE_TIME_SPEC, params: { TIMESPECKEY: '105' } }, // step 5: middle, spec then holiday
      { command: C.DELETE_HOLIDAY, params: { HOLIDAYKEY: '104' } },
      { command: C.DELETE_TIME_SPEC, params: { TIMESPECKEY: '107' } }, // last
      { command: C.DELETE_HOLIDAY, params: { HOLIDAYKEY: '106' } },
      { command: C.GET_PORTAL_GROUPS, params: {} }, // step 6: found, modify
      {
        command: C.MODIFY_PORTAL_GROUP,
        params: { PORTALGROUPKEY: '108', PORTALKEYS: { PORTALKEY: ['1', '2'] }, UNLOCKTIMESPECGROUPKEY: '101' },
      },
      { command: C.GET_PORTAL_GROUP, params: { PORTALGROUPKEY: '108' } }, // step 7
      { command: C.GET_TIME_SPEC_GROUPS, params: {} },
      { command: C.GET_TIME_SPEC, params: { TIMESPECKEY: '103' } },
      { command: C.GET_HOLIDAY, params: { HOLIDAYKEY: '102' } },
    ]);

    const json = parseSuccess(result.content[0].text);
    expect(json).toMatchObject({
      window: WINDOW_B,
      segments: [{ kind: 'first', holidayKey: '102', timeSpecKey: '103', STARTTIME: '17:00', ENDTIME: '20:00' }],
      timeSpecGroupKey: '101',
      portalGroupKey: '108',
      replacedPreviousWindow: true,
      verified: true,
    });
    expect(fake.holidays.map((holiday) => holiday.NAME)).toEqual(['P first']);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never', 'P first']);
    expect(fake.timeSpecGroups.find((group) => group.TIMESPECGROUPKEY === '101')?.TIMESPECKEYS).toEqual(['103']);
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
    fake.refuse(C.ADD_HOLIDAY, 'Duplicate', (params) => params.HOLIDAYNAME === 'P middle');
    const result = await scheduleTool(fake).handler({ ...WINDOW_A });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Step 3 .*"P middle".* failed: NetBox NBAPI command failed: Duplicate/);
    // Apply stopped at the failing AddHoliday; the rollback then ran (Get +
    // Delete for the "first" segment already written) but never reached step 6.
    expect(fake.commands()).not.toContain(C.ADD_PORTAL_GROUP);
    expect(fake.holidays.map((holiday) => holiday.NAME)).toEqual([]);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never']);
  });

  it('R25 failure handling: a step 6 failure (duplicate portal/time-spec-group name) rolls back the managed holidays and time specs before returning isError', async () => {
    const fake = freshController();
    fake.refuse(C.ADD_PORTAL_GROUP, 'Duplicate Portal Group');
    const result = await scheduleTool(fake).handler({ ...WINDOW_A });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Step 6 .*failed: NetBox NBAPI command failed: Duplicate Portal Group/);
    expect(result.content[0].text).toContain('Rolled back:');
    // No managed holiday or time spec survives the rollback (the managed
    // time spec group may remain, empty, or be gone — either is acceptable).
    expect(fake.holidays.map((holiday) => holiday.NAME)).toEqual([]);
    expect(fake.timeSpecs.map((spec) => spec.NAME)).toEqual(['Always', 'Never']);
    const tsg = fake.timeSpecGroups.find((group) => group.NAME === 'P time specs');
    if (tsg) expect(tsg.TIMESPECKEYS).toEqual([]);
    // No portal group was left behind either (AddPortalGroup itself failed).
    expect(fake.portalGroups.some((group) => group.NAME === 'P')).toBe(false);
  });

  it('a read-back mismatch (controller returns a different STARTTIME) is isError describing the field', async () => {
    const fake = freshController();
    fake.override(C.GET_TIME_SPEC, (params, respond) => {
      const normal = respond();
      if (params.TIMESPECKEY !== '103') return normal;
      const data = normal.data as { TIMESPEC: Record<string, string> };
      return { notFound: false, data: { TIMESPEC: { ...data.TIMESPEC, STARTTIME: '10:00' } } };
    });
    const result = await scheduleTool(fake).handler({ ...WINDOW_B, portalKeys: ['1'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Step 7 (read-back)');
    expect(result.content[0].text).toContain('time spec "P first" STARTTIME: expected "17:00", got "10:00"');
  });

  it('read-back normalises TRUE/FALSE weekday flags, HH:MM:SS times and YYYY-MM-DD HH:MM:SS dates (no false mismatch)', async () => {
    const fake = freshController();
    fake.override(C.GET_TIME_SPEC, (_params, respond) => {
      const data = respond().data as { TIMESPEC: Record<string, string> };
      return { notFound: false, data: { TIMESPEC: { ...data.TIMESPEC, STARTTIME: `${data.TIMESPEC.STARTTIME}:00`, ENDTIME: `${data.TIMESPEC.ENDTIME}:00` } } };
    });
    const result = await scheduleTool(fake).handler({ ...WINDOW_A, portalKeys: ['3'] });
    expect(result.isError).toBeUndefined();
    expect(parseSuccess(result.content[0].text).verified).toBe(true);
  });

  it('a duplicate managed-named holiday left over from a manual edit is deleted (only the first match is kept)', async () => {
    const fake = freshController();
    await scheduleTool(fake).handler({ ...WINDOW_B, portalKeys: ['1'] });
    const duplicateKey = fake.seedHoliday({ NAME: 'P first', HOLIDAYGROUPS: '8', STARTDATE: '2026-11-01 00:00', ENDDATE: '2026-11-02 00:00' });
    fake.calls = [];

    const result = await scheduleTool(fake).handler({ ...WINDOW_B, portalKeys: ['1'] });

    expect(result.isError).toBeUndefined();
    expect(fake.writeCalls().map((call) => [call.command, call.params.HOLIDAYKEY ?? call.params.TIMESPECKEY ?? call.params.PORTALGROUPKEY])).toEqual([
      [C.MODIFY_HOLIDAY, '102'],
      [C.MODIFY_TIME_SPEC, '103'],
      [C.MODIFY_TIME_SPEC_GROUP, undefined],
      [C.DELETE_HOLIDAY, duplicateKey],
      [C.MODIFY_PORTAL_GROUP, '104'],
    ]);
    expect(fake.holidays.map((holiday) => holiday.HOLIDAYKEY)).toEqual(['102']);
  });
});

describe('schedule_unlock_window (R28): idempotency', () => {
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
      C.MODIFY_HOLIDAY,
      C.MODIFY_TIME_SPEC,
      C.MODIFY_HOLIDAY,
      C.MODIFY_TIME_SPEC,
      C.MODIFY_TIME_SPEC_GROUP,
      C.MODIFY_PORTAL_GROUP,
    ]);
    expect(second.segments).toEqual(first.segments);
    expect(second.timeSpecGroupKey).toBe(first.timeSpecGroupKey);
    expect(second.portalGroupKey).toBe(first.portalGroupKey);
    expect(second.replacedPreviousWindow).toBe(true);
    expect(fake.holidays).toHaveLength(3);
    expect(fake.timeSpecs).toHaveLength(5);
    expect(fake.timeSpecGroups).toHaveLength(3);
    expect(fake.portalGroups).toHaveLength(1);
  });
});

describe('scheduleUnlockWindow executor (direct)', () => {
  it('falls back to finding an added object by name when the controller returns no key', async () => {
    const fake = freshController();
    fake.override(C.ADD_TIME_SPEC_GROUP, (_params, respond) => {
      respond();
      return { notFound: false, data: {} };
    });
    const result = await scheduleUnlockWindow(fake.client, { ...WINDOW_B, portalKeys: ['1'] }, SETTINGS);
    expect('verified' in result && result.verified).toBe(true);
    expect('timeSpecGroupKey' in result && result.timeSpecGroupKey).toBe('101');
  });
});
