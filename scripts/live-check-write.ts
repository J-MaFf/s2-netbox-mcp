import 'dotenv/config';
import { loadConfigFromEnv, NetboxConfigError } from '../src/config.js';
import { NetboxClient } from '../src/netboxClient.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { wrapList } from '../src/toolHelpers.js';
import { asRecord, asRecordList, fetchAllPages, isBareNotFoundFail, text } from '../src/paging.js';
import {
  NEVER_GROUP_NAME,
  fetchHoliday,
  fetchHolidays,
  fetchPortalGroup,
  fetchPortalGroups,
  fetchTimeSpec,
  fetchTimeSpecGroups,
  fetchTimeSpecs,
  segmentKindOf,
  timeSpecGroupName,
} from '../src/unlockWindow/managed.js';
import { cancelUnlockWindow, getUnlockWindow, scheduleUnlockWindow, type UnlockWindowSettings } from '../src/unlockWindow/executor.js';
import {
  LIVE_PREFIX,
  LiveCheckArgError,
  assertEqual,
  assertSameSet,
  assertTrue,
  clockOf,
  computeTestWindow,
  parseLiveCheckWriteArgs,
} from './liveCheckWriteHelpers.js';

/**
 * Opt-in live WRITE smoke test (R30 / C20) — `npm run test:live:write`.
 *
 * (a) Skips with one line and exit 0, making no network call, unless
 *     NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD, NETBOX_ENABLE_WRITES=true
 *     and NETBOX_LIVE_TEST_PORTALKEY are all set.
 * (b) Under the distinct prefix "MCP livecheck", round-trips
 *     add -> get -> modify -> get -> delete for a time spec, a time spec
 *     group, a holiday, a reader group and a portal group, asserting every
 *     read-back. The portal group's unlock time spec group is *Never*, and the
 *     holiday is in 2099, so nothing here can unlock a door.
 * (c) ONLY with `--go` — which the operator passes after notifying the user
 *     (push notification plus a chat message with the exact unlock and relock
 *     clock times) and receiving a go-ahead, because the user observes the
 *     door in person — schedules a real 2-minute unlock window on the
 *     designated portal via the real schedule_unlock_window executor, polls
 *     get_unlock_window every 30 s, then cancels and asserts the portal group
 *     is on *Never* and no managed holiday remains. `--start HH:MM` pins the
 *     unlock time (1-60 min ahead) so the exact times can be communicated
 *     before the go-ahead; otherwise unlock = now + 2 min, relock = + 4 min.
 * (d) Never touches persons, credentials, access levels, threat levels,
 *     outputs, events, partitions or UDF lists (unit tests cover those).
 * (e) Never prints NETBOX_PASSWORD (every line goes through redact()).
 * (f) Exits non-zero on any assertion failure; once (c) has begun, always
 *     attempts cancel_unlock_window before exiting.
 *
 * `npm test` never runs this file.
 */

let secret = '';

function redact(line: string): string {
  return secret ? line.split(secret).join('[REDACTED]') : line;
}

function log(line: string): void {
  console.log(redact(line));
}

function logErr(line: string): void {
  console.error(redact(line));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NAMES = {
  timeSpec: `${LIVE_PREFIX} timespec`,
  timeSpecGroup: `${LIVE_PREFIX} tsg`,
  holiday: `${LIVE_PREFIX} holiday`,
  readerGroup: `${LIVE_PREFIX} readergroup`,
  portalGroup: `${LIVE_PREFIX} portalgroup`,
};

interface StepResult {
  name: string;
  pass: boolean;
  summary: string;
}

const results: StepResult[] = [];

/** Runs one named step; a thrown error (assertion or controller) fails it. */
async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    const summary = await fn();
    results.push({ name, pass: true, summary });
    log(`[PASS] ${name}: ${summary}`);
    return true;
  } catch (err) {
    results.push({ name, pass: false, summary: errorText(err) });
    log(`[FAIL] ${name}: ${errorText(err)}`);
    return false;
  }
}

function info(line: string): void {
  log(`[INFO] ${line}`);
}

/** A Get* for a deleted object answers NOT FOUND or (6.2.0) FAIL "NOT FOUND". */
async function isGone(read: () => Promise<unknown>): Promise<boolean> {
  try {
    return (await read()) === undefined;
  } catch (err) {
    if (isBareNotFoundFail(err)) return true;
    throw err;
  }
}

