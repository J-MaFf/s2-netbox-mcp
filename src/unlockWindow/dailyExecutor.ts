import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { asRecord, text } from '../paging.js';
import { wrapList } from '../toolHelpers.js';
import type { NbapiParams } from '../xml.js';
import {
  DailyPlanError,
  addDays,
  checkDailyWindowLimits,
  dailyScheduleName,
  formatLocalDateTime,
  planDailyUnlockWindow,
  type DailyPlan,
} from './dailyPlanner.js';
import {
  MANAGED_DESCRIPTION,
  NEVER_GROUP_NAME,
  WEEKDAYS,
  carriesManagedPrefix,
  fetchHolidays,
  fetchHoliday,
  fetchPortalGroup,
  fetchPortalGroups,
  fetchPortals,
  fetchTimeSpec,
  fetchTimeSpecGroups,
  fetchTimeSpecs,
  sameSet,
  timeSpecGroupName,
  type HolidayRecord,
  type PortalRecord,
  type TimeSpecRecord,
} from './managed.js';

/**
 * The executors behind `schedule_daily_unlock_window` (R2/R3/R5/R6/R7),
 * `cancel_daily_unlock_window` (R8) and `get_daily_unlock_window` (R9).
 *
 * Planning is delegated to the pure planner (dailyPlanner.ts); this module
 * is the only place that issues NBAPI calls for the managed daily window,
 * and it follows the exact R6 apply order. Unlike the continuous feature's
 * executor, this plan is always exactly one segment (no first/middle/last,
 * no per-kind leftover cleanup) — see the spec's Design decision 2.
 *
 * Managed objects are identified by NAME only (R10), reusing managed.ts's
 * `timeSpecGroupName`/`carriesManagedPrefix` helpers (the time spec group is
 * `<prefix> time specs`, exactly as in the continuous feature) plus this
 * module's own `dailyScheduleName` (`<prefix> schedule`, the one holiday and
 * the one time spec). The portal group is named exactly `<prefix>`.
 */

export interface DailyUnlockWindowSettings {
  /** NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP. */
  holidayGroup: number;
  /** NETBOX_DAILY_UNLOCK_NAME_PREFIX. */
  namePrefix: string;
  /** Host clock; injectable for tests. */
  now?: () => Date;
}

/** A client-side rejection or a failed/mismatching apply step: the tool
 * returns `isError` with this message (never a stack trace). */
export class DailyUnlockWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DailyUnlockWindowError';
  }
}

/** Runs one apply step, wrapping any controller error so the tool error
 * names the step and carries the controller's own message (R6). */
async function atStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DailyUnlockWindowError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DailyUnlockWindowError(`Step ${step} failed: ${message}`);
  }
}

/** Holidays are capped per partition (ERRMSG "Cannot exceed count of 30 Holidays per partition") —
 * the same physical limit the continuous feature's planner enforces. */
export const HOLIDAY_LIMIT = 30;

// ---------------------------------------------------------------------------
// Side-effect report (R5)
// ---------------------------------------------------------------------------

export interface DailySuppressedTimeSpec {
  TIMESPECKEY: string;
  NAME: string;
  HOLIDAYGROUPS: string;
  /** The daily plan's reserved group this time spec does not tick. */
  missingGroup: number;
}

export interface DailyOverlappingHoliday {
  HOLIDAYKEY: string;
  NAME: string;
  HOLIDAYGROUPS: string;
  STARTDATE: string;
  ENDDATE: string;
}

export interface DailySideEffectReport {
  /** Time specs (other than `Never` and this tool's own) that lack the
   * plan's reserved holiday group — a holiday in that group suppresses them
   * on the window's dates, so e.g. an access level on such a spec loses
   * access. A currently-active continuous-window time spec is *not*
   * excluded here (see the spec's Design decision 3): it is reported like
   * any other foreign time spec if its groups don't include the daily group. */
  suppressedTimeSpecs: DailySuppressedTimeSpec[];
  /** Non-managed holidays whose [STARTDATE, ENDDATE) intersects the plan's coverage. */
  overlappingHolidays: DailyOverlappingHoliday[];
}

