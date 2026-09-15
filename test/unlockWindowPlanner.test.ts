import { describe, expect, it } from 'vitest';
import {
  UnlockPlanError,
  addDays,
  checkWindowLimits,
  formatLocalDateTime,
  parseLocalDateTime,
  planUnlockWindow,
} from '../src/unlockWindow/planner.js';

const GROUPS = [8, 7, 6] as const;

describe('planUnlockWindow (R23): the four required plans (groups 8,7,6, prefix P)', () => {
  it('2026-10-03 09:00 -> 2026-10-03 17:00: one `first` segment, holiday 10-03 -> 10-04, spec 09:00-17:00, group 8', () => {
    const plan = planUnlockWindow('2026-10-03 09:00', '2026-10-03 17:00', GROUPS, 'P');
    expect(plan.segments).toEqual([
      {
        kind: 'first',
        name: 'P first',
        holidayGroup: 8,
        STARTDATE: '2026-10-03 00:00',
        ENDDATE: '2026-10-04 00:00',
        STARTTIME: '09:00',
        ENDTIME: '17:00',
      },
    ]);
  });

  it('2026-10-03 18:00 -> 2026-10-04 00:00: identical to the same-day window ending 23:59 (one segment, 18:00-23:59)', () => {
    const toMidnight = planUnlockWindow('2026-10-03 18:00', '2026-10-04 00:00', GROUPS, 'P');
    expect(toMidnight.segments).toEqual([
      {
        kind: 'first',
        name: 'P first',
        holidayGroup: 8,
        STARTDATE: '2026-10-03 00:00',
        ENDDATE: '2026-10-04 00:00',
        STARTTIME: '18:00',
        ENDTIME: '23:59',
      },
    ]);
    const to2359 = planUnlockWindow('2026-10-03 18:00', '2026-10-03 23:59', GROUPS, 'P');
    expect(toMidnight.segments).toEqual(to2359.segments);
    expect(toMidnight.effective.end).toEqual(to2359.effective.end);
  });

  it('2026-10-03 18:00 -> 2026-10-04 09:00: first (18:00-23:59, 10-03 -> 10-04, g8) and last (00:00-09:00, 10-04 -> 10-05, g6); no middle', () => {
    const plan = planUnlockWindow('2026-10-03 18:00', '2026-10-04 09:00', GROUPS, 'P');
    expect(plan.segments).toEqual([
      {
        kind: 'first',
        name: 'P first',
        holidayGroup: 8,
        STARTDATE: '2026-10-03 00:00',
        ENDDATE: '2026-10-04 00:00',
        STARTTIME: '18:00',
        ENDTIME: '23:59',
      },
      {
        kind: 'last',
        name: 'P last',
        holidayGroup: 6,
        STARTDATE: '2026-10-04 00:00',
        ENDDATE: '2026-10-05 00:00',
        STARTTIME: '00:00',
        ENDTIME: '09:00',
      },
    ]);
  });

  it('2026-10-02 17:00 -> 2026-10-06 08:30: first (10-02, 17:00-23:59, g8), middle (10-03 -> 10-06, 00:00-23:59, g7), last (10-06, 00:00-08:30, g6)', () => {
    const plan = planUnlockWindow('2026-10-02 17:00', '2026-10-06 08:30', GROUPS, 'P');
    expect(plan.segments).toEqual([
      {
        kind: 'first',
        name: 'P first',
        holidayGroup: 8,
        STARTDATE: '2026-10-02 00:00',
        ENDDATE: '2026-10-03 00:00',
        STARTTIME: '17:00',
        ENDTIME: '23:59',
      },
      {
        kind: 'middle',
        name: 'P middle',
        holidayGroup: 7,
        STARTDATE: '2026-10-03 00:00',
        ENDDATE: '2026-10-06 00:00',
        STARTTIME: '00:00',
        ENDTIME: '23:59',
      },
      {
        kind: 'last',
        name: 'P last',
        holidayGroup: 6,
        STARTDATE: '2026-10-06 00:00',
        ENDDATE: '2026-10-07 00:00',
        STARTTIME: '00:00',
        ENDTIME: '08:30',
      },
    ]);
  });
});

