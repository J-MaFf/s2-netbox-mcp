import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findPortals, searchPortals, MAX_PAGES } from '../src/portalSearch.js';
import { registerPortalTools } from '../src/tools/portal.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';

// Synthetic fixtures shaped like live NetBox 6.2.0 responses: GetPortals nests
// readers without DESCRIPTION, and a one-child collection parses to a bare
// object rather than an array.
const PORTALS = [
  { PORTALKEY: '1', NAME: 'B1OF05A', READERS: { READER: { READERKEY: '1', NAME: 'B1OF05A READER', PORTALORDER: '1' } } },
  { PORTALKEY: '2', NAME: 'B1OF05B', READERS: { READER: { READERKEY: '4', NAME: 'B1OF05B READER', PORTALORDER: '1' } } },
  {
    PORTALKEY: '3',
    NAME: 'B1OF09',
    READERS: {
      READER: [
        { READERKEY: '7', NAME: 'B1OF09 IN', PORTALORDER: '1' },
        { READERKEY: '10', NAME: 'B1OF09 OUT', PORTALORDER: '2' },
      ],
    },
  },
  // Portal name mistyped with a letter O; its reader carries the intended code.
  { PORTALKEY: '4', NAME: 'B1PKO2A', READERS: { READER: { READERKEY: '13', NAME: 'B1PK02A READER', PORTALORDER: '1' } } },
  { PORTALKEY: '5', NAME: 'North Gate', READERS: { READER: { READERKEY: '16', NAME: 'North Gate READER', PORTALORDER: '1' } } },
];

const READERS = [
  { READERKEY: '1', NAME: 'B1OF05A READER', DESCRIPTION: 'WORKSHOP TO MAINTENANCE OFFICE' },
  { READERKEY: '4', NAME: 'B1OF05B READER', DESCRIPTION: 'BREAKROOM TO MAINTENANCE OFFICE' },
  { READERKEY: '7', NAME: 'B1OF09 IN', DESCRIPTION: 'HALLWAY TO MAINTENANCE WORKSHOP' },
  { READERKEY: '10', NAME: 'B1OF09 OUT', DESCRIPTION: 'MAINTENANCE WORKSHOP TO HALLWAY' },
  { READERKEY: '13', NAME: 'B1PK02A READER', DESCRIPTION: 'HALLWAY TO PACKAGING' },
  { READERKEY: '16', NAME: 'North Gate READER', DESCRIPTION: '' },
];

function names(result: { matches: Array<{ NAME: string }> }): string[] {
  return result.matches.map((portal) => portal.NAME);
}

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

function singlePageClient() {
  return scriptedClient({
    [NBAPI_COMMANDS.GET_PORTALS]: [{ notFound: false, data: { PORTALS: { PORTAL: PORTALS }, NEXTKEY: '-1' } }],
    [NBAPI_COMMANDS.GET_READERS]: [{ notFound: false, data: { READERS: { READER: READERS }, NEXTKEY: '-1' } }],
  });
}

describe('searchPortals', () => {
  it('joins reader descriptions by READERKEY and matches case-insensitively', () => {
    const result = searchPortals(PORTALS, READERS, 'maintenance office');
    expect(names(result)).toEqual(['B1OF05A', 'B1OF05B']);
    expect(result.matches[1].READERS).toEqual([
      { READERKEY: '4', NAME: 'B1OF05B READER', DESCRIPTION: 'BREAKROOM TO MAINTENANCE OFFICE' },
    ]);
    expect(result).toMatchObject({ query: 'maintenance office', portalsSearched: 5, matchCount: 2 });
  });

  it('requires every term, in any order, across the portal name and all of its readers', () => {
    expect(names(searchPortals(PORTALS, READERS, 'office breakroom'))).toEqual(['B1OF05B']);
    expect(names(searchPortals(PORTALS, READERS, 'b1of09 workshop'))).toEqual(['B1OF09']);
    expect(names(searchPortals(PORTALS, READERS, 'maintenance packaging'))).toEqual([]);
  });

  it('keeps every reader of a multi-reader portal', () => {
    const [portal] = searchPortals(PORTALS, READERS, 'B1OF09').matches;
    expect(portal.READERS.map((reader) => reader.DESCRIPTION)).toEqual([
      'HALLWAY TO MAINTENANCE WORKSHOP',
      'MAINTENANCE WORKSHOP TO HALLWAY',
    ]);
  });

  it('matches on reader name when the portal name differs', () => {
    expect(names(searchPortals(PORTALS, READERS, 'B1PK02A'))).toEqual(['B1PKO2A']);
  });

  it('lists portals whose readers have no description', () => {
    expect(searchPortals(PORTALS, READERS, 'gate').portalsWithoutDescriptions).toEqual(['North Gate']);
  });

  it('falls back to the nested reader fields when GetReaders has no entry for a READERKEY', () => {
    const result = searchPortals(PORTALS, [], 'B1OF05A');
    expect(result.matches[0].READERS).toEqual([{ READERKEY: '1', NAME: 'B1OF05A READER', DESCRIPTION: '' }]);
  });
});

