import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NBAPI_COMMANDS } from '../src/commands.js';
import {
  LIVE_CHECK_ACTIONS,
  LIVE_CHECK_ACTION_NAMES,
  LIVE_PREFIX,
  LiveAssertionError,
  LiveCheckActionError,
  LiveCheckArgError,
  assertEqual,
  assertSameSet,
  assertTrue,
  buildActionParams,
  clockOf,
  computeClockSkew,
  computeTestWindow,
  estimateControllerClock,
  findStrikeOutput,
  formatClockHMS,
  formatDurationHMS,
  isPortalStateNotChangedError,
  parseCardFormatName,
  parseControllerDttm,
  parseLiveCheckWriteArgs,
  resolveLiveCheckAction,
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

    it('accepts --action and --value (both spellings)', () => {
      expect(parseLiveCheckWriteArgs(['--action', 'unlock_portal'])).toEqual({ go: false, action: 'unlock_portal' });
      expect(parseLiveCheckWriteArgs(['--action=lock_portal'])).toEqual({ go: false, action: 'lock_portal' });
      expect(parseLiveCheckWriteArgs(['--action', 'set_threat_level', '--value', 'High'])).toEqual({
        go: false,
        action: 'set_threat_level',
        value: 'High',
      });
      expect(parseLiveCheckWriteArgs(['--action=set_threat_level', '--value=High'])).toEqual({
        go: false,
        action: 'set_threat_level',
        value: 'High',
      });
    });

    it('rejects a missing --action or --value value', () => {
      expect(() => parseLiveCheckWriteArgs(['--action'])).toThrow(LiveCheckArgError);
      expect(() => parseLiveCheckWriteArgs(['--action', 'unlock_portal', '--value'])).toThrow(LiveCheckArgError);
      expect(() => parseLiveCheckWriteArgs(['--action='])).toThrow(LiveCheckArgError);
    });

    it('refuses --action combined with --go with a LiveCheckActionError (exit-2 case), before any other validation', () => {
      expect(() => parseLiveCheckWriteArgs(['--action', 'unlock_portal', '--go'])).toThrow(LiveCheckActionError);
      expect(() => parseLiveCheckWriteArgs(['--go', '--action', 'unlock_portal'])).toThrow(/cannot be combined with --go/);
    });
  });

  describe('supervised single-action mode (#12)', () => {
    describe('resolveLiveCheckAction', () => {
      it('resolves every documented action name to a spec built from NBAPI_COMMANDS constants', () => {
        for (const name of LIVE_CHECK_ACTION_NAMES) {
          const spec = resolveLiveCheckAction(name);
          expect(spec.name).toBe(name);
          if (spec.kind === 'command') {
            expect(spec.command).toBeTruthy();
          } else {
            expect(spec.portalStateAction).toBeTruthy();
          }
        }
      });

      it('throws LiveCheckActionError with the full supported list for an unknown action', () => {
        expect(() => resolveLiveCheckAction('bogus_action')).toThrow(LiveCheckActionError);
        try {
          resolveLiveCheckAction('bogus_action');
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(LiveCheckActionError);
          for (const name of LIVE_CHECK_ACTION_NAMES) {
            expect((err as Error).message).toContain(name);
          }
        }
      });
    });

    it('maps each action to the exact NBAPI_COMMANDS constant (or setPortalsState action) it sends — never a literal', () => {
      expect(LIVE_CHECK_ACTIONS.unlock_portal).toMatchObject({ kind: 'command', command: NBAPI_COMMANDS.UNLOCK_PORTAL, targetsOutput: false });
      expect(LIVE_CHECK_ACTIONS.lock_portal).toMatchObject({ kind: 'command', command: NBAPI_COMMANDS.LOCK_PORTAL, targetsOutput: false });
      expect(LIVE_CHECK_ACTIONS.momentary_unlock_portal).toMatchObject({
        kind: 'command',
        command: NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL,
        targetsOutput: false,
      });
      expect(LIVE_CHECK_ACTIONS.dog_on_next_exit_portal).toMatchObject({
        kind: 'command',
        command: NBAPI_COMMANDS.DOG_ON_NEXT_EXIT_PORTAL,
        targetsOutput: false,
      });
      expect(LIVE_CHECK_ACTIONS.activate_output).toMatchObject({ kind: 'command', command: NBAPI_COMMANDS.ACTIVATE_OUTPUT, targetsOutput: true });
      expect(LIVE_CHECK_ACTIONS.deactivate_output).toMatchObject({
        kind: 'command',
        command: NBAPI_COMMANDS.DEACTIVATE_OUTPUT,
        targetsOutput: true,
      });
      expect(LIVE_CHECK_ACTIONS.set_portals_state_unlock).toMatchObject({ kind: 'setPortalsState', portalStateAction: 'UNLOCK' });
      expect(LIVE_CHECK_ACTIONS.set_portals_state_lock).toMatchObject({ kind: 'setPortalsState', portalStateAction: 'LOCK' });
      expect(LIVE_CHECK_ACTIONS.set_portals_state_momentary).toMatchObject({ kind: 'setPortalsState', portalStateAction: 'MOMENTARY_UNLOCK' });
      expect(LIVE_CHECK_ACTIONS.set_threat_level).toMatchObject({
        kind: 'command',
        command: NBAPI_COMMANDS.SET_THREAT_LEVEL,
        requiresValue: true,
      });
      expect(LIVE_CHECK_ACTIONS.trigger_event_activate).toMatchObject({
        kind: 'command',
        command: NBAPI_COMMANDS.TRIGGER_EVENT,
        targetsOutput: false,
        requiresValue: true,
      });
      expect(LIVE_CHECK_ACTIONS.trigger_event_deactivate).toMatchObject({
        kind: 'command',
        command: NBAPI_COMMANDS.TRIGGER_EVENT,
        targetsOutput: false,
        requiresValue: true,
      });
    });

    it('only set_threat_level and the two trigger_event actions require --value', () => {
      const requiresValueNames = new Set(['set_threat_level', 'trigger_event_activate', 'trigger_event_deactivate']);
      for (const name of LIVE_CHECK_ACTION_NAMES) {
        expect(LIVE_CHECK_ACTIONS[name].requiresValue).toBe(requiresValueNames.has(name));
      }
    });

    it('AddPartition is not reachable through any action in the table; TriggerEvent is reachable only via the two named trigger_event actions, each requiring --value', () => {
      const entries = Object.values(LIVE_CHECK_ACTIONS);
      const commands = entries.map((spec) => spec.command);
      expect(commands).not.toContain(NBAPI_COMMANDS.ADD_PARTITION);
      const triggerEventActions = entries.filter((spec) => spec.command === NBAPI_COMMANDS.TRIGGER_EVENT);
      expect(triggerEventActions.map((spec) => spec.name).sort()).toEqual(['trigger_event_activate', 'trigger_event_deactivate']);
      for (const spec of triggerEventActions) {
        expect(spec.requiresValue).toBe(true);
      }
    });

    describe('OBSERVE text', () => {
      it('unlock_portal / lock_portal name each other as the reversing action', () => {
        expect(LIVE_CHECK_ACTIONS.unlock_portal.observe({ portalName: '02OF01A EL' })).toBe(
          'OBSERVE: 02OF01A EL should be unlocked now (Extended Unlock) until lock_portal is run'
        );
        expect(LIVE_CHECK_ACTIONS.lock_portal.observe({ portalName: '02OF01A EL' })).toBe('OBSERVE: 02OF01A EL should be locked now');
      });

      it('dog_on_next_exit_portal names lock_portal as the reversing action', () => {
        expect(LIVE_CHECK_ACTIONS.dog_on_next_exit_portal.observe({ portalName: 'Lobby' })).toContain('until lock_portal is run');
      });

      it('activate_output / deactivate_output name each other as the reversing action', () => {
        expect(LIVE_CHECK_ACTIONS.activate_output.observe({ portalName: 'Lobby' })).toContain('until deactivate_output is run');
        expect(LIVE_CHECK_ACTIONS.deactivate_output.observe({ portalName: 'Lobby' })).toContain('inactive');
      });

      it('set_portals_state_unlock / set_portals_state_lock name each other as the reversing action', () => {
        expect(LIVE_CHECK_ACTIONS.set_portals_state_unlock.observe({ portalName: 'Lobby' })).toContain('until set_portals_state_lock is run');
        expect(LIVE_CHECK_ACTIONS.set_portals_state_lock.observe({ portalName: 'Lobby' })).toBe('OBSERVE: Lobby should be locked now');
      });

      it('set_threat_level echoes --value and names Default as the reversing value', () => {
        const line = LIVE_CHECK_ACTIONS.set_threat_level.observe({ portalName: 'Lobby', value: 'High' });
        expect(line).toContain('"High"');
        expect(line).toContain('--value Default');
      });

      it('trigger_event_activate / trigger_event_deactivate echo the event name and name each other as the reversing action', () => {
        const activated = LIVE_CHECK_ACTIONS.trigger_event_activate.observe({ portalName: '02OF01A', value: 'Door Alarm' });
        expect(activated).toContain('event Door Alarm activated');
        expect(activated).toContain('02OF01A');
        expect(activated).toContain('trigger_event_deactivate');
        const deactivated = LIVE_CHECK_ACTIONS.trigger_event_deactivate.observe({ portalName: '02OF01A', value: 'Door Alarm' });
        expect(deactivated).toContain('event Door Alarm deactivated');
        expect(deactivated).toContain('02OF01A');
      });
    });

    describe('findStrikeOutput', () => {
      it('finds the first GetOutputs entry whose NAME starts with the portal NAME', () => {
        const outputs = [
          { NAME: '01OF01A EL', OUTPUTKEY: '10' },
          { NAME: '02OF01A EL', OUTPUTKEY: '11' },
          { NAME: '02OF01A EL 2', OUTPUTKEY: '12' },
        ];
        expect(findStrikeOutput('02OF01A', outputs)).toEqual({ NAME: '02OF01A EL', OUTPUTKEY: '11' });
      });

      it('returns undefined when no output NAME starts with the portal NAME', () => {
        expect(findStrikeOutput('Nonexistent', [{ NAME: '01OF01A EL', OUTPUTKEY: '10' }])).toBeUndefined();
      });
    });

    describe('isPortalStateNotChangedError', () => {
      it('matches the controller\'s no-op ERRMSG, case-insensitively', () => {
        expect(isPortalStateNotChangedError('Portal state not changed')).toBe(true);
        expect(isPortalStateNotChangedError('portal state NOT CHANGED')).toBe(true);
      });

      it('does not match other ERRMSGs, or undefined', () => {
        expect(isPortalStateNotChangedError('Invalid portal key')).toBe(false);
        expect(isPortalStateNotChangedError(undefined)).toBe(false);
      });
    });

    describe('buildActionParams', () => {
      it('sends PORTALKEY for a portal-targeting command action', () => {
        expect(buildActionParams(LIVE_CHECK_ACTIONS.unlock_portal, { PORTALKEY: '5' }, undefined)).toEqual({ PORTALKEY: '5' });
      });

      it('sends OUTPUTKEY (never PORTALKEY) for an output-targeting command action', () => {
        expect(buildActionParams(LIVE_CHECK_ACTIONS.activate_output, { PORTALKEY: '5', OUTPUTKEY: '99' }, undefined)).toEqual({
          OUTPUTKEY: '99',
        });
      });

      it('sends LEVELNAME from --value for set_threat_level', () => {
        expect(buildActionParams(LIVE_CHECK_ACTIONS.set_threat_level, { PORTALKEY: '5' }, 'High')).toEqual({ LEVELNAME: 'High' });
      });

      it('sends EVENTNAME from --value, EVENTACTION, and PARTITIONID 1 for the trigger_event actions (never PORTALKEY/OUTPUTKEY)', () => {
        expect(buildActionParams(LIVE_CHECK_ACTIONS.trigger_event_activate, { PORTALKEY: '5' }, 'Door Alarm')).toEqual({
          EVENTNAME: 'Door Alarm',
          EVENTACTION: 'ACTIVATE',
          PARTITIONID: '1',
        });
        expect(buildActionParams(LIVE_CHECK_ACTIONS.trigger_event_deactivate, { PORTALKEY: '5' }, 'Door Alarm')).toEqual({
          EVENTNAME: 'Door Alarm',
          EVENTACTION: 'DEACTIVATE',
          PARTITIONID: '1',
        });
      });
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

  describe('parseCardFormatName (#13: GetCardFormats CARDFORMATS.CARDFORMAT shape tolerance)', () => {
    it('resolves the first name from an array of plain strings (the live 6.2.0 shape)', () => {
      expect(parseCardFormatName(['26 bit Wiegand', '37 bit HID'])).toBe('26 bit Wiegand');
    });

    it('resolves a bare (single-format) string', () => {
      expect(parseCardFormatName('26 bit Wiegand')).toBe('26 bit Wiegand');
    });

    it('resolves an object carrying NAME, and an array of such objects', () => {
      expect(parseCardFormatName({ NAME: '26 bit Wiegand' })).toBe('26 bit Wiegand');
      expect(parseCardFormatName([{ NAME: '26 bit Wiegand' }, { NAME: '37 bit HID' }])).toBe('26 bit Wiegand');
    });

    it('trims whitespace and skips blank entries to find the first usable name', () => {
      expect(parseCardFormatName(['  ', '  26 bit Wiegand  '])).toBe('26 bit Wiegand');
      expect(parseCardFormatName([{ NAME: '' }, { NAME: '37 bit HID' }])).toBe('37 bit HID');
    });

    it('returns "" for undefined, null, or an empty list', () => {
      expect(parseCardFormatName(undefined)).toBe('');
      expect(parseCardFormatName(null)).toBe('');
      expect(parseCardFormatName([])).toBe('');
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

  it('never references an output, TriggerEvent, SetThreatLevel, AddPartition, or a portal-action command (#13)', () => {
    const forbidden = [
      'ACTIVATE_OUTPUT', 'DEACTIVATE_OUTPUT',
      'TRIGGER_EVENT',
      'SET_THREAT_LEVEL',
      'ADD_PARTITION',
      'LOCK_PORTAL', 'UNLOCK_PORTAL', 'MOMENTARY_UNLOCK_PORTAL', 'DOG_ON_NEXT_EXIT_PORTAL',
    ];
    const offenders = forbidden.filter((constant) => script.includes(`NBAPI_COMMANDS.${constant}`));
    expect(offenders).toEqual([]);
  });

  it('never sends PERSONPURGE, and never marks a person DELETED directly (#13)', () => {
    expect(script).not.toContain('PERSONPURGE');
    expect(script).not.toMatch(/DELETED:\s*['"]TRUE['"]/);
  });

  it('round-trips person/credential, access level/group, and threat level/group objects, plus InsertActivity, a UDF list item, and SwitchPartition (#13)', () => {
    const required = [
      'ADD_PERSON', 'MODIFY_PERSON', 'REMOVE_PERSON',
      'ADD_CREDENTIAL', 'MODIFY_CREDENTIAL', 'REMOVE_CREDENTIAL',
      'ADD_ACCESS_LEVEL', 'MODIFY_ACCESS_LEVEL', 'DELETE_ACCESS_LEVEL',
      'ADD_ACCESS_LEVEL_GROUP', 'MODIFY_ACCESS_LEVEL_GROUP', 'DELETE_ACCESS_LEVEL_GROUP',
      'ADD_THREAT_LEVEL', 'MODIFY_THREAT_LEVEL', 'REMOVE_THREAT_LEVEL',
      'ADD_THREAT_LEVEL_GROUP', 'MODIFY_THREAT_LEVEL_GROUP', 'REMOVE_THREAT_LEVEL_GROUP',
      'INSERT_ACTIVITY', 'MODIFY_UDF_LIST_ITEMS', 'SWITCH_PARTITION',
    ];
    const missing = required.filter((constant) => !script.includes(`NBAPI_COMMANDS.${constant}`));
    expect(missing).toEqual([]);
  });

  it('the person round-trip runs create -> read -> modify -> read -> delete in order, using only the returned PERSONID/CREDENTIALID', () => {
    const order = [
      "step('add_person -> get_person'",
      "step('modify_person (MIDDLENAME/NOTES) -> get_person'",
      "step('add_credential -> get_person (WANTCREDENTIALID) shows the card'",
      "step('modify_credential (DISABLED=1) -> get_person shows DISABLED'",
      "step('remove_credential -> get_person shows no card'",
      "step('remove_person -> get_person (NOT FOUND or DELETED=TRUE)'",
    ];
    const indices = order.map((needle) => script.indexOf(needle));
    expect(indices.every((index) => index > -1)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('the access level round-trip creates a second temporary access level to populate the group, and cleans it up', () => {
    expect(script).toContain(`NAMES.accessLevel2`);
    const groupDeleteIndex = script.indexOf("step('delete_access_level_group");
    const tempCleanupIndex = script.indexOf("step('delete_access_level (temp, cleanup)");
    expect(groupDeleteIndex).toBeGreaterThan(-1);
    expect(tempCleanupIndex).toBeGreaterThan(groupDeleteIndex);
  });

  it('the threat level round-trip never calls SetThreatLevel, and proves removal via a second RemoveThreatLevel failing', () => {
    expect(script).not.toContain('NBAPI_COMMANDS.SET_THREAT_LEVEL');
    expect(script).toContain('a second RemoveThreatLevel for the same name fails');
  });

  it('modify_access_level sends TIMESPECGROUPKEY (the controller requires it on every ModifyAccessLevel call) (#13)', () => {
    const modifyIndex = script.indexOf("step('modify_access_level (description)");
    expect(modifyIndex).toBeGreaterThan(-1);
    const nextStepIndex = script.indexOf("step('delete_access_level", modifyIndex);
    const modifyBlock = script.slice(modifyIndex, nextStepIndex);
    expect(modifyBlock).toContain('NBAPI_COMMANDS.MODIFY_ACCESS_LEVEL');
    expect(modifyBlock).toContain('TIMESPECGROUPKEY: neverKey');
  });

  it('the threat level round-trip skips (not fails) its dependent steps when AddThreatLevel does not create the level, and never sends AddThreatLevelGroup for it (#13)', () => {
    expect(script).toContain('if (!levelCreated)');
    expect(script).toContain('THREAT_LEVEL_DEPENDENT_STEPS');
    expect(script).toContain("results.push({ name, pass: true, summary: note })");
    const skipCheckIndex = script.indexOf('if (!levelCreated)');
    const addGroupCallIndex = script.indexOf('NBAPI_COMMANDS.ADD_THREAT_LEVEL_GROUP');
    expect(skipCheckIndex).toBeGreaterThan(-1);
    expect(addGroupCallIndex).toBeGreaterThan(skipCheckIndex);
  });

  it('add_threat_level sends a short LEVELNAME and an explicit SEQNUM (both tried after ruling out the two-custom-level cap) (#13)', () => {
    expect(script).toContain("NBAPI_COMMANDS.ADD_THREAT_LEVEL, { LEVELNAME: NAMES.threatLevel, COLOR: 'Blue', SEQNUM: '7' }");
    const match = /threatLevel:\s*'([^']*)'/.exec(script);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').length).toBeLessThanOrEqual(20);
  });

  it('modify_credential and remove_credential fall back from CREDENTIALID-only to PERSONID + CARDFORMAT + ENCODEDNUM (#13)', () => {
    expect(script).toContain('callCredentialCommand');
    expect(script).toContain('PERSONID + CARDFORMAT + ENCODEDNUM');
  });

  it('uses a card number that fits the 16-bit field of the live 26-bit Wiegand format (#13)', () => {
    expect(script).toContain("const TEST_CARD_NUMBER = '65431'");
    expect(script).not.toContain('98765431');
  });

  it('modify_threat_level sends SEQNUM along with COLOR, since the controller rejects the call without it (#13)', () => {
    expect(script).toContain(
      "NBAPI_COMMANDS.MODIFY_THREAT_LEVEL, { LEVELNAME: NAMES.threatLevel, SEQNUM: '7', COLOR: 'Green' }"
    );
  });

  it('the UDF list round-trip records a SKIPPED pass when no UDF list is configured', () => {
    expect(script).toContain('SKIPPED: no UDF list is configured on this controller');
  });

  it('the new round-trips run in phase (b), before the controller clock check', () => {
    const personIndex = script.indexOf('await personRoundTrip(client)');
    const accessLevelIndex = script.indexOf('await accessLevelRoundTrip(client');
    const threatLevelIndex = script.indexOf('await threatLevelRoundTrip(client)');
    const udfIndex = script.indexOf('await udfListRoundTrip(client)');
    const clockCheckIndex = script.indexOf('await controllerClockCheck(client)');
    expect(personIndex).toBeGreaterThan(-1);
    expect(accessLevelIndex).toBeGreaterThan(personIndex);
    expect(threatLevelIndex).toBeGreaterThan(accessLevelIndex);
    expect(udfIndex).toBeGreaterThan(threatLevelIndex);
    expect(clockCheckIndex).toBeGreaterThan(udfIndex);
  });

  it('final leftover cleanup also removes prefixed persons, access levels/groups, and threat levels/groups', () => {
    expect(script).toContain('removeExistingLivecheckPersons');
    expect(script).toContain('NBAPI_COMMANDS.DELETE_ACCESS_LEVEL_GROUP');
    expect(script).toContain('NBAPI_COMMANDS.DELETE_ACCESS_LEVEL,');
    expect(script).toContain('NBAPI_COMMANDS.REMOVE_THREAT_LEVEL_GROUP');
    expect(script).toContain('NBAPI_COMMANDS.REMOVE_THREAT_LEVEL,');
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

  it('runs the controller clock check after the CRUD round-trips and before phase (c), and gates (c) on it', () => {
    expect(script).toContain('controllerClockCheck');
    expect(script).toContain("clockSkew.status === 'fail'");
    const crudIndex = script.indexOf('portalGroupRoundTrip(client, portal.PORTALKEY, never.TIMESPECGROUPKEY)');
    const clockCheckIndex = script.indexOf('await controllerClockCheck(client)');
    const phaseCIndex = script.indexOf("if (clockSkew.status === 'fail')");
    expect(crudIndex).toBeGreaterThan(-1);
    expect(clockCheckIndex).toBeGreaterThan(crudIndex);
    expect(phaseCIndex).toBeGreaterThan(clockCheckIndex);
  });

  it('the HEADS-UP line includes the estimated controller time', () => {
    expect(script).toContain('estimated controller time now');
    expect(script).toContain('estimateControllerClock');
  });

  it('R30 b2: the clock-skew FAIL prints the required message shape and a re-run hint, with no stale-record exemption', () => {
    expect(script).toContain('controller clock skew: controller');
    expect(script).toContain('[FAIL] ${summary}');
    expect(script).toContain('badge any reader and re-run');
    expect(script).not.toMatch(/status === 'stale'/);
    expect(script).not.toContain("'stale'");
  });

  it('supervised single-action mode (#12): resolves --action before the credential skip-line check, runs runSingleAction instead of phases (b)/(b2)/(c), and never a literal NBAPI command string for it', () => {
    expect(script).toContain('resolveLiveCheckAction(args.action)');
    expect(script).toContain('await runSingleAction(client, actionSpec');
    const actionResolveIndex = script.indexOf('resolveLiveCheckAction(args.action)');
    const skipLineIndex = script.indexOf("const { NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD } = process.env;");
    expect(actionResolveIndex).toBeGreaterThan(-1);
    expect(skipLineIndex).toBeGreaterThan(actionResolveIndex);
    // runSingleAction sends actionSpec.command / setPortalsState(stateAction, ...), never a literal command string.
    const runSingleActionStart = script.indexOf('async function runSingleAction');
    const runSingleActionEnd = script.indexOf('\n// ---', runSingleActionStart);
    const body = script.slice(runSingleActionStart, runSingleActionEnd);
    expect(body).not.toMatch(/NBAPI_COMMANDS\.(ADD_PARTITION|TRIGGER_EVENT)/);
    expect(body).toContain('actionSpec.command');
    expect(body).toContain('setPortalsState(client, stateAction');
  });

  it('exits 2 (no network) when --action is combined with --go, or when the action/value is invalid', () => {
    expect(script).toContain('LiveCheckActionError');
    expect(script).toMatch(/err instanceof LiveCheckActionError[\s\S]{0,200}return 2;/);
    expect(script).toContain('requires --value');
  });

  it('a FAIL with ERRMSG "Portal state not changed" is reported PASS-with-note in action mode', () => {
    expect(script).toContain('isPortalStateNotChangedError(err.errmsg)');
    expect(script).toContain('PASS (already in that state)');
  });

  it('action mode never reads config.enableDestructive (NETBOX_ENABLE_DESTRUCTIVE is not required, since action mode never deletes anything)', () => {
    expect(script).not.toContain('config.enableDestructive');
  });
});

describe('R30 b2: controller clock skew estimate', () => {
  describe('formatClockHMS / formatDurationHMS / parseControllerDttm', () => {
    it('formats a Date as local HH:MM:SS', () => {
      expect(formatClockHMS(new Date(2026, 8, 15, 8, 5, 34))).toBe('08:05:34');
      expect(formatClockHMS(new Date(2026, 8, 15, 0, 0, 0))).toBe('00:00:00');
    });

    it('formats a duration in seconds as HH:MM:SS', () => {
      expect(formatDurationHMS(0)).toBe('00:00:00');
      expect(formatDurationHMS(65)).toBe('00:01:05');
      expect(formatDurationHMS(4 * 3600 + 34 * 60 + 56)).toBe('04:34:56');
    });

    it('parses a controller DTTM as host-local wall time', () => {
      const parsed = parseControllerDttm('2026-09-15 03:30:38');
      expect(parsed).toEqual(new Date(2026, 8, 15, 3, 30, 38));
    });

    it('rejects a DTTM that does not match YYYY-MM-DD HH:MM:SS', () => {
      expect(parseControllerDttm('not a date')).toBeUndefined();
      expect(parseControllerDttm('2026-09-15')).toBeUndefined();
      expect(parseControllerDttm('2026-09-15T03:30:38')).toBeUndefined();
    });
  });

  describe('computeClockSkew', () => {
    it('is ok when the clocks agree within 2 minutes', () => {
      const host = new Date(2026, 8, 15, 8, 5, 34);
      const dttm = '2026-09-15 08:04:00'; // 1m34s behind
      const result = computeClockSkew(host, dttm);
      expect(result.status).toBe('ok');
      expect(result.hostClock).toBe('08:05:34');
      expect(result.controllerClock).toBe('08:04:00');
      expect(result.skewSeconds).toBe(94);
      expect(result.offsetSeconds).toBe(-94);
    });

    it('is ok exactly at the 2-minute boundary', () => {
      const host = new Date(2026, 8, 15, 8, 5, 0);
      const dttm = '2026-09-15 08:03:00'; // exactly 2 min behind
      expect(computeClockSkew(host, dttm).status).toBe('ok');
    });

    it('fails when the clocks disagree by more than 2 minutes', () => {
      const host = new Date(2026, 8, 15, 8, 5, 0);
      const dttm = '2026-09-15 08:00:00'; // 5 min behind
      const result = computeClockSkew(host, dttm);
      expect(result.status).toBe('fail');
      expect(result.skewSeconds).toBe(300);
      expect(result.offsetSeconds).toBe(-300);
    });

    it('fails on the live-observed scenario\'s shape scaled to a moderate delta', () => {
      const host = new Date(2026, 8, 15, 8, 5, 34);
      const dttm = '2026-09-15 07:56:00'; // ~9m34s behind
      expect(computeClockSkew(host, dttm).status).toBe('fail');
    });

    it('fails with no stale-record exemption, even for a large delta like the live-observed ~4h35m skew', () => {
      const host = new Date(2026, 8, 15, 8, 5, 34);
      const dttm = '2026-09-15 03:30:38'; // the live-observed ~4h35m skew
      const result = computeClockSkew(host, dttm);
      expect(result.status).toBe('fail');
      expect(result.controllerClock).toBe('03:30:38');
      expect(result.hostClock).toBe('08:05:34');
    });

    it('is no-record when there is no access history record at all', () => {
      const result = computeClockSkew(new Date(2026, 8, 15, 8, 5, 34), undefined);
      expect(result.status).toBe('no-record');
      expect(result.controllerClock).toBeUndefined();
      expect(result.skewSeconds).toBeUndefined();
    });

    it('is no-record when the DTTM does not parse', () => {
      const result = computeClockSkew(new Date(2026, 8, 15, 8, 5, 34), 'garbage');
      expect(result.status).toBe('no-record');
    });
  });

  describe('estimateControllerClock', () => {
    it('projects the controller clock forward using a signed offset', () => {
      const host = new Date(2026, 8, 15, 8, 10, 0);
      expect(estimateControllerClock(host, -94)).toBe('08:08:26');
      expect(estimateControllerClock(host, 0)).toBe('08:10:00');
      expect(estimateControllerClock(host, 60)).toBe('08:11:00');
    });
  });
});
