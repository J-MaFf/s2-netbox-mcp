import { describe, expect, it } from 'vitest';
import { fetchTimeSpecNames } from '../src/timeSpecNames.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';

/**
 * Unit tests for the shared time-spec-name enrichment helper (see
 * specs/archive/time-spec-groups-resolve-member-names.md R2/R5) -- used by
 * get_time_spec_groups's RESOLVEMEMBERNAMES path (see
 * test/timeSpecTools.test.ts's own get_time_spec_groups RESOLVEMEMBERNAMES
 * describe block for that call site's tests). Mirrors
 * test/timeSpecGroupNames.test.ts's conventions exactly.
 */

/** A fake client that serves the given pages per command, in order, and
 * records every call (mirrors test/readerDescriptions.test.ts's
 * scriptedClient). */
function scriptedClient(pages: Partial<Record<string, NbapiCallResult[]>>) {
  const calls: Array<{ command: string; params: unknown }> = [];
  const client = {
    call: async (command: string, params: unknown) => {
      const served = calls.filter((call) => call.command === command).length;
      calls.push({ command, params });
      const page = pages[command]?.[served];
      if (!page) throw new Error(`unexpected ${command} call #${served + 1}`);
      return page;
    },
  } as unknown as NetboxClient;
  return { client, calls };
}

describe('fetchTimeSpecNames (R2/R5)', () => {
  it('builds a TIMESPECKEY -> NAME map from a scripted multi-page GetTimeSpecs response, one entry per time spec', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPECS]: [
        {
          notFound: false,
          data: {
            TIMESPECS: {
              TIMESPEC: [
                { TIMESPECKEY: '1', NAME: 'Always' },
                { TIMESPECKEY: '2', NAME: 'Never' },
              ],
            },
            NEXTKEY: '2',
          },
        },
        {
          notFound: false,
          data: {
            TIMESPECS: { TIMESPEC: { TIMESPECKEY: '3', NAME: 'GRAND OPENING' } },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const result = await fetchTimeSpecNames(client);

    const specCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPECS);
    expect(specCalls).toHaveLength(2); // proves the multi-page walk actually followed NEXTKEY
    expect(result).toEqual(
      new Map([
        ['1', 'Always'],
        ['2', 'Never'],
        ['3', 'GRAND OPENING'],
      ])
    );
  });

  it('never issues a singular GetTimeSpec call -- only the paginated GetTimeSpecs list', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPECS]: [
        { notFound: false, data: { TIMESPECS: { TIMESPEC: { TIMESPECKEY: '1', NAME: 'Always' } }, NEXTKEY: '-1' } },
      ],
    });

    await fetchTimeSpecNames(client);

    expect(calls.every((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPECS)).toBe(true);
    expect(calls.some((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPEC)).toBe(false);
  });

  it('skips a time spec whose TIMESPECKEY normalizes to the empty string rather than adding a bogus map entry', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPECS]: [
        {
          notFound: false,
          data: {
            TIMESPECS: {
              TIMESPEC: [
                { TIMESPECKEY: '', NAME: 'malformed' },
                { TIMESPECKEY: '9', NAME: 'ok' },
              ],
            },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const result = await fetchTimeSpecNames(client);

    expect(result.has('')).toBe(false);
    expect(result).toEqual(new Map([['9', 'ok']]));
  });

  it('treats NOT FOUND as no time specs (empty map, no throw)', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPECS]: [{ notFound: true, data: undefined }],
    });

    const result = await fetchTimeSpecNames(client);

    expect(result.size).toBe(0);
  });

  it('R5: does not throw when the underlying GetTimeSpecs call itself throws -- resolves to an empty Map instead', async () => {
    const client = {
      call: async () => {
        throw new Error('transient GetTimeSpecs failure');
      },
    } as unknown as NetboxClient;

    const result = await fetchTimeSpecNames(client);

    expect(result).toEqual(new Map());
  });
});
