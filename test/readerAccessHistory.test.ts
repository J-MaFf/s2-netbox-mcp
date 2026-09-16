import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchReaderAccessHistory, getReaderAccessHistory, MAX_ACCESS_HISTORY_PAGES } from '../src/readerAccessHistory.js';
import { registerEventsTools } from '../src/tools/events.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';

/** A fake client that serves the given pages per command, in order, and records every call. */
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

/** A discovery-call response (`MAXRECORDS: '1'`, no `AFTERLOGID`): a single record carrying `maxLogid`. */
function discoveryPage(maxLogid: number): NbapiCallResult {
  return { notFound: false, data: { ACCESSES: { ACCESS: [record({ LOGID: String(maxLogid) })] }, NEXTLOGID: String(maxLogid + 1) } };
}

function accessPage(records: Array<Record<string, string>>, nextLogId: string): NbapiCallResult {
  return { notFound: false, data: { ACCESSES: { ACCESS: records }, NEXTLOGID: nextLogId } };
}

function record(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    LOGID: '1',
    PERSONID: '00208',
    READER: '02OF01B READER',
    READERKEY: '190',
    PORTALKEY: '57',
    PORTALNAME: '02OF01B',
    DTTM: '2026-09-15 19:26:42',
    NODEDTTM: '2026-09-15 19:26:42',
    TYPE: '1',
    REASON: '',
    ...overrides,
  };
}

/** A full page of `count` records (the module's fixed page size is 200), all
 * for `readerKey`, with distinct LOGIDs starting at `startLogId`. */
function fullPage(count: number, startLogId: number, readerKey: string): Array<Record<string, string>> {
  return Array.from({ length: count }, (_, i) => record({ LOGID: String(startLogId + i), READERKEY: readerKey }));
}

