import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { asRecord, text } from '../paging.js';
import { wrapList } from '../toolHelpers.js';
import type { NbapiParams } from '../xml.js';
import {
  SEGMENT_KINDS,
  UnlockPlanError,
  addDays,
  checkWindowLimits,
  formatLocalDateTime,
  planUnlockWindow,
  type PlannedSegment,
  type SegmentKind,
  type UnlockPlan,
} from './planner.js';
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
  segmentKindOf,
  type HolidayRecord,
  type PortalRecord,
  type TimeSpecGroupRecord,
  type TimeSpecRecord,
} from './managed.js';

/**
 * The executors behind `schedule_unlock_window` (R22, R24, R25, R28),
 * `cancel_unlock_window` (R26) and `get_unlock_window` (R26).
 *
 * Planning is delegated to the pure planner; this module is the only place
 * that issues NBAPI calls for the managed window, and it follows the exact
 * eight-step apply order of R25. Managed objects are identified by NAME only
 * (R27) — see managed.ts.
 */

export interface UnlockWindowSettings {
  /** NETBOX_UNLOCK_HOLIDAY_GROUPS in [first, middle, last] order. */
  holidayGroups: readonly number[];
  /** NETBOX_UNLOCK_NAME_PREFIX. */
  namePrefix: string;
  /** Host clock; injectable for tests. */
  now?: () => Date;
}

/** A client-side rejection or a failed/mismatching apply step: the tool
 * returns `isError` with this message (never a stack trace). */
export class UnlockWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockWindowError';
  }
}

/** Runs one apply step, wrapping any controller error so the tool error
 * names the step and carries the controller's own message (R25). */
async function atStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnlockWindowError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new UnlockWindowError(`Step ${step} failed: ${message}`);
  }
}

/** Holidays are capped per partition (ERRMSG "Cannot exceed count of 30 Holidays per partition"). */
export const HOLIDAY_LIMIT = 30;

// ---------------------------------------------------------------------------
// Side-effect report (R24)
// ---------------------------------------------------------------------------

export interface SuppressedTimeSpec {
  TIMESPECKEY: string;
  NAME: string;
  HOLIDAYGROUPS: string;
  /** The plan's groups this time spec does not tick. */
  missingGroups: number[];
}

export interface OverlappingHoliday {
  HOLIDAYKEY: string;
  NAME: string;
  HOLIDAYGROUPS: string;
  STARTDATE: string;
  ENDDATE: string;
}

export interface SideEffectReport {
  /** Time specs (other than `Never` and our own) that lack at least one
   * group the plan uses — a holiday in that group suppresses them on the
   * window's dates, so e.g. an access level on such a spec loses access. */
  suppressedTimeSpecs: SuppressedTimeSpec[];
  /** Non-managed holidays whose [STARTDATE, ENDDATE) intersects the plan's coverage. */
  overlappingHolidays: OverlappingHoliday[];
}

