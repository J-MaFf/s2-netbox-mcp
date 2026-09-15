import { describe, expect, it } from 'vitest';
import {
  DailyPlanError,
  addDays,
  checkDailyWindowLimits,
  dailyScheduleName,
  daysBetween,
  formatLocalDateTime,
  parseLocalDate,
  parseLocalTime,
  planDailyUnlockWindow,
} from '../src/unlockWindow/dailyPlanner.js';

describe('planDailyUnlockWindow (R2): the two required plans (group 5, prefix P)', () => {
  it('startDate=endDate=2026-09-16, 05:00-22:00: holiday 2026-09-16 00:00 -> 2026-09-17 00:00, spec 05:00-22:00, group 5', () => {
    const plan = planDailyUnlockWindow('2026-09-16', '2026-09-16', '05:00', '22:00', 5, 'P');
    expect(plan).toEqual({
      window: { startDate: '2026-09-16', endDate: '2026-09-16', dailyStartTime: '05:00', dailyEndTime: '22:00' },
      name: 'P schedule',
      holidayGroup: 5,
      STARTDATE: '2026-09-16 00:00',
      ENDDATE: '2026-09-17 00:00',
      STARTTIME: '05:00',
      ENDTIME: '22:00',
    });
  });

  it('startDate=2026-09-16, endDate=2026-09-19, 05:00-22:00: one segment covering all 4 dates, holiday 2026-09-16 -> 2026-09-20', () => {
    const plan = planDailyUnlockWindow('2026-09-16', '2026-09-19', '05:00', '22:00', 5, 'P');
    expect(plan).toEqual({
      window: { startDate: '2026-09-16', endDate: '2026-09-19', dailyStartTime: '05:00', dailyEndTime: '22:00' },
      name: 'P schedule',
      holidayGroup: 5,
      STARTDATE: '2026-09-16 00:00',
      ENDDATE: '2026-09-20 00:00',
      STARTTIME: '05:00',
      ENDTIME: '22:00',
    });
  });
});

describe('dailyScheduleName', () => {
  it('is "<prefix> schedule" — the NAME of both the managed holiday and the managed time spec', () => {
    expect(dailyScheduleName('MCP Daily Unlock Window')).toBe('MCP Daily Unlock Window schedule');
    expect(dailyScheduleName('P')).toBe('P schedule');
  });
});

describe('planDailyUnlockWindow: purity and rejections (R3)', () => {
  it('is pure: identical inputs give deeply-equal plans', () => {
    const a = planDailyUnlockWindow('2026-09-16', '2026-09-19', '05:00', '22:00', 5, 'P');
    const b = planDailyUnlockWindow('2026-09-16', '2026-09-19', '05:00', '22:00', 5, 'P');
    expect(a).toEqual(b);
  });

  it('rejects a malformed startDate/endDate (not a real calendar date)', () => {
    expect(() => planDailyUnlockWindow('2026/09/16', '2026-09-16', '05:00', '22:00', 5, 'P')).toThrow(DailyPlanError);
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-09-16', '05:00', '22:00', 5, 'P')).not.toThrow();
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-13-01', '05:00', '22:00', 5, 'P')).toThrow(/endDate must be a real calendar date/);
    expect(() => planDailyUnlockWindow('2026-02-30', '2026-09-16', '05:00', '22:00', 5, 'P')).toThrow(/startDate must be a real calendar date/);
  });

  it('rejects a malformed dailyStartTime/dailyEndTime (not a real HH:MM time)', () => {
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-09-16', '5:00', '22:00', 5, 'P')).toThrow(/dailyStartTime must be a real clock time/);
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-09-16', '05:00', '24:00', 5, 'P')).toThrow(/dailyEndTime must be a real clock time/);
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-09-16', '05:00', '22:60', 5, 'P')).toThrow(DailyPlanError);
  });

  it('rejects endDate earlier than startDate', () => {
    expect(() => planDailyUnlockWindow('2026-09-19', '2026-09-16', '05:00', '22:00', 5, 'P')).toThrow(/endDate .* must not be earlier than startDate/);
  });

  it('accepts endDate === startDate', () => {
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-09-16', '05:00', '22:00', 5, 'P')).not.toThrow();
  });

  it('rejects dailyEndTime <= dailyStartTime, including an overnight-crossing window (Out of scope)', () => {
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-09-16', '22:00', '05:00', 5, 'P')).toThrow(/overnight-crossing daily window is not supported/);
    expect(() => planDailyUnlockWindow('2026-09-16', '2026-09-16', '09:00', '09:00', 5, 'P')).toThrow(/dailyEndTime .* must be later than dailyStartTime/);
  });
});

describe('checkDailyWindowLimits (R3): host clock and the 31-day cap', () => {
  const now = new Date(2026, 8, 14, 12, 0); // 2026-09-14 12:00 local

  it('rejects a window whose last instant is not later than now (host clock)', () => {
    expect(() => checkDailyWindowLimits('2026-09-10', '2026-09-14', '11:00', now)).toThrow(/not later than the current time/);
    expect(() => checkDailyWindowLimits('2026-09-10', '2026-09-14', '12:00', now)).toThrow(/not later than the current time/);
    expect(() => checkDailyWindowLimits('2026-09-10', '2026-09-14', '12:01', now)).not.toThrow();
  });

  it('accepts exactly 31 days and rejects anything longer', () => {
    expect(() => checkDailyWindowLimits('2026-10-01', '2026-11-01', '23:59', now)).not.toThrow();
    expect(() => checkDailyWindowLimits('2026-10-01', '2026-11-02', '23:59', now)).toThrow(/longer than 31 days/);
  });
});

describe('date/time helpers', () => {
  it('parseLocalDate accepts real leap days and rejects fake ones or loose formats', () => {
    expect(parseLocalDate('2028-02-29')).toMatchObject({ date: '2028-02-29' });
    expect(parseLocalDate('2027-02-29')).toBeUndefined();
    expect(parseLocalDate('2026-1-1')).toBeUndefined();
    expect(parseLocalDate('2026-09-16 00:00')).toBeUndefined();
  });

  it('parseLocalTime accepts real clock times and rejects out-of-range or loose formats', () => {
    expect(parseLocalTime('09:00')).toMatchObject({ time: '09:00', hour: 9, minute: 0 });
    expect(parseLocalTime('23:59')).toMatchObject({ hour: 23, minute: 59 });
    expect(parseLocalTime('24:00')).toBeUndefined();
    expect(parseLocalTime('09:60')).toBeUndefined();
    expect(parseLocalTime('9:00')).toBeUndefined();
  });

  it('addDays crosses month and year boundaries in both directions', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('daysBetween measures whole days between two dates', () => {
    expect(daysBetween('2026-09-16', '2026-09-16')).toBe(0);
    expect(daysBetween('2026-09-16', '2026-09-19')).toBe(3);
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });

  it('formatLocalDateTime renders a host Date as controller-local YYYY-MM-DD HH:MM', () => {
    expect(formatLocalDateTime(new Date(2026, 9, 3, 9, 5))).toBe('2026-10-03 09:05');
  });
});