export function computeDailySideEffects(
  plan: DailyPlan,
  timeSpecs: readonly TimeSpecRecord[],
  holidays: readonly HolidayRecord[],
  prefix: string
): DailySideEffectReport {
  const group = String(plan.holidayGroup);
  const suppressedTimeSpecs: DailySuppressedTimeSpec[] = [];
  for (const spec of timeSpecs) {
    if (spec.NAME === 'Never' || carriesManagedPrefix(spec.NAME, prefix)) continue;
    if (!spec.HOLIDAYGROUPS.includes(group)) {
      suppressedTimeSpecs.push({
        TIMESPECKEY: spec.TIMESPECKEY,
        NAME: spec.NAME,
        HOLIDAYGROUPS: spec.HOLIDAYGROUPS.join(','),
        missingGroup: plan.holidayGroup,
      });
    }
  }

  const overlappingHolidays: DailyOverlappingHoliday[] = holidays
    .filter((holiday) => !carriesManagedPrefix(holiday.NAME, prefix))
    .filter((holiday) => holiday.STARTDATE < plan.ENDDATE && holiday.ENDDATE > plan.STARTDATE)
    .map((holiday) => ({
      HOLIDAYKEY: holiday.HOLIDAYKEY,
      NAME: holiday.NAME,
      HOLIDAYGROUPS: holiday.HOLIDAYGROUPS.join(','),
      STARTDATE: holiday.STARTDATE,
      ENDDATE: holiday.ENDDATE,
    }));

  return { suppressedTimeSpecs, overlappingHolidays };
}

// ---------------------------------------------------------------------------
// schedule_daily_unlock_window
// ---------------------------------------------------------------------------

export interface ScheduleDailyUnlockWindowInput {
  startDate: string;
  endDate: string;
  dailyStartTime: string;
  dailyEndTime: string;
  portalKeys?: string[];
  acknowledgeSideEffects?: boolean;
  dryRun?: boolean;
}

export interface ScheduleDailyUnlockWindowResult {
  window: { startDate: string; endDate: string; dailyStartTime: string; dailyEndTime: string };
  holidayKey: string;
  timeSpecKey: string;
  timeSpecGroupKey: string;
  portalGroupKey: string;
  holidayGroup: number;
  portals: PortalRecord[];
  replacedPreviousWindow: boolean;
  sideEffects: DailySideEffectReport;
  verified: true;
}

export interface ScheduleDailyUnlockWindowDryRun {
  dryRun: true;
  window: { startDate: string; endDate: string; dailyStartTime: string; dailyEndTime: string };
  name: string;
  holidayGroup: number;
  STARTDATE: string;
  ENDDATE: string;
  STARTTIME: string;
  ENDTIME: string;
  /** Present when a managed holiday of this name already exists (it would be modified, not added). */
  existingHolidayKey?: string;
  existingTimeSpecKey?: string;
  portals: PortalRecord[];
  wouldReplacePreviousWindow: boolean;
  holidays: { existing: number; toAdd: number; limit: number };
  sideEffects: DailySideEffectReport;
  /** True when the real call would be refused without acknowledgeSideEffects=true. */
  requiresAcknowledgement: boolean;
}

function dailyTimeSpecParams(plan: DailyPlan): NbapiParams {
  const weekdays = Object.fromEntries(WEEKDAYS.map((day) => [day, '0']));
  return {
    NAME: plan.name,
    DESCRIPTION: MANAGED_DESCRIPTION,
    STARTTIME: plan.STARTTIME,
    ENDTIME: plan.ENDTIME,
    ...weekdays,
    HOLIDAYGROUPS: String(plan.holidayGroup),
  };
}

function dailyHolidayParams(plan: DailyPlan): NbapiParams {
  return {
    HOLIDAYNAME: plan.name,
    HOLIDAYGROUPS: String(plan.holidayGroup),
    STARTDATE: plan.STARTDATE,
    ENDDATE: plan.ENDDATE,
  };
}

/** Resolves the key an Add command returned; if the controller returned
 * none, re-lists and finds the object by its (managed, unique) name. */
async function keyFromAdd(
  data: unknown,
  keyField: string,
  refetch: () => Promise<string | undefined>,
  describe: string
): Promise<string> {
  const key = text(asRecord(data)[keyField]);
  if (key) return key;
  const found = await refetch();
  if (found) return found;
  throw new DailyUnlockWindowError(`${describe} succeeded but returned no ${keyField}, and the object could not be found by name afterwards.`);
}