async function readReaderGroup(client: NetboxClient, READERGROUPKEY: string) {
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_READER_GROUP, { READERGROUPKEY });
    if (result.notFound) return undefined;
    const details = asRecord(result.data);
    const raw = 'READERGROUP' in details ? asRecord(details.READERGROUP) : details;
    return {
      NAME: text(raw.NAME),
      DESCRIPTION: text(raw.DESCRIPTION),
      READERKEYS: asRecordList(asRecord(raw.READERS).READER).map((reader) => text(reader.READERKEY)),
    };
  } catch (err) {
    if (isBareNotFoundFail(err)) return undefined;
    throw err;
  }
}

/** Best-effort removal of any "MCP livecheck *" object a previous aborted run
 * left behind — only objects carrying that prefix are ever touched. */
async function cleanupLeftovers(client: NetboxClient): Promise<string[]> {
  const removed: string[] = [];
  const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      removed.push(label);
    } catch (err) {
      info(`cleanup could not remove ${label}: ${errorText(err)}`);
    }
  };
  for (const group of await fetchPortalGroups(client)) {
    if (group.NAME.startsWith(LIVE_PREFIX)) {
      await attempt(`portal group ${group.PORTALGROUPKEY}`, () => client.call(NBAPI_COMMANDS.DELETE_PORTAL_GROUP, { PORTALGROUPKEY: group.PORTALGROUPKEY }));
    }
  }
  for (const group of await fetchTimeSpecGroups(client)) {
    if (group.NAME.startsWith(LIVE_PREFIX)) {
      await attempt(`time spec group ${group.TIMESPECGROUPKEY}`, () =>
        client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC_GROUP, { TIMESPECGROUPKEY: group.TIMESPECGROUPKEY })
      );
    }
  }
  for (const spec of await fetchTimeSpecs(client)) {
    if (spec.NAME.startsWith(LIVE_PREFIX)) {
      await attempt(`time spec ${spec.TIMESPECKEY}`, () => client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY: spec.TIMESPECKEY }));
    }
  }
  for (const holiday of await fetchHolidays(client)) {
    if (holiday.NAME.startsWith(LIVE_PREFIX)) {
      await attempt(`holiday ${holiday.HOLIDAYKEY}`, () => client.call(NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY: holiday.HOLIDAYKEY }));
    }
  }
  const readerGroups = await fetchAllPages(client, NBAPI_COMMANDS.GET_READER_GROUPS, 'READERGROUPS', 'READERGROUP', { emptyOnNotFoundFail: true });
  for (const group of readerGroups) {
    if (text(group.NAME).startsWith(LIVE_PREFIX)) {
      await attempt(`reader group ${text(group.READERGROUPKEY)}`, () =>
        client.call(NBAPI_COMMANDS.DELETE_READER_GROUP, { READERGROUPKEY: text(group.READERGROUPKEY) })
      );
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// (b) CRUD round-trips
// ---------------------------------------------------------------------------

async function timeSpecAndGroupRoundTrip(client: NetboxClient, holidayGroup: number): Promise<boolean> {
  let specKey = '';
  let groupKey = '';
  let allPassed = true;

  allPassed =
    (await step('add_time_spec -> get_time_spec', async () => {
      const weekdays = Object.fromEntries(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((day) => [day, '0']));
      const result = await client.call(NBAPI_COMMANDS.ADD_TIME_SPEC, {
        NAME: NAMES.timeSpec,
        DESCRIPTION: 'created by npm run test:live:write',
        STARTTIME: '08:00',
        ENDTIME: '09:00',
        ...weekdays,
      });
      specKey = text(asRecord(result.data).TIMESPECKEY);
      assertTrue('AddTimeSpec returned a TIMESPECKEY', specKey !== '');
      const spec = await fetchTimeSpec(client, specKey);
      assertTrue(`GetTimeSpec ${specKey} found it`, spec !== undefined);
      assertEqual('NAME', spec!.NAME, NAMES.timeSpec);
      assertEqual('STARTTIME', spec!.STARTTIME, '08:00');
      assertEqual('ENDTIME', spec!.ENDTIME, '09:00');
      assertSameSet('weekdays off', Object.values(spec!.weekdays), ['0']);
      const singular = (await fetchTimeSpecGroups(client)).find((group) => group.NAME === NAMES.timeSpec);
      info(
        singular
          ? `AddTimeSpec also created a same-named singular time spec group (${singular.TIMESPECGROUPKEY}) — the spec's assumption holds`
          : 'AddTimeSpec did NOT create a same-named singular time spec group on this controller'
      );
      return `TIMESPECKEY ${specKey}`;
    })) && allPassed;

  allPassed =
    (await step('add_time_spec_group -> get_time_spec_groups', async () => {
      const result = await client.call(NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP, { NAME: NAMES.timeSpecGroup, DESCRIPTION: 'created by npm run test:live:write' });
      groupKey = text(asRecord(result.data).TIMESPECGROUPKEY);
      if (groupKey) {
        info('AddTimeSpecGroup returned TIMESPECGROUPKEY in its response');
      } else {
        groupKey = (await fetchTimeSpecGroups(client)).find((group) => group.NAME === NAMES.timeSpecGroup)?.TIMESPECGROUPKEY ?? '';
        info('AddTimeSpecGroup returned no key; resolved it by NAME from GetTimeSpecGroups');
      }
      assertTrue('a TIMESPECGROUPKEY was resolved', groupKey !== '');
      const group = (await fetchTimeSpecGroups(client)).find((candidate) => candidate.TIMESPECGROUPKEY === groupKey);
      assertTrue(`GetTimeSpecGroups lists ${groupKey}`, group !== undefined);
      assertEqual('NAME', group!.NAME, NAMES.timeSpecGroup);
      assertSameSet('TIMESPECKEYS (empty)', group!.TIMESPECKEYS, []);
      return `TIMESPECGROUPKEY ${groupKey}`;
    })) && allPassed;

  allPassed =
    (await step('modify_time_spec_group (members + description) -> get_time_spec_groups', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP, {
        TIMESPECGROUPKEY: groupKey,
        DESCRIPTION: 'modified by npm run test:live:write',
        ...wrapList('TIMESPECKEYS', 'TIMESPECKEY', [specKey]),
      });
      const group = (await fetchTimeSpecGroups(client)).find((candidate) => candidate.TIMESPECGROUPKEY === groupKey);
      assertTrue(`GetTimeSpecGroups lists ${groupKey}`, group !== undefined);
      assertEqual('DESCRIPTION', group!.DESCRIPTION, 'modified by npm run test:live:write');
      assertSameSet('TIMESPECKEYS', group!.TIMESPECKEYS, [specKey]);
      return `members = [${specKey}]`;
    })) && allPassed;

  // Informational: cancel_unlock_window relies on (and tolerates refusal of) emptying a group.
  try {
    await client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP, { TIMESPECGROUPKEY: groupKey, ...wrapList('TIMESPECKEYS', 'TIMESPECKEY', []) });
    const group = (await fetchTimeSpecGroups(client)).find((candidate) => candidate.TIMESPECGROUPKEY === groupKey);
    info(`ModifyTimeSpecGroup with an empty TIMESPECKEYS list ${group && group.TIMESPECKEYS.length === 0 ? 'empties the group' : 'left the group non-empty'} on this controller`);
  } catch (err) {
    info(`ModifyTimeSpecGroup with an empty TIMESPECKEYS list is refused on this controller: ${errorText(err)} (cancel_unlock_window tolerates this)`);
  }

  allPassed =
    (await step('delete_time_spec_group -> get_time_spec_groups', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC_GROUP, { TIMESPECGROUPKEY: groupKey });
      const stillThere = (await fetchTimeSpecGroups(client)).some((candidate) => candidate.TIMESPECGROUPKEY === groupKey);
      assertTrue(`time spec group ${groupKey} is gone`, !stillThere);
      return `TIMESPECGROUPKEY ${groupKey} deleted`;
    })) && allPassed;

  allPassed =
    (await step('modify_time_spec -> get_time_spec', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC, { TIMESPECKEY: specKey, ENDTIME: '10:00', HOLIDAYGROUPS: String(holidayGroup) });
      const spec = await fetchTimeSpec(client, specKey);
      assertTrue(`GetTimeSpec ${specKey} found it`, spec !== undefined);
      assertEqual('ENDTIME', spec!.ENDTIME, '10:00');
      assertSameSet('HOLIDAYGROUPS', spec!.HOLIDAYGROUPS, [String(holidayGroup)]);
      return `ENDTIME 10:00, HOLIDAYGROUPS ${holidayGroup}`;
    })) && allPassed;

  allPassed =
    (await step('delete_time_spec -> get_time_spec', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY: specKey });
      assertTrue(`time spec ${specKey} is gone`, await isGone(() => fetchTimeSpec(client, specKey)));
      return `TIMESPECKEY ${specKey} deleted`;
    })) && allPassed;

  return allPassed;
}

