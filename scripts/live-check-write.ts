import 'dotenv/config';
import { loadConfigFromEnv, NetboxConfigError } from '../src/config.js';
import { NetboxClient } from '../src/netboxClient.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { wrapList, mergeParams } from '../src/toolHelpers.js';
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
  computeClockSkew,
  computeTestWindow,
  estimateControllerClock,
  formatDurationHMS,
  parseCardFormatName,
  parseLiveCheckWriteArgs,
  type ClockSkewResult,
} from './liveCheckWriteHelpers.js';

/**
 * Opt-in live WRITE smoke test (R30 / C20 / #13) — `npm run test:live:write`.
 *
 * (a) Skips with one line and exit 0, making no network call, unless
 *     NETBOX_BASE_URL, NETBOX_USERNAME, NETBOX_PASSWORD, NETBOX_ENABLE_WRITES=true
 *     and NETBOX_LIVE_TEST_PORTALKEY are all set.
 * (b) Under the distinct prefix "MCP livecheck", round-trips
 *     add -> get -> modify -> get -> delete for a time spec, a time spec
 *     group, a holiday, a reader group, a portal group, a person (plus a
 *     credential on that person), an access level (plus an access level
 *     group), and a threat level (plus a threat level group), asserting
 *     every read-back, then confirms InsertActivity, a UDF list item
 *     round-trip (or SKIPPED if no UDF list exists), and SwitchPartition
 *     back to the session's own partition. The portal group's unlock time
 *     spec group is *Never*, and the holiday is in 2099, so nothing here can
 *     unlock a door. SetThreatLevel, AddPartition, permanently purging a
 *     person, and TriggerEvent are never used (#13).
 * (c) ONLY with `--go` — which the operator passes after notifying the user
 *     (push notification plus a chat message with the exact unlock and relock
 *     clock times) and receiving a go-ahead, because the user observes the
 *     door in person — schedules a real 2-minute unlock window on the
 *     designated portal via the real schedule_unlock_window executor, polls
 *     get_unlock_window every 30 s, then cancels and asserts the portal group
 *     is on *Never* and no managed holiday remains. `--start HH:MM` pins the
 *     unlock time (1-60 min ahead) so the exact times can be communicated
 *     before the go-ahead; otherwise unlock = now + 2 min, relock = + 4 min.
 * (d) Never touches outputs or portal lock/unlock actions directly, never
 *     calls SetThreatLevel, AddPartition, TriggerEvent, or permanently purges
 *     a person record (unit tests cover those).
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
  person: `${LIVE_PREFIX} person`,
  accessLevel: `${LIVE_PREFIX} accesslevel`,
  accessLevel2: `${LIVE_PREFIX} accesslevel2`,
  accessLevelGroup: `${LIVE_PREFIX} alg`,
  // Short, on purpose: the live 6.2.0 controller was observed to reject
  // AddThreatLevel for the full "MCP livecheck threatlevel" name even though
  // only the six default threat levels existed (ruling out the documented
  // two-custom-level cap) — a length limit is a plausible cause, so this name
  // is kept short while still carrying an "MCP" prefix (#13).
  threatLevel: 'MCP LC TL',
  threatLevelGroup: `${LIVE_PREFIX} tlg`,
  udfItem: `${LIVE_PREFIX} item`,
};

/** Fixed test card number used for the credential round-trip (#13). Kept small
 * on purpose: the live controller's first CARDFORMAT is "26 bit Wiegand",
 * whose card number field is only 16 bits wide (max 65535), so a larger
 * 8-digit number overflows it ("Encoded number ... is too large for selected
 * format"). This value fits every common Wiegand format's card-number field,
 * not just 26-bit. */
const TEST_CARD_NUMBER = '65431';
/** Fixed CUSTOMKEY used for the UDF list item round-trip (#13). */
const UDF_ITEM_CUSTOMKEY = '_mcp_livecheck';

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

/** Reads a person by PERSONID (GetPerson), tolerant of the response's exact
 * wrapping. `wantCredentialId: true` requests CREDENTIALID on returned cards
 * (per #13's AddCredential -> GetPerson(WANTCREDENTIALID) round-trip). */