export async function scheduleDailyUnlockWindow(
  client: NetboxClient,
  input: ScheduleDailyUnlockWindowInput,
  settings: DailyUnlockWindowSettings
): Promise<ScheduleDailyUnlockWindowResult | ScheduleDailyUnlockWindowDryRun> {
  const now = settings.now ?? (() => new Date());
  const prefix = settings.namePrefix;

  // R3 (pure rejections) + R2 (plan) — no NBAPI call has been made yet.
  let plan: DailyPlan;
  try {
    plan = planDailyUnlockWindow(input.startDate, input.endDate, input.dailyStartTime, input.dailyEndTime, settings.holidayGroup, prefix);
    checkDailyWindowLimits(input.startDate, input.endDate, input.dailyEndTime, now());
  } catch (err) {
    if (err instanceof DailyPlanError) throw new DailyUnlockWindowError(err.message);
    throw err;
  }

  // Step 1: resolve targets.
  const portals = await atStep('1 (resolve portals)', () => fetchPortals(client));
  const portalsByKey = new Map(portals.map((portal) => [portal.PORTALKEY, portal]));
  let targets: PortalRecord[];
  if (input.portalKeys === undefined) {
    targets = portals;
  } else {
    const unique = [...new Set(input.portalKeys)];
    const unknown = unique.filter((key) => !portalsByKey.has(key));
    if (unknown.length > 0) {
      throw new DailyUnlockWindowError(`portalKeys contains key(s) not returned by GetPortals: ${unknown.join(', ')}.`);
    }
    targets = unique.map((key) => portalsByKey.get(key)!);
  }
  if (targets.length === 0) {
    throw new DailyUnlockWindowError('No portals to schedule: GetPortals returned none.');
  }

  // R3's holiday-cap pre-check + R5 pre-reads (every time spec, every holiday) — still no write.
  const holidays = await atStep('1 (read holidays)', () => fetchHolidays(client));
  const timeSpecs = await atStep('1 (read time specs)', () => fetchTimeSpecs(client));

  const existingManagedHoliday = holidays.find((holiday) => holiday.NAME === plan.name);
  const existingManagedSpec = timeSpecs.find((spec) => spec.NAME === plan.name);
  const replacedPreviousWindow = existingManagedHoliday !== undefined || existingManagedSpec !== undefined;

  const holidaysToAdd = existingManagedHoliday ? 0 : 1;
  if (holidays.length + holidaysToAdd > HOLIDAY_LIMIT) {
    throw new DailyUnlockWindowError(
      `Adding ${holidaysToAdd} holiday(s) to the ${holidays.length} already configured would exceed the controller's limit of ${HOLIDAY_LIMIT} per partition.`
    );
  }

  const sideEffects = computeDailySideEffects(plan, timeSpecs, holidays, prefix);
  const requiresAcknowledgement = sideEffects.suppressedTimeSpecs.length > 0 && input.acknowledgeSideEffects !== true;

  if (input.dryRun === true) {
    return {
      dryRun: true,
      window: plan.window,
      name: plan.name,
      holidayGroup: plan.holidayGroup,
      STARTDATE: plan.STARTDATE,
      ENDDATE: plan.ENDDATE,
      STARTTIME: plan.STARTTIME,
      ENDTIME: plan.ENDTIME,
      ...(existingManagedHoliday ? { existingHolidayKey: existingManagedHoliday.HOLIDAYKEY } : {}),
      ...(existingManagedSpec ? { existingTimeSpecKey: existingManagedSpec.TIMESPECKEY } : {}),
      portals: targets,
      wouldReplacePreviousWindow: replacedPreviousWindow,
      holidays: { existing: holidays.length, toAdd: holidaysToAdd, limit: HOLIDAY_LIMIT },
      sideEffects,
      requiresAcknowledgement,
    };
  }

  if (requiresAcknowledgement) {
    const listed = sideEffects.suppressedTimeSpecs
      .map((spec) => `${spec.TIMESPECKEY} "${spec.NAME}" (HOLIDAYGROUPS: ${spec.HOLIDAYGROUPS || 'none'}; lacks ${spec.missingGroup})`)
      .join('; ');
    throw new DailyUnlockWindowError(
      `Refused: ${sideEffects.suppressedTimeSpecs.length} time spec(s) would be suppressed on the window's dates because they do not tick the reserved holiday group ${plan.holidayGroup}: ${listed}. ` +
        'Re-run with acknowledgeSideEffects=true to proceed anyway (nothing was written).'
    );
  }

  try {
    return await applyDailyUnlockWindow(client, prefix, plan, targets, holidays, timeSpecs, replacedPreviousWindow, sideEffects);
  } catch (err) {
    if (!(err instanceof DailyUnlockWindowError)) throw err;
    const removed = await rollbackDailyManagedObjects(client, prefix);
    throw new DailyUnlockWindowError(`${err.message} Rolled back: ${removed}.`);
  }
}

/** Steps 2-8 of R6: the part of schedule_daily_unlock_window that writes.
 * Split out so a failure anywhere in here can be caught once and rolled back
 * without duplicating the eight-step body. */