async function holidayRoundTrip(client: NetboxClient, holidayGroup: number): Promise<boolean> {
  let key = '';
  let allPassed = true;

  allPassed =
    (await step('add_holiday -> get_holiday', async () => {
      const result = await client.call(NBAPI_COMMANDS.ADD_HOLIDAY, {
        HOLIDAYNAME: NAMES.holiday,
        HOLIDAYGROUPS: String(holidayGroup),
        STARTDATE: '2099-01-01 00:00',
        ENDDATE: '2099-01-02 00:00',
      });
      key = text(asRecord(result.data).HOLIDAYKEY);
      assertTrue('AddHoliday returned a HOLIDAYKEY', key !== '');
      const holiday = await fetchHoliday(client, key);
      assertTrue(`GetHoliday ${key} found it`, holiday !== undefined);
      assertEqual('NAME', holiday!.NAME, NAMES.holiday);
      assertEqual('STARTDATE', holiday!.STARTDATE, '2099-01-01 00:00');
      assertEqual('ENDDATE', holiday!.ENDDATE, '2099-01-02 00:00');
      assertSameSet('HOLIDAYGROUPS', holiday!.HOLIDAYGROUPS, [String(holidayGroup)]);
      return `HOLIDAYKEY ${key}`;
    })) && allPassed;

  allPassed =
    (await step('modify_holiday -> get_holiday', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_HOLIDAY, { HOLIDAYKEY: key, ENDDATE: '2099-01-03 00:00' });
      const holiday = await fetchHoliday(client, key);
      assertTrue(`GetHoliday ${key} found it`, holiday !== undefined);
      assertEqual('ENDDATE', holiday!.ENDDATE, '2099-01-03 00:00');
      assertEqual('STARTDATE unchanged', holiday!.STARTDATE, '2099-01-01 00:00');
      return 'ENDDATE 2099-01-03 00:00';
    })) && allPassed;

  allPassed =
    (await step('delete_holiday -> get_holiday', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY: key });
      assertTrue(`holiday ${key} is gone`, await isGone(() => fetchHoliday(client, key)));
      return `HOLIDAYKEY ${key} deleted`;
    })) && allPassed;

  return allPassed;
}

