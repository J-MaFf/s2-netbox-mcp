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
  timeSpecGroupName,
} from '../src/unlockWindow/managed.js';
import { dailyScheduleName } from '../src/unlockWindow/dailyPlanner.js';
import {
  cancelDailyUnlockWindow,
  getDailyUnlockWindow,
  scheduleDailyUnlockWindow,
  type DailyUnlockWindowSettings,
} from '../src/unlockWindow/dailyExecutor.js';
import {
  assertEqual,
  assertSameSet,
  assertTrue,
  clockOf,
  computeClockSkew,
  estimateControllerClock,
  formatDurationHMS,
  type ClockSkewResult,
} from './liveCheckWriteHelpers.js';

/**
 * Opt-in live WRITE smoke test for the daily recurring unlock window
 * (daily-unlock-window spec R11) — a sibling to `scripts/live-check-write.ts`
 * covering `schedule_daily_unlock_window` / `cancel_daily_unlock_window` /
 * `get_daily_unlock_window`, following the same conventions (skip line,
 * distinct name prefix, clock-skew gate, `--go` go-ahead, never-print-the-
 * password, cancel-on-failure).
 *
 * Run via `npm run test:live:write:daily` (kept separate from
 * `npm run test:live:write` rather than chained with `&&`, because npm
 * appends `-- --go` to the end of a chained script string, which would only
 * reach the *last* command and silently break the existing
 * `npm run test:live:write -- --go` invocation for the continuous feature —
 * see this session's completion note).
 *
 * (a) Skips with one line and exit 0, making no network call, unless
 *     NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD, NETBOX_ENABLE_WRITES=true
 *     and NETBOX_LIVE_TEST_PORTALKEY are all set.
 * (b) Under the distinct prefix "MCP livecheck daily", round-trips
 *     add -> get -> modify -> get -> delete for a time spec, a time spec
 *     group, a holiday, and a portal group, asserting every read-back. The
 *     portal group's unlock time spec group is *Never*, and the holiday is
 *     in 2099, so nothing here can unlock a door.
 * (b2) Estimates the controller's current time the same way as
 *      live-check-write.ts (newest GetAccessHistory record vs host clock)
 *      and refuses to run phase (c) above a 2-minute skew.
 * (c) ONLY with `--go` — passed after the operator has notified the user
 *     (push notification plus a chat message with the exact unlock/relock
 *     clock times) and received a go-ahead, because the user observes the
 *     door in person — schedules a real daily window covering only today's
 *     date, dailyStartTime = now + 2 min, dailyEndTime = now + 4 min, on
 *     NETBOX_LIVE_TEST_PORTALKEY via the real schedule_daily_unlock_window
 *     executor, asserts verified:true, prints an OBSERVE: line, polls
 *     get_daily_unlock_window every 30 s until dailyEndTime + 1 min, then
 *     calls cancel_daily_unlock_window and asserts the portal group's
 *     UNLOCKTIMESPECGROUPKEY is Never's key and no managed holiday or time
 *     spec remains.
 * (d) Never touches persons, credentials, access levels, threat levels,
 *     outputs, events, partitions, or UDF lists.
 * (e) Never prints NETBOX_PASSWORD (every line goes through redact()).
 * (f) Exits non-zero on any assertion failure and, on a failure after the
 *     door phase began, still attempts cancel_daily_unlock_window before
 *     exiting.
 *
 * `npm test` never runs this script.
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

const LIVE_PREFIX_DAILY = 'MCP livecheck daily';
const NAMES = {
  timeSpec: `${LIVE_PREFIX_DAILY} timespec`,
  timeSpecGroup: `${LIVE_PREFIX_DAILY} tsg`,
  holiday: `${LIVE_PREFIX_DAILY} holiday`,
  portalGroup: `${LIVE_PREFIX_DAILY} portalgroup`,
};

interface StepResult {
  name: string;
  pass: boolean;
  summary: string;
}

const results: StepResult[] = [];

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
        DESCRIPTION: 'created by npm run test:live:write:daily',
        STARTTIME: '08:00',
        ENDTIME: '09:00',
        ...weekdays,
      });
      specKey = text(asRecord(result.data).TIMESPECKEY);
      assertTrue('AddTimeSpec returned a TIMESPECKEY', specKey !== '');
      const spec = await fetchTimeSpec(client, specKey);
      assertTrue(`GetTimeSpec ${specKey} found it`, spec !== undefined);
      assertEqual('NAME', spec!.NAME, NAMES.timeSpec);
      return `TIMESPECKEY ${specKey}`;
    })) && allPassed;

  allPassed =
    (await step('add_time_spec_group -> get_time_spec_groups', async () => {
      const result = await client.call(NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP, {
        NAME: NAMES.timeSpecGroup,
        DESCRIPTION: 'created by npm run test:live:write:daily',
      });
      groupKey = text(asRecord(result.data).TIMESPECGROUPKEY);
      if (!groupKey) groupKey = (await fetchTimeSpecGroups(client)).find((group) => group.NAME === NAMES.timeSpecGroup)?.TIMESPECGROUPKEY ?? '';
      assertTrue('a TIMESPECGROUPKEY was resolved', groupKey !== '');
      const group = (await fetchTimeSpecGroups(client)).find((candidate) => candidate.TIMESPECGROUPKEY === groupKey);
      assertTrue(`GetTimeSpecGroups lists ${groupKey}`, group !== undefined);
      assertEqual('NAME', group!.NAME, NAMES.timeSpecGroup);
      return `TIMESPECGROUPKEY ${groupKey}`;
    })) && allPassed;

  allPassed =
    (await step('modify_time_spec_group (members) -> get_time_spec_groups', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP, {
        TIMESPECGROUPKEY: groupKey,
        ...wrapList('TIMESPECKEYS', 'TIMESPECKEY', [specKey]),
      });
      const group = (await fetchTimeSpecGroups(client)).find((candidate) => candidate.TIMESPECGROUPKEY === groupKey);
      assertTrue(`GetTimeSpecGroups lists ${groupKey}`, group !== undefined);
      assertSameSet('TIMESPECKEYS', group!.TIMESPECKEYS, [specKey]);
      return `members = [${specKey}]`;
    })) && allPassed;

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
      return `HOLIDAYKEY ${key}`;
    })) && allPassed;

  allPassed =
    (await step('modify_holiday -> get_holiday', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_HOLIDAY, { HOLIDAYKEY: key, ENDDATE: '2099-01-03 00:00' });
      const holiday = await fetchHoliday(client, key);
      assertTrue(`GetHoliday ${key} found it`, holiday !== undefined);
      assertEqual('ENDDATE', holiday!.ENDDATE, '2099-01-03 00:00');
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

async function portalGroupRoundTrip(client: NetboxClient, portalKey: string, neverKey: string): Promise<boolean> {
  let key = '';
  let allPassed = true;

  allPassed =
    (await step('add_portal_group (unlock = Never) -> get_portal_group', async () => {
      const result = await client.call(NBAPI_COMMANDS.ADD_PORTAL_GROUP, {
        NAME: NAMES.portalGroup,
        DESCRIPTION: 'created by npm run test:live:write:daily',
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
        DESCRIPTION: 'modified by npm run test:live:write:daily',
        ...wrapList('PORTALKEYS', 'PORTALKEY', [portalKey]),
        UNLOCKTIMESPECGROUPKEY: neverKey,
      });
      const group = await fetchPortalGroup(client, key);
      assertTrue(`GetPortalGroup ${key} found it`, group !== undefined);
      assertEqual('DESCRIPTION', group!.DESCRIPTION, 'modified by npm run test:live:write:daily');
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

/** Best-effort removal of any "MCP livecheck daily *" object a previous
 * aborted run left behind — only objects carrying that prefix are touched. */
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
    if (group.NAME.startsWith(LIVE_PREFIX_DAILY)) {
      await attempt(`portal group ${group.PORTALGROUPKEY}`, () => client.call(NBAPI_COMMANDS.DELETE_PORTAL_GROUP, { PORTALGROUPKEY: group.PORTALGROUPKEY }));
    }
  }
  for (const group of await fetchTimeSpecGroups(client)) {
    if (group.NAME.startsWith(LIVE_PREFIX_DAILY)) {
      await attempt(`time spec group ${group.TIMESPECGROUPKEY}`, () =>
        client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC_GROUP, { TIMESPECGROUPKEY: group.TIMESPECGROUPKEY })
      );
    }
  }
  for (const spec of await fetchTimeSpecs(client)) {
    if (spec.NAME.startsWith(LIVE_PREFIX_DAILY)) {
      await attempt(`time spec ${spec.TIMESPECKEY}`, () => client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY: spec.TIMESPECKEY }));
    }
  }
  for (const holiday of await fetchHolidays(client)) {
    if (holiday.NAME.startsWith(LIVE_PREFIX_DAILY)) {
      await attempt(`holiday ${holiday.HOLIDAYKEY}`, () => client.call(NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY: holiday.HOLIDAYKEY }));
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// (b2) controller clock estimate, from the newest GetAccessHistory record
// (mirrors scripts/live-check-write.ts; duplicated here in miniature so this
// script has no import-order dependency on that one).
// ---------------------------------------------------------------------------

function findNewestAccessDttm(data: unknown): string | undefined {
  const record = asRecord(data);
  if (typeof record.DTTM === 'string') return record.DTTM;
  for (const value of Object.values(record)) {
    if (value === null || typeof value !== 'object') continue;
    const nested = asRecord(value);
    if (typeof nested.DTTM === 'string') return nested.DTTM;
    for (const list of [asRecordList(value), ...Object.values(nested).map(asRecordList)]) {
      const withDttm = list.find((item) => typeof item.DTTM === 'string');
      if (withDttm) return text(withDttm.DTTM);
    }
  }
  return undefined;
}

async function fetchNewestAccessDttm(client: NetboxClient): Promise<string | undefined> {
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_HISTORY, { MAXRECORDS: '1' });
    if (result.notFound) return undefined;
    return findNewestAccessDttm(result.data);
  } catch (err) {
    if (isBareNotFoundFail(err)) return undefined;
    throw err;
  }
}

