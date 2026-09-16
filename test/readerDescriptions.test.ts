import { describe, expect, it } from 'vitest';
import { fetchReaderDescriptions, enrichWithReaderDescriptions } from '../src/readerDescriptions.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';

/**
 * Unit tests for the shared reader-description enrichment helper (see
 * specs/archive/get-access-history-resolve-descriptions.md R1/R2) -- used by
 * get_access_history and get_card_access_details's per-record
 * RESOLVEDESCRIPTIONS path, and get_reader_access_history's single
 * top-level READERDESCRIPTION field (see test/readerAccessHistory.test.ts
 * for that call site's own tests).
 */

/** A fake client that serves the given pages per command, in order, and
 * records every call (mirrors test/portalSearch.test.ts's scriptedClient). */
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

interface TestRecord {
  READERKEY: string;
  LOGID: string;
}

function record(readerKey: string, logId: string): TestRecord {
  return { READERKEY: readerKey, LOGID: logId };
}

describe('fetchReaderDescriptions (R1)', () => {
  it('builds a READERKEY -> DESCRIPTION map from a scripted multi-page GetReaders response, one entry per reader', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_READERS]: [
        {
          notFound: false,
          data: {
            READERS: {
              READER: [
                { READERKEY: '1', NAME: 'B1OF05A READER', DESCRIPTION: 'WORKSHOP TO MAINTENANCE OFFICE' },
                { READERKEY: '4', NAME: 'B1OF05B READER', DESCRIPTION: 'BREAKROOM TO MAINTENANCE OFFICE' },
              ],
            },
            NEXTKEY: '4',
          },
        },
        {
          notFound: false,
          data: {
            READERS: { READER: { READERKEY: '7', NAME: 'B1OF09 IN', DESCRIPTION: 'HALLWAY TO MAINTENANCE WORKSHOP' } },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const result = await fetchReaderDescriptions(client);

    const readerCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS);
    expect(readerCalls).toHaveLength(2); // proves the multi-page walk actually followed NEXTKEY
    expect(result).toEqual(
      new Map([
        ['1', 'WORKSHOP TO MAINTENANCE OFFICE'],
        ['4', 'BREAKROOM TO MAINTENANCE OFFICE'],
        ['7', 'HALLWAY TO MAINTENANCE WORKSHOP'],
      ])
    );
  });

  it('skips a reader whose READERKEY normalizes to the empty string rather than adding a bogus map entry', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_READERS]: [
        {
          notFound: false,
          data: {
            READERS: {
              READER: [
                { READERKEY: '', NAME: 'malformed', DESCRIPTION: 'should not appear' },
                { READERKEY: '9', NAME: 'ok', DESCRIPTION: 'fine' },
              ],
            },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const result = await fetchReaderDescriptions(client);

    expect(result.has('')).toBe(false);
    expect(result).toEqual(new Map([['9', 'fine']]));
  });

  it('treats NOT FOUND as no readers (empty map, no throw)', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_READERS]: [{ notFound: true, data: undefined }],
    });

    const result = await fetchReaderDescriptions(client);

    expect(result.size).toBe(0);
  });

  it('R1/R2b: does not throw when the underlying GetReaders call itself throws -- resolves to an empty Map instead', async () => {
    const client = {
      call: async () => {
        throw new Error('transient GetReaders failure');
      },
    } as unknown as NetboxClient;

    const result = await fetchReaderDescriptions(client);

    expect(result).toEqual(new Map());
  });
});

describe('enrichWithReaderDescriptions (R2)', () => {
  it('calls GetReaders exactly once regardless of record count, not once per record (5 records, 2 distinct READERKEYs)', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_READERS]: [
        {
          notFound: false,
          data: {
            READERS: {
              READER: [
                { READERKEY: '190', NAME: 'R190', DESCRIPTION: 'Desc190' },
                { READERKEY: '191', NAME: 'R191', DESCRIPTION: 'Desc191' },
              ],
            },
            NEXTKEY: '-1',
          },
        },
      ],
    });

    const records = [record('190', 'a'), record('191', 'b'), record('190', 'c'), record('190', 'd'), record('191', 'e')];
    const result = await enrichWithReaderDescriptions(client, records);

    const readerCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS);
    expect(readerCalls).toHaveLength(1);
    expect(result).toEqual([
      expect.objectContaining({ LOGID: 'a', READERDESCRIPTION: 'Desc190' }),
      expect.objectContaining({ LOGID: 'b', READERDESCRIPTION: 'Desc191' }),
      expect.objectContaining({ LOGID: 'c', READERDESCRIPTION: 'Desc190' }),
      expect.objectContaining({ LOGID: 'd', READERDESCRIPTION: 'Desc190' }),
      expect.objectContaining({ LOGID: 'e', READERDESCRIPTION: 'Desc191' }),
    ]);
  });

  it("a record whose READERKEY isn't in the fetched set gets READERDESCRIPTION: '' without throwing", async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_READERS]: [
        {
          notFound: false,
          data: { READERS: { READER: { READERKEY: '190', NAME: 'R190', DESCRIPTION: 'Desc190' } }, NEXTKEY: '-1' },
        },
      ],
    });

    const result = await enrichWithReaderDescriptions(client, [record('999', 'a'), record('190', 'b')]);

    expect(result).toEqual([
      expect.objectContaining({ LOGID: 'a', READERKEY: '999', READERDESCRIPTION: '' }),
      expect.objectContaining({ LOGID: 'b', READERKEY: '190', READERDESCRIPTION: 'Desc190' }),
    ]);
  });

  it('preserves every other original field on each record, unchanged', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_READERS]: [
        {
          notFound: false,
          data: { READERS: { READER: { READERKEY: '190', NAME: 'R190', DESCRIPTION: 'Desc190' } }, NEXTKEY: '-1' },
        },
      ],
    });

    const [enriched] = await enrichWithReaderDescriptions(client, [{ READERKEY: '190', LOGID: 'a', PERSONID: '00208' }]);

    expect(enriched).toEqual({ READERKEY: '190', LOGID: 'a', PERSONID: '00208', READERDESCRIPTION: 'Desc190' });
  });

  it('still issues the one fixed-cost GetReaders fetch even when given zero records, and returns an empty array', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_READERS]: [{ notFound: false, data: { READERS: '', NEXTKEY: '-1' } }],
    });

    const result = await enrichWithReaderDescriptions(client, []);

    expect(result).toEqual([]);
    expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toHaveLength(1);
  });
});

describe('enrichWithReaderDescriptions failure isolation (R2b, inherited from fetchReaderDescriptions per R1)', () => {
  it('does not throw when the underlying GetReaders call itself throws -- every record gets READERDESCRIPTION: \'\' instead', async () => {
    const client = {
      call: async () => {
        throw new Error('transient GetReaders failure');
      },
    } as unknown as NetboxClient;

    const result = await enrichWithReaderDescriptions(client, [record('190', 'a'), record('191', 'b')]);

    expect(result).toEqual([
      expect.objectContaining({ LOGID: 'a', READERKEY: '190', READERDESCRIPTION: '' }),
      expect.objectContaining({ LOGID: 'b', READERKEY: '191', READERDESCRIPTION: '' }),
    ]);
  });

  it('does not throw when GetReaders throws and there are zero records -- resolves to an empty array', async () => {
    const client = {
      call: async () => {
        throw new Error('transient GetReaders failure');
      },
    } as unknown as NetboxClient;

    const result = await enrichWithReaderDescriptions(client, []);

    expect(result).toEqual([]);
  });
});