async function readPerson(client: NetboxClient, PERSONID: string, wantCredentialId = false) {
  try {
    const result = await client.call(
      NBAPI_COMMANDS.GET_PERSON,
      mergeParams({ PERSONID, WANTCREDENTIALID: wantCredentialId ? '1' : undefined })
    );
    if (result.notFound) return undefined;
    const details = asRecord(result.data);
    const raw = 'PERSON' in details ? asRecord(details.PERSON) : details;
    const cardsContainer = asRecord(raw.CARDS ?? raw.ACCESSCARDS ?? raw.CREDENTIALS);
    const cards = asRecordList(cardsContainer.CARD ?? cardsContainer.ACCESSCARD ?? cardsContainer.CREDENTIAL ?? []);
    return {
      PERSONID: text(raw.PERSONID) || PERSONID,
      LASTNAME: text(raw.LASTNAME),
      MIDDLENAME: text(raw.MIDDLENAME),
      NOTES: text(raw.NOTES),
      DELETED: /^\s*TRUE\s*$/i.test(text(raw.DELETED)),
      CARDS: cards.map((card) => ({
        CREDENTIALID: text(card.CREDENTIALID),
        ENCODEDNUM: text(card.ENCODEDNUM),
        HOTSTAMP: text(card.HOTSTAMP),
        CARDFORMAT: text(card.CARDFORMAT),
        DISABLED: text(card.DISABLED),
      })),
    };
  } catch (err) {
    if (isBareNotFoundFail(err)) return undefined;
    throw err;
  }
}

/** Extracts PERSONID values from a SearchPersonData response, tolerant of exact wrapping. */
function extractSearchedPersonIds(data: unknown): string[] {
  const details = asRecord(data);
  const container = 'PERSONS' in details ? asRecord(details.PERSONS) : details;
  const list = asRecordList(container.PERSON ?? details.PERSON ?? []);
  return list.map((person) => text(person.PERSONID)).filter((id) => id !== '');
}

/** Removes any person whose LASTNAME is the "MCP livecheck person" prefix
 * name (SearchPersonData -> RemovePerson), best-effort. Used both to clear a
 * previous aborted run before add_person and in final leftover cleanup. */
async function removeExistingLivecheckPersons(client: NetboxClient): Promise<string[]> {
  const removed: string[] = [];
  try {
    const result = await client.call(NBAPI_COMMANDS.SEARCH_PERSON_DATA, { LASTNAME: NAMES.person });
    if (result.notFound) return removed;
    for (const personId of extractSearchedPersonIds(result.data)) {
      try {
        await client.call(NBAPI_COMMANDS.REMOVE_PERSON, { PERSONID: personId });
        removed.push(`person ${personId}`);
      } catch (err) {
        info(`cleanup could not remove person ${personId}: ${errorText(err)}`);
      }
    }
  } catch (err) {
    if (!isBareNotFoundFail(err)) info(`SearchPersonData for leftover persons failed: ${errorText(err)}`);
  }
  return removed;
}

/** Reads an access level by ACCESSLEVELKEY (GetAccessLevel), tolerant of the response's exact wrapping. */
async function readAccessLevel(client: NetboxClient, ACCESSLEVELKEY: string) {
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_LEVEL, { ACCESSLEVELKEY });
    if (result.notFound) return undefined;
    const details = asRecord(result.data);
    const raw = 'ACCESSLEVEL' in details ? asRecord(details.ACCESSLEVEL) : details;
    return {
      ACCESSLEVELKEY: text(raw.ACCESSLEVELKEY) || ACCESSLEVELKEY,
      ACCESSLEVELNAME: text(raw.ACCESSLEVELNAME),
      ACCESSLEVELDESCRIPTION: text(raw.ACCESSLEVELDESCRIPTION),
      TIMESPECGROUPKEY: text(raw.TIMESPECGROUPKEY),
      READERKEY: text(raw.READERKEY),
    };
  } catch (err) {
    if (isBareNotFoundFail(err)) return undefined;
    throw err;
  }
}

/** Reads an access level group by ACCESSLEVELGROUPKEY (GetAccessLevelGroup),
 * tolerant of the response's exact wrapping and of the controller's known
 * FAIL/ERRMSG="NOT FOUND" quirk (documented for GetTimeSpecGroup against an
 * empty/unconfigured collection — spec "Live facts") treated the same way
 * here for an access level group with no members. */
async function readAccessLevelGroup(client: NetboxClient, ACCESSLEVELGROUPKEY: string) {
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP, { ACCESSLEVELGROUPKEY });
    if (result.notFound) return undefined;
    const details = asRecord(result.data);
    const raw = 'ACCESSLEVELGROUP' in details ? asRecord(details.ACCESSLEVELGROUP) : details;
    const items = asRecordList(asRecord(raw.ACCESSLEVELS).ACCESSLEVEL ?? []);
    return {
      ACCESSLEVELGROUPKEY: text(raw.ACCESSLEVELGROUPKEY) || ACCESSLEVELGROUPKEY,
      NAME: text(raw.NAME),
      DESCRIPTION: text(raw.DESCRIPTION),
      ACCESSLEVELKEYS: items.map((item) => text(item.KEY)).filter((key) => key !== ''),
    };
  } catch (err) {
    if (isBareNotFoundFail(err)) return undefined;
    throw err;
  }
}

