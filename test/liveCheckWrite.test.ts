import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LIVE_PREFIX,
  LiveAssertionError,
  LiveCheckArgError,
  assertEqual,
  assertSameSet,
  assertTrue,
  clockOf,
  computeTestWindow,
  parseLiveCheckWriteArgs,
} from '../scripts/liveCheckWriteHelpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('live-check-write helpers (R30)', () => {
  it('uses the distinct "MCP livecheck" prefix for its CRUD objects', () => {
    expect(LIVE_PREFIX).toBe('MCP livecheck');
  });

  describe('parseLiveCheckWriteArgs', () => {
    it('defaults to no go-ahead and no pinned start', () => {
      expect(parseLiveCheckWriteArgs([])).toEqual({ go: false });
    });

    it('accepts --go and --start HH:MM (both spellings)', () => {
      expect(parseLiveCheckWriteArgs(['--go'])).toEqual({ go: true });
      expect(parseLiveCheckWriteArgs(['--go', '--start', '14:30'])).toEqual({ go: true, start: '14:30' });
      expect(parseLiveCheckWriteArgs(['--start=09:05'])).toEqual({ go: false, start: '09:05' });
    });

    it('rejects a missing or malformed --start value and unknown arguments', () => {
      expect(() => parseLiveCheckWriteArgs(['--start'])).toThrow(LiveCheckArgError);
      expect(() => parseLiveCheckWriteArgs(['--start', '9:30'])).toThrow(/HH:MM/);
      expect(() => parseLiveCheckWriteArgs(['--bogus'])).toThrow(/Unknown argument "--bogus"/);
    });
  });

  describe('computeTestWindow', () => {
    const now = new Date(2026, 8, 14, 12, 0, 37); // 2026-09-14 12:00:37 local

    it('defaults to unlock at now + 2 min (seconds dropped) and relock 2 min later, polling until relock + 1 min', () => {
      const window = computeTestWindow(now);
      expect(window).toMatchObject({
        start: '2026-09-14 12:02',
        end: '2026-09-14 12:04',
        unlockClock: '12:02',
        relockClock: '12:04',
      });
      expect(window.endMs - window.startMs).toBe(2 * 60_000);
      expect(window.pollUntilMs - window.endMs).toBe(60_000);
      expect(window.startMs).toBe(new Date(2026, 8, 14, 12, 2, 0).getTime());
    });

    it('pins the unlock to --start HH:MM today when it is 1-60 minutes ahead', () => {
      expect(computeTestWindow(now, '12:30')).toMatchObject({ start: '2026-09-14 12:30', end: '2026-09-14 12:32', unlockClock: '12:30', relockClock: '12:32' });
      expect(computeTestWindow(now, '13:00').start).toBe('2026-09-14 13:00');
    });

    it('rejects a --start that is in the past, under a minute ahead, more than an hour ahead, or not a clock time', () => {
      expect(() => computeTestWindow(now, '11:00')).toThrow(/between 1 and 60 minutes ahead/);
      expect(() => computeTestWindow(now, '12:01')).toThrow(/between 1 and 60 minutes ahead/);
      expect(() => computeTestWindow(now, '13:01')).toThrow(/between 1 and 60 minutes ahead/);
      expect(() => computeTestWindow(now, '25:00')).toThrow(LiveCheckArgError);
    });

    it('clockOf renders HH:MM', () => {
      expect(clockOf(new Date(2026, 8, 14, 7, 5))).toBe('07:05');
    });
  });

  describe('assertions', () => {
    it('assertEqual / assertTrue / assertSameSet throw LiveAssertionError carrying the label', () => {
      expect(() => assertEqual('NAME', 'a', 'b')).toThrow(LiveAssertionError);
      expect(() => assertEqual('NAME', 'a', 'b')).toThrow(/NAME: expected "b", got "a"/);
      expect(() => assertEqual('NAME', 'a', 'a')).not.toThrow();
      expect(() => assertTrue('verified', false)).toThrow(/verified/);
      expect(() => assertSameSet('keys', ['1', '2'], ['2', '1'])).not.toThrow();
      expect(() => assertSameSet('keys', ['1'], ['1', '2'])).toThrow(/keys: expected \[1,2\], got \[1\]/);
    });
  });
});

describe('scripts/live-check-write.ts scope (R30 d) and wiring', () => {
  const script = readFileSync(`${ROOT}scripts/live-check-write.ts`, 'utf8');
  const readScript = readFileSync(`${ROOT}scripts/live-check.ts`, 'utf8');
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { scripts: Record<string, string> };

  it('never references a person, credential, access level, threat level, output, event, partition, UDF, or portal-action command', () => {
    const forbidden = [
      'ADD_PERSON', 'MODIFY_PERSON', 'REMOVE_PERSON',
      'ADD_CREDENTIAL', 'MODIFY_CREDENTIAL', 'REMOVE_CREDENTIAL',
      'ADD_ACCESS_LEVEL', 'MODIFY_ACCESS_LEVEL', 'DELETE_ACCESS_LEVEL',
      'ADD_ACCESS_LEVEL_GROUP', 'MODIFY_ACCESS_LEVEL_GROUP', 'DELETE_ACCESS_LEVEL_GROUP',
      'SET_THREAT_LEVEL', 'ADD_THREAT_LEVEL', 'MODIFY_THREAT_LEVEL', 'REMOVE_THREAT_LEVEL',
      'ADD_THREAT_LEVEL_GROUP', 'MODIFY_THREAT_LEVEL_GROUP', 'REMOVE_THREAT_LEVEL_GROUP',
      'ACTIVATE_OUTPUT', 'DEACTIVATE_OUTPUT',
      'TRIGGER_EVENT', 'INSERT_ACTIVITY',
      'ADD_PARTITION', 'SWITCH_PARTITION', 'MODIFY_UDF_LIST_ITEMS',
      'LOCK_PORTAL', 'UNLOCK_PORTAL', 'MOMENTARY_UNLOCK_PORTAL', 'DOG_ON_NEXT_EXIT_PORTAL',
    ];
    const offenders = forbidden.filter((constant) => script.includes(`NBAPI_COMMANDS.${constant}`));
    expect(offenders).toEqual([]);
  });

  it('the read-only live check (R29) references no write command constant at all', () => {
    const writeConstants = readScript.match(/NBAPI_COMMANDS\.(ADD|MODIFY|DELETE|REMOVE|SET|ACTIVATE|DEACTIVATE|LOCK|UNLOCK|MOMENTARY|DOG|TRIGGER|INSERT|SWITCH)_[A-Z_]+/g) ?? [];
    expect(writeConstants).toEqual([]);
  });

  it('gates phase (c) on --go, prints the HEADS-UP and OBSERVE lines, and polls every 30 s', () => {
    expect(script).toContain('--go');
    expect(script).toContain('if (!args.go)');
    expect(script).toContain('HEADS-UP: scheduling a 2-minute unlock of portal');
    expect(script).toContain('OBSERVE: portal');
    expect(script).toContain('30_000');
    expect(script).toContain('cancelUnlockWindow');
  });

  it('package.json wires test:live:write to the script and npm test never runs it', () => {
    expect(pkg.scripts['test:live:write']).toBe('tsx scripts/live-check-write.ts');
    expect(pkg.scripts.test).not.toContain('live');
  });
});