async function controllerClockCheck(client: NetboxClient): Promise<ClockSkewResult> {
  const newestDttm = await fetchNewestAccessDttm(client);
  const skew = computeClockSkew(new Date(), newestDttm);
  const name = 'controller clock check (newest access record vs host clock)';
  if (skew.status === 'ok' || skew.status === 'fail') {
    const line = `controller clock ~${skew.controllerClock} (newest access record) vs host ${skew.hostClock} — skew ${formatDurationHMS(skew.skewSeconds ?? 0)}`;
    if (skew.status === 'ok') {
      results.push({ name, pass: true, summary: line });
      info(line);
    } else {
      const summary = `controller clock skew: controller ${skew.controllerClock} vs host ${skew.hostClock}`;
      results.push({ name, pass: false, summary });
      info(line);
      log(`[FAIL] ${summary}`);
      log('hint: if the site has simply been quiet, badge any reader and re-run');
    }
    return skew;
  }
  log('[WARN] no access history record was available to estimate the controller clock; skipping the skew gate');
  return skew;
}

// ---------------------------------------------------------------------------
// (c) the real daily window, covering only today's date
// ---------------------------------------------------------------------------

interface DailyTestWindow {
  startDate: string;
  endDate: string;
  dailyStartTime: string;
  dailyEndTime: string;
  unlockClock: string;
  relockClock: string;
  pollUntilMs: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Today's date, unlock = now + 2 min, relock = now + 4 min (seconds dropped),
 * as a same-day daily-window request (R11 c). */
function computeDailyTestWindow(now: Date): DailyTestWindow {
  const wholeMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  const unlock = new Date(wholeMinute.getTime() + 2 * 60_000);
  const relock = new Date(wholeMinute.getTime() + 4 * 60_000);
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return {
    startDate: today,
    endDate: today,
    dailyStartTime: clockOf(unlock),
    dailyEndTime: clockOf(relock),
    unlockClock: clockOf(unlock),
    relockClock: clockOf(relock),
    pollUntilMs: relock.getTime() + 60_000,
  };
}

async function dailyUnlockWindowPhase(
  client: NetboxClient,
  settings: DailyUnlockWindowSettings,
  portal: { PORTALKEY: string; NAME: string },
  neverKey: string,
  clockSkew: ClockSkewResult
): Promise<void> {
  const now = new Date();
  const window = computeDailyTestWindow(now);
  if (window.dailyEndTime <= window.dailyStartTime) {
    // Crossed midnight while building the window (running this right at day
    // boundary) — the daily tool rejects an overnight-crossing window by
    // design (Out of scope), so refuse cleanly rather than let it fail deep
    // inside schedule_daily_unlock_window.
    results.push({ name: 'daily unlock window phase', pass: false, summary: 'refused: the 2-4 minute test window crossed midnight; re-run a few minutes later' });
    log(`[FAIL] daily unlock window phase: ${results[results.length - 1].summary}`);
    return;
  }
  const estimatedControllerNow =
    clockSkew.offsetSeconds === undefined ? 'unavailable' : estimateControllerClock(now, clockSkew.offsetSeconds);
  log(
    `HEADS-UP: scheduling a 2-minute daily unlock of portal ${portal.NAME} (key ${portal.PORTALKEY}) for today ${window.startDate}: ` +
      `unlock ${window.unlockClock}, relock ${window.relockClock} (estimated controller time now: ${estimatedControllerNow})`
  );

  let scheduled = false;
  try {
    await step('schedule_daily_unlock_window (verified:true)', async () => {
      const result = await scheduleDailyUnlockWindow(
        client,
        {
          startDate: window.startDate,
          endDate: window.endDate,
          dailyStartTime: window.dailyStartTime,
          dailyEndTime: window.dailyEndTime,
          portalKeys: [portal.PORTALKEY],
          acknowledgeSideEffects: true,
        },
        settings
      );
      scheduled = true;
      assertTrue('the executor returned a non-dry-run result', 'verified' in result);
      assertTrue('verified === true', 'verified' in result && result.verified === true);
      return `${window.startDate} ${window.dailyStartTime}-${window.dailyEndTime}, portal group ${'portalGroupKey' in result ? result.portalGroupKey : '?'}`;
    });
    if (!scheduled) return;

    log(`OBSERVE: portal ${portal.NAME} should unlock at ${window.unlockClock} and relock at ${window.relockClock} — confirm on Monitor → Portal Status`);

    await step('get_daily_unlock_window polled every 30 s until dailyEndTime + 1 min', async () => {
      let sawActive = false;
      let polls = 0;
      for (;;) {
        const status = await getDailyUnlockWindow(client, settings);
        polls += 1;
        if (status.activeNow) sawActive = true;
        log(`[poll ${clockOf(new Date())}] activeNow=${status.activeNow} window=${status.window ? `${status.window.startDate} ${status.window.dailyStartTime}-${status.window.dailyEndTime}` : 'none'}`);
        const remaining = window.pollUntilMs - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(30_000, remaining));
      }
      assertTrue('activeNow was reported true at least once inside the window', sawActive);
      return `${polls} poll(s); activeNow observed true during the window`;
    });
  } finally {
    if (scheduled) {
      await step('cancel_daily_unlock_window -> portal group on Never, no managed holiday/time spec/group member', async () => {
        const result = await cancelDailyUnlockWindow(client, settings);
        assertTrue('cancelled', result.cancelled);
        const managed = (await fetchPortalGroups(client)).find((group) => group.NAME === settings.namePrefix);
        assertTrue(`managed portal group "${settings.namePrefix}" still exists`, managed !== undefined);
        const group = await fetchPortalGroup(client, managed!.PORTALGROUPKEY);
        assertEqual('UNLOCKTIMESPECGROUPKEY is Never', group?.UNLOCKTIMESPECGROUPKEY, neverKey);
        const name = dailyScheduleName(settings.namePrefix);
        const leftoverHoliday = (await fetchHolidays(client)).some((holiday) => holiday.NAME === name);
        assertTrue('no managed holiday remains', !leftoverHoliday);
        const leftoverSpec = (await fetchTimeSpecs(client)).some((spec) => spec.NAME === name);
        assertTrue('no managed time spec remains', !leftoverSpec);
        const managedTsg = (await fetchTimeSpecGroups(client)).find((tsg) => tsg.NAME === timeSpecGroupName(settings.namePrefix));
        assertSameSet('managed time spec group members remaining', managedTsg?.TIMESPECKEYS ?? [], []);
        if (result.leftBehind.length > 0) {
          info(`cancel_daily_unlock_window reported leftBehind (tolerated): ${result.leftBehind.map((item) => `${item.type} "${item.NAME}": ${item.error}`).join('; ')}`);
        }
        return `portal group ${managed!.PORTALGROUPKEY} on Never (${neverKey})`;
      });
    }
  }
}

