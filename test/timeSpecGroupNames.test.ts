import { describe, expect, it } from 'vitest';
import { fetchTimeSpecGroupNames } from '../src/timeSpecGroupNames.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';

/**
 * Unit tests for the shared time-spec-group-name enrichment helper (see
 * specs/archive/access-level-resolve-group-names.md R2/R5) -- used by
 * get_access_level's RESOLVEGROUPNAMES path (see
 * test/tools.test.ts's own get_access_level RESOLVEGROUPNAMES describe
 * block for that call site's tests). Mirrors
 * test/readerDescriptions.test.ts's conventions exactly.
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

describe('fetchTimeSpecGroupNames (R2/R5)', () => {
  it('builds a TIMESPECGROUPKEY -> NAME map from a scripted multi-page GetTimeSpecGroups response, one entry per group', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
        {
          notFound: false,
          data: {
            TIMESPECGROUPS: {
              TIMESPECGROUP: [
                { TIMESPECGROUPKEY: '1', NAME: 'Always' },
                { TIMESPECGROUPKEY: '4', NAME: 'Business Hours' },
              ],
            },
            NEXTKEY: '4',
          },
        },
        {
          notFound: false,
          data: {
            TIMESPECGROUPS: { TIMESPECGROUP: { TIMESPECGROUPKEY: '28', NAME: 'GRAND OPENING' } },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const result = await fetchTimeSpecGroupNames(client);

    const groupCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS);
    expect(groupCalls).toHaveLength(2); // proves the multi-page walk actually followed NEXTKEY
    expect(result).toEqual(
      new Map([
        ['1', 'Always'],
        ['4', 'Business Hours'],
        ['28', 'GRAND OPENING'],
      ])
    );
  });

  it('never issues a singular GetTimeSpecGroup call -- only the paginated GetTimeSpecGroups list', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
        { notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: { TIMESPECGROUPKEY: '1', NAME: 'Always' } }, NEXTKEY: '-1' } },
      ],
    });

    await fetchTimeSpecGroupNames(client);

    expect(calls.every((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS)).toBe(true);
    expect(calls.some((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUP)).toBe(false);
  });

  it('skips a group whose TIMESPECGROUPKEY normalizes to the empty string rather than adding a bogus map entry', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
        {
          notFound: false,
          data: {
            TIMESPECGROUPS: {
              TIMESPECGROUP: [
                { TIMESPECGROUPKEY: '', NAME: 'malformed' },
                { TIMESPECGROUPKEY: '9', NAME: 'ok' },
              ],
            },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const result = await fetchTimeSpecGroupNames(client);

    expect(result.has('')).toBe(false);
    expect(result).toEqual(new Map([['9', 'ok']]));
  });

  it('treats NOT FOUND as no groups (empty map, no throw)', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [{ notFound: true, data: undefined }],
    });

    const result = await fetchTimeSpecGroupNames(client);

    expect(result.size).toBe(0);
  });

  it('R5: does not throw when the underlying GetTimeSpecGroups call itself throws -- resolves to an empty Map instead', async () => {
    const client = {
      call: async () => {
        throw new Error('transient GetTimeSpecGroups failure');
      },
    } as unknown as NetboxClient;

    const result = await fetchTimeSpecGroupNames(client);

    expect(result).toEqual(new Map());
  });
});
