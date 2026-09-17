import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LIVE_CHECK_ACTIONS,
  LIVE_CHECK_ACTION_NAMES,
  buildActionParams,
  formatLocationKeys,
  formatUsernameRequirementFinding,
  resolveLiveCheckAction,
} from '../scripts/liveCheckWriteHelpers.js';
import { NBAPI_COMMANDS } from '../src/commands.js';

/**
 * Unit tests for the helpers and steps added to the live WRITE script by
 * specs/nbapi-v2-full-conformance.md R11. The script itself is never executed
 * here (it writes to a real controller on import); the pure helpers are tested
 * directly and the step wiring is asserted by reading the script's source, the
 * same technique test/liveCheckWrite.test.ts already uses.
 */
const script = readFileSync(fileURLToPath(new URL('../scripts/live-check-write.ts', import.meta.url)), 'utf8');

describe('formatLocationKeys (R11 d)', () => {
  it('joins keys with commas, preserving discovery order', () => {
    expect(formatLocationKeys(['3', '7', '11'])).toBe('3,7,11');
  });

  it('de-duplicates, trims and drops blanks', () => {
    expect(formatLocationKeys([' 3 ', '3', '', '   ', '7'])).toBe('3,7');
  });

  it('returns an empty string when there is nothing usable, so the caller can SKIP-pass', () => {
    expect(formatLocationKeys([])).toBe('');
    expect(formatLocationKeys(['', ' '])).toBe('');
  });
});

describe('formatUsernameRequirementFinding (R11 c / R12)', () => {
  it('states the SUCCESS answer to the #79 question', () => {
    const finding = formatUsernameRequirementFinding({ succeeded: true });
    expect(finding).toContain('SUCCEEDED');
    expect(finding).toContain('USERNAME does not make');
    expect(finding).toContain('optional is correct');
  });

  it('states the FAIL answer and quotes the controller ERRMSG verbatim', () => {
    const finding = formatUsernameRequirementFinding({ succeeded: false, errmsg: 'Missing ROLE.' });
    expect(finding).toContain('FAILED');
    expect(finding).toContain('"Missing ROLE."');
    expect(finding).toContain('mandatory once USERNAME is set');
  });

  it('tolerates a missing ERRMSG without producing "undefined"', () => {
    expect(formatUsernameRequirementFinding({ succeeded: false })).not.toContain('undefined');
  });
});

describe('set_threat_level_locations supervised action (R11 d)', () => {
  it('is in the action table, wraps SetThreatLevel, and requires both --value and discovered LOCATIONKEYS', () => {
    expect(LIVE_CHECK_ACTION_NAMES).toContain('set_threat_level_locations');
    expect(resolveLiveCheckAction('set_threat_level_locations')).toBe(LIVE_CHECK_ACTIONS.set_threat_level_locations);
    expect(LIVE_CHECK_ACTIONS.set_threat_level_locations).toMatchObject({
      kind: 'command',
      command: NBAPI_COMMANDS.SET_THREAT_LEVEL,
      targetsOutput: false,
      requiresValue: true,
      needsLocationKeys: true,
    });
  });

  it('builds LEVELNAME + LOCATIONKEYS params, leaving PORTALKEY/OUTPUTKEY out', () => {
    expect(
      buildActionParams(LIVE_CHECK_ACTIONS.set_threat_level_locations, { PORTALKEY: '56', LOCATIONKEYS: '1,2' }, 'High')
    ).toEqual({ LEVELNAME: 'High', LOCATIONKEYS: '1,2' });
  });

  it('leaves the unscoped set_threat_level action unchanged (no LOCATIONKEYS)', () => {
    expect(buildActionParams(LIVE_CHECK_ACTIONS.set_threat_level, { PORTALKEY: '56', LOCATIONKEYS: '1,2' }, 'High')).toEqual({
      LEVELNAME: 'High',
    });
    expect(LIVE_CHECK_ACTIONS.set_threat_level.needsLocationKeys).toBeUndefined();
  });

  it('is the only action that needs location keys', () => {
    const needing = LIVE_CHECK_ACTION_NAMES.filter((name) => LIVE_CHECK_ACTIONS[name].needsLocationKeys);
    expect(needing).toEqual(['set_threat_level_locations']);
  });

  it('its observe line tells the operator how to put the threat level back', () => {
    expect(LIVE_CHECK_ACTIONS.set_threat_level_locations.observe({ portalName: '02OF01A', value: 'High' })).toContain(
      '--action set_threat_level --value Default'
    );
  });
});

