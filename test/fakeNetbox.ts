import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';

/**
 * A small in-memory stand-in for the NetBox controller, for the composite
 * tools' tests (R10, R22-R28). It keeps portals, time specs, time spec
 * groups, holidays and portal groups as state, answers the Get/Add/Modify/
 * Delete commands the composite tools use with live-6.2.0-shaped responses,
 * and records every call in order.
 *
 * Live quirks it reproduces on purpose:
 *  - `GetTimeSpecGroup` ALWAYS fails with CODE=FAIL/ERRMSG="NOT FOUND", so
 *    any code that depends on it fails these tests (membership must come
 *    from paginated `GetTimeSpecGroups`).
 *  - Weekday flags read back as `TRUE`/`FALSE`; dates as `YYYY-MM-DD HH:MM:SS`;
 *    `GetHolidays` returns `HOLIDAYS` as a comma-separated key string.
 *  - A one-item collection collapses to a bare object and an empty one to ''
 *    (what fast-xml-parser produces).
 *  - `AddPortalGroup`/`AddTimeSpecGroup` reject a NAME already used by a
 *    group of either type (`ERRMSG` "Duplicate Portal Group"/"Duplicate") —
 *    portal groups and time spec groups share one name table.
 */

export interface FakePortal {
  PORTALKEY: string;
  NAME: string;
}

export interface FakeTimeSpec {
  TIMESPECKEY: string;
  NAME: string;
  DESCRIPTION: string;
  STARTTIME: string;
  ENDTIME: string;
  MONDAY: string;
  TUESDAY: string;
  WEDNESDAY: string;
  THURSDAY: string;
  FRIDAY: string;
  SATURDAY: string;
  SUNDAY: string;
  HOLIDAYGROUPS: string;
}

export interface FakeTimeSpecGroup {
  TIMESPECGROUPKEY: string;
  NAME: string;
  DESCRIPTION: string;
  TIMESPECKEYS: string[];
}

export interface FakeHoliday {
  HOLIDAYKEY: string;
  NAME: string;
  HOLIDAYGROUPS: string;
  /** `YYYY-MM-DD HH:MM:SS` */
  STARTDATE: string;
  ENDDATE: string;
}

export interface FakePortalGroup {
  PORTALGROUPKEY: string;
  NAME: string;
  DESCRIPTION: string;
  PORTALKEYS: string[];
  UNLOCKTIMESPECGROUPKEY: string;
  THREATLEVELGROUPKEY: string;
}

export interface RecordedCall {
  command: string;
  params: Record<string, unknown>;
}

type Params = Record<string, unknown>;
type Override = (params: Params, respond: () => NbapiCallResult) => NbapiCallResult;

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;