/** Resolves the first CARDFORMAT name from GetCardFormats, tolerant of the
 * response's exact wrapping and of the live 6.2.0 shape where CARDFORMAT is
 * a plain string (or array of plain strings) rather than an object carrying
 * NAME (#13). */
async function fetchFirstCardFormatName(client: NetboxClient): Promise<string> {
  const result = await client.call(NBAPI_COMMANDS.GET_CARD_FORMATS, {});
  if (result.notFound) return '';
  const details = asRecord(result.data);
  const name = parseCardFormatName(asRecord(details.CARDFORMATS).CARDFORMAT);
  if (name !== '') return name;
  return typeof details.NAME === 'string' ? text(details.NAME) : '';
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
  removed.push(...(await removeExistingLivecheckPersons(client)));
  const accessLevelGroups = await fetchAllPages(
    client,
    NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS,
    'ACCESSLEVELGROUPS',
    'ACCESSLEVELGROUP',
    { emptyOnNotFoundFail: true }
  );
  for (const group of accessLevelGroups) {
    if (text(group.NAME).startsWith(LIVE_PREFIX)) {
      await attempt(`access level group ${text(group.ACCESSLEVELGROUPKEY)}`, () =>
        client.call(NBAPI_COMMANDS.DELETE_ACCESS_LEVEL_GROUP, { ACCESSLEVELGROUPKEY: text(group.ACCESSLEVELGROUPKEY) })
      );
    }
  }
  const accessLevels = await fetchAllPages(client, NBAPI_COMMANDS.GET_ACCESS_LEVELS, 'ACCESSLEVELS', 'ACCESSLEVEL', {
    emptyOnNotFoundFail: true,
  });
  for (const level of accessLevels) {
    if (text(level.ACCESSLEVELNAME ?? level.NAME).startsWith(LIVE_PREFIX)) {
      await attempt(`access level ${text(level.ACCESSLEVELKEY)}`, () =>
        client.call(NBAPI_COMMANDS.DELETE_ACCESS_LEVEL, { ACCESSLEVELKEY: text(level.ACCESSLEVELKEY) })
      );
    }
  }
  // No list command exists for threat levels/groups — attempt removal of the
  // known prefixed names directly; a "not found" style failure here is
  // expected and non-fatal on a run where nothing was left behind.
  await attempt(`threat level group "${NAMES.threatLevelGroup}"`, () =>
    client.call(NBAPI_COMMANDS.REMOVE_THREAT_LEVEL_GROUP, { LEVELGROUPNAME: NAMES.threatLevelGroup })
  );
  await attempt(`threat level "${NAMES.threatLevel}"`, () =>
    client.call(NBAPI_COMMANDS.REMOVE_THREAT_LEVEL, { LEVELNAME: NAMES.threatLevel })
  );
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

/** Modifies or removes a credential, preferring CREDENTIALID-only
 * identification and falling back to PERSONID + CARDFORMAT + ENCODEDNUM (both
 * forms the doc allows) if the controller refuses the first. Logs which form
 * worked (#13). */
async function callCredentialCommand(
  client: NetboxClient,
  command: typeof NBAPI_COMMANDS.MODIFY_CREDENTIAL | typeof NBAPI_COMMANDS.REMOVE_CREDENTIAL,
  personId: string,
  credentialId: string,
  cardFormat: string,
  extraParams: Record<string, string> = {}
): Promise<string> {
  try {
    await client.call(command, mergeParams({ PERSONID: personId, CREDENTIALID: credentialId, ...extraParams }));
    return 'PERSONID + CREDENTIALID';
  } catch (err) {
    info(`${command} with PERSONID + CREDENTIALID was refused (${errorText(err)}); retrying with PERSONID + CARDFORMAT + ENCODEDNUM`);
    await client.call(command, mergeParams({ PERSONID: personId, CARDFORMAT: cardFormat, ENCODEDNUM: TEST_CARD_NUMBER, ...extraParams }));
    return 'PERSONID + CARDFORMAT + ENCODEDNUM';
  }
}

async function personRoundTrip(client: NetboxClient): Promise<boolean> {
  let personId = '';
  let credentialId = '';
  let cardFormat = '';
  let allPassed = true;

  const preExisting = await removeExistingLivecheckPersons(client);
  if (preExisting.length > 0) info(`removed pre-existing "${NAMES.person}" person(s) from a previous run: ${preExisting.join(', ')}`);

  allPassed =
    (await step('add_person -> get_person', async () => {
      const result = await client.call(NBAPI_COMMANDS.ADD_PERSON, {
        LASTNAME: NAMES.person,
        FIRSTNAME: 'Test',
        NOTES: 'created by npm run test:live:write',
      });
      personId = text(asRecord(result.data).PERSONID);
      assertTrue('AddPerson returned a PERSONID', personId !== '');
      const person = await readPerson(client, personId);
      assertTrue(`GetPerson ${personId} found it`, person !== undefined);
      assertEqual('LASTNAME', person!.LASTNAME, NAMES.person);
      return `PERSONID ${personId}`;
    })) && allPassed;

  allPassed =
    (await step('modify_person (MIDDLENAME/NOTES) -> get_person', async () => {
      await client.call(NBAPI_COMMANDS.MODIFY_PERSON, {
        PERSONID: personId,
        MIDDLENAME: 'Livecheck',
        NOTES: 'modified by npm run test:live:write',
      });
      const person = await readPerson(client, personId);
      assertTrue(`GetPerson ${personId} found it`, person !== undefined);
      assertEqual('MIDDLENAME', person!.MIDDLENAME, 'Livecheck');
      assertEqual('NOTES', person!.NOTES, 'modified by npm run test:live:write');
      return 'MIDDLENAME=Livecheck';
    })) && allPassed;

  allPassed =
    (await step('add_credential -> get_person (WANTCREDENTIALID) shows the card', async () => {
      cardFormat = await fetchFirstCardFormatName(client);
      assertTrue('GetCardFormats returned at least one format', cardFormat !== '');
      const result = await client.call(NBAPI_COMMANDS.ADD_CREDENTIAL, {
        PERSONID: personId,
        CARDFORMAT: cardFormat,
        ENCODEDNUM: TEST_CARD_NUMBER,
        HOTSTAMP: TEST_CARD_NUMBER,
        WANTCREDENTIALID: '1',
      });
      credentialId = text(asRecord(result.data).CREDENTIALID);
      const person = await readPerson(client, personId, true);
      assertTrue(`GetPerson ${personId} found it`, person !== undefined);
      const card = person!.CARDS.find(
        (c) => c.CREDENTIALID === credentialId || c.ENCODEDNUM === TEST_CARD_NUMBER || c.HOTSTAMP === TEST_CARD_NUMBER
      );
      assertTrue('GetPerson (WANTCREDENTIALID) lists the new card', card !== undefined);
      if (!credentialId) credentialId = card!.CREDENTIALID;
      assertTrue('a CREDENTIALID was resolved', credentialId !== '');
      return `CARDFORMAT "${cardFormat}", CREDENTIALID ${credentialId}`;
    })) && allPassed;

  allPassed =
    (await step('modify_credential (DISABLED=1) -> get_person shows DISABLED', async () => {
      const form = await callCredentialCommand(client, NBAPI_COMMANDS.MODIFY_CREDENTIAL, personId, credentialId, cardFormat, {
        DISABLED: '1',
      });
      const person = await readPerson(client, personId, true);
      const card = person?.CARDS.find((c) => c.CREDENTIALID === credentialId);
      assertTrue('GetPerson still lists the credential', card !== undefined);
      assertEqual('DISABLED', card!.DISABLED, '1');
      return `DISABLED=1 (identified via ${form})`;
    })) && allPassed;

  allPassed =
    (await step('remove_credential -> get_person shows no card', async () => {
      const form = await callCredentialCommand(client, NBAPI_COMMANDS.REMOVE_CREDENTIAL, personId, credentialId, cardFormat);
      const person = await readPerson(client, personId, true);
      const stillThere = person?.CARDS.some((c) => c.CREDENTIALID === credentialId) ?? false;
      assertTrue('the credential is gone from GetPerson', !stillThere);
      return `CREDENTIALID ${credentialId} removed (identified via ${form})`;
    })) && allPassed;

  allPassed =
    (await step('remove_person -> get_person (NOT FOUND or DELETED=TRUE)', async () => {
      await client.call(NBAPI_COMMANDS.REMOVE_PERSON, { PERSONID: personId });
      const after = await readPerson(client, personId);
      if (after === undefined) return `PERSONID ${personId}: GetPerson returned NOT FOUND`;
      assertTrue('GetPerson shows DELETED=TRUE after RemovePerson', after.DELETED);
      return `PERSONID ${personId}: GetPerson returned DELETED=TRUE`;
    })) && allPassed;

  return allPassed;
}

async function accessLevelRoundTrip(client: NetboxClient, neverKey: string, readerKey: string): Promise<boolean> {
  let levelKey = '';
  let level2Key = '';
  let groupKey = '';
  let allPassed = true;

  allPassed =
    (await step('add_access_level (TIMESPECGROUPKEY=Never) -> get_access_level', async () => {
      const result = await client.call(
        NBAPI_COMMANDS.ADD_ACCESS_LEVEL,
        mergeParams({ ACCESSLEVELNAME: NAMES.accessLevel, TIMESPECGROUPKEY: neverKey, READERKEY: readerKey || undefined })
      );
      levelKey = text(asRecord(result.data).ACCESSLEVELKEY);
      assertTrue('AddAccessLevel returned an ACCESSLEVELKEY', levelKey !== '');
      const level = await readAccessLevel(client, levelKey);
      assertTrue(`GetAccessLevel ${levelKey} found it`, level !== undefined);
      assertEqual('ACCESSLEVELNAME', level!.ACCESSLEVELNAME, NAMES.accessLevel);
      assertEqual('TIMESPECGROUPKEY', level!.TIMESPECGROUPKEY, neverKey);
      return `ACCESSLEVELKEY ${levelKey}`;
    })) && allPassed;

  allPassed =
    (await step('modify_access_level (description) -> get_access_level', async () => {
      // The controller requires TIMESPECGROUPKEY on every ModifyAccessLevel
      // call, despite the doc's example omitting it (#13) — reaffirm Never.
      await client.call(NBAPI_COMMANDS.MODIFY_ACCESS_LEVEL, {
        ACCESSLEVELKEY: levelKey,
        ACCESSLEVELDESCRIPTION: 'modified by npm run test:live:write',
        TIMESPECGROUPKEY: neverKey,
      });
      const level = await readAccessLevel(client, levelKey);
      assertTrue(`GetAccessLevel ${levelKey} found it`, level !== undefined);
      assertEqual('ACCESSLEVELDESCRIPTION', level!.ACCESSLEVELDESCRIPTION, 'modified by npm run test:live:write');
      return 'ACCESSLEVELDESCRIPTION modified';
    })) && allPassed;

  allPassed =
    (await step('delete_access_level -> get_access_level', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_ACCESS_LEVEL, { ACCESSLEVELKEY: levelKey });
      assertTrue(`access level ${levelKey} is gone`, await isGone(() => readAccessLevel(client, levelKey)));
      return `ACCESSLEVELKEY ${levelKey} deleted`;
    })) && allPassed;

  allPassed =
    (await step('add_access_level_group (second temp access level) -> get_access_level_group', async () => {
      const level2 = await client.call(
        NBAPI_COMMANDS.ADD_ACCESS_LEVEL,
        mergeParams({ ACCESSLEVELNAME: NAMES.accessLevel2, TIMESPECGROUPKEY: neverKey, READERKEY: readerKey || undefined })
      );
      level2Key = text(asRecord(level2.data).ACCESSLEVELKEY);
      assertTrue('AddAccessLevel (temp) returned an ACCESSLEVELKEY', level2Key !== '');

      const result = await client.call(
        NBAPI_COMMANDS.ADD_ACCESS_LEVEL_GROUP,
        mergeParams({ NAME: NAMES.accessLevelGroup, ...wrapList('ACCESSLEVELS', 'ACCESSLEVEL', [{ KEY: level2Key }]) })
      );
      groupKey = text(asRecord(result.data).ACCESSLEVELGROUPKEY);
      assertTrue('AddAccessLevelGroup returned an ACCESSLEVELGROUPKEY', groupKey !== '');
      const group = await readAccessLevelGroup(client, groupKey);
      assertTrue(`GetAccessLevelGroup ${groupKey} found it`, group !== undefined);
      assertEqual('NAME', group!.NAME, NAMES.accessLevelGroup);
      assertSameSet('ACCESSLEVELKEYS', group!.ACCESSLEVELKEYS, [level2Key]);
      return `ACCESSLEVELGROUPKEY ${groupKey}, member ${level2Key}`;
    })) && allPassed;

  allPassed =
    (await step('modify_access_level_group (description) -> get_access_level_group', async () => {
      await client.call(
        NBAPI_COMMANDS.MODIFY_ACCESS_LEVEL_GROUP,
        mergeParams({
          ACCESSLEVELGROUPKEY: groupKey,
          DESCRIPTION: 'modified by npm run test:live:write',
          ...wrapList('ACCESSLEVELS', 'ACCESSLEVEL', [{ KEY: level2Key }]),
        })
      );
      const group = await readAccessLevelGroup(client, groupKey);
      assertTrue(`GetAccessLevelGroup ${groupKey} found it`, group !== undefined);
      assertEqual('DESCRIPTION', group!.DESCRIPTION, 'modified by npm run test:live:write');
      return 'DESCRIPTION modified';
    })) && allPassed;

  allPassed =
    (await step('delete_access_level_group -> get_access_level_group (NOT FOUND quirk tolerated)', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_ACCESS_LEVEL_GROUP, { ACCESSLEVELGROUPKEY: groupKey });
      assertTrue(`access level group ${groupKey} is gone`, await isGone(() => readAccessLevelGroup(client, groupKey)));
      return `ACCESSLEVELGROUPKEY ${groupKey} deleted`;
    })) && allPassed;

  allPassed =
    (await step('delete_access_level (temp, cleanup) -> get_access_level', async () => {
      await client.call(NBAPI_COMMANDS.DELETE_ACCESS_LEVEL, { ACCESSLEVELKEY: level2Key });
      assertTrue(`access level ${level2Key} is gone`, await isGone(() => readAccessLevel(client, level2Key)));
      return `ACCESSLEVELKEY ${level2Key} deleted`;
    })) && allPassed;

  return allPassed;
}