export function computeSideEffects(
  plan: UnlockPlan,
  timeSpecs: readonly TimeSpecRecord[],
  holidays: readonly HolidayRecord[],
  prefix: string
): SideEffectReport {
  const groupsUsed = [...new Set(plan.holidayGroupsUsed)];
  const suppressedTimeSpecs: SuppressedTimeSpec[] = [];
  for (const spec of timeSpecs) {
    if (spec.NAME === 'Never' || carriesManagedPrefix(spec.NAME, prefix)) continue;
    const missingGroups = groupsUsed.filter((group) => !spec.HOLIDAYGROUPS.includes(String(group)));
    if (missingGroups.length > 0) {
      suppressedTimeSpecs.push({
        TIMESPECKEY: spec.TIMESPECKEY,
        NAME: spec.NAME,
        HOLIDAYGROUPS: spec.HOLIDAYGROUPS.join(','),
        missingGroups,
      });
    }
  }

  const overlappingHolidays: OverlappingHoliday[] = holidays
    .filter((holiday) => !carriesManagedPrefix(holiday.NAME, prefix))
    .filter((holiday) => holiday.STARTDATE < plan.coverage.ENDDATE && holiday.ENDDATE > plan.coverage.STARTDATE)
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
// schedule_unlock_window
// ---------------------------------------------------------------------------

export interface ScheduleUnlockWindowInput {
  start: string;
  end: string;
  portalKeys?: string[];
  acknowledgeSideEffects?: boolean;
  dryRun?: boolean;
}

export interface ScheduledSegment {
  kind: SegmentKind;
  holidayKey: string;
  timeSpecKey: string;
  holidayGroup: number;
  STARTDATE: string;
  ENDDATE: string;
  STARTTIME: string;
  ENDTIME: string;
}

export interface ScheduleUnlockWindowResult {
  window: { start: string; end: string };
  segments: ScheduledSegment[];
  timeSpecGroupKey: string;
  portalGroupKey: string;
  portals: PortalRecord[];
  replacedPreviousWindow: boolean;
  sideEffects: SideEffectReport;
  verified: true;
}

export interface DryRunSegment extends Omit<ScheduledSegment, 'holidayKey' | 'timeSpecKey'> {
  name: string;
  /** Present when a managed holiday of this name already exists (it would be modified, not added). */
  existingHolidayKey?: string;
  existingTimeSpecKey?: string;
}

export interface ScheduleUnlockWindowDryRun {
  dryRun: true;
  window: { start: string; end: string };
  segments: DryRunSegment[];
  portals: PortalRecord[];
  wouldReplacePreviousWindow: boolean;
  holidays: { existing: number; toAdd: number; limit: number };
  sideEffects: SideEffectReport;
  /** True when the real call would be refused without acknowledgeSideEffects=true. */
  requiresAcknowledgement: boolean;
}

function timeSpecParams(segment: PlannedSegment): NbapiParams {
  const weekdays = Object.fromEntries(WEEKDAYS.map((day) => [day, '0']));
  return {
    NAME: segment.name,
    DESCRIPTION: MANAGED_DESCRIPTION,
    STARTTIME: segment.STARTTIME,
    ENDTIME: segment.ENDTIME,
    ...weekdays,
    HOLIDAYGROUPS: String(segment.holidayGroup),
  };
}

function holidayParams(segment: PlannedSegment): NbapiParams {
  return {
    HOLIDAYNAME: segment.name,
    HOLIDAYGROUPS: String(segment.holidayGroup),
    STARTDATE: segment.STARTDATE,
    ENDDATE: segment.ENDDATE,
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
  throw new UnlockWindowError(`${describe} succeeded but returned no ${keyField}, and the object could not be found by name afterwards.`);
}

export async function scheduleUnlockWindow(
  client: NetboxClient,
  input: ScheduleUnlockWindowInput,
  settings: UnlockWindowSettings
): Promise<ScheduleUnlockWindowResult | ScheduleUnlockWindowDryRun> {
  const now = settings.now ?? (() => new Date());
  const prefix = settings.namePrefix;

  // R22 (pure rejections) + R23 (plan) — no NBAPI call has been made yet.
  let plan: UnlockPlan;
  try {
    plan = planUnlockWindow(input.start, input.end, settings.holidayGroups, prefix);
    checkWindowLimits(input.start, input.end, now());
  } catch (err) {
    if (err instanceof UnlockPlanError) throw new UnlockWindowError(err.message);
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
      throw new UnlockWindowError(`portalKeys contains key(s) not returned by GetPortals: ${unknown.join(', ')}.`);
    }
    targets = unique.map((key) => portalsByKey.get(key)!);
  }
  if (targets.length === 0) {
    throw new UnlockWindowError('No portals to schedule: GetPortals returned none.');
  }

  // R24 pre-reads (every time spec, every holiday) — still no write.
  const timeSpecs = await atStep('1 (read time specs)', () => fetchTimeSpecs(client));
  const holidays = await atStep('1 (read holidays)', () => fetchHolidays(client));

  const managedHolidays = holidays.filter((holiday) => segmentKindOf(holiday.NAME, prefix) !== undefined);
  const managedSpecs = timeSpecs.filter((spec) => segmentKindOf(spec.NAME, prefix) !== undefined);
  const replacedPreviousWindow = managedHolidays.length > 0 || managedSpecs.length > 0;

  const holidaysToAdd = plan.segments.filter((segment) => !holidays.some((holiday) => holiday.NAME === segment.name)).length;
  if (holidays.length + holidaysToAdd > HOLIDAY_LIMIT) {
    throw new UnlockWindowError(
      `Adding ${holidaysToAdd} holiday(s) to the ${holidays.length} already configured would exceed the controller's limit of ${HOLIDAY_LIMIT} per partition.`
    );
  }

  const sideEffects = computeSideEffects(plan, timeSpecs, holidays, prefix);
  const requiresAcknowledgement = sideEffects.suppressedTimeSpecs.length > 0 && input.acknowledgeSideEffects !== true;

  if (input.dryRun === true) {
    return {
      dryRun: true,
      window: plan.window,
      segments: plan.segments.map((segment) => {
        const existingHoliday = holidays.find((holiday) => holiday.NAME === segment.name);
        const existingSpec = timeSpecs.find((spec) => spec.NAME === segment.name);
        return {
          kind: segment.kind,
          name: segment.name,
          holidayGroup: segment.holidayGroup,
          STARTDATE: segment.STARTDATE,
          ENDDATE: segment.ENDDATE,
          STARTTIME: segment.STARTTIME,
          ENDTIME: segment.ENDTIME,
          ...(existingHoliday ? { existingHolidayKey: existingHoliday.HOLIDAYKEY } : {}),
          ...(existingSpec ? { existingTimeSpecKey: existingSpec.TIMESPECKEY } : {}),
        };
      }),
      portals: targets,
      wouldReplacePreviousWindow: replacedPreviousWindow,
      holidays: { existing: holidays.length, toAdd: holidaysToAdd, limit: HOLIDAY_LIMIT },
      sideEffects,
      requiresAcknowledgement,
    };
  }

  if (requiresAcknowledgement) {
    const listed = sideEffects.suppressedTimeSpecs
      .map((spec) => `${spec.TIMESPECKEY} "${spec.NAME}" (HOLIDAYGROUPS: ${spec.HOLIDAYGROUPS || 'none'}; lacks ${spec.missingGroups.join(',')})`)
      .join('; ');
    throw new UnlockWindowError(
      `Refused: ${sideEffects.suppressedTimeSpecs.length} time spec(s) would be suppressed on the window's dates because they do not tick the reserved holiday group(s) ${plan.holidayGroupsUsed.join(',')}: ${listed}. ` +
        'Re-run with acknowledgeSideEffects=true to proceed anyway (nothing was written).'
    );
  }

  // Step 2: managed time spec group.
  let timeSpecGroupKey = '';
  await atStep('2 (managed time spec group)', async () => {
    const groups = await fetchTimeSpecGroups(client);
    const existing = groups.find((group) => group.NAME === prefix);
    if (existing) {
      timeSpecGroupKey = existing.TIMESPECGROUPKEY;
      return;
    }
    const result = await client.call(NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP, { NAME: prefix, DESCRIPTION: MANAGED_DESCRIPTION });
    timeSpecGroupKey = await keyFromAdd(
      result.data,
      'TIMESPECGROUPKEY',
      async () => (await fetchTimeSpecGroups(client)).find((group) => group.NAME === prefix)?.TIMESPECGROUPKEY,
      NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP
    );
  });

  // Step 3: managed holidays and time specs, one segment at a time.
  const scheduled: ScheduledSegment[] = [];
  const usedHolidayKeys = new Set<string>();
  const usedTimeSpecKeys = new Set<string>();
  for (const segment of plan.segments) {
    await atStep(`3 (managed holiday and time spec "${segment.name}")`, async () => {
      const existingHoliday = holidays.find((holiday) => holiday.NAME === segment.name);
      let holidayKey: string;
      if (existingHoliday) {
        await client.call(NBAPI_COMMANDS.MODIFY_HOLIDAY, { HOLIDAYKEY: existingHoliday.HOLIDAYKEY, ...holidayParams(segment) });
        holidayKey = existingHoliday.HOLIDAYKEY;
      } else {
        const result = await client.call(NBAPI_COMMANDS.ADD_HOLIDAY, holidayParams(segment));
        holidayKey = await keyFromAdd(
          result.data,
          'HOLIDAYKEY',
          async () => (await fetchHolidays(client)).find((holiday) => holiday.NAME === segment.name)?.HOLIDAYKEY,
          NBAPI_COMMANDS.ADD_HOLIDAY
        );
      }
      usedHolidayKeys.add(holidayKey);

      const existingSpec = timeSpecs.find((spec) => spec.NAME === segment.name);
      let timeSpecKey: string;
      if (existingSpec) {
        await client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC, { TIMESPECKEY: existingSpec.TIMESPECKEY, ...timeSpecParams(segment) });
        timeSpecKey = existingSpec.TIMESPECKEY;
      } else {
        const result = await client.call(NBAPI_COMMANDS.ADD_TIME_SPEC, timeSpecParams(segment));
        timeSpecKey = await keyFromAdd(
          result.data,
          'TIMESPECKEY',
          async () => (await fetchTimeSpecs(client)).find((spec) => spec.NAME === segment.name)?.TIMESPECKEY,
          NBAPI_COMMANDS.ADD_TIME_SPEC
        );
      }
      usedTimeSpecKeys.add(timeSpecKey);

      scheduled.push({
        kind: segment.kind,
        holidayKey,
        timeSpecKey,
        holidayGroup: segment.holidayGroup,
        STARTDATE: segment.STARTDATE,
        ENDDATE: segment.ENDDATE,
        STARTTIME: segment.STARTTIME,
        ENDTIME: segment.ENDTIME,
      });
    });
  }

  // Step 4: the managed group's membership becomes exactly the planned specs.
  const plannedSpecKeys = scheduled.map((segment) => segment.timeSpecKey);
  await atStep('4 (managed time spec group membership)', () =>
    client.call(NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP, {
      TIMESPECGROUPKEY: timeSpecGroupKey,
      ...wrapList('TIMESPECKEYS', 'TIMESPECKEY', plannedSpecKeys),
    })
  );

  // Step 5: leftovers from a previous window — managed names this plan does
  // not use (plus any same-named duplicate not chosen in step 3). Time spec
  // first, then holiday, per name; safe now that step 4 unreferenced them.
  for (const kind of SEGMENT_KINDS) {
    const leftoverSpecs = managedSpecs.filter((spec) => segmentKindOf(spec.NAME, prefix) === kind && !usedTimeSpecKeys.has(spec.TIMESPECKEY));
    const leftoverHolidays = managedHolidays.filter(
      (holiday) => segmentKindOf(holiday.NAME, prefix) === kind && !usedHolidayKeys.has(holiday.HOLIDAYKEY)
    );
    for (const spec of leftoverSpecs) {
      await atStep(`5 (delete leftover time spec "${spec.NAME}")`, () =>
        client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY: spec.TIMESPECKEY })
      );
    }
    for (const holiday of leftoverHolidays) {
      await atStep(`5 (delete leftover holiday "${holiday.NAME}")`, () =>
        client.call(NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY: holiday.HOLIDAYKEY })
      );
    }
  }

  // Step 6: managed portal group.
  const targetKeys = targets.map((portal) => portal.PORTALKEY);
  let portalGroupKey = '';
  await atStep('6 (managed portal group)', async () => {
    const groups = await fetchPortalGroups(client);
    const existing = groups.find((group) => group.NAME === prefix);
    if (existing) {
      await client.call(NBAPI_COMMANDS.MODIFY_PORTAL_GROUP, {
        PORTALGROUPKEY: existing.PORTALGROUPKEY,
        PORTALKEY: targetKeys,
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
    } else if (!sameSet(timeSpecGroup.TIMESPECKEYS, plannedSpecKeys)) {
      mismatches.push(
        `time spec group "${prefix}" TIMESPECKEYS: expected [${plannedSpecKeys.join(',')}], got [${timeSpecGroup.TIMESPECKEYS.join(',')}]`
      );
    }

    for (const segment of scheduled) {
      const planned = plan.segments.find((candidate) => candidate.kind === segment.kind)!;
      const spec = await fetchTimeSpec(client, segment.timeSpecKey);
      const specLabel = `time spec "${planned.name}"`;
      if (!spec) {
        mismatches.push(`${specLabel} (${segment.timeSpecKey}) was not found on read-back`);
      } else {
        expect(specLabel, 'NAME', planned.name, spec.NAME);
        expect(specLabel, 'STARTTIME', planned.STARTTIME, spec.STARTTIME);
        expect(specLabel, 'ENDTIME', planned.ENDTIME, spec.ENDTIME);
        for (const day of WEEKDAYS) expect(specLabel, day, '0', spec.weekdays[day]);
        if (!sameSet(spec.HOLIDAYGROUPS, [String(planned.holidayGroup)])) {
          mismatches.push(`${specLabel} HOLIDAYGROUPS: expected "${planned.holidayGroup}", got "${spec.HOLIDAYGROUPS.join(',')}"`);
        }
      }

      const holiday = await fetchHoliday(client, segment.holidayKey);
      const holidayLabel = `holiday "${planned.name}"`;
      if (!holiday) {
        mismatches.push(`${holidayLabel} (${segment.holidayKey}) was not found on read-back`);
      } else {
        expect(holidayLabel, 'NAME', planned.name, holiday.NAME);
        expect(holidayLabel, 'STARTDATE', planned.STARTDATE, holiday.STARTDATE);
        expect(holidayLabel, 'ENDDATE', planned.ENDDATE, holiday.ENDDATE);
        if (!sameSet(holiday.HOLIDAYGROUPS, [String(planned.holidayGroup)])) {
          mismatches.push(`${holidayLabel} HOLIDAYGROUPS: expected "${planned.holidayGroup}", got "${holiday.HOLIDAYGROUPS.join(',')}"`);
        }
      }
    }

    if (mismatches.length > 0) {
      throw new UnlockWindowError(
        `Step 7 (read-back) found ${mismatches.length} mismatch(es) between the controller and the plan: ${mismatches.join('; ')}. ` +
          'The managed objects were written but could not be verified — inspect them with get_unlock_window or cancel with cancel_unlock_window.'
      );
    }
  });

  // Step 8.
  return {
    window: plan.window,
    segments: scheduled,
    timeSpecGroupKey,
    portalGroupKey,
    portals: targets,
    replacedPreviousWindow,
    sideEffects,
    verified: true,
  };
}

// ---------------------------------------------------------------------------
// cancel_unlock_window (R26)
// ---------------------------------------------------------------------------

export interface LeftBehind {
  type: 'timeSpecGroup' | 'timeSpec';
  key: string;
  NAME: string;
  error: string;
}

export interface CancelUnlockWindowResult {
  cancelled: boolean;
  message: string;
  portalGroup?: { PORTALGROUPKEY: string; NAME: string; portals: PortalRecord[] };
  /** The *Never* group the portal group now points at. */
  unlockTimeSpecGroup?: { TIMESPECGROUPKEY: string; NAME: string };
  deletedHolidays: Array<{ HOLIDAYKEY: string; NAME: string }>;
  timeSpecGroup?: { TIMESPECGROUPKEY: string; NAME: string; emptied: boolean };
  deletedTimeSpecs: Array<{ TIMESPECKEY: string; NAME: string }>;
  /** Managed objects the controller refused to empty/delete (tolerated:
   * with the portal group on *Never* and no managed holiday, nothing can unlock). */
  leftBehind: LeftBehind[];
}

export async function cancelUnlockWindow(client: NetboxClient, settings: UnlockWindowSettings): Promise<CancelUnlockWindowResult> {
  const prefix = settings.namePrefix;

  const timeSpecGroups = await atStep('1 (resolve the Never time spec group)', () => fetchTimeSpecGroups(client));
  const never = timeSpecGroups.find((group) => group.NAME === NEVER_GROUP_NAME);
  if (!never) {
    throw new UnlockWindowError(
      `Cannot cancel: no time spec group named "${NEVER_GROUP_NAME}" exists on this controller (GetTimeSpecGroups listed: ${
        timeSpecGroups.map((group) => `"${group.NAME}"`).join(', ') || 'none'
      }).`
    );
  }
  const managedGroup = timeSpecGroups.find((group) => group.NAME === prefix);

  const portalGroups = await atStep('1 (find the managed portal group)', () => fetchPortalGroups(client));
  const managedPortalGroupSummary = portalGroups.find((group) => group.NAME === prefix);
  if (!managedPortalGroupSummary) {
    return {
      cancelled: false,
      message: `Nothing to cancel: no managed portal group named "${prefix}" exists.`,
      deletedHolidays: [],
      deletedTimeSpecs: [],
      leftBehind: [],
    };
  }

  const portalGroup = await atStep('1 (read the managed portal group)', () => fetchPortalGroup(client, managedPortalGroupSummary.PORTALGROUPKEY));
  if (!portalGroup) {
    throw new UnlockWindowError(
      `Managed portal group "${prefix}" (${managedPortalGroupSummary.PORTALGROUPKEY}) was listed but GetPortalGroup could not read it.`
    );
  }
  const holidays = await atStep('1 (read holidays)', () => fetchHolidays(client));
  const managedHolidays = holidays.filter((holiday) => segmentKindOf(holiday.NAME, prefix) !== undefined);
  const timeSpecs = await atStep('1 (read time specs)', () => fetchTimeSpecs(client));
  const managedSpecs = timeSpecs.filter((spec) => segmentKindOf(spec.NAME, prefix) !== undefined);

  // Step 2: point the managed portal group at Never (re-sending its current membership).
  await atStep('2 (point the managed portal group at Never)', () =>
    client.call(NBAPI_COMMANDS.MODIFY_PORTAL_GROUP, {
      PORTALGROUPKEY: portalGroup.PORTALGROUPKEY,
      PORTALKEY: portalGroup.PORTALS.map((portal) => portal.PORTALKEY),
      UNLOCKTIMESPECGROUPKEY: never.TIMESPECGROUPKEY,
    })
  );

  // Step 3: delete every managed holiday.
  const deletedHolidays: CancelUnlockWindowResult['deletedHolidays'] = [];
  for (const holiday of managedHolidays) {
    await atStep(`3 (delete managed holiday "${holiday.NAME}")`, () =>
      client.call(NBAPI_COMMANDS.DELETE_HOLIDAY, { HOLIDAYKEY: holiday.HOLIDAYKEY })
    );
    deletedHolidays.push({ HOLIDAYKEY: holiday.HOLIDAYKEY, NAME: holiday.NAME });
  }

  // Step 4 (tolerated): empty the managed group, then delete the managed specs.
  const leftBehind: LeftBehind[] = [];
  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  let timeSpecGroup: CancelUnlockWindowResult['timeSpecGroup'];
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
  const deletedTimeSpecs: CancelUnlockWindowResult['deletedTimeSpecs'] = [];
  for (const spec of managedSpecs) {
    try {
      await client.call(NBAPI_COMMANDS.DELETE_TIME_SPEC, { TIMESPECKEY: spec.TIMESPECKEY });
      deletedTimeSpecs.push({ TIMESPECKEY: spec.TIMESPECKEY, NAME: spec.NAME });
    } catch (err) {
      leftBehind.push({ type: 'timeSpec', key: spec.TIMESPECKEY, NAME: spec.NAME, error: errorText(err) });
    }
  }

  return {
    cancelled: true,
    message:
      `Managed portal group "${prefix}" now unlocks on "${NEVER_GROUP_NAME}" and ${deletedHolidays.length} managed holiday(s) were deleted` +
      (leftBehind.length > 0 ? `; ${leftBehind.length} managed object(s) could not be cleaned up (see leftBehind) but nothing can unlock.` : '.'),
    portalGroup: { PORTALGROUPKEY: portalGroup.PORTALGROUPKEY, NAME: portalGroup.NAME, portals: portalGroup.PORTALS },
    unlockTimeSpecGroup: { TIMESPECGROUPKEY: never.TIMESPECGROUPKEY, NAME: never.NAME },
    deletedHolidays,
    ...(timeSpecGroup ? { timeSpecGroup } : {}),
    deletedTimeSpecs,
    leftBehind,
  };
}

// ---------------------------------------------------------------------------
// get_unlock_window (R26, read-only)
// ---------------------------------------------------------------------------

export interface UnlockWindowStatus {
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
  timeSpecs: Array<{
    kind: SegmentKind;
    TIMESPECKEY: string;
    NAME: string;
    STARTTIME: string;
    ENDTIME: string;
    HOLIDAYGROUPS: string;
    inManagedGroup: boolean;
  }>;
  holidays: Array<{ kind: SegmentKind; HOLIDAYKEY: string; NAME: string; STARTDATE: string; ENDDATE: string; HOLIDAYGROUPS: string }>;
  /** Derived from the managed holidays and time specs; null when none exist. */
  window: { start: string; end: string } | null;
  /** Whether a managed segment is unlocking the portal group at this instant (host clock). */
  activeNow: boolean;
  /** The host clock reading used for activeNow, `YYYY-MM-DD HH:MM`. */
  checkedAt: string;
}

export async function getUnlockWindow(client: NetboxClient, settings: UnlockWindowSettings): Promise<UnlockWindowStatus> {
  const now = settings.now ?? (() => new Date());
  const prefix = settings.namePrefix;

  const portalGroups = await fetchPortalGroups(client);
  const managedSummary = portalGroups.find((group) => group.NAME === prefix);
  const portalGroup = managedSummary ? await fetchPortalGroup(client, managedSummary.PORTALGROUPKEY) : undefined;

  const timeSpecGroups = await fetchTimeSpecGroups(client);
  const managedGroup: TimeSpecGroupRecord | undefined = timeSpecGroups.find((group) => group.NAME === prefix);

  const timeSpecs = (await fetchTimeSpecs(client)).filter((spec) => segmentKindOf(spec.NAME, prefix) !== undefined);
  const holidays = (await fetchHolidays(client)).filter((holiday) => segmentKindOf(holiday.NAME, prefix) !== undefined);

  const specByKind = (kind: SegmentKind) => timeSpecs.find((spec) => segmentKindOf(spec.NAME, prefix) === kind);
  const holidayByKind = (kind: SegmentKind) => holidays.find((holiday) => segmentKindOf(holiday.NAME, prefix) === kind);

  let window: UnlockWindowStatus['window'] = null;
  if (holidays.length > 0) {
    const startDate = holidays.map((holiday) => holiday.STARTDATE.slice(0, 10)).sort()[0];
    const lastEndDate = holidays.map((holiday) => holiday.ENDDATE.slice(0, 10)).sort().reverse()[0];
    const firstSpec = specByKind('first');
    const lastSpec = specByKind('last') ?? firstSpec;
    window = {
      start: `${startDate} ${firstSpec?.STARTTIME ?? '00:00'}`,
      end: `${addDays(lastEndDate, -1)} ${lastSpec?.ENDTIME ?? '23:59'}`,
    };
  }

  const pointsAtManaged = portalGroup !== undefined && managedGroup !== undefined && portalGroup.UNLOCKTIMESPECGROUPKEY === managedGroup.TIMESPECGROUPKEY;

  const checkedAt = formatLocalDateTime(now());
  const today = checkedAt.slice(0, 10);
  const clock = checkedAt.slice(11);
  const activeNow =
    pointsAtManaged &&
    SEGMENT_KINDS.some((kind) => {
      const holiday = holidayByKind(kind);
      const spec = specByKind(kind);
      if (!holiday || !spec || !managedGroup!.TIMESPECKEYS.includes(spec.TIMESPECKEY)) return false;
      const sharesGroup = holiday.HOLIDAYGROUPS.some((group) => spec.HOLIDAYGROUPS.includes(group));
      const dateCovered = holiday.STARTDATE.slice(0, 10) <= today && today < holiday.ENDDATE.slice(0, 10);
      return sharesGroup && dateCovered && spec.STARTTIME <= clock && clock <= spec.ENDTIME;
    });

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
    timeSpecs: timeSpecs.map((spec) => ({
      kind: segmentKindOf(spec.NAME, prefix)!,
      TIMESPECKEY: spec.TIMESPECKEY,
      NAME: spec.NAME,
      STARTTIME: spec.STARTTIME,
      ENDTIME: spec.ENDTIME,
      HOLIDAYGROUPS: spec.HOLIDAYGROUPS.join(','),
      inManagedGroup: managedGroup?.TIMESPECKEYS.includes(spec.TIMESPECKEY) ?? false,
    })),
    holidays: holidays.map((holiday) => ({
      kind: segmentKindOf(holiday.NAME, prefix)!,
      HOLIDAYKEY: holiday.HOLIDAYKEY,
      NAME: holiday.NAME,
      STARTDATE: holiday.STARTDATE,
      ENDDATE: holiday.ENDDATE,
      HOLIDAYGROUPS: holiday.HOLIDAYGROUPS.join(','),
    })),
    window,
    activeNow,
    checkedAt,
  };
}