describe('scripts/live-check-write.ts: the R11 steps are wired in as default steps', () => {
  const STEP_NEEDLES: ReadonlyArray<readonly [string, string]> = [
    ['a: modify_time_spec NAME rename', "step('modify_time_spec (NAME rename) -> get_time_specs shows the new name'"],
    ['b: add_time_spec_group seeded TIMESPECKEYS', "step('add_time_spec_group (TIMESPECKEYS seeded) -> get_time_spec_groups shows the member'"],
    ['c1: add_person without USERNAME/ROLE/AUTHTYPE', "step('add_person WITHOUT USERNAME/ROLE/AUTHTYPE -> get_person (regression guard, #79)'"],
    ['c2: add_person with USERNAME', "step('add_person WITH USERNAME but no ROLE/AUTHTYPE (#79 finding — both outcomes pass)'"],
    ['e: add_duty_log', "step('add_duty_log (temp person) -> SUCCESS or a documented FAIL'"],
  ];

  for (const [label, needle] of STEP_NEEDLES) {
    it(`contains step ${label}`, () => {
      expect(script.includes(needle)).toBe(true);
    });
  }

  it('step (a) renames through the LIVE_PREFIX-carrying name, so cleanup still finds an aborted run', () => {
    expect(script).toContain('timeSpecRenamed: `${LIVE_PREFIX} timespec renamed`');
    expect(script).toContain('timeSpecGroupSeeded: `${LIVE_PREFIX} tsg seeded`');
  });

  it('step (b) deletes the seeded group it created, in a finally block', () => {
    const seeded = script.slice(script.indexOf("step('add_time_spec_group (TIMESPECKEYS seeded)"));
    expect(seeded.slice(0, 2000)).toContain('NBAPI_COMMANDS.DELETE_TIME_SPEC_GROUP');
    expect(seeded.slice(0, 2000)).toContain('} finally {');
  });

  it('step (c2) removes the #79 probe person it may have created', () => {
    const probe = script.slice(script.indexOf("step('add_person WITH USERNAME"));
    expect(probe.slice(0, 2000)).toContain('NBAPI_COMMANDS.REMOVE_PERSON');
    expect(probe.slice(0, 2000)).toContain('formatUsernameRequirementFinding');
  });

  it('step (e) uses the temp person and an MCP livecheck-prefixed LOGTEXT', () => {
    const duty = script.slice(script.indexOf("step('add_duty_log (temp person)"));
    expect(duty.slice(0, 1200)).toContain('NBAPI_COMMANDS.ADD_DUTY_LOG');
    expect(duty.slice(0, 1200)).toContain('${LIVE_PREFIX} duty log');
    expect(duty.slice(0, 1200)).toContain('PERSONID: personId');
  });

  it('SetThreatLevel is reachable only through the supervised --action table, never as a default step', () => {
    // The script itself must never issue SetThreatLevel directly; the only
    // route is LIVE_CHECK_ACTIONS, which runSingleAction drives (R11 d).
    expect(script).not.toContain('NBAPI_COMMANDS.SET_THREAT_LEVEL');
  });

  it('the LOCATIONKEYS discovery path SKIP-passes when GetLocations returns nothing', () => {
    expect(script).toContain('NBAPI_COMMANDS.GET_LOCATIONS');
    expect(script).toContain('formatLocationKeys');
    expect(script).toContain('needs at least one location');
  });
});