/** Steps that depend on add_threat_level having actually created the level;
 * skipped (not failed) when it did not, so one controller-side rejection
 * does not cascade into five more FAILs (#13). */
const THREAT_LEVEL_DEPENDENT_STEPS = [
  'add_threat_level_group (confirms the level exists)',
  'modify_threat_level (COLOR=Green)',
  'modify_threat_level_group (LEVELNAMES)',
  'remove_threat_level_group',
  'remove_threat_level -> a second remove_threat_level fails (proves it is gone)',
];

async function threatLevelRoundTrip(client: NetboxClient): Promise<boolean> {
  let allPassed = true;
  let levelCreated = false;

  allPassed =
    (await step('add_threat_level (COLOR=Blue)', async () => {
      // SEQNUM is documented as optional, but the doc's own AddThreatLevel
      // example sends SEQNUM 4 — sent here in case it is required in
      // practice (#13).
      await client.call(NBAPI_COMMANDS.ADD_THREAT_LEVEL, { LEVELNAME: NAMES.threatLevel, COLOR: 'Blue', SEQNUM: '7' });
      levelCreated = true;
      return `LEVELNAME "${NAMES.threatLevel}"`;
    })) && allPassed;

  if (!levelCreated) {
    const note =
      'SKIPPED: add_threat_level failed above (see that step for the controller\'s message). The six-default-plus-two-custom cap was ' +
      'ruled out (only the six defaults existed); a short LEVELNAME and an explicit SEQNUM were both tried without success.';
    for (const name of THREAT_LEVEL_DEPENDENT_STEPS) {
      results.push({ name, pass: true, summary: note });
      log(`[PASS] ${name}: ${note}`);
    }
    return allPassed;
  }

  allPassed =
    (await step('add_threat_level_group (confirms the level exists)', async () => {
      await client.call(
        NBAPI_COMMANDS.ADD_THREAT_LEVEL_GROUP,
        mergeParams({ LEVELGROUPNAME: NAMES.threatLevelGroup, ...wrapList('LEVELNAMES', 'LEVELNAME', [NAMES.threatLevel]) })
      );
      return `LEVELGROUPNAME "${NAMES.threatLevelGroup}" containing "${NAMES.threatLevel}"`;
    })) && allPassed;

  allPassed =
    (await step('modify_threat_level (COLOR=Green)', async () => {
      // The doc lists LEVELNAME, SEQNUM, and COLOR without marking any of
      // them optional, and the live controller bears this out: it rejected
      // ModifyThreatLevel without SEQNUM even though AddThreatLevel above
      // succeeded, so SEQNUM is resent here with the same value (#13).
      await client.call(NBAPI_COMMANDS.MODIFY_THREAT_LEVEL, { LEVELNAME: NAMES.threatLevel, SEQNUM: '7', COLOR: 'Green' });
      return 'COLOR=Green';
    })) && allPassed;

  allPassed =
    (await step('modify_threat_level_group (LEVELNAMES)', async () => {
      await client.call(
        NBAPI_COMMANDS.MODIFY_THREAT_LEVEL_GROUP,
        mergeParams({ LEVELGROUPNAME: NAMES.threatLevelGroup, ...wrapList('LEVELNAMES', 'LEVELNAME', [NAMES.threatLevel]) })
      );
      return 'LEVELNAMES reaffirmed';
    })) && allPassed;

  allPassed =
    (await step('remove_threat_level_group', async () => {
      await client.call(NBAPI_COMMANDS.REMOVE_THREAT_LEVEL_GROUP, { LEVELGROUPNAME: NAMES.threatLevelGroup });
      return `LEVELGROUPNAME "${NAMES.threatLevelGroup}" removed`;
    })) && allPassed;

  allPassed =
    (await step('remove_threat_level -> a second remove_threat_level fails (proves it is gone)', async () => {
      await client.call(NBAPI_COMMANDS.REMOVE_THREAT_LEVEL, { LEVELNAME: NAMES.threatLevel });
      let secondRemoveFailed = false;
      try {
        await client.call(NBAPI_COMMANDS.REMOVE_THREAT_LEVEL, { LEVELNAME: NAMES.threatLevel });
      } catch {
        secondRemoveFailed = true;
      }
      assertTrue('a second RemoveThreatLevel for the same name fails', secondRemoveFailed);
      return `LEVELNAME "${NAMES.threatLevel}" removed`;
    })) && allPassed;

  return allPassed;
}