async function applyDailyUnlockWindow(
  client: NetboxClient,
  prefix: string,
  plan: DailyPlan,
  targets: PortalRecord[],
  holidays: HolidayRecord[],
  timeSpecs: TimeSpecRecord[],
  replacedPreviousWindow: boolean,
  sideEffects: DailySideEffectReport
): Promise<ScheduleDailyUnlockWindowResult> {
  // Step 2: managed time spec group. Never named exactly `prefix` (that's
  // the portal group's name) — group names are unique across group types
  // (same controller quirk the continuous feature documents).
  const tsgName = timeSpecGroupName(prefix);
  let timeSpecGroupKey = '';
  await atStep('2 (managed time spec group)', async () => {
    const groups = await fetchTimeSpecGroups(client);
    const existing = groups.find((group) => group.NAME === tsgName);
    if (existing) {
      timeSpecGroupKey = existing.TIMESPECGROUPKEY;
      return;
    }
    const result = await client.call(NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP, { NAME: tsgName, DESCRIPTION: MANAGED_DESCRIPTION });
    timeSpecGroupKey = await keyFromAdd(
      result.data,
      'TIMESPECGROUPKEY',
      async () => (await fetchTimeSpecGroups(client)).find((group) => group.NAME === tsgName)?.TIMESPECGROUPKEY,
      NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP
    );
  });

  // Step 3: the managed holiday.
  const existingHoliday = holidays.find((holiday) => holiday.NAME === plan.name);
  let holidayKey = '';
  await atStep('3 (managed holiday)', async () => {
    if (existingHoliday) {
      await client.call(NBAPI_COMMANDS.MODIFY_HOLIDAY, { HOLIDAYKEY: existingHoliday.HOLIDAYKEY, ...dailyHolidayParams(plan) });
      holidayKey = existingHoliday.HOLIDAYKEY;
      return;
    }
    const result = await client.call(NBAPI_COMMANDS.ADD_HOLIDAY, dailyHolidayParams(plan));
    holidayKey = await keyFromAdd(
      result.data,
      'HOLIDAYKEY',
      async () => (await fetchHolidays(client)).find((holiday) => holiday.NAME === plan.name)?.HOLIDAYKEY,
      NBAPI_COMMANDS.ADD_HOLIDAY
    );
  });

  // Step 4: the managed time spec.
  const existingSpec = timeSpecs.find((spec) => spec.NAME === plan.name);
  let timeSpecKey = '';
  await atStep('4 (managed time spec)', async () => {
    if (existingSpec) {
      await client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC, { TIMESPECKEY: existingSpec.TIMESPECKEY, ...dailyTimeSpecParams(plan) });
      timeSpecKey = existingSpec.TIMESPECKEY;
      return;
    }
    const result = await client.call(NBAPI_COMMANDS.ADD_TIME_SPEC, dailyTimeSpecParams(plan));
    timeSpecKey = await keyFromAdd(
      result.data,
      'TIMESPECKEY',
      async () => (await fetchTimeSpecs(client)).find((spec) => spec.NAME === plan.name)?.TIMESPECKEY,
      NBAPI_COMMANDS.ADD_TIME_SPEC
    );
  });

  // Step 5: the managed group's membership becomes exactly the one planned spec.
  await atStep('5 (managed time spec group membership)', () =>
    client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP, {
      TIMESPECGROUPKEY: timeSpecGroupKey,
      ...wrapList('TIMESPECKEYS', 'TIMESPECKEY', [timeSpecKey]),
    })
  );

  // Step 6: managed portal group.
  const targetKeys = targets.map((portal) => portal.PORTALKEY);
  let portalGroupKey = '';
  await atStep('6 (managed portal group)', async () => {
    const groups = await fetchPortalGroups(client);
    const existing = groups.find((group) => group.NAME === prefix);
    if (existing) {
      await client.call(NBAPI_COMMANDS.MODIFY_PORTAL_GROUP, {
        PORTALGROUPKEY: existing.PORTALGROUPKEY,
        ...wrapList('PORTALKEYS', 'PORTALKEY', targetKeys),
        UNLOCKTIMESPECGROUPKEY: timeSpecGroupKey,
      });
      portalGroupKey = existing.PORTALGROUPKEY;
      return;
    }
    const result = await client.call(NBAPI_COMMANDS.ADD_PORTAL_GROUP, {
      NAME: prefix,
      DESCRIPTION: MANAGED_DESCRIPTION,
      UNLOCKTIMESPECGROUPKEY: timeSpecGroupKey,
      ...wrapList('PORTALKEYS', 'PORTALKEY', targetKeys),
    });
    portalGroupKey = await keyFromAdd(
      result.data,
      'PORTALGROUPKEY',
      async () => (await fetchPortalGroups(client)).find((group) => group.NAME === prefix)?.PORTALGROUPKEY,
      NBAPI_COMMANDS.ADD_PORTAL_GROUP
    );
  });

  // Step 7: read back and compare to the plan.
  await atStep('7 (read-back)', async () => {
    const mismatches: string[] = [];
    const expect = (object: string, field: string, expected: string, actual: string): void => {
      if (expected !== actual) mismatches.push(`${object} ${field}: expected "${expected}", got "${actual}"`);
    };

    const portalGroup = await fetchPortalGroup(client, portalGroupKey);
    if (!portalGroup) {
      mismatches.push(`portal group ${portalGroupKey} was not found on read-back`);
    } else {
      const readKeys = portalGroup.PORTALS.map((portal) => portal.PORTALKEY);
      if (!sameSet(readKeys, targetKeys)) {
        mismatches.push(`portal group "${prefix}" PORTALKEYS: expected [${targetKeys.join(',')}], got [${readKeys.join(',')}]`);
      }
      expect(`portal group "${prefix}"`, 'UNLOCKTIMESPECGROUPKEY', timeSpecGroupKey, portalGroup.UNLOCKTIMESPECGROUPKEY);
    }

    const timeSpecGroup = (await fetchTimeSpecGroups(client)).find((group) => group.TIMESPECGROUPKEY === timeSpecGroupKey);
    if (!timeSpecGroup) {
      mismatches.push(`time spec group ${timeSpecGroupKey} was not listed by GetTimeSpecGroups on read-back`);
    } else if (!sameSet(timeSpecGroup.TIMESPECKEYS, [timeSpecKey])) {
      mismatches.push(
        `time spec group "${tsgName}" TIMESPECKEYS: expected [${timeSpecKey}], got [${timeSpecGroup.TIMESPECKEYS.join(',')}]`
      );
    }

    const spec = await fetchTimeSpec(client, timeSpecKey);
    const specLabel = `time spec "${plan.name}"`;
    if (!spec) {
      mismatches.push(`${specLabel} (${timeSpecKey}) was not found on read-back`);
    } else {
      expect(specLabel, 'NAME', plan.name, spec.NAME);
      expect(specLabel, 'STARTTIME', plan.STARTTIME, spec.STARTTIME);
      expect(specLabel, 'ENDTIME', plan.ENDTIME, spec.ENDTIME);
      for (const day of WEEKDAYS) expect(specLabel, day, '0', spec.weekdays[day]);
      if (!sameSet(spec.HOLIDAYGROUPS, [String(plan.holidayGroup)])) {
        mismatches.push(`${specLabel} HOLIDAYGROUPS: expected "${plan.holidayGroup}", got "${spec.HOLIDAYGROUPS.join(',')}"`);
      }
    }

    const holiday = await fetchHoliday(client, holidayKey);
    const holidayLabel = `holiday "${plan.name}"`;
    if (!holiday) {
      mismatches.push(`${holidayLabel} (${holidayKey}) was not found on read-back`);
    } else {
      expect(holidayLabel, 'NAME', plan.name, holiday.NAME);
      expect(holidayLabel, 'STARTDATE', plan.STARTDATE, holiday.STARTDATE);
      expect(holidayLabel, 'ENDDATE', plan.ENDDATE, holiday.ENDDATE);
      if (!sameSet(holiday.HOLIDAYGROUPS, [String(plan.holidayGroup)])) {
        mismatches.push(`${holidayLabel} HOLIDAYGROUPS: expected "${plan.holidayGroup}", got "${holiday.HOLIDAYGROUPS.join(',')}"`);
      }
    }

    if (mismatches.length > 0) {
      throw new DailyUnlockWindowError(
        `Step 7 (read-back) found ${mismatches.length} mismatch(es) between the controller and the plan: ${mismatches.join('; ')}. ` +
          'The managed objects were written but could not be verified — inspect them with get_daily_unlock_window or cancel with cancel_daily_unlock_window.'
      );
    }
  });

  // Step 8.
  return {
    window: plan.window,
    holidayKey,
    timeSpecKey,
    timeSpecGroupKey,
    portalGroupKey,
    holidayGroup: plan.holidayGroup,
    portals: targets,
    replacedPreviousWindow,
    sideEffects,
    verified: true,
  };
}