async function readerGroupRoundTrip(client: NetboxClient, readerKey: string): Promise<boolean> {
  let key = '';
  let allPassed = true;

  allPassed =
    (await step('add_reader_group -> get_reader_group', async () => {
      const result = await client.call(NBAPI_COMMANDS.ADD_READER_GROUP, {
        NAME: NAMES.readerGroup,
        DESCRIPTION: 'created by npm run test:live:write',
        ...wrapList('READERKEYS', 'READERKEY', [readerKey]),
      });
      key = text(asRecord(result.data).READERGROUPKEY);
      assertTrue('AddReaderGroup returned a READERGROUPKEY', key !== '');
      const group = await readReaderGroup(client, key);
      assertTrue(`GetReaderGroup ${key} found it`, group !== undefined);
      assertEqual('NAME', group!.NAME, NAMES.readerGroup);
      assertSameSet('READERKEYS', group!.READERKEYS, [readerKey]);
      return `READERGROUPKEY ${key}`;
    })) && allPassed;

  allPassed =
    (await step('modify_reader_group -> get_reader_group', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_READER_GROUP, {
        READERGROUPKEY: key,
        DESCRIPTION: 'modified by npm run test:live:write',
        ...wrapList('READERKEYS', 'READERKEY', [readerKey]),
      });
      const group = await readReaderGroup(client, key);
      assertTrue(`GetReaderGroup ${key} found it`, group !== undefined);
      assertEqual('DESCRIPTION', group!.DESCRIPTION, 'modified by npm run test:live:write');
      assertSameSet('READERKEYS unchanged', group!.READERKEYS, [readerKey]);
      return 'DESCRIPTION modified';
    })) && allPassed;

  allPassed =
    (await step('delete_reader_group -> get_reader_group', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_READER_GROUP, { READERGROUPKEY: key });
      assertTrue(`reader group ${key} is gone`, await isGone(() => readReaderGroup(client, key)));
      return `READERGROUPKEY ${key} deleted`;
    })) && allPassed;

  return allPassed;
}