/** GetUDFLists -> ModifyUDFListItems (add) -> GetUDFListItems -> ModifyUDFListItems (delete) ->
 * GetUDFListItems, or a recorded SKIPPED pass if no UDF list is configured on the controller. */
async function udfListRoundTrip(client: NetboxClient): Promise<boolean> {
  let udfListKey = '';
  try {
    const result = await client.call(NBAPI_COMMANDS.GET_UDF_LISTS, {});
    if (!result.notFound) {
      const details = asRecord(result.data);
      const lists = asRecordList(asRecord(details.UDFLISTS).UDFLIST ?? []);
      udfListKey = text(lists[0]?.UDFLISTKEY);
    }
  } catch (err) {
    if (!isBareNotFoundFail(err)) throw err;
  }

  if (!udfListKey) {
    const name = 'udf_list_items round-trip';
    results.push({ name, pass: true, summary: 'SKIPPED: no UDF list is configured on this controller' });
    log(`[PASS] ${name}: SKIPPED: no UDF list is configured on this controller`);
    return true;
  }

  let allPassed = true;

  allPassed =
    (await step('modify_udf_list_items (add) -> get_udf_list_items', async () => {
      await client.call(
        NBAPI_COMMANDS.MODIFY_UDF_LIST_ITEMS,
        mergeParams({
          UDFLISTKEY: udfListKey,
          ...wrapList('LISTITEMS', 'LISTITEM', [{ ITEMNAME: NAMES.udfItem, CUSTOMKEY: UDF_ITEM_CUSTOMKEY, DELETE: '0' }]),
        })
      );
      const result = await client.call(NBAPI_COMMANDS.GET_UDF_LIST_ITEMS, { UDFLISTKEY: udfListKey });
      const items = asRecordList(asRecord(asRecord(result.data).LISTITEMS).LISTITEM ?? []);
      const item = items.find((candidate) => text(candidate.CUSTOMKEY) === UDF_ITEM_CUSTOMKEY);
      assertTrue('GetUDFListItems lists the new item', item !== undefined);
      return `UDFLISTKEY ${udfListKey}, item CUSTOMKEY ${UDF_ITEM_CUSTOMKEY}`;
    })) && allPassed;

  allPassed =
    (await step('modify_udf_list_items (delete) -> get_udf_list_items', async () => {
      const before = await client.call(NBAPI_COMMANDS.GET_UDF_LIST_ITEMS, { UDFLISTKEY: udfListKey });
      const beforeItems = asRecordList(asRecord(asRecord(before.data).LISTITEMS).LISTITEM ?? []);
      const item = beforeItems.find((candidate) => text(candidate.CUSTOMKEY) === UDF_ITEM_CUSTOMKEY);
      assertTrue('the item to delete was found', item !== undefined);
      const itemKey = text(item!.ITEMKEY);
      await client.call(
        NBAPI_COMMANDS.MODIFY_UDF_LIST_ITEMS,
        mergeParams({ UDFLISTKEY: udfListKey, ...wrapList('LISTITEMS', 'LISTITEM', [{ ITEMKEY: itemKey, DELETE: '1' }]) })
      );
      const after = await client.call(NBAPI_COMMANDS.GET_UDF_LIST_ITEMS, { UDFLISTKEY: udfListKey });
      const afterItems = asRecordList(asRecord(asRecord(after.data).LISTITEMS).LISTITEM ?? []);
      const stillThere = afterItems.some((candidate) => text(candidate.CUSTOMKEY) === UDF_ITEM_CUSTOMKEY);
      assertTrue('the item is gone', !stillThere);
      return `ITEMKEY ${itemKey} deleted`;
    })) && allPassed;

  return allPassed;
}