/** R6 failure handling: best-effort delete of the currently-managed holiday
 * and time spec (never the portal group or the time spec group itself —
 * those are left as-is, possibly empty), so no partial window can remain
 * active after an apply step fails. Returns a one-line summary for the
 * error text. Tolerates refusal of either delete (mirrors the R8 cleanup)
 * rather than letting a rollback failure mask the original error. */
async function rollbackDailyManagedObjects(client: NetboxClient, prefix: string): Promise<string> {
  const name = dailyScheduleName(prefix);
  const removed: string[] = [];
  const failed: string[] = [];

  const holiday = (await fetchHolidays(client)).find((candidate) => candidate.NAME === name);
  if (holiday) {
    try {
      await client.call(NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY: holiday.HOLIDAYKEY });
      removed.push(`holiday "${name}"`);
    } catch (err) {
      failed.push(`holiday "${name}" (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const spec = (await fetchTimeSpecs(client)).find((candidate) => candidate.NAME === name);
  if (spec) {
    try {
      await client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY: spec.TIMESPECKEY });
      removed.push(`time spec "${name}"`);
    } catch (err) {
      failed.push(`time spec "${name}" (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const parts: string[] = [];
  if (removed.length > 0) parts.push(removed.join(', '));
  if (parts.length === 0) parts.push('nothing (no managed holiday or time spec existed)');
  if (failed.length > 0) parts.push(`could not remove: ${failed.join(', ')}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// cancel_daily_unlock_window (R8)
// ---------------------------------------------------------------------------

export interface DailyLeftBehind {
  type: 'timeSpecGroup' | 'timeSpec';
  key: string;
  NAME: string;
  error: string;
}

export interface CancelDailyUnlockWindowResult {
  cancelled: boolean;
  message: string;
  portalGroup?: { PORTALGROUPKEY: string; NAME: string; portals: PortalRecord[] };
  /** The *Never* group the portal group now points at. */
  unlockTimeSpecGroup?: { TIMESPECGROUPKEY: string; NAME: string };
  deletedHoliday?: { HOLIDAYKEY: string; NAME: string };
  timeSpecGroup?: { TIMESPECGROUPKEY: string; NAME: string; emptied: boolean };
  deletedTimeSpec?: { TIMESPECKEY: string; NAME: string };
  /** Managed objects the controller refused to empty/delete (tolerated:
   * with the portal group on *Never* and no managed holiday, nothing can unlock). */
  leftBehind: DailyLeftBehind[];
}

export async function cancelDailyUnlockWindow(client: NetboxClient, settings: DailyUnlockWindowSettings): Promise<CancelDailyUnlockWindowResult> {
  const prefix = settings.namePrefix;
  const name = dailyScheduleName(prefix);
  const tsgName = timeSpecGroupName(prefix);

  const timeSpecGroups = await atStep('1 (resolve the Never time spec group)', () => fetchTimeSpecGroups(client));
  const never = timeSpecGroups.find((group) => group.NAME === NEVER_GROUP_NAME);
  if (!never) {
    throw new DailyUnlockWindowError(
      `Cannot cancel: no time spec group named "${NEVER_GROUP_NAME}" exists on this controller (GetTimeSpecGroups listed: ${
        timeSpecGroups.map((group) => `"${group.NAME}"`).join(', ') || 'none'
      }).`
    );
  }
  const managedGroup = timeSpecGroups.find((group) => group.NAME === tsgName);

  const portalGroups = await atStep('1 (find the managed portal group)', () => fetchPortalGroups(client));
  const managedPortalGroupSummary = portalGroups.find((group) => group.NAME === prefix);

  let portalGroup: Awaited<ReturnType<typeof fetchPortalGroup>>;
  if (managedPortalGroupSummary) {
    portalGroup = await atStep('1 (read the managed portal group)', () => fetchPortalGroup(client, managedPortalGroupSummary.PORTALGROUPKEY));
    if (!portalGroup) {
      throw new DailyUnlockWindowError(
        `Managed portal group "${prefix}" (${managedPortalGroupSummary.PORTALGROUPKEY}) was listed but GetPortalGroup could not read it.`
      );
    }
  }

  const holidays = await atStep('1 (read holidays)', () => fetchHolidays(client));
  const managedHoliday = holidays.find((holiday) => holiday.NAME === name);
  const timeSpecs = await atStep('1 (read time specs)', () => fetchTimeSpecs(client));
  const managedSpec = timeSpecs.find((spec) => spec.NAME === name);

  if (!portalGroup && !managedGroup && !managedHoliday && !managedSpec) {
    return {
      cancelled: false,
      message: `Nothing to cancel: no managed object (portal group "${prefix}", time spec group "${tsgName}", holiday, or time spec) exists.`,
      leftBehind: [],
    };
  }

  if (portalGroup) {
    await atStep('2 (point the managed portal group at Never)', () =>
      client.call(NBAPI_COMMANDS.MODIFY_PORTAL_GROUP, {
        PORTALGROUPKEY: portalGroup!.PORTALGROUPKEY,
        ...wrapList('PORTALKEYS', 'PORTALKEY', portalGroup!.PORTALS.map((portal) => portal.PORTALKEY)),
        UNLOCKTIMESPECGROUPKEY: never.TIMESPECGROUPKEY,
      })
    );
  }

  // Step 3: delete the managed holiday, whether or not the portal group exists.
  let deletedHoliday: CancelDailyUnlockWindowResult['deletedHoliday'];
  if (managedHoliday) {
    await atStep(`3 (delete managed holiday "${managedHoliday.NAME}")`, () =>
      client.call(NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY: managedHoliday.HOLIDAYKEY })
    );
    deletedHoliday = { HOLIDAYKEY: managedHoliday.HOLIDAYKEY, NAME: managedHoliday.NAME };
  }

  // Step 4 (tolerated): empty the managed group, then delete the managed spec.
  const leftBehind: DailyLeftBehind[] = [];
  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  let timeSpecGroup: CancelDailyUnlockWindowResult['timeSpecGroup'];
  if (managedGroup) {
    let emptied = false;
    try {
      await client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP, {
        TIMESPECGROUPKEY: managedGroup.TIMESPECGROUPKEY,
        ...wrapList('TIMESPECKEYS', 'TIMESPECKEY', []),
      });
      emptied = true;
    } catch (err) {
      leftBehind.push({ type: 'timeSpecGroup', key: managedGroup.TIMESPECGROUPKEY, NAME: managedGroup.NAME, error: errorText(err) });
    }
    timeSpecGroup = { TIMESPECGROUPKEY: managedGroup.TIMESPECGROUPKEY, NAME: managedGroup.NAME, emptied };
  }
  let deletedTimeSpec: CancelDailyUnlockWindowResult['deletedTimeSpec'];
  if (managedSpec) {
    try {
      await client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY: managedSpec.TIMESPECKEY });
      deletedTimeSpec = { TIMESPECKEY: managedSpec.TIMESPECKEY, NAME: managedSpec.NAME };
    } catch (err) {
      leftBehind.push({ type: 'timeSpec', key: managedSpec.TIMESPECKEY, NAME: managedSpec.NAME, error: errorText(err) });
    }
  }

  return {
    cancelled: true,
    message:
      (portalGroup
        ? `Managed portal group "${prefix}" now unlocks on "${NEVER_GROUP_NAME}" and `
        : `No managed portal group "${prefix}" exists (nothing to point at Never) and `) +
      (managedHoliday ? 'the managed holiday was deleted' : 'no managed holiday existed') +
      (leftBehind.length > 0 ? `; ${leftBehind.length} managed object(s) could not be cleaned up (see leftBehind) but nothing can unlock.` : '.'),
    ...(portalGroup ? { portalGroup: { PORTALGROUPKEY: portalGroup.PORTALGROUPKEY, NAME: portalGroup.NAME, portals: portalGroup.PORTALS } } : {}),
    unlockTimeSpecGroup: { TIMESPECGROUPKEY: never.TIMESPECGROUPKEY, NAME: never.NAME },
    ...(deletedHoliday ? { deletedHoliday } : {}),
    ...(timeSpecGroup ? { timeSpecGroup } : {}),
    ...(deletedTimeSpec ? { deletedTimeSpec } : {}),
    leftBehind,
  };
}

// ---------------------------------------------------------------------------
// get_daily_unlock_window (R9, read-only)
// ---------------------------------------------------------------------------

export interface DailyUnlockWindowStatus {
  prefix: string;
  /** True when the managed portal group exists. */
  configured: boolean;
  portalGroup: {
    PORTALGROUPKEY: string;
    NAME: string;
    portals: PortalRecord[];
    UNLOCKTIMESPECGROUPKEY: string;
    unlockTimeSpecGroupName: string;
    pointsAtManagedTimeSpecGroup: boolean;
  } | null;
  timeSpecGroup: { TIMESPECGROUPKEY: string; NAME: string; TIMESPECKEYS: string[] } | null;
  timeSpec: {
    TIMESPECKEY: string;
    NAME: string;
    STARTTIME: string;
    ENDTIME: string;
    HOLIDAYGROUPS: string;
    inManagedGroup: boolean;
  } | null;
  holiday: { HOLIDAYKEY: string; NAME: string; STARTDATE: string; ENDDATE: string; HOLIDAYGROUPS: string } | null;
  /** Derived from the managed holiday and time spec; null when neither exists. */
  window: { startDate: string; endDate: string; dailyStartTime: string; dailyEndTime: string } | null;
  /** Whether the managed daily window is unlocking the portal group at this instant (host clock). */
  activeNow: boolean;
  /** The host clock reading used for activeNow, `YYYY-MM-DD HH:MM`. */
  checkedAt: string;
}

export async function getDailyUnlockWindow(client: NetboxClient, settings: DailyUnlockWindowSettings): Promise<DailyUnlockWindowStatus> {
  const now = settings.now ?? (() => new Date());
  const prefix = settings.namePrefix;
  const name = dailyScheduleName(prefix);
  const tsgName = timeSpecGroupName(prefix);

  const portalGroups = await fetchPortalGroups(client);
  const managedSummary = portalGroups.find((group) => group.NAME === prefix);
  const portalGroup = managedSummary ? await fetchPortalGroup(client, managedSummary.PORTALGROUPKEY) : undefined;

  const timeSpecGroups = await fetchTimeSpecGroups(client);
  const managedGroup = timeSpecGroups.find((group) => group.NAME === tsgName);

  const timeSpec = (await fetchTimeSpecs(client)).find((spec) => spec.NAME === name);
  const holiday = (await fetchHolidays(client)).find((candidate) => candidate.NAME === name);

  let window: DailyUnlockWindowStatus['window'] = null;
  if (holiday) {
    window = {
      startDate: holiday.STARTDATE.slice(0, 10),
      endDate: addDays(holiday.ENDDATE.slice(0, 10), -1),
      dailyStartTime: timeSpec?.STARTTIME ?? '00:00',
      dailyEndTime: timeSpec?.ENDTIME ?? '23:59',
    };
  }

  const pointsAtManaged = portalGroup !== undefined && managedGroup !== undefined && portalGroup.UNLOCKTIMESPECGROUPKEY === managedGroup.TIMESPECGROUPKEY;

  const checkedAt = formatLocalDateTime(now());
  const today = checkedAt.slice(0, 10);
  const clock = checkedAt.slice(11);
  const activeNow =
    pointsAtManaged &&
    holiday !== undefined &&
    timeSpec !== undefined &&
    holiday.HOLIDAYGROUPS.some((group) => timeSpec.HOLIDAYGROUPS.includes(group)) &&
    holiday.STARTDATE.slice(0, 10) <= today &&
    today < holiday.ENDDATE.slice(0, 10) &&
    timeSpec.STARTTIME <= clock &&
    clock <= timeSpec.ENDTIME;

  return {
    prefix,
    configured: portalGroup !== undefined,
    portalGroup: portalGroup
      ? {
          PORTALGROUPKEY: portalGroup.PORTALGROUPKEY,
          NAME: portalGroup.NAME,
          portals: portalGroup.PORTALS,
          UNLOCKTIMESPECGROUPKEY: portalGroup.UNLOCKTIMESPECGROUPKEY,
          unlockTimeSpecGroupName:
            timeSpecGroups.find((group) => group.TIMESPECGROUPKEY === portalGroup.UNLOCKTIMESPECGROUPKEY)?.NAME ?? '',
          pointsAtManagedTimeSpecGroup: pointsAtManaged,
        }
      : null,
    timeSpecGroup: managedGroup
      ? { TIMESPECGROUPKEY: managedGroup.TIMESPECGROUPKEY, NAME: managedGroup.NAME, TIMESPECKEYS: managedGroup.TIMESPECKEYS }
      : null,
    timeSpec: timeSpec
      ? {
          TIMESPECKEY: timeSpec.TIMESPECKEY,
          NAME: timeSpec.NAME,
          STARTTIME: timeSpec.STARTTIME,
          ENDTIME: timeSpec.ENDTIME,
          HOLIDAYGROUPS: timeSpec.HOLIDAYGROUPS.join(','),
          inManagedGroup: managedGroup?.TIMESPECKEYS.includes(timeSpec.TIMESPECKEY) ?? false,
        }
      : null,
    holiday: holiday
      ? {
          HOLIDAYKEY: holiday.HOLIDAYKEY,
          NAME: holiday.NAME,
          STARTDATE: holiday.STARTDATE,
          ENDDATE: holiday.ENDDATE,
          HOLIDAYGROUPS: holiday.HOLIDAYGROUPS.join(','),
        }
      : null,
    window,
    activeNow,
    checkedAt,
  };
}