async function portalGroupRoundTrip(client: NetboxClient, portalKey: string, neverKey: string): Promise<boolean> {
  let key = '';
  let allPassed = true;

  allPassed =
    (await step('add_portal_group (unlock = Never) -> get_portal_group', async () => {
      const result = await client.call(NBAPI_COMMANDS.ADD_PORTAL_GROUP, {
        NAME: NAMES.portalGroup,
        DESCRIPTION: 'created by npm run test:live:write',
        UNLOCKTIMESPECGROUPKEY: neverKey,
        ...wrapList('PORTALKEYS', 'PORTALKEY', [portalKey]),
      });
      key = text(asRecord(result.data).PORTALGROUPKEY);
      assertTrue('AddPortalGroup returned a PORTALGROUPKEY', key !== '');
      const group = await fetchPortalGroup(client, key);
      assertTrue(`GetPortalGroup ${key} found it`, group !== undefined);
      assertEqual('NAME', group!.NAME, NAMES.portalGroup);
      assertSameSet('PORTALKEYS', group!.PORTALS.map((portal) => portal.PORTALKEY), [portalKey]);
      assertEqual('UNLOCKTIMESPECGROUPKEY', group!.UNLOCKTIMESPECGROUPKEY, neverKey);
      return `PORTALGROUPKEY ${key}`;
    })) && allPassed;

  allPassed =
    (await step('modify_portal_group -> get_portal_group', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_PORTAL_GROUP, {
        PORTALGROUPKEY: key,
        DESCRIPTION: 'modified by npm run test:live:write',
        ...wrapList('PORTALKEYS', 'PORTALKEY', [portalKey]),
        UNLOCKTIMESPECGROUPKEY: neverKey,
      });
      const group = await fetchPortalGroup(client, key);
      assertTrue(`GetPortalGroup ${key} found it`, group !== undefined);
      assertEqual('DESCRIPTION', group!.DESCRIPTION, 'modified by npm run test:live:write');
      assertSameSet('PORTALKEYS unchanged', group!.PORTALS.map((portal) => portal.PORTALKEY), [portalKey]);
      assertEqual('UNLOCKTIMESPECGROUPKEY unchanged', group!.UNLOCKTIMESPECGROUPKEY, neverKey);
      return 'DESCRIPTION modified';
    })) && allPassed;

  allPassed =
    (await step('delete_portal_group -> get_portal_group', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_PORTAL_GROUP, { PORTALGROUPKEY: key });
      assertTrue(`portal group ${key} is gone`, await isGone(() => fetchPortalGroup(client, key)));
      return `PORTALGROUPKEY ${key} deleted`;
    })) && allPassed;

  return allPassed;
}

// ---------------------------------------------------------------------------
// (c) the real 2-minute window on the designated portal
// ---------------------------------------------------------------------------

