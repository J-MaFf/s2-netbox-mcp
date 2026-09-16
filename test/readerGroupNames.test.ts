import { describe, expect, it } from 'vitest';
import { fetchReaderGroupNames } from '../src/readerGroupNames.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';

/**
 * Unit tests for the shared reader-group-name enrichment helper (see
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

describe('fetchReaderGroupNames (R2/R5)', () => {
  it('builds a READERGROUPKEY -> NAME map from a scripted multi-page GetReaderGroups response, one entry per group', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_READER_GROUPS]: [
        {
          notFound: false,
          data: {
            READERGROUPS: {
              READERGROUP: [
                { READERGROUPKEY: '22', NAME: 'Master Door Access - all doors' },
                { READERGROUPKEY: '5', NAME: 'Lobby Readers' },
              ],
            },
            NEXTKEY: '5',
          },
        },
        {
          notFound: false,
          data: { READERGROUPS: { READERGROUP: { READERGROUPKEY: '9', NAME: 'Loading Dock' } }, NEXTKEY: '-1' },
        },
      ],
    });

    const result = await fetchReaderGroupNames(client);

    const groupCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READER_GROUPS);
    expect(groupCalls).toHaveLength(2); // proves the multi-page walk actually followed NEXTKEY
    expect(result).toEqual(
      new Map([
        ['22', 'Master Door Access - all doors'],
        ['5', 'Lobby Readers'],
        ['9', 'Loading Dock'],
      ])
    );
  });

  it('never issues a singular GetReaderGroup call -- only the paginated GetReaderGroups list', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_READER_GROUPS]: [
        { notFound: false, data: { READERGROUPS: { READERGROUP: { READERGROUPKEY: '22', NAME: 'X' } }, NEXTKEY: '-1' } },
      ],
    });

    await fetchReaderGroupNames(client);

    expect(calls.every((c) => c.command === NBAPI_COMMANDS.GET_READER_GROUPS)).toBe(true);
    expect(calls.some((c) => c.command === NBAPI_COMMANDS.GET_READER_GROUP)).toBe(false);
  });

  it('skips a group whose READERGROUPKEY normalizes to the empty string rather than adding a bogus map entry', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_READER_GROUPS]: [
        {
          notFound: false,
          data: {
            READERGROUPS: {
              READERGROUP: [
                { READERGROUPKEY: '', NAME: 'malformed' },
                { READERGROUPKEY: '9', NAME: 'ok' },
              ],
            },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const result = await fetchReaderGroupNames(client);

    expect(result.has('')).toBe(false);
    expect(result).toEqual(new Map([['9', 'ok']]));
  });

  it('treats NOT FOUND as no groups (empty map, no throw)', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_READER_GROUPS]: [{ notFound: true, data: undefined }],
    });

    const result = await fetchReaderGroupNames(client);

    expect(result.size).toBe(0);
  });

  it('R5: does not throw when the underlying GetReaderGroups call itself throws -- resolves to an empty Map instead', async () => {
    const client = {
      call: async () => {
        throw new Error('transient GetReaderGroups failure');
      },
    } as unknown as NetboxClient;

    const result = await fetchReaderGroupNames(client);

    expect(result).toEqual(new Map());
  });
});