/** fast-xml-parser shape: [] -> '', [x] -> x, [x, y] -> [x, y]. */
function collapse<T>(items: T[]): '' | T | T[] {
  if (items.length === 0) return '';
  return items.length === 1 ? items[0] : items;
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function list(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(str);
}

/** Input dates are `YYYY-MM-DD HH:MM` (or `YYYY-MM-DD`); the controller reads them back with seconds. */
function withSeconds(value: unknown): string {
  const raw = str(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
  return raw;
}

function flag(value: unknown): string {
  return /^(1|true)$/i.test(str(value)) ? 'TRUE' : 'FALSE';
}

const fail = (errmsg: string): never => {
  throw new NbapiFailError(errmsg);
};

const ok = (data: unknown = {}): NbapiCallResult => ({ notFound: false, data });
const notFound: NbapiCallResult = { notFound: true, data: undefined };

export class FakeNetbox {
  portals: FakePortal[] = [];
  timeSpecs: FakeTimeSpec[] = [];
  timeSpecGroups: FakeTimeSpecGroup[] = [];
  holidays: FakeHoliday[] = [];
  portalGroups: FakePortalGroup[] = [];
  calls: RecordedCall[] = [];
  /** When set, GetPortals pages with this many portals per page. */
  portalsPageSize: number | undefined;
  /** Scripted outcome for Lock/Unlock/MomentaryUnlock of a given PORTALKEY. */
  portalActionOutcomes = new Map<string, 'unchanged' | 'offline'>();

  private nextKey = 100;
  private refusals: Array<{ command: string; errmsg: string; when?: (params: Params) => boolean }> = [];
  private overrides = new Map<string, Override>();

  /** A controller with the built-in Always (1) / Never (2) time specs and their singular groups. */
  static withBuiltins(): FakeNetbox {
    const fake = new FakeNetbox();
    fake.timeSpecs.push(
      {
        TIMESPECKEY: '1',
        NAME: 'Always',
        DESCRIPTION: 'all days and holidays',
        STARTTIME: '00:00',
        ENDTIME: '23:59',
        MONDAY: 'TRUE',
        TUESDAY: 'TRUE',
        WEDNESDAY: 'TRUE',
        THURSDAY: 'TRUE',
        FRIDAY: 'TRUE',
        SATURDAY: 'TRUE',
        SUNDAY: 'TRUE',
        HOLIDAYGROUPS: '1,2,3,4,5,6,7,8',
      },
      {
        TIMESPECKEY: '2',
        NAME: 'Never',
        DESCRIPTION: '',
        STARTTIME: '00:00',
        ENDTIME: '00:00',
        MONDAY: 'FALSE',
        TUESDAY: 'FALSE',
        WEDNESDAY: 'FALSE',
        THURSDAY: 'FALSE',
        FRIDAY: 'FALSE',
        SATURDAY: 'FALSE',
        SUNDAY: 'FALSE',
        HOLIDAYGROUPS: '',
      }
    );
    fake.timeSpecGroups.push(
      { TIMESPECGROUPKEY: '1', NAME: 'Always', DESCRIPTION: '', TIMESPECKEYS: ['1'] },
      { TIMESPECGROUPKEY: '2', NAME: 'Never', DESCRIPTION: '', TIMESPECKEYS: ['2'] }
    );
    return fake;
  }

  get client(): NetboxClient {
    return { call: (command: string, params: Params = {}) => this.call(command, params) } as unknown as NetboxClient;
  }

  commands(): string[] {
    return this.calls.map((call) => call.command);
  }

  /** Every call that is not a Get* read. */
  writeCalls(): RecordedCall[] {
    return this.calls.filter((call) => !call.command.startsWith('Get'));
  }

  /** Make `command` fail with `errmsg` (optionally only when `when(params)`). */
  refuse(command: string, errmsg: string, when?: (params: Params) => boolean): void {
    this.refusals.push({ command, errmsg, when });
  }

  /** Replace or wrap the response of `command`; `respond()` yields the normal one. */
  override(command: string, fn: Override): void {
    this.overrides.set(command, fn);
  }

  seedTimeSpec(fields: Partial<FakeTimeSpec> & { NAME: string }): string {
    const key = fields.TIMESPECKEY ?? this.allocateKey();
    const weekdays = Object.fromEntries(WEEKDAYS.map((day) => [day, fields[day] ?? 'FALSE'])) as Record<(typeof WEEKDAYS)[number], string>;
    this.timeSpecs.push({
      TIMESPECKEY: key,
      NAME: fields.NAME,
      DESCRIPTION: fields.DESCRIPTION ?? '',
      STARTTIME: fields.STARTTIME ?? '00:00',
      ENDTIME: fields.ENDTIME ?? '23:59',
      ...weekdays,
      HOLIDAYGROUPS: fields.HOLIDAYGROUPS ?? '',
    });
    return key;
  }

  seedTimeSpecGroup(fields: Partial<FakeTimeSpecGroup> & { NAME: string }): string {
    const key = fields.TIMESPECGROUPKEY ?? this.allocateKey();
    this.timeSpecGroups.push({ TIMESPECGROUPKEY: key, NAME: fields.NAME, DESCRIPTION: fields.DESCRIPTION ?? '', TIMESPECKEYS: fields.TIMESPECKEYS ?? [] });
    return key;
  }

  seedHoliday(fields: Partial<FakeHoliday> & { NAME: string; STARTDATE: string; ENDDATE: string }): string {
    const key = fields.HOLIDAYKEY ?? this.allocateKey();
    this.holidays.push({
      HOLIDAYKEY: key,
      NAME: fields.NAME,
      HOLIDAYGROUPS: fields.HOLIDAYGROUPS ?? '',
      STARTDATE: withSeconds(fields.STARTDATE),
      ENDDATE: withSeconds(fields.ENDDATE),
    });
    return key;
  }

  seedPortalGroup(fields: Partial<FakePortalGroup> & { NAME: string }): string {
    const key = fields.PORTALGROUPKEY ?? this.allocateKey();
    this.portalGroups.push({
      PORTALGROUPKEY: key,
      NAME: fields.NAME,
      DESCRIPTION: fields.DESCRIPTION ?? '',
      PORTALKEYS: fields.PORTALKEYS ?? [],
      UNLOCKTIMESPECGROUPKEY: fields.UNLOCKTIMESPECGROUPKEY ?? '',
      THREATLEVELGROUPKEY: fields.THREATLEVELGROUPKEY ?? '',
    });
    return key;
  }

  private allocateKey(): string {
    this.nextKey += 1;
    return String(this.nextKey);
  }

  async call(command: string, params: Params): Promise<NbapiCallResult> {
    this.calls.push({ command, params: JSON.parse(JSON.stringify(params)) });
    for (const refusal of this.refusals) {
      if (refusal.command === command && (refusal.when === undefined || refusal.when(params))) fail(refusal.errmsg);
    }
    const override = this.overrides.get(command);
    if (override) return override(params, () => this.respond(command, params));
    return this.respond(command, params);
  }

  private respond(command: string, params: Params): NbapiCallResult {
    switch (command) {
      case NBAPI_COMMANDS.GET_PORTALS: {
        if (this.portalsPageSize === undefined) {
          return ok({ PORTALS: { PORTAL: collapse(this.portals.map((portal) => ({ ...portal }))) }, NEXTKEY: '-1' });
        }
        const offset = params.STARTFROMKEY === undefined ? 0 : Number(params.STARTFROMKEY);
        const page = this.portals.slice(offset, offset + this.portalsPageSize);
        const next = offset + this.portalsPageSize;
        return ok({ PORTALS: { PORTAL: collapse(page.map((portal) => ({ ...portal }))) }, NEXTKEY: next < this.portals.length ? String(next) : '-1' });
      }

      case NBAPI_COMMANDS.GET_TIME_SPECS:
        return ok({ TIMESPECS: { TIMESPEC: collapse(this.timeSpecs.map((spec) => ({ ...spec }))) }, NEXTKEY: '-1' });

      case NBAPI_COMMANDS.GET_TIME_SPEC: {
        const spec = this.timeSpecs.find((candidate) => candidate.TIMESPECKEY === str(params.TIMESPECKEY));
        return spec ? ok({ TIMESPEC: { ...spec } }) : notFound;
      }

      case NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS:
        return ok({
          TIMESPECGROUPS: {
            TIMESPECGROUP: collapse(
              this.timeSpecGroups.map((group) => ({
                TIMESPECGROUPKEY: group.TIMESPECGROUPKEY,
                NAME: group.NAME,
                DESCRIPTION: group.DESCRIPTION,
                TIMESPECKEYS: group.TIMESPECKEYS.length === 0 ? '' : { TIMESPECKEY: collapse([...group.TIMESPECKEYS]) },
              }))
            ),
          },
          NEXTKEY: '-1',
        });

      case NBAPI_COMMANDS.GET_TIME_SPEC_GROUP:
        // The verified 6.2.0 quirk: fails for every key, even listed ones.
        return fail('NOT FOUND');

      case NBAPI_COMMANDS.GET_HOLIDAYS:
        return ok({ HOLIDAYS: this.holidays.map((holiday) => holiday.HOLIDAYKEY).join(',') });

      case NBAPI_COMMANDS.GET_HOLIDAY: {
        const holiday = this.holidays.find((candidate) => candidate.HOLIDAYKEY === str(params.HOLIDAYKEY));
        if (!holiday) return notFound;
        const { HOLIDAYKEY: _key, ...fields } = holiday;
        return ok({ HOLIDAY: fields });
      }

      case NBAPI_COMMANDS.GET_PORTAL_GROUPS:
        return ok({
          PORTALGROUPS: {
            PORTALGROUP: collapse(
              this.portalGroups.map((group) => ({
                PORTALGROUPKEY: group.PORTALGROUPKEY,
                NAME: group.NAME,
                DESCRIPTION: group.DESCRIPTION,
                UNLOCKTIMESPECGROUPKEY: group.UNLOCKTIMESPECGROUPKEY,
              }))
            ),
          },
          NEXTKEY: '-1',
        });

      case NBAPI_COMMANDS.GET_PORTAL_GROUP: {
        const group = this.portalGroups.find((candidate) => candidate.PORTALGROUPKEY === str(params.PORTALGROUPKEY));
        if (!group) return notFound;
        const members = group.PORTALKEYS.map((key) => ({ PORTALKEY: key, NAME: this.portals.find((portal) => portal.PORTALKEY === key)?.NAME ?? '' }));
        return ok({
          PORTALGROUP: {
            PORTALGROUPKEY: group.PORTALGROUPKEY,
            NAME: group.NAME,
            DESCRIPTION: group.DESCRIPTION,
            PORTALS: { PORTAL: collapse(members) },
            UNLOCKTIMESPECGROUPKEY: group.UNLOCKTIMESPECGROUPKEY,
            THREATLEVELGROUPKEY: group.THREATLEVELGROUPKEY,
          },
        });
      }

      case NBAPI_COMMANDS.ADD_TIME_SPEC: {
        const key = this.allocateKey();
        const weekdays = Object.fromEntries(WEEKDAYS.map((day) => [day, flag(params[day])])) as Record<(typeof WEEKDAYS)[number], string>;
        this.timeSpecs.push({
          TIMESPECKEY: key,
          NAME: str(params.NAME),
          DESCRIPTION: str(params.DESCRIPTION),
          STARTTIME: str(params.STARTTIME),
          ENDTIME: str(params.ENDTIME),
          ...weekdays,
          HOLIDAYGROUPS: str(params.HOLIDAYGROUPS),
        });
        return ok({ TIMESPECKEY: key });
      }

      case NBAPI_COMMANDS.MODIFY_TIME_SPEC: {
        const spec = this.timeSpecs.find((candidate) => candidate.TIMESPECKEY === str(params.TIMESPECKEY));
        if (!spec) return fail('Invalid TIMESPECKEY');
        if (spec.NAME === 'Always' || spec.NAME === 'Never') return fail('Cannot modify timespecs ALWAYS or NEVER');
        for (const field of ['NAME', 'DESCRIPTION', 'STARTTIME', 'ENDTIME', 'HOLIDAYGROUPS'] as const) {
          if (params[field] !== undefined) spec[field] = str(params[field]);
        }
        for (const day of WEEKDAYS) if (params[day] !== undefined) spec[day] = flag(params[day]);
        return ok({});
      }

      case NBAPI_COMMANDS.DELETE_TIME_SPEC: {
        const key = str(params.TIMESPECKEY);
        const spec = this.timeSpecs.find((candidate) => candidate.TIMESPECKEY === key);
        if (!spec) return fail('Invalid TIMESPECKEY');
        if (spec.NAME === 'Always' || spec.NAME === 'Never') return fail('Cannot Delete timespecs ALWAYS or NEVER');
        this.timeSpecs = this.timeSpecs.filter((candidate) => candidate.TIMESPECKEY !== key);
        // Doc: deleting a time spec also modifies any group it is a member of.
        for (const group of this.timeSpecGroups) group.TIMESPECKEYS = group.TIMESPECKEYS.filter((member) => member !== key);
        return ok({ TIMESPECKEY: key });
      }

      case NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP: {
        const name = str(params.NAME);
        // Live 6.2.0: portal groups and time spec groups share one name table.
        if (this.timeSpecGroups.some((group) => group.NAME === name) || this.portalGroups.some((group) => group.NAME === name)) {
          return fail('Duplicate');
        }
        const key = this.allocateKey();
        this.timeSpecGroups.push({ TIMESPECGROUPKEY: key, NAME: name, DESCRIPTION: str(params.DESCRIPTION), TIMESPECKEYS: [] });
        return ok({ TIMESPECGROUPKEY: key });
      }

      case NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP: {
        const group = this.timeSpecGroups.find((candidate) => candidate.TIMESPECGROUPKEY === str(params.TIMESPECGROUPKEY));
        if (!group) return fail('Invalid TIMESPECGROUPKEY');
        if (params.NAME !== undefined) group.NAME = str(params.NAME);
        if (params.DESCRIPTION !== undefined) group.DESCRIPTION = str(params.DESCRIPTION);
        if (params.TIMESPECKEYS !== undefined) {
          group.TIMESPECKEYS = list((params.TIMESPECKEYS as Params).TIMESPECKEY);
        }
        return ok({});
      }

      case NBAPI_COMMANDS.DELETE_TIME_SPEC_GROUP: {
        const key = str(params.TIMESPECGROUPKEY);
        if (!this.timeSpecGroups.some((candidate) => candidate.TIMESPECGROUPKEY === key)) return fail('Invalid TIMESPECGROUPKEY');
        this.timeSpecGroups = this.timeSpecGroups.filter((candidate) => candidate.TIMESPECGROUPKEY !== key);
        return ok({ TIMESPECGROUPKEY: key });
      }

      case NBAPI_COMMANDS.ADD_HOLIDAY: {
        if (this.holidays.length >= 30) return fail('Cannot exceed count of 30 Holidays per partition');
        const key = this.allocateKey();
        this.holidays.push({
          HOLIDAYKEY: key,
          NAME: str(params.HOLIDAYNAME),
          HOLIDAYGROUPS: str(params.HOLIDAYGROUPS),
          STARTDATE: withSeconds(params.STARTDATE),
          ENDDATE: withSeconds(params.ENDDATE),
        });
        return ok({ HOLIDAYKEY: key });
      }

      case NBAPI_COMMANDS.MODIFY_HOLIDAY: {
        const holiday = this.holidays.find((candidate) => candidate.HOLIDAYKEY === str(params.HOLIDAYKEY));
        if (!holiday) return fail('Invalid HOLIDAYKEY');
        if (params.HOLIDAYNAME !== undefined) holiday.NAME = str(params.HOLIDAYNAME);
        if (params.HOLIDAYGROUPS !== undefined) holiday.HOLIDAYGROUPS = str(params.HOLIDAYGROUPS);
        if (params.STARTDATE !== undefined) holiday.STARTDATE = withSeconds(params.STARTDATE);
        if (params.ENDDATE !== undefined) holiday.ENDDATE = withSeconds(params.ENDDATE);
        return ok({});
      }

      case NBAPI_COMMANDS.DELETE_HOLIDAY: {
        const key = str(params.HOLIDAYKEY);
        if (!this.holidays.some((candidate) => candidate.HOLIDAYKEY === key)) return fail('Invalid HOLIDAYKEY');
        this.holidays = this.holidays.filter((candidate) => candidate.HOLIDAYKEY !== key);
        return ok({ HOLIDAYKEY: key });
      }

      case NBAPI_COMMANDS.ADD_PORTAL_GROUP: {
        const name = str(params.NAME);
        // Live 6.2.0: portal groups and time spec groups share one name table
        // (verified 2026-09-15: AddPortalGroup failed with "Duplicate Portal
        // Group" against an already-created time spec group of the same name).
        if (this.portalGroups.some((group) => group.NAME === name) || this.timeSpecGroups.some((group) => group.NAME === name)) {
          return fail('Duplicate Portal Group');
        }
        const key = this.allocateKey();
        this.portalGroups.push({
          PORTALGROUPKEY: key,
          NAME: name,
          DESCRIPTION: str(params.DESCRIPTION),
          PORTALKEYS: list((params.PORTALKEYS as Params | undefined)?.PORTALKEY),
          UNLOCKTIMESPECGROUPKEY: str(params.UNLOCKTIMESPECGROUPKEY),
          THREATLEVELGROUPKEY: str(params.THREATLEVELGROUPKEY),
        });
        return ok({ PORTALGROUPKEY: key });
      }

      case NBAPI_COMMANDS.MODIFY_PORTAL_GROUP: {
        // Live 6.2.0 behaviour (2026-09-15): membership is replaced by the
        // wrapped <PORTALKEYS><PORTALKEY>... list if present, and CLEARED if
        // that wrapper is absent — including when only top-level PORTALKEY
        // siblings are given, since that shape is not parsed.
        const group = this.portalGroups.find((candidate) => candidate.PORTALGROUPKEY === str(params.PORTALGROUPKEY));
        if (!group) return fail('Invalid PORTALGROUPKEY');
        if (params.NAME !== undefined) group.NAME = str(params.NAME);
        if (params.DESCRIPTION !== undefined) group.DESCRIPTION = str(params.DESCRIPTION);
        group.PORTALKEYS = list((params.PORTALKEYS as Params | undefined)?.PORTALKEY);
        if (params.UNLOCKTIMESPECGROUPKEY !== undefined) group.UNLOCKTIMESPECGROUPKEY = str(params.UNLOCKTIMESPECGROUPKEY);
        if (params.THREATLEVELGROUPKEY !== undefined) group.THREATLEVELGROUPKEY = str(params.THREATLEVELGROUPKEY);
        return ok({});
      }

      case NBAPI_COMMANDS.DELETE_PORTAL_GROUP: {
        const key = str(params.PORTALGROUPKEY);
        if (!this.portalGroups.some((candidate) => candidate.PORTALGROUPKEY === key)) return fail('Invalid PORTALGROUPKEY');
        this.portalGroups = this.portalGroups.filter((candidate) => candidate.PORTALGROUPKEY !== key);
        return ok({ PORTALGROUPKEY: key });
      }

      case NBAPI_COMMANDS.LOCK_PORTAL:
      case NBAPI_COMMANDS.UNLOCK_PORTAL:
      case NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL: {
        const key = str(params.PORTALKEY);
        if (!this.portals.some((portal) => portal.PORTALKEY === key)) return fail('Invalid portal key');
        const outcome = this.portalActionOutcomes.get(key);
        if (outcome === 'unchanged') return fail('Portal state not changed');
        if (outcome === 'offline') return fail('Portal not online or reachable');
        return ok({ PORTALKEY: key });
      }

      default:
        throw new Error(`FakeNetbox: no handler for ${command}`);
    }
  }
}