describe('findPortals', () => {
  it('follows NEXTKEY across pages until -1, then reads readers', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_PORTALS]: [
        { notFound: false, data: { PORTALS: { PORTAL: PORTALS.slice(0, 3) }, NEXTKEY: '3' } },
        { notFound: false, data: { PORTALS: { PORTAL: PORTALS[3] }, NEXTKEY: '4' } },
        { notFound: false, data: { PORTALS: { PORTAL: PORTALS[4] }, NEXTKEY: '-1' } },
      ],
      [NBAPI_COMMANDS.GET_READERS]: [{ notFound: false, data: { READERS: { READER: READERS }, NEXTKEY: '-1' } }],
    });

    const result = await findPortals(client, 'maintenance');

    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_PORTALS, params: {} },
      { command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: '3' } },
      { command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: '4' } },
      { command: NBAPI_COMMANDS.GET_READERS, params: {} },
    ]);
    expect(result.portalsSearched).toBe(5);
    expect(names(result)).toEqual(['B1OF05A', 'B1OF05B', 'B1OF09']);
  });

  it('treats NOT FOUND and empty collections as no records', async () => {
    const { client } = scriptedClient({
      [NBAPI_COMMANDS.GET_PORTALS]: [{ notFound: true, data: undefined }],
      [NBAPI_COMMANDS.GET_READERS]: [{ notFound: false, data: { READERS: '', NEXTKEY: '-1' } }],
    });
    expect(await findPortals(client, 'anything')).toMatchObject({ portalsSearched: 0, matchCount: 0, matches: [] });
  });

  it('stops when the controller repeats a NEXTKEY or omits it', async () => {
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_PORTALS]: [
        { notFound: false, data: { PORTALS: { PORTAL: PORTALS[0] }, NEXTKEY: '9' } },
        { notFound: false, data: { PORTALS: { PORTAL: PORTALS[1] }, NEXTKEY: '9' } },
      ],
      [NBAPI_COMMANDS.GET_READERS]: [{ notFound: false, data: { READERS: { READER: READERS } } }],
    });
    const result = await findPortals(client, 'office');
    expect(calls).toHaveLength(3);
    expect(result.portalsSearched).toBe(2);
  });

  it(`gives up after ${MAX_PAGES} pages`, async () => {
    let requests = 0;
    const client = {
      call: async () => ({ notFound: false, data: { PORTALS: '', NEXTKEY: String(++requests) } }),
    } as unknown as NetboxClient;
    await expect(findPortals(client, 'office')).rejects.toThrow(`after ${MAX_PAGES} requests`);
    expect(requests).toBe(MAX_PAGES);
  });
});

describe('find_portals tool', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

  function registerFindPortals(client: NetboxClient): { schema: Record<string, unknown>; handler: Handler } {
    let registered: { schema: Record<string, unknown>; handler: Handler } | undefined;
    const server = {
      tool: (name: string, _description: string, schema: Record<string, unknown>, handler: Handler) => {
        if (name === 'find_portals') registered = { schema, handler };
      },
    };
    registerPortalTools(server as unknown as McpServer, client, { writesEnabled: false, destructiveEnabled: false });
    if (!registered) throw new Error('find_portals not registered');
    return registered;
  }

  it('takes a single query field and returns the search result as JSON', async () => {
    const { client } = singlePageClient();
    const { schema, handler } = registerFindPortals(client);
    expect(Object.keys(schema)).toEqual(['query']);

    const result = await handler({ query: 'breakroom' });

    expect(result.isError).toBeUndefined();
    expect(names(JSON.parse(result.content[0].text))).toEqual(['B1OF05B']);
  });

  it('surfaces NBAPI failures as tool errors', async () => {
    const client = {
      call: async () => {
        throw new NbapiFailError('NOT PERMITTED');
      },
    } as unknown as NetboxClient;

    const result = await registerFindPortals(client).handler({ query: 'office' });

    expect(result).toEqual({ content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }], isError: true });
  });
});