async function unlockWindowPhase(
  client: NetboxClient,
  settings: UnlockWindowSettings,
  portal: { PORTALKEY: string; NAME: string },
  neverKey: string,
  startClock: string | undefined
): Promise<void> {
  const window = computeTestWindow(new Date(), startClock);
  log(`HEADS-UP: scheduling a 2-minute unlock of portal ${portal.NAME} (key ${portal.PORTALKEY}): unlock ${window.unlockClock}, relock ${window.relockClock}`);

  let scheduled = false;
  try {
    await step('schedule_unlock_window (verified:true)', async () => {
      const result = await scheduleUnlockWindow(
        client,
        { start: window.start, end: window.end, portalKeys: [portal.PORTALKEY], acknowledgeSideEffects: true },
        settings
      );
      scheduled = true;
      assertTrue('the executor returned a non-dry-run result', 'verified' in result);
      assertTrue('verified === true', 'verified' in result && result.verified === true);
      const segments = 'segments' in result ? result.segments : [];
      return `window ${window.start} -> ${window.end}, ${segments.length} segment(s), portal group ${'portalGroupKey' in result ? result.portalGroupKey : '?'}`;
    });
    if (!scheduled) return;

    log(`OBSERVE: portal ${portal.NAME} should unlock at ${window.unlockClock} and relock at ${window.relockClock} — confirm on Monitor → Portal Status`);

    await step('get_unlock_window polled every 30 s until end + 1 min', async () => {
      let sawActive = false;
      let polls = 0;
      for (;;) {
        const status = await getUnlockWindow(client, settings);
        polls += 1;
        if (status.activeNow) sawActive = true;
        log(`[poll ${clockOf(new Date())}] activeNow=${status.activeNow} window=${status.window ? `${status.window.start} -> ${status.window.end}` : 'none'}`);
        const remaining = window.pollUntilMs - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(30_000, remaining));
      }
      assertTrue('activeNow was reported true at least once inside the window', sawActive);
      return `${polls} poll(s); activeNow observed true during the window`;
    });
  } finally {
    if (scheduled) {
      await step('cancel_unlock_window -> portal group on Never, no managed holiday/time spec/group member', async () => {
        const result = await cancelUnlockWindow(client, settings);
        assertTrue('cancelled', result.cancelled);
        const managed = (await fetchPortalGroups(client)).find((group) => group.NAME === settings.namePrefix);
        assertTrue(`managed portal group "${settings.namePrefix}" still exists`, managed !== undefined);
        const group = await fetchPortalGroup(client, managed!.PORTALGROUPKEY);
        assertEqual('UNLOCKTIMESPECGROUPKEY is Never', group?.UNLOCKTIMESPECGROUPKEY, neverKey);
        const leftoverHolidays = (await fetchHolidays(client)).filter((holiday) => segmentKindOf(holiday.NAME, settings.namePrefix) !== undefined);
        assertSameSet('managed holidays remaining', leftoverHolidays.map((holiday) => holiday.NAME), []);
        const leftoverSpecs = (await fetchTimeSpecs(client)).filter((spec) => segmentKindOf(spec.NAME, settings.namePrefix) !== undefined);
        assertSameSet('managed time specs remaining', leftoverSpecs.map((spec) => spec.NAME), []);
        const managedTsg = (await fetchTimeSpecGroups(client)).find((tsg) => tsg.NAME === timeSpecGroupName(settings.namePrefix));
        assertSameSet('managed time spec group members remaining', managedTsg?.TIMESPECKEYS ?? [], []);
        if (result.leftBehind.length > 0) {
          info(`cancel_unlock_window reported leftBehind (tolerated): ${result.leftBehind.map((item) => `${item.type} "${item.NAME}": ${item.error}`).join('; ')}`);
        }
        return `portal group ${managed!.PORTALGROUPKEY} on Never (${neverKey}); ${result.deletedHolidays.length} holiday(s), ${result.deletedTimeSpecs.length} time spec(s) deleted; leftBehind: ${result.leftBehind.length}`;
      });
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let args;
  try {
    args = parseLiveCheckWriteArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof LiveCheckArgError) {
      console.error(`s2-netbox-mcp live-check-write: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const { NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD } = process.env;
  const skipLine =
    's2-netbox-mcp live-check-write: skipped (requires NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD, NETBOX_ENABLE_WRITES=true and NETBOX_LIVE_TEST_PORTALKEY).';
  if (!NETBOX_BASE_URL || !NETBOX_USERNAME || !NETBOX_PASSWORD) {
    console.log(skipLine);
    return 0;
  }

  let config;
  try {
    config = loadConfigFromEnv();
  } catch (err) {
    if (err instanceof NetboxConfigError) {
      console.error(`s2-netbox-mcp live-check-write: ${err.message}`);
      return 1;
    }
    throw err;
  }
  if (!config.enableWrites || !config.liveTestPortalKey) {
    console.log(skipLine);
    return 0;
  }

  secret = config.password;
  const settings: UnlockWindowSettings = { holidayGroups: config.unlockHolidayGroups, namePrefix: config.unlockNamePrefix };
  const client = new NetboxClient(config);

  try {
    // Preconditions: the designated portal, one of its readers, and Never.
    const portals = await fetchAllPages(client, NBAPI_COMMANDS.GET_PORTALS, 'PORTALS', 'PORTAL');
    const portalRecord = portals.find((portal) => text(portal.PORTALKEY) === config.liveTestPortalKey);
    if (!portalRecord) {
      logErr(`s2-netbox-mcp live-check-write: NETBOX_LIVE_TEST_PORTALKEY=${config.liveTestPortalKey} was not returned by GetPortals.`);
      return 1;
    }
    const portal = { PORTALKEY: text(portalRecord.PORTALKEY), NAME: text(portalRecord.NAME) };
    const readerKey = text(asRecordList(asRecord(portalRecord.READERS).READER)[0]?.READERKEY);
    const never = (await fetchTimeSpecGroups(client)).find((group) => group.NAME === NEVER_GROUP_NAME);
    if (!never) {
      logErr(`s2-netbox-mcp live-check-write: no time spec group named "${NEVER_GROUP_NAME}" exists; refusing to continue.`);
      return 1;
    }
    log(`Designated portal: ${portal.NAME} (key ${portal.PORTALKEY}); reader ${readerKey || 'none'}; Never = ${never.TIMESPECGROUPKEY}; prefix "${settings.namePrefix}"; groups ${settings.holidayGroups.join(',')}`);

    const removed = await cleanupLeftovers(client);
    if (removed.length > 0) info(`removed leftovers from a previous run: ${removed.join(', ')}`);

    // (b)
    const holidayGroup = settings.holidayGroups[0];
    let crudPassed = true;
    crudPassed = (await timeSpecAndGroupRoundTrip(client, holidayGroup)) && crudPassed;
    crudPassed = (await holidayRoundTrip(client, holidayGroup)) && crudPassed;
    if (readerKey) {
      crudPassed = (await readerGroupRoundTrip(client, readerKey)) && crudPassed;
    } else {
      results.push({ name: 'reader group round-trip', pass: false, summary: `portal ${portal.NAME} has no reader to build a reader group from` });
      crudPassed = false;
    }
    crudPassed = (await portalGroupRoundTrip(client, portal.PORTALKEY, never.TIMESPECGROUPKEY)) && crudPassed;

    // (c)
    if (!args.go) {
      info(
        'phase (c) — the real 2-minute unlock of the designated portal — was NOT run. Notify the user (push notification plus a chat ' +
          'message with the exact unlock and relock clock times), get a go-ahead, then re-run with `npm run test:live:write -- --go [--start HH:MM]`.'
      );
    } else if (!crudPassed) {
      results.push({ name: 'unlock window phase', pass: false, summary: 'skipped because a CRUD round-trip failed' });
      log('[FAIL] unlock window phase: skipped because a CRUD round-trip failed');
    } else {
      const existing = await getUnlockWindow(client, settings);
      if (existing.holidays.length > 0 || (existing.portalGroup?.pointsAtManagedTimeSpecGroup ?? false)) {
        results.push({
          name: 'unlock window phase',
          pass: false,
          summary: `a managed unlock window already exists (${existing.window ? `${existing.window.start} -> ${existing.window.end}` : 'partial state'}); cancel it first so this check does not replace a real window`,
        });
        log(`[FAIL] unlock window phase: ${results[results.length - 1].summary}`);
      } else {
        await unlockWindowPhase(client, settings, portal, never.TIMESPECGROUPKEY, args.start);
      }
    }

    const leftovers = await cleanupLeftovers(client);
    if (leftovers.length > 0) info(`removed objects left behind by this run: ${leftovers.join(', ')}`);
  } finally {
    await client.logout();
  }

  const passCount = results.filter((result) => result.pass).length;
  const failCount = results.length - passCount;
  log(`Summary: ${results.length} step(s), ${passCount} passed, ${failCount} failed.`);
  return failCount > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    logErr(`s2-netbox-mcp live-check-write: unexpected error: ${errorText(err)}`);
    process.exit(1);
  });