describe('planUnlockWindow: derived fields, purity, and rejections', () => {
  it('reports the window as given, the groups used in segment order, and the date coverage', () => {
    const plan = planUnlockWindow('2026-10-02 17:00', '2026-10-06 08:30', GROUPS, 'MCP Unlock Window');
    expect(plan.window).toEqual({ start: '2026-10-02 17:00', end: '2026-10-06 08:30' });
    expect(plan.holidayGroupsUsed).toEqual([8, 7, 6]);
    expect(plan.coverage).toEqual({ STARTDATE: '2026-10-02 00:00', ENDDATE: '2026-10-07 00:00' });
    expect(plan.segments.map((segment) => segment.name)).toEqual([
      'MCP Unlock Window first',
      'MCP Unlock Window middle',
      'MCP Unlock Window last',
    ]);
  });

  it('a two-day window (adjacent dates) has first + last only', () => {
    const plan = planUnlockWindow('2026-10-02 17:00', '2026-10-03 08:30', GROUPS, 'P');
    expect(plan.segments.map((segment) => segment.kind)).toEqual(['first', 'last']);
    expect(plan.holidayGroupsUsed).toEqual([8, 6]);
  });

  it('is pure: identical inputs give deeply-equal plans and the groups array is not mutated', () => {
    const groups = [8, 7, 6];
    const a = planUnlockWindow('2026-10-02 17:00', '2026-10-06 08:30', groups, 'P');
    const b = planUnlockWindow('2026-10-02 17:00', '2026-10-06 08:30', groups, 'P');
    expect(a).toEqual(b);
    expect(groups).toEqual([8, 7, 6]);
  });

  it('rejects a malformed start or end', () => {
    expect(() => planUnlockWindow('2026/10/03 09:00', '2026-10-03 17:00', GROUPS, 'P')).toThrow(UnlockPlanError);
    expect(() => planUnlockWindow('2026-10-03 09:00', '2026-10-03T17:00', GROUPS, 'P')).toThrow(/end must be a real calendar date-time/);
    expect(() => planUnlockWindow('2026-10-03', '2026-10-03 17:00', GROUPS, 'P')).toThrow(/start must be/);
  });

  it('rejects impossible calendar date-times (Feb 30, month 13, 24:00)', () => {
    expect(() => planUnlockWindow('2026-02-30 09:00', '2026-03-01 17:00', GROUPS, 'P')).toThrow(UnlockPlanError);
    expect(() => planUnlockWindow('2026-10-03 09:00', '2026-13-03 17:00', GROUPS, 'P')).toThrow(UnlockPlanError);
    expect(() => planUnlockWindow('2026-10-03 24:00', '2026-10-04 17:00', GROUPS, 'P')).toThrow(UnlockPlanError);
  });

  it('rejects end <= start (including equal)', () => {
    expect(() => planUnlockWindow('2026-10-03 17:00', '2026-10-03 09:00', GROUPS, 'P')).toThrow(/must be later than start/);
    expect(() => planUnlockWindow('2026-10-03 09:00', '2026-10-03 09:00', GROUPS, 'P')).toThrow(/must be later than start/);
  });

  it('refuses a plan whose segments outnumber the configured reserved groups instead of sharing a group', () => {
    expect(planUnlockWindow('2026-10-03 09:00', '2026-10-03 17:00', [8], 'P').segments).toHaveLength(1);
    expect(() => planUnlockWindow('2026-10-03 18:00', '2026-10-04 09:00', [8], 'P')).toThrow(/NETBOX_UNLOCK_HOLIDAY_GROUPS/);
    expect(() => planUnlockWindow('2026-10-02 17:00', '2026-10-06 08:30', [8, 7], 'P')).toThrow(/"last" segment/);
  });
});

describe('checkWindowLimits (R22): host clock and the 31-day cap', () => {
  const now = new Date(2026, 8, 14, 12, 0); // 2026-09-14 12:00 local

  it('rejects a window whose end is not later than now (host clock)', () => {
    expect(() => checkWindowLimits('2026-09-14 09:00', '2026-09-14 11:00', now)).toThrow(/not later than the current time/);
    expect(() => checkWindowLimits('2026-09-14 09:00', '2026-09-14 12:00', now)).toThrow(/not later than the current time/);
    expect(() => checkWindowLimits('2026-09-14 09:00', '2026-09-14 12:01', now)).not.toThrow();
  });

  it('accepts exactly 31 days and rejects anything longer', () => {
    expect(() => checkWindowLimits('2026-10-01 00:00', '2026-11-01 00:00', now)).not.toThrow();
    expect(() => checkWindowLimits('2026-10-01 00:00', '2026-11-01 00:01', now)).toThrow(/longer than 31 days/);
  });
});

describe('date helpers', () => {
  it('parseLocalDateTime accepts real leap days and rejects fake ones or loose formats', () => {
    expect(parseLocalDateTime('2028-02-29 00:00')).toMatchObject({ date: '2028-02-29', time: '00:00' });
    expect(parseLocalDateTime('2027-02-29 00:00')).toBeUndefined();
    expect(parseLocalDateTime('2026-1-1 00:00')).toBeUndefined();
    expect(parseLocalDateTime('2026-10-03 9:00')).toBeUndefined();
  });

  it('addDays crosses month and year boundaries in both directions', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('formatLocalDateTime renders a host Date as controller-local YYYY-MM-DD HH:MM', () => {
    expect(formatLocalDateTime(new Date(2026, 9, 3, 9, 5))).toBe('2026-10-03 09:05');
  });
});