describe('fetchReaderAccessHistory', () => {
  it('R1: discovers maxLogid via a MAXRECORDS:1 call with no AFTERLOGID, then seeds the walk at maxLogid - scanWindow', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(50000),
        accessPage([record({ LOGID: '48001', READERKEY: '190' })], '48002'), // short page: stops immediately
      ],
    });

    await fetchReaderAccessHistory(client, '190', { scanWindow: 2000 });

    expect(calls).toHaveLength(2);
    expect(calls[0].params).toEqual({ MAXRECORDS: '1' });
    expect((calls[1].params as Record<string, unknown>).AFTERLOGID).toBe(String(50000 - 2000));
  });

  it('R2a: stops once cumulative scanned records reach scanWindow exactly at a page boundary, with no further call', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage(fullPage(200, 1, '190'), '201'),
        accessPage(fullPage(200, 201, '190'), '401'), // cumulative scanned = 400 = scanWindow, boundary hit exactly
      ],
    });

    // maxMatches set well above the 400 records this scan will find, so only
    // the scanWindow stop condition (a) is exercised here.
    const result = await fetchReaderAccessHistory(client, '190', { scanWindow: 400, maxMatches: 100000 });

    expect(calls).toHaveLength(3); // discovery + exactly 2 walk calls, no third
    expect(result).toHaveLength(400);
  });

  it('R2b: stops once a page returns fewer records than MAXRECORDS, with no further call', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage([record({ READERKEY: '190' })], '2')],
    });

    const result = await fetchReaderAccessHistory(client, '190', { scanWindow: 2000 });

    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(1);
  });

  it('R2b: stops on an empty page', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage([], '2')],
    });

    const result = await fetchReaderAccessHistory(client, '190', { scanWindow: 2000 });

    expect(calls).toHaveLength(2);
    expect(result).toEqual([]);
  });

  it('R2c: stops early once matches reach maxMatches, without exhausting scanWindow', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage(fullPage(200, 1, '190'), '201'), // 200 matches found >= maxMatches(5); scanWindow(2000) far from exhausted
        accessPage(fullPage(200, 201, '190'), '401'), // must never be requested
      ],
    });

    const result = await fetchReaderAccessHistory(client, '190', { scanWindow: 2000, maxMatches: 5 });

    expect(calls).toHaveLength(2); // discovery + exactly one walk call
    expect(result.length).toBeGreaterThanOrEqual(5);
  });

  it(`R3: throws naming the ${MAX_ACCESS_HISTORY_PAGES}-page cap when every page is full and none of the other stop conditions trigger`, async () => {
    let requests = 0;
    const client = {
      call: async (command: string, params: unknown) => {
        if ((params as Record<string, unknown>).AFTERLOGID === undefined) {
          return discoveryPage(1_000_000); // discovery call, not counted toward the walk cap
        }
        requests += 1;
        // Every page is full and never matches the requested reader, so
        // neither the scanWindow nor the matches-found stop conditions ever
        // trigger — only R3's page cap should end the loop.
        return accessPage(
          Array.from({ length: 200 }, (_, i) => record({ LOGID: String(requests * 1000 + i), READERKEY: 'not-190' })),
          String(requests * 1000 + 200)
        );
      },
    } as unknown as NetboxClient;

    await expect(fetchReaderAccessHistory(client, '190', { scanWindow: 1_000_000, maxMatches: 100 })).rejects.toThrow(
      `${NBAPI_COMMANDS.GET_ACCESS_HISTORY} was still returning pages after ${MAX_ACCESS_HISTORY_PAGES} requests`
    );
    expect(requests).toBe(MAX_ACCESS_HISTORY_PAGES);
  });

  it('R4: keeps only records whose READERKEY exactly matches the requested key', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage(
          [
            record({ LOGID: '1', READERKEY: '190' }),
            record({ LOGID: '2', READERKEY: '191' }),
            record({ LOGID: '3', READERKEY: '190' }),
            record({ LOGID: '4', READERKEY: '1900' }), // string-inequal, must not match '190'
          ],
          '5'
        ),
      ],
    });

    const result = await fetchReaderAccessHistory(client, '190', { scanWindow: 2000 });

    expect(result.map((r) => r.LOGID)).toEqual(['1', '3']);
  });

  it('R5: defaults scanWindow to 2000 when omitted', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(50000),
        accessPage([record({ LOGID: '48001', READERKEY: '190' })], '48002'),
      ],
    });

    await fetchReaderAccessHistory(client, '190', {});

    expect((calls[1].params as Record<string, unknown>).AFTERLOGID).toBe(String(50000 - 2000));
  });

  it('R5: uses an explicit scanWindow instead of the default', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(50000),
        accessPage([record({ LOGID: '48001', READERKEY: '190' })], '48002'),
      ],
    });

    await fetchReaderAccessHistory(client, '190', { scanWindow: 500 });

    expect((calls[1].params as Record<string, unknown>).AFTERLOGID).toBe(String(50000 - 500));
  });

  it('R6: clamps seedLogid to 0 (AFTERLOGID "0") when maxLogid is smaller than scanWindow, and completes without error', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(50), // maxLogid (50) < scanWindow (2000)
        accessPage([record({ LOGID: '1', READERKEY: '190' })], '2'),
      ],
    });

    const result = await fetchReaderAccessHistory(client, '190', { scanWindow: 2000 });

    expect((calls[1].params as Record<string, unknown>).AFTERLOGID).toBe('0');
    expect(result).toHaveLength(1);
  });
});

