import { describe, expect, it } from 'vitest';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';
import { MAX_PAGES as PORTAL_SEARCH_MAX_PAGES } from '../src/portalSearch.js';
import { MAX_PAGES, fetchAllPages, fetchAllPagesWith, splitKeys } from '../src/paging.js';
import {
  carriesManagedPrefix,
  fetchHolidayKeys,
  fetchHolidays,
  fetchTimeSpecGroups,
  keyList,
  managedNames,
  normalizeDateTime,
  normalizeFlag,
  normalizeGroups,
  normalizeTime,
  segmentKindOf,
} from '../src/unlockWindow/managed.js';

/** A fake client that serves the given pages per command, in order, and records every call. */
function scriptedClient(pages: Partial<Record<string, Array<NbapiCallResult | (() => never)>>>) {
  const calls: Array<{ command: string; params: unknown }> = [];
  const client = {
    call: async (command: string, params: unknown) => {
      const served = calls.filter((call) => call.command === command).length;
      calls.push({ command, params });
      const page = pages[command]?.[served];
      if (!page) throw new Error(`unexpected ${command} call #${served + 1}`);
      return typeof page === 'function' ? page() : page;
    },
  } as unknown as NetboxClient;
  return { client, calls };
}

const notFoundFail = () => {
  throw new NbapiFailError('NOT FOUND');
};

describe('src/paging.ts: the shared NEXTKEY loop', () => {
  it('is the same loop find_portals uses (one MAX_PAGES, re-exported)', () => {
    expect(PORTAL_SEARCH_MAX_PAGES).toBe(MAX_PAGES);
  });

  it('fetchAllPagesWith follows NEXTKEY and applies a custom extractor per page', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_HOLIDAYS]: [
        { notFound: false, data: { HOLIDAYS: '1,4', NEXTKEY: '4' } },
        { notFound: false, data: { HOLIDAYS: '9' } },
      ],
    });
    const keys = await fetchAllPagesWith(client, NBAPI_COMMANDS.GET_HOLIDAYS, (details) => splitKeys(details.HOLIDAYS));
    expect(keys).toEqual(['1', '4', '9']);
    expect(calls.map((call) => call.params)).toEqual([{}, { STARTFROMKEY: '4' }]);
  });

  it('treats the 6.2.0 bare FAIL/"NOT FOUND" as an empty collection only when asked to', async () => {
    const emptyOnFail = scriptedClient({ [NBAPI_COMMANDS.GET_PORTAL_GROUPS]: [notFoundFail] });
    await expect(
      fetchAllPages(emptyOnFail.client, NBAPI_COMMANDS.GET_PORTAL_GROUPS, 'PORTALGROUPS', 'PORTALGROUP', { emptyOnNotFoundFail: true })
    ).resolves.toEqual([]);

    const strict = scriptedClient({ [NBAPI_COMMANDS.GET_PORTAL_GROUPS]: [notFoundFail] });
    await expect(fetchAllPages(strict.client, NBAPI_COMMANDS.GET_PORTAL_GROUPS, 'PORTALGROUPS', 'PORTALGROUP')).rejects.toThrow('NOT FOUND');

    const otherFail = scriptedClient({
      [NBAPI_COMMANDS.GET_PORTAL_GROUPS]: [
        () => {
          throw new NbapiFailError('NOT PERMITTED');
        },
      ],
    });
    await expect(
      fetchAllPages(otherFail.client, NBAPI_COMMANDS.GET_PORTAL_GROUPS, 'PORTALGROUPS', 'PORTALGROUP', { emptyOnNotFoundFail: true })
    ).rejects.toThrow('NOT PERMITTED');
  });
});