// ---------------------------------------------------------------------------

interface Args {
  go: boolean;
}

class ArgError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { go: false };
  for (const arg of argv) {
    if (arg === '--go') {
      args.go = true;
    } else {
      throw new ArgError(`Unknown argument "${arg}". Usage: npm run test:live:write:daily -- [--go]`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      console.error(`s2-netbox-mcp live-check-write-daily: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const { NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD } = process.env;
  const skipLine =
    's2-netbox-mcp live-check-write-daily: skipped (requires NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD, NETBOX_ENABLE_WRITES=true and NETBOX_LIVE_TEST_PORTALKEY).';
  if (!NETBOX_BASE_URL || !NETBOX_USERNAME || !NETBOX_PASSWORD) {
    console.log(skipLine);
    return 0;
  }

  let config;
  try {
    config = loadConfigFromEnv();
  } catch (err) {
    if (err instanceof NetboxConfigError) {
      console.error(`s2-netbox-mcp live-check-write-daily: ${err.message}`);
      return 1;
    }
    throw err;
  }
  if (!config.enableWrites || !config.liveTestPortalKey) {
    console.log(skipLine);
    return 0;
  }

  secret = config.password;
  const client = new NetboxClient(config);
  const settings: DailyUnlockWindowSettings = { holidayGroup: config.dailyUnlockHolidayGroup, namePrefix: config.dailyUnlockNamePrefix };

  try {
    const portals = await fetchAllPages(client, NBAPI_COMMANDS.GET_PORTALS, 'PORTALS', 'PORTAL');
    const portalRecord = portals.find((portal) => text(portal.PORTALKEY) === config.liveTestPortalKey);
    if (!portalRecord) {
      logErr(`s2-netbox-mcp live-check-write-daily: NETBOX_LIVE_TEST_PORTALKEY=${config.liveTestPortalKey} was not returned by GetPortals.`);
      return 1;
    }
    const portal = { PORTALKEY: text(portalRecord.PORTALKEY), NAME: text(portalRecord.NAME) };
    const never = (await fetchTimeSpecGroups(client)).find((group) => group.NAME === NEVER_GROUP_NAME);
    if (!never) {
      logErr(`s2-netbox-mcp live-check-write-daily: no time spec group named "${NEVER_GROUP_NAME}" exists; refusing to continue.`);
      return 1;
    }
    log(`Designated portal: ${portal.NAME} (key ${portal.PORTALKEY}); Never = ${never.TIMESPECGROUPKEY}; prefix "${settings.namePrefix}"; daily group ${settings.holidayGroup}`);

    const removed = await cleanupLeftovers(client);
    if (removed.length > 0) info(`removed leftovers from a previous run: ${removed.join(', ')}`);

    // (b)
    let crudPassed = true;
    crudPassed = (await timeSpecAndGroupRoundTrip(client, settings.holidayGroup)) && crudPassed;
    crudPassed = (await holidayRoundTrip(client, settings.holidayGroup)) && crudPassed;
    crudPassed = (await portalGroupRoundTrip(client, portal.PORTALKEY, never.TIMESPECGROUPKEY)) && crudPassed;

    // (b2)
    const clockSkew = await controllerClockCheck(client);

    // (c)
    if (clockSkew.status === 'fail') {
      info('phase (c) — the real daily unlock of the designated portal — was NOT run: the controller clock skew check failed above.');
    } else if (!args.go) {
      info(
        'phase (c) — the real daily unlock of the designated portal — was NOT run. Notify the user (push notification plus a chat ' +
          'message with the exact unlock and relock clock times), get a go-ahead, then re-run with `npm run test:live:write:daily -- --go`.'
      );
    } else if (!crudPassed) {
      results.push({ name: 'daily unlock window phase', pass: false, summary: 'skipped because a CRUD round-trip failed' });
      log('[FAIL] daily unlock window phase: skipped because a CRUD round-trip failed');
    } else {
      const existing = await getDailyUnlockWindow(client, settings);
      if (existing.holiday !== null || (existing.portalGroup?.pointsAtManagedTimeSpecGroup ?? false)) {
        results.push({
          name: 'daily unlock window phase',
          pass: false,
          summary: `a managed daily unlock window already exists (${existing.window ? `${existing.window.startDate}..${existing.window.endDate}` : 'partial state'}); cancel it first so this check does not replace a real window`,
        });
        log(`[FAIL] daily unlock window phase: ${results[results.length - 1].summary}`);
      } else {
        await dailyUnlockWindowPhase(client, settings, portal, never.TIMESPECGROUPKEY, clockSkew);
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
    logErr(`s2-netbox-mcp live-check-write-daily: unexpected error: ${errorText(err)}`);
    process.exit(1);
  });