describe('getReaderAccessHistory', () => {
  it('carries PORTALNAME through on every match, matching the native field GetAccessHistory already returns', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage([record({ LOGID: '1', READERKEY: '190', PORTALKEY: '57', PORTALNAME: '02OF01B' })], '2'),
      ],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    expect(result.matches).toEqual([expect.objectContaining({ PORTALKEY: '57', PORTALNAME: '02OF01B' })]);
  });

  it('R7: calls GetPerson exactly once per distinct PERSONID and attaches names to every matching record', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage(
          [
            record({ LOGID: '1', READERKEY: '190', PERSONID: '00208' }),
            record({ LOGID: '2', READERKEY: '190', PERSONID: '00208' }),
          ],
          '3'
        ),
      ],
      [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    const personCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON);
    expect(personCalls).toHaveLength(1);
    expect(result.matches).toEqual([
      expect.objectContaining({ LOGID: '1', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' }),
      expect.objectContaining({ LOGID: '2', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' }),
    ]);
  });

  it('R7: a GetPerson failure for one PERSONID leaves that record\'s name empty without failing the call or affecting others', async () => {
    // Operator-style PERSONIDs (e.g. '_5') may not resolve via GetPerson (see spec Context) —
    // scripted here as a thrown NbapiFailError, distinct from '00208' which resolves normally.
    const client = {
      call: async (command: string, params: unknown) => {
        if (command === NBAPI_COMMANDS.GET_ACCESS_HISTORY) {
          if ((params as Record<string, unknown>).AFTERLOGID === undefined) return discoveryPage(1000);
          return accessPage(
            [
              record({ LOGID: '1', READERKEY: '190', PERSONID: '_5' }),
              record({ LOGID: '2', READERKEY: '190', PERSONID: '00208' }),
            ],
            '3'
          );
        }
        if (command === NBAPI_COMMANDS.GET_PERSON) {
          const personId = (params as Record<string, unknown>).PERSONID;
          if (personId === '_5') throw new NbapiFailError('NOT FOUND');
          return { notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } };
        }
        throw new Error(`unexpected command ${command}`);
      },
    } as unknown as NetboxClient;

    const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    expect(result.matches).toEqual([
      expect.objectContaining({ LOGID: '1', PERSONID: '_5', FIRSTNAME: '', LASTNAME: '' }),
      expect.objectContaining({ LOGID: '2', PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' }),
    ]);
  });

  it('R7: a GetPerson not-found-shaped result also yields empty names without failing the call', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage([record({ LOGID: '1', READERKEY: '190', PERSONID: '_10' })], '2'),
      ],
      [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: true, data: undefined }],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    expect(result.matches).toEqual([expect.objectContaining({ LOGID: '1', FIRSTNAME: '', LASTNAME: '' })]);
  });

  it('R8: truncates to MAXMATCHES in chronological order and sets truncated: true', async () => {
    const records = Array.from({ length: 5 }, (_, i) => record({ LOGID: String(i + 1), READERKEY: '190', PERSONID: '00208' }));
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage(records, '6')],
      [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', MAXMATCHES: '3', RESOLVEDESCRIPTIONS: false });

    expect(result.truncated).toBe(true);
    expect(result.matches.map((m) => m.LOGID)).toEqual(['1', '2', '3']);
  });

  it('R8: truncated: false and every match present when the count is within MAXMATCHES', async () => {
    const records = [record({ LOGID: '1', READERKEY: '190', PERSONID: '00208' }), record({ LOGID: '2', READERKEY: '190', PERSONID: '00208' })];
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage(records, '3')],
      [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', MAXMATCHES: '100', RESOLVEDESCRIPTIONS: false });

    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(2);
  });

  it('R7 (refactor): a returned match includes non-undefined FULLNAME and NOTES keys via the shared enrichWithPersonNames helper', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage([record({ LOGID: '1', READERKEY: '190', PERSONID: '00208' })], '2'),
      ],
      [NBAPI_COMMANDS.GET_PERSON]: [
        { notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', NOTES: 'VIP' } },
      ],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(match.FULLNAME).not.toBeUndefined();
    expect(match.NOTES).not.toBeUndefined();
    expect(match.FULLNAME).toBe('Joey Maffiola');
    expect(match.NOTES).toBe('VIP');
    // FIRSTNAME/LASTNAME keep their existing meaning — no field removed or renamed.
    expect(match.FIRSTNAME).toBe('Joey');
    expect(match.LASTNAME).toBe('Maffiola');
  });

  it('R8: defaults MAXMATCHES to 100 when omitted', async () => {
    const records = Array.from({ length: 3 }, (_, i) => record({ LOGID: String(i + 1), READERKEY: '190', PERSONID: '00208' }));
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage(records, '4')],
      [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(3);
  });

  it('R5/R8: defaults SCANWINDOW to 2000 and reports it on the result when omitted', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(50000),
        accessPage([record({ LOGID: '48001', READERKEY: '190' })], '48002'),
      ],
    });

    const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    expect(result.scanWindow).toBe(2000);
  });

  describe('R4: RESOLVEDESCRIPTIONS (spec: get-access-history-resolve-descriptions)', () => {
    it('RESOLVEDESCRIPTIONS omitted defaults to true: fetches GetReaders once and attaches a single top-level READERDESCRIPTION, not one per match', async () => {
      const { client, calls } = scriptedClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
          discoveryPage(1000),
          accessPage(
            [
              record({ LOGID: '1', READERKEY: '190', PERSONID: '00208' }),
              record({ LOGID: '2', READERKEY: '190', PERSONID: '00208' }),
            ],
            '3'
          ),
        ],
        [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
        [NBAPI_COMMANDS.GET_READERS]: [
          {
            notFound: false,
            data: { READERS: { READER: { READERKEY: '190', NAME: 'R190', DESCRIPTION: 'HALLWAY TO ROUND BED AREA' } }, NEXTKEY: '-1' },
          },
        ],
      });

      const result = await getReaderAccessHistory(client, { READERKEY: '190' });

      const readerCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS);
      expect(readerCalls).toHaveLength(1);
      expect(result.READERDESCRIPTION).toBe('HALLWAY TO ROUND BED AREA');
      expect(result.matches).toHaveLength(2);
      for (const match of result.matches) {
        expect(match).not.toHaveProperty('READERDESCRIPTION');
      }
    });

    it('RESOLVEDESCRIPTIONS: true (explicit) behaves the same as omitted', async () => {
      const { client, calls } = scriptedClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage([record({ LOGID: '1', READERKEY: '190' })], '2')],
        [NBAPI_COMMANDS.GET_READERS]: [
          { notFound: false, data: { READERS: { READER: { READERKEY: '190', DESCRIPTION: 'HALLWAY' } }, NEXTKEY: '-1' } },
        ],
      });

      const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: true });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toHaveLength(1);
      expect(result.READERDESCRIPTION).toBe('HALLWAY');
    });

    it('RESOLVEDESCRIPTIONS: false omits the top-level field entirely (not present at all, not merely empty) and makes zero GetReaders calls', async () => {
      const { client, calls } = scriptedClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage([record({ LOGID: '1', READERKEY: '190' })], '2')],
      });

      const result = await getReaderAccessHistory(client, { READERKEY: '190', RESOLVEDESCRIPTIONS: false });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toHaveLength(0);
      expect('READERDESCRIPTION' in result).toBe(false);
    });

    it("READERDESCRIPTION is '' when the requested READERKEY has no match among fetched readers", async () => {
      const { client } = scriptedClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage([], '1')],
        [NBAPI_COMMANDS.GET_READERS]: [{ notFound: false, data: { READERS: '', NEXTKEY: '-1' } }],
      });

      const result = await getReaderAccessHistory(client, { READERKEY: '190' });

      expect(result.READERDESCRIPTION).toBe('');
    });
  });
});