// ---------------------------------------------------------------------------
// (b2) controller clock estimate, from the newest GetAccessHistory record
// ---------------------------------------------------------------------------

/** Digs the newest record's DTTM out of GetAccessHistory's response, tolerant
 * of exactly where fast-xml-parser lands it (a wrapped collection, a single
 * collapsed record, or the field sitting directly on the top level). */
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

/** Fetches the newest access-history record's DTTM, or `undefined` if the
 * controller has none (bare NOT FOUND is treated the same as an empty list). */
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

/**
 * (b2): estimates the controller's clock from the newest GetAccessHistory
 * record and compares it with the host clock (R30 b2). Returns the skew
 * result so phase (c) can both gate on it and print an estimated controller
 * time in its HEADS-UP line.
 */
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
  log(`[WARN] no access history record was available to estimate the controller clock; skipping the skew gate`);
  return skew;
}

// ---------------------------------------------------------------------------
// (c) the real 2-minute window on the designated portal
// ---------------------------------------------------------------------------

async function unlockWindowPhase(
  client: NetboxClient,
  settings: UnlockWindowSettings,
  portal: { PORTALKEY: string; NAME: string },
  neverKey: string,
  startClock: string | undefined,
  clockSkew: ClockSkewResult
): Promise<void> {
  const window = computeTestWindow(new Date(), startClock);
  const estimatedControllerNow =
    clockSkew.offsetSeconds === undefined ? 'unavailable' : estimateControllerClock(new Date(), clockSkew.offsetSeconds);
  log(
    `HEADS-UP: scheduling a 2-minute unlock of portal ${portal.NAME} (key ${portal.PORTALKEY}): unlock ${window.unlockClock}, relock ${window.relockClock} (estimated controller time now: ${estimatedControllerNow})`
  );

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
    crudPassed = (await personRoundTrip(client)) && crudPassed;
    crudPassed = (await accessLevelRoundTrip(client, never.TIMESPECGROUPKEY, readerKey)) && crudPassed;
    crudPassed = (await threatLevelRoundTrip(client)) && crudPassed;
    crudPassed =
      (await step('insert_activity (USERACTIVITY)', async () => {
        const activityText = `${LIVE_PREFIX} ${new Date().toISOString()}`;
        await client.call(NBAPI_COMMANDS.INSERT_ACTIVITY, { ACTIVITYTYPE: 'USERACTIVITY', ACTIVITYTEXT: activityText });
        return `ACTIVITYTEXT "${activityText}"`;
      })) && crudPassed;
    crudPassed = (await udfListRoundTrip(client)) && crudPassed;
    crudPassed =
      (await step('get_partitions -> switch_partition (back to the session\'s own partition)', async () => {
        const result = await client.call(NBAPI_COMMANDS.GET_PARTITIONS, {});
        const details = asRecord(result.data);
        const container = 'PARTITIONS' in details ? asRecord(details.PARTITIONS) : details;
        const partitions = asRecordList(container.PARTITION ?? []);
        assertTrue('GetPartitions returned at least one partition', partitions.length > 0);
        const partitionKey = text(partitions[0].PARTITIONKEY);
        assertTrue('a PARTITIONKEY was resolved', partitionKey !== '');
        await client.call(NBAPI_COMMANDS.SWITCH_PARTITION, { PARTITIONKEY: partitionKey });
        return `SwitchPartition to the session's own PARTITIONKEY ${partitionKey} succeeded`;
      })) && crudPassed;

    // (b2)
    const clockSkew = await controllerClockCheck(client);

    // (c)
    if (clockSkew.status === 'fail') {
      info('phase (c) — the real 2-minute unlock of the designated portal — was NOT run: the controller clock skew check failed above.');
    } else if (!args.go) {
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
        await unlockWindowPhase(client, settings, portal, never.TIMESPECGROUPKEY, args.start, clockSkew);
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