describe('src/unlockWindow/managed.ts: readers and normalisation', () => {
  it('fetchHolidayKeys accepts the live comma string, an empty string, and the doc record shape', async () => {
    const comma = scriptedClient({ [NBAPI_COMMANDS.GET_HOLIDAYS]: [{ notFound: false, data: { HOLIDAYS: '1' } }] });
    expect(await fetchHolidayKeys(comma.client)).toEqual(['1']);

    const empty = scriptedClient({ [NBAPI_COMMANDS.GET_HOLIDAYS]: [{ notFound: false, data: { HOLIDAYS: '' } }] });
    expect(await fetchHolidayKeys(empty.client)).toEqual([]);

    const records = scriptedClient({
      [NBAPI_COMMANDS.GET_HOLIDAYS]: [{ notFound: false, data: { HOLIDAYS: { HOLIDAY: [{ HOLIDAYKEY: '3' }, { HOLIDAYKEY: '5' }] }, NEXTKEY: '-1' } }],
    });
    expect(await fetchHolidayKeys(records.client)).toEqual(['3', '5']);
  });

  it('fetchHolidays reads GetHolidays then GetHoliday per key, normalising the live YYYY-MM-DD HH:MM:SS dates', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_HOLIDAYS]: [{ notFound: false, data: { HOLIDAYS: '1,2' } }],
      [NBAPI_COMMANDS.GET_HOLIDAY]: [
        { notFound: false, data: { HOLIDAY: { NAME: 'GRAND OPENING', HOLIDAYGROUPS: '1', STARTDATE: '2026-09-11 00:00:00', ENDDATE: '2026-09-21 00:00:00' } } },
        { notFound: true, data: undefined },
      ],
    });
    expect(await fetchHolidays(client)).toEqual([
      { HOLIDAYKEY: '1', NAME: 'GRAND OPENING', HOLIDAYGROUPS: ['1'], STARTDATE: '2026-09-11 00:00', ENDDATE: '2026-09-21 00:00' },
    ]);
    expect(calls.map((call) => call.command)).toEqual([NBAPI_COMMANDS.GET_HOLIDAYS, NBAPI_COMMANDS.GET_HOLIDAY, NBAPI_COMMANDS.GET_HOLIDAY]);
  });

  it('fetchTimeSpecGroups reads membership from the TIMESPECKEYS/TIMESPECKEY shape (single, repeated, or empty)', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
        {
          notFound: false,
          data: {
            TIMESPECGROUPS: {
              TIMESPECGROUP: [
                { TIMESPECGROUPKEY: '1', NAME: 'Always', DESCRIPTION: '', TIMESPECKEYS: { TIMESPECKEY: '1' } },
                { TIMESPECGROUPKEY: '28', NAME: 'GRAND OPENING', DESCRIPTION: '', TIMESPECKEYS: { TIMESPECKEY: ['3', '4'] } },
                { TIMESPECGROUPKEY: '30', NAME: 'Empty', DESCRIPTION: '', TIMESPECKEYS: '' },
              ],
            },
            NEXTKEY: '-1',
          },
        },
      ],
    });
    expect((await fetchTimeSpecGroups(client)).map((group) => [group.TIMESPECGROUPKEY, group.TIMESPECKEYS])).toEqual([
      ['1', ['1']],
      ['28', ['3', '4']],
      ['30', []],
    ]);
  });

  it('normalises times, dates, flags, and groups the way the live controller returns them', () => {
    expect(normalizeTime('23:59:00')).toBe('23:59');
    expect(normalizeTime('9:05')).toBe('09:05');
    expect(normalizeTime('08:30')).toBe('08:30');
    expect(normalizeDateTime('2026-10-03 00:00:00')).toBe('2026-10-03 00:00');
    expect(normalizeDateTime('2026-10-03')).toBe('2026-10-03 00:00');
    expect(normalizeDateTime('2026-10-03 17:30')).toBe('2026-10-03 17:30');
    expect(normalizeFlag('TRUE')).toBe('1');
    expect(normalizeFlag('1')).toBe('1');
    expect(normalizeFlag('FALSE')).toBe('0');
    expect(normalizeFlag(undefined)).toBe('0');
    expect(normalizeGroups('8, 1,8,')).toEqual(['1', '8']);
    expect(normalizeGroups('')).toEqual([]);
    expect(keyList('1,2', 'X')).toEqual(['1', '2']);
    expect(keyList({ TIMESPECKEY: '7' }, 'TIMESPECKEY')).toEqual(['7']);
    expect(keyList('', 'TIMESPECKEY')).toEqual([]);
  });

  it('managed names are exact: segmentKindOf matches only "<prefix> first|middle|last"; carriesManagedPrefix is prefix-based', () => {
    expect(managedNames('MCP Unlock Window')).toEqual({
      portalGroup: 'MCP Unlock Window',
      timeSpecGroup: 'MCP Unlock Window time specs',
      segments: { first: 'MCP Unlock Window first', middle: 'MCP Unlock Window middle', last: 'MCP Unlock Window last' },
    });
    expect(segmentKindOf('P first', 'P')).toBe('first');
    expect(segmentKindOf('P last', 'P')).toBe('last');
    expect(segmentKindOf('P', 'P')).toBeUndefined();
    expect(segmentKindOf('P firstborn', 'P')).toBeUndefined();
    expect(segmentKindOf('p first', 'P')).toBeUndefined();
    expect(carriesManagedPrefix('P', 'P')).toBe(true);
    expect(carriesManagedPrefix('P anything', 'P')).toBe(true);
    expect(carriesManagedPrefix('Pfoo', 'P')).toBe(false);
    expect(carriesManagedPrefix('Never', 'P')).toBe(false);
  });
});