describe('get_reader_access_history tool registration (R8/R9)', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

  function registerGetReaderAccessHistory(client: NetboxClient): { schema: Record<string, unknown>; description: string; handler: Handler } {
    let registered: { schema: Record<string, unknown>; description: string; handler: Handler } | undefined;
    const server = {
      tool: (name: string, description: string, schema: Record<string, unknown>, handler: Handler) => {
        if (name === 'get_reader_access_history') registered = { schema, description, handler };
      },
    };
    registerEventsTools(server as unknown as McpServer, client, { writesEnabled: false, destructiveEnabled: false });
    if (!registered) throw new Error('get_reader_access_history not registered');
    return registered;
  }

  it('R8: is registered unconditionally (not gated by write flags) with READERKEY/SCANWINDOW/MAXMATCHES/RESOLVEDESCRIPTIONS', () => {
    const { client } = scriptedClient({});
    const { schema } = registerGetReaderAccessHistory(client);
    expect(Object.keys(schema).sort()).toEqual(['MAXMATCHES', 'READERKEY', 'RESOLVEDESCRIPTIONS', 'SCANWINDOW'].sort());
  });

  it('R9: description mentions the lack of a server-side filter and the default 2000-record scan window', () => {
    const { client } = scriptedClient({});
    const { description } = registerGetReaderAccessHistory(client);
    const lower = description.toLowerCase();
    expect(lower).toContain('no');
    expect(lower).toContain('filter');
    expect(description).toContain('2000');
  });

  it('R6: description mentions RESOLVEDESCRIPTIONS and its default-true behavior', () => {
    const { client } = scriptedClient({});
    const { description } = registerGetReaderAccessHistory(client);
    expect(description).toContain('RESOLVEDESCRIPTIONS');
    expect(description.toLowerCase()).toContain('true');
  });

  it('returns the composite result as JSON through the tool handler', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage([record({ LOGID: '1', READERKEY: '190', PERSONID: '00208' })], '2'),
      ],
      [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
    });
    const { handler } = registerGetReaderAccessHistory(client);

    const result = await handler({ READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matches).toEqual([expect.objectContaining({ LOGID: '1', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' })]);
    expect(parsed.truncated).toBe(false);
  });

  it('R4: RESOLVEDESCRIPTIONS omitted attaches a top-level READERDESCRIPTION in the JSON result, absent from each match', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
        discoveryPage(1000),
        accessPage([record({ LOGID: '1', READERKEY: '190', PERSONID: '00208' })], '2'),
      ],
      [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
      [NBAPI_COMMANDS.GET_READERS]: [
        { notFound: false, data: { READERS: { READER: { READERKEY: '190', DESCRIPTION: 'HALLWAY TO ROUND BED AREA' } }, NEXTKEY: '-1' } },
      ],
    });
    const { handler } = registerGetReaderAccessHistory(client);

    const result = await handler({ READERKEY: '190' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.READERDESCRIPTION).toBe('HALLWAY TO ROUND BED AREA');
    expect(parsed.matches[0]).not.toHaveProperty('READERDESCRIPTION');
  });

  it('R4: RESOLVEDESCRIPTIONS: false omits READERDESCRIPTION from the JSON result entirely', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [discoveryPage(1000), accessPage([record({ LOGID: '1', READERKEY: '190' })], '2')],
    });
    const { handler } = registerGetReaderAccessHistory(client);

    const result = await handler({ READERKEY: '190', RESOLVEDESCRIPTIONS: false });

    const parsed = JSON.parse(result.content[0].text);
    expect('READERDESCRIPTION' in parsed).toBe(false);
  });

  it("R2b: a failing GetReaders call does not break get_reader_access_history -- the primary matches still return successfully, with top-level READERDESCRIPTION: ''", async () => {
    let accessHistoryCalls = 0;
    const client = {
      call: async (command: string) => {
        if (command === NBAPI_COMMANDS.GET_READERS) {
          throw new Error('transient GetReaders failure');
        }
        if (command === NBAPI_COMMANDS.GET_ACCESS_HISTORY) {
          accessHistoryCalls++;
          return accessHistoryCalls === 1
            ? discoveryPage(1000)
            : accessPage([record({ LOGID: '1', READERKEY: '190', PERSONID: '00208' })], '2');
        }
        if (command === NBAPI_COMMANDS.GET_PERSON) {
          return { notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } };
        }
        throw new Error(`unexpected ${command} call`);
      },
    } as unknown as NetboxClient;
    const { handler } = registerGetReaderAccessHistory(client);

    const result = await handler({ READERKEY: '190' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matches).toEqual([expect.objectContaining({ LOGID: '1', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' })]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.READERDESCRIPTION).toBe('');
  });

  it('surfaces NBAPI failures as tool errors', async () => {
    const client = {
      call: async () => {
        throw new NbapiFailError('NOT PERMITTED');
      },
    } as unknown as NetboxClient;

    const result = await registerGetReaderAccessHistory(client).handler({ READERKEY: '190' });

    expect(result).toEqual({ content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }], isError: true });
  });

  it('R5: an NBAPI failure surfaces the same error text whether RESOLVEDESCRIPTIONS is true or omitted', async () => {
    const client = {
      call: async () => {
        throw new NbapiFailError('NOT PERMITTED');
      },
    } as unknown as NetboxClient;

    const result = await registerGetReaderAccessHistory(client).handler({ READERKEY: '190', RESOLVEDESCRIPTIONS: true });

    expect(result).toEqual({ content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }], isError: true });
  });
});
