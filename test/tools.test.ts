import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPersonTools } from '../src/tools/person.js';
import { registerAccessLevelTools } from '../src/tools/accessLevel.js';
import { registerPortalTools } from '../src/tools/portal.js';
import { registerEventsTools } from '../src/tools/events.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

/** A fake client that serves the given responses per command, in order, and
 * records every call — used for get_access_history's RESOLVENAMES:true
 * tests, which need GetAccessHistory and GetPerson to answer differently
 * within the same test (mirrors test/readerAccessHistory.test.ts's
 * scriptedClient). */
function scriptedEventsClient(pages: Partial<Record<string, NbapiCallResult[]>>) {
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

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerPersonTools', () => {
  it('registers exactly get_person, search_person_data, get_card_access_details, get_card_formats when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_card_access_details', 'get_card_formats', 'get_person', 'search_person_data'].sort()
    );
  });

  it('additionally registers the R16/R17 write tools when writes are on', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      [
        'get_card_access_details',
        'get_card_formats',
        'get_person',
        'search_person_data',
        'add_person',
        'modify_person',
        'remove_person',
        'add_credential',
        'modify_credential',
        'remove_credential',
      ].sort()
    );
  });

  it('get_person schema matches the Command reference: PERSONID required, ALLPARTITIONS/ACCESSLEVELDETAILS/WANTCREDENTIALID optional', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_person');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['PERSONID', 'ALLPARTITIONS', 'ACCESSLEVELDETAILS', 'WANTCREDENTIALID'].sort()
    );
  });

  it('get_person calls GetPerson with the given PERSONID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    await byName(server, 'get_person').handler({ PERSONID: '42' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PERSON, params: { PERSONID: '42' } }]);
  });

  it('search_person_data schema includes every documented filter field, including UDF1-UDF20', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'search_person_data');
    const keys = Object.keys(reg.schema);
    const expectedNonUdf = [
      'PERSONID',
      'LASTNAME',
      'FIRSTNAME',
      'MIDDLENAME',
      'HOTSTAMP',
      'WANTCREDENTIALID',
      'ACCESSLEVEL',
      'OLDESTLASTMOD',
      'NEWESTLASTMOD',
      'DELETED',
      'ALLPARTITIONS',
      'CASEINSENSITIVE',
      'WILDCARDSEARCH',
      'ACCESSLEVELDETAILS',
      'RAWCARDNUMBER',
    ];
    for (const field of expectedNonUdf) {
      expect(keys).toContain(field);
    }
    for (let i = 1; i <= 20; i++) {
      expect(keys).toContain(`UDF${i}`);
    }
    expect(keys.sort()).toEqual([...expectedNonUdf, ...Array.from({ length: 20 }, (_, i) => `UDF${i + 1}`)].sort());
  });

  it('search_person_data merges named fields, dropping undefined ones', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    await byName(server, 'search_person_data').handler({
      FIRSTNAME: 'Jane',
      LASTNAME: undefined,
      PERSONID: undefined,
    });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.SEARCH_PERSON_DATA, params: { FIRSTNAME: 'Jane' } }]);
  });

  it('get_card_access_details schema requires ENCODEDNUM + CARDFORMAT, not PERSONID', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_card_access_details');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['CARDFORMAT', 'ENCODEDNUM', 'MAXRECORDS', 'OLDESTDTTM', 'RESOLVENAMES', 'RESOLVEDESCRIPTIONS'].sort()
    );
    expect(Object.keys(reg.schema)).not.toContain('PERSONID');
  });

  it('get_card_access_details calls GetCardAccessDetails with ENCODEDNUM and CARDFORMAT', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    // RESOLVEDESCRIPTIONS: false keeps this test focused on plain param pass-through --
    // its default-true behavior is covered separately below.
    await byName(server, 'get_card_access_details').handler({
      ENCODEDNUM: '0012345',
      CARDFORMAT: 'Standard26',
      RESOLVEDESCRIPTIONS: false,
    });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
    ]);
  });

  describe('get_card_access_details RESOLVENAMES (spec: get-card-access-details-resolve-names)', () => {
    it('R1: schema is exactly CARDFORMAT/ENCODEDNUM/MAXRECORDS/OLDESTDTTM/RESOLVENAMES/RESOLVEDESCRIPTIONS', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');
      expect(Object.keys(reg.schema).sort()).toEqual(
        ['CARDFORMAT', 'ENCODEDNUM', 'MAXRECORDS', 'OLDESTDTTM', 'RESOLVENAMES', 'RESOLVEDESCRIPTIONS'].sort()
      );
    });

    it('R2: RESOLVENAMES omitted (and RESOLVEDESCRIPTIONS explicitly false) makes exactly one GetCardAccessDetails call, no GetPerson call, and returns the plain (unenriched) response', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: { PERSONID: '_41', DISABLED: '0', EXPDATE: 'null', ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] }, NEXTLOGID: '2' },
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', RESOLVEDESCRIPTIONS: false });

      expect(calls).toEqual([
        { command: NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
      ]);
      expect(JSON.parse(result.content[0].text)).toEqual({
        PERSONID: '_41',
        DISABLED: '0',
        EXPDATE: 'null',
        ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] },
        NEXTLOGID: '2',
      });
    });

    it('R2: RESOLVENAMES explicitly false (and RESOLVEDESCRIPTIONS explicitly false) makes exactly one GetCardAccessDetails call, no GetPerson call, and returns the plain (unenriched) response', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: { PERSONID: '_41', DISABLED: '0', EXPDATE: 'null', ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] }, NEXTLOGID: '2' },
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({
        RESOLVENAMES: false,
        RESOLVEDESCRIPTIONS: false,
        ENCODEDNUM: '0012345',
        CARDFORMAT: 'Standard26',
      });

      expect(calls).toEqual([
        { command: NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
      ]);
      expect(JSON.parse(result.content[0].text)).toEqual({
        PERSONID: '_41',
        DISABLED: '0',
        EXPDATE: 'null',
        ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] },
        NEXTLOGID: '2',
      });
    });

    it('R3: RESOLVENAMES true attaches FIRSTNAME/LASTNAME/FULLNAME/NOTES to the TOP LEVEL of the response (not per ACCESS record), with exactly one GetPerson call', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS]: [
          {
            notFound: false,
            data: {
              PERSONID: '_41',
              DISABLED: '0',
              EXPDATE: 'null',
              ACCESSES: {
                ACCESS: [
                  { LOGID: '49809', DTTM: 'd', NODEDTTM: 'n', TYPE: '1', REASON: '', READERKEY: '52', PORTALKEY: '18', PORTALNAME: '02RB06' },
                ],
              },
              NEXTLOGID: '49805',
            },
          },
        ],
        [NBAPI_COMMANDS.GET_PERSON]: [
          { notFound: false, data: { PERSONID: '_41', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', NOTES: 'VIP' } },
        ],
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      // RESOLVEDESCRIPTIONS: false isolates this test to RESOLVENAMES's own
      // enrichment behavior -- their independence/combination is covered
      // separately below.
      const result = await reg.handler({
        ENCODEDNUM: '0012345',
        CARDFORMAT: 'Standard26',
        RESOLVENAMES: true,
        RESOLVEDESCRIPTIONS: false,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        PERSONID: '_41',
        DISABLED: '0',
        EXPDATE: 'null',
        FIRSTNAME: 'Joey',
        LASTNAME: 'Maffiola',
        FULLNAME: 'Joey Maffiola',
        NOTES: 'VIP',
        ACCESSES: {
          ACCESS: [
            { LOGID: '49809', DTTM: 'd', NODEDTTM: 'n', TYPE: '1', REASON: '', READERKEY: '52', PORTALKEY: '18', PORTALNAME: '02RB06' },
          ],
        },
        NEXTLOGID: '49805',
      });
      // Enrichment fields must not have leaked onto the ACCESS record itself.
      expect(parsed.ACCESSES.ACCESS[0]).not.toHaveProperty('FIRSTNAME');
      expect(parsed.ACCESSES.ACCESS[0]).not.toHaveProperty('FULLNAME');

      const personCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON);
      expect(personCalls).toHaveLength(1);
      expect(personCalls[0].params).toEqual({ PERSONID: '_41' });
    });

    it('R4: RESOLVENAMES true with a top-level PERSONID of the empty string makes zero GetPerson calls and sets empty-string enrichment fields', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: { PERSONID: '', DISABLED: '0', EXPDATE: 'null', ACCESSES: { ACCESS: [] }, NEXTLOGID: '2' },
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({
        ENCODEDNUM: '0012345',
        CARDFORMAT: 'Standard26',
        RESOLVENAMES: true,
        RESOLVEDESCRIPTIONS: false,
      });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON)).toHaveLength(0);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PERSONID).toBe('');
      expect(parsed.FIRSTNAME).toBe('');
      expect(parsed.LASTNAME).toBe('');
      expect(parsed.FULLNAME).toBe('');
      expect(parsed.NOTES).toBe('');
    });

    it('R5: RESOLVENAMES true with a notFound GetCardAccessDetails response produces the same standard not-found text as the plain path', async () => {
      const server = new FakeServer();
      const { client } = fakeClient({ notFound: true, data: undefined });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', RESOLVENAMES: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      });
    });

    it('R5: RESOLVENAMES true with a thrown NbapiFailError produces the same standard mapped error text as the plain path', async () => {
      const server = new FakeServer();
      const client = {
        call: async () => {
          throw new NbapiFailError('NOT PERMITTED');
        },
      } as unknown as NetboxClient;
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', RESOLVENAMES: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
    });

    it('R6: a failing GetPerson lookup does not break get_card_access_details -- the call still succeeds, with empty-string enrichment fields', async () => {
      const server = new FakeServer();
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          if (command === NBAPI_COMMANDS.GET_PERSON) {
            throw new Error('transient GetPerson failure');
          }
          return {
            notFound: false,
            data: {
              PERSONID: '_41',
              DISABLED: '0',
              EXPDATE: 'null',
              ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] },
              NEXTLOGID: '2',
            },
          };
        },
      } as unknown as NetboxClient;
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({
        ENCODEDNUM: '0012345',
        CARDFORMAT: 'Standard26',
        RESOLVENAMES: true,
        RESOLVEDESCRIPTIONS: false,
      });

      expect(calls.some((c) => c.command === NBAPI_COMMANDS.GET_PERSON)).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PERSONID).toBe('_41');
      expect(parsed.FIRSTNAME).toBe('');
      expect(parsed.LASTNAME).toBe('');
      expect(parsed.FULLNAME).toBe('');
      expect(parsed.NOTES).toBe('');
    });

    it('R7: description mentions RESOLVENAMES', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      expect(reg.description).toContain('RESOLVENAMES');
    });

    it('RESOLVENAMES and RESOLVEDESCRIPTIONS are independent: RESOLVENAMES true + RESOLVEDESCRIPTIONS false calls GetPerson but never GetReaders', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS]: [
          {
            notFound: false,
            data: { PERSONID: '_41', ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] }, NEXTLOGID: '2' },
          },
        ],
        [NBAPI_COMMANDS.GET_PERSON]: [
          { notFound: false, data: { PERSONID: '_41', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', NOTES: '' } },
        ],
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({
        ENCODEDNUM: '0012345',
        CARDFORMAT: 'Standard26',
        RESOLVENAMES: true,
        RESOLVEDESCRIPTIONS: false,
      });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON)).toHaveLength(1);
      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toHaveLength(0);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.FULLNAME).toBe('Joey Maffiola');
      expect(parsed.ACCESSES.ACCESS[0]).not.toHaveProperty('READERDESCRIPTION');
    });

    it('RESOLVENAMES and RESOLVEDESCRIPTIONS true together enrich the top level with names and each ACCESS record with descriptions', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS]: [
          {
            notFound: false,
            data: { PERSONID: '_41', ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] }, NEXTLOGID: '2' },
          },
        ],
        [NBAPI_COMMANDS.GET_PERSON]: [
          { notFound: false, data: { PERSONID: '_41', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', NOTES: '' } },
        ],
        [NBAPI_COMMANDS.GET_READERS]: [
          { notFound: false, data: { READERS: { READER: { READERKEY: '52', DESCRIPTION: 'HALLWAY' } }, NEXTKEY: '-1' } },
        ],
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({
        ENCODEDNUM: '0012345',
        CARDFORMAT: 'Standard26',
        RESOLVENAMES: true,
        RESOLVEDESCRIPTIONS: true,
      });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON)).toHaveLength(1);
      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.FULLNAME).toBe('Joey Maffiola');
      expect(parsed.ACCESSES.ACCESS[0].READERDESCRIPTION).toBe('HALLWAY');
    });
  });

  describe('get_card_access_details RESOLVEDESCRIPTIONS (spec: get-access-history-resolve-descriptions)', () => {
    it('R3: RESOLVEDESCRIPTIONS omitted defaults to true: GetReaders is fetched once and every ACCESS record gains READERDESCRIPTION, preserving other top-level fields', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS]: [
          {
            notFound: false,
            data: {
              PERSONID: '_41',
              DISABLED: '0',
              EXPDATE: 'null',
              ACCESSES: {
                ACCESS: [
                  { LOGID: '49809', DTTM: 'd', NODEDTTM: 'n', TYPE: '1', REASON: '', READERKEY: '52', PORTALKEY: '18', PORTALNAME: '02RB06' },
                ],
              },
              NEXTLOGID: '49805',
            },
          },
        ],
        [NBAPI_COMMANDS.GET_READERS]: [
          { notFound: false, data: { READERS: { READER: { READERKEY: '52', DESCRIPTION: 'HALLWAY TO ROUND BED AREA' } }, NEXTKEY: '-1' } },
        ],
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' });

      const readerCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS);
      expect(readerCalls).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PERSONID).toBe('_41');
      expect(parsed.DISABLED).toBe('0');
      expect(parsed.NEXTLOGID).toBe('49805');
      expect(parsed.ACCESSES.ACCESS).toEqual([
        {
          LOGID: '49809',
          DTTM: 'd',
          NODEDTTM: 'n',
          TYPE: '1',
          REASON: '',
          READERKEY: '52',
          PORTALKEY: '18',
          PORTALNAME: '02RB06',
          READERDESCRIPTION: 'HALLWAY TO ROUND BED AREA',
        },
      ]);
    });

    it('R3: RESOLVEDESCRIPTIONS: false makes zero GetReaders calls and returns the plain (unenriched) response', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: { PERSONID: '_41', ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '52' }] }, NEXTLOGID: '2' },
      });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', RESOLVEDESCRIPTIONS: false });

      expect(calls).toEqual([
        { command: NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
      ]);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ACCESSES.ACCESS[0]).not.toHaveProperty('READERDESCRIPTION');
    });

    it('R2b: a failing GetReaders call does not break get_card_access_details -- the ACCESS records still return successfully, just without READERDESCRIPTION', async () => {
      const server = new FakeServer();
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          if (command === NBAPI_COMMANDS.GET_READERS) {
            throw new Error('transient GetReaders failure');
          }
          return {
            notFound: false,
            data: {
              PERSONID: '_41',
              ACCESSES: {
                ACCESS: [
                  { LOGID: '49809', DTTM: 'd', NODEDTTM: 'n', TYPE: '1', REASON: '', READERKEY: '52', PORTALKEY: '18', PORTALNAME: '02RB06' },
                ],
              },
              NEXTLOGID: '49805',
            },
          };
        },
      } as unknown as NetboxClient;
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' });

      expect(calls.some((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PERSONID).toBe('_41');
      expect(parsed.ACCESSES.ACCESS).toEqual([
        {
          LOGID: '49809',
          DTTM: 'd',
          NODEDTTM: 'n',
          TYPE: '1',
          REASON: '',
          READERKEY: '52',
          PORTALKEY: '18',
          PORTALNAME: '02RB06',
          READERDESCRIPTION: '',
        },
      ]);
    });

    it('R5: RESOLVEDESCRIPTIONS true with a notFound GetCardAccessDetails response produces the same standard not-found text as RESOLVEDESCRIPTIONS: false would', async () => {
      const server = new FakeServer();
      const { client } = fakeClient({ notFound: true, data: undefined });
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', RESOLVEDESCRIPTIONS: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      });
    });

    it('R5: RESOLVEDESCRIPTIONS true with a thrown NbapiFailError produces the same standard mapped error text as the plain path', async () => {
      const server = new FakeServer();
      const client = {
        call: async () => {
          throw new NbapiFailError('NOT PERMITTED');
        },
      } as unknown as NetboxClient;
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', RESOLVEDESCRIPTIONS: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
    });

    it('R6: description mentions RESOLVEDESCRIPTIONS and its default-true behavior', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_card_access_details');

      expect(reg.description).toContain('RESOLVEDESCRIPTIONS');
      expect(reg.description.toLowerCase()).toContain('true');
    });
  });

  describe('R16: add_person / modify_person / remove_person', () => {
    it('add_person requires LASTNAME and exposes exactly the documented AddPerson fields (no PICTURE*/PARTITIONKEY)', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const keys = Object.keys(byName(server, 'add_person').schema);
      expect(keys).toContain('LASTNAME');
      expect(keys).toContain('ACCESSLEVELS');
      expect(keys).toContain('VEHICLES');
      for (let i = 1; i <= 20; i++) expect(keys).toContain(`UDF${i}`);
      for (const forbidden of ['PICTURE', 'PICTUREEXT', 'PICTUREURL', 'PARTITIONKEY']) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it('add_person schema is exactly the documented AddPerson field set', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const keys = Object.keys(byName(server, 'add_person').schema);
      const nonUdf = [
        'PERSONID',
        'LASTNAME',
        'FIRSTNAME',
        'MIDDLENAME',
        'NOTES',
        'EXPDATE',
        'ACTDATE',
        'PIN',
        'BADGELAYOUT',
        'CONTACTPHONE',
        'CONTACTEMAIL',
        'CONTACTSMSEMAIL',
        'CONTACTLOCATION',
        'OTHERCONTACTNAME',
        'OTHERCONTACTPHONE1',
        'OTHERCONTACTPHONE2',
        'ACCESSLEVELS',
        'VEHICLES',
      ];
      expect(keys.sort()).toEqual([...nonUdf, ...Array.from({ length: 20 }, (_, i) => `UDF${i + 1}`)].sort());
    });

    it('modify_person schema is add_person’s optionals plus PERSONPURGE/DELETED/ALLPARTITIONS', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const keys = Object.keys(byName(server, 'modify_person').schema);
      const nonUdf = [
        'PERSONID',
        'LASTNAME',
        'FIRSTNAME',
        'MIDDLENAME',
        'NOTES',
        'EXPDATE',
        'ACTDATE',
        'PIN',
        'BADGELAYOUT',
        'CONTACTPHONE',
        'CONTACTEMAIL',
        'CONTACTSMSEMAIL',
        'CONTACTLOCATION',
        'OTHERCONTACTNAME',
        'OTHERCONTACTPHONE1',
        'OTHERCONTACTPHONE2',
        'ACCESSLEVELS',
        'VEHICLES',
        'PERSONPURGE',
        'DELETED',
        'ALLPARTITIONS',
      ];
      expect(keys.sort()).toEqual([...nonUdf, ...Array.from({ length: 20 }, (_, i) => `UDF${i + 1}`)].sort());
    });

    it('add_person description starts with WRITE: and carries the AD-sync caution and the replaces warning', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const description = byName(server, 'add_person').description;
      expect(description.startsWith('WRITE:')).toBe(true);
      expect(description).toContain('Active Directory');
      expect(description).toContain('replaces');
    });

    it('add_person sends AddPerson with a flat PARAMS map', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      await byName(server, 'add_person').handler({ LASTNAME: 'Newton', FIRSTNAME: 'Isaac' });
      expect(calls).toEqual([
        { command: NBAPI_COMMANDS.ADD_PERSON, params: { LASTNAME: 'Newton', FIRSTNAME: 'Isaac' } },
      ]);
    });

    it('add_person wraps ACCESSLEVELS (bare-name syntax) as <ACCESSLEVELS><ACCESSLEVEL>...', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      await byName(server, 'add_person').handler({ LASTNAME: 'Newton', ACCESSLEVELS: ['All Doors', 'Lab'] });
      expect(calls[0].params).toMatchObject({ ACCESSLEVELS: { ACCESSLEVEL: ['All Doors', 'Lab'] } });
    });

    it('add_person wraps ACCESSLEVELS (block syntax) and VEHICLES', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      await byName(server, 'add_person').handler({
        LASTNAME: 'Newton',
        ACCESSLEVELS: [{ ACCESSLEVELNAME: 'Lab', DELETE: '0' }],
        VEHICLES: [{ VEHICLEMAKE: 'Honda', VEHICLELICNUM: '123 PGA' }],
      });
      expect(calls[0].params).toMatchObject({
        ACCESSLEVELS: { ACCESSLEVEL: [{ ACCESSLEVELNAME: 'Lab', DELETE: '0' }] },
        VEHICLES: { VEHICLE: [{ VEHICLEMAKE: 'Honda', VEHICLELICNUM: '123 PGA' }] },
      });
    });

    it('add_person rejects mixed ACCESSLEVELS syntaxes without calling the client', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const result = await byName(server, 'add_person').handler({
        LASTNAME: 'Newton',
        ACCESSLEVELS: ['Lab', { ACCESSLEVELNAME: 'All Doors' }],
      });
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    });

    it('modify_person requires PERSONID and refuses DELETED="TRUE" without NETBOX_ENABLE_DESTRUCTIVE, sending nothing', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
      const reg = byName(server, 'modify_person');
      expect(Object.keys(reg.schema)).toContain('PERSONID');
      expect(Object.keys(reg.schema)).toContain('DELETED');
      expect(Object.keys(reg.schema)).toContain('PERSONPURGE');
      const result = await reg.handler({ PERSONID: '1', DELETED: 'TRUE' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('NETBOX_ENABLE_DESTRUCTIVE');
      expect(calls).toEqual([]);
    });

    it('modify_person refuses PERSONPURGE="TRUE" without NETBOX_ENABLE_DESTRUCTIVE, sending nothing', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
      const result = await byName(server, 'modify_person').handler({ PERSONID: '1', PERSONPURGE: 'TRUE' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('NETBOX_ENABLE_DESTRUCTIVE');
      expect(calls).toEqual([]);
    });

    it('modify_person allows DELETED="TRUE" when NETBOX_ENABLE_DESTRUCTIVE is on', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const result = await byName(server, 'modify_person').handler({ PERSONID: '1', DELETED: 'TRUE' });
      expect(result.isError).toBeUndefined();
      expect(calls).toEqual([{ command: NBAPI_COMMANDS.MODIFY_PERSON, params: { PERSONID: '1', DELETED: 'TRUE' } }]);
    });

    it('remove_person is only registered when both gates are on, and is destructive', () => {
      const partial = new FakeServer();
      const { client } = fakeClient();
      registerPersonTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
      expect(partial.registrations.map((r) => r.name)).not.toContain('remove_person');

      const full = new FakeServer();
      registerPersonTools(full as unknown as McpServer, client, WRITES_ON);
      const reg = byName(full, 'remove_person');
      expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
      expect(Object.keys(reg.schema)).toEqual(['PERSONID']);
    });
  });

  describe('R17: add_credential / modify_credential / remove_credential', () => {
    it('add_credential requires PERSONID + CARDFORMAT and rejects a call with neither ENCODEDNUM nor HOTSTAMP', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'add_credential');
      expect(Object.keys(reg.schema).sort()).toEqual(
        ['PERSONID', 'CARDFORMAT', 'ENCODEDNUM', 'HOTSTAMP', 'WANTCREDENTIALID', 'CARDSTATUS', 'CARDEXPDATE'].sort()
      );
      const result = await reg.handler({ PERSONID: '1', CARDFORMAT: 'Standard26' });
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    });

    it('add_credential succeeds with ENCODEDNUM and calls AddCredential', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const result = await byName(server, 'add_credential').handler({
        PERSONID: '1',
        CARDFORMAT: 'Standard26',
        ENCODEDNUM: '0012345',
      });
      expect(result.isError).toBeUndefined();
      expect(calls).toEqual([
        {
          command: NBAPI_COMMANDS.ADD_CREDENTIAL,
          params: { PERSONID: '1', CARDFORMAT: 'Standard26', ENCODEDNUM: '0012345' },
        },
      ]);
    });

    it('modify_credential exposes the documented optionals and rejects a call with both DISABLED and CARDSTATUS', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'modify_credential');
      expect(Object.keys(reg.schema).sort()).toEqual(
        ['PERSONID', 'CARDFORMAT', 'ENCODEDNUM', 'HOTSTAMP', 'CREDENTIALID', 'DISABLED', 'CARDSTATUS', 'CARDEXPDATE'].sort()
      );
      const result = await reg.handler({
        PERSONID: '1',
        DISABLED: '1',
        CARDSTATUS: 'Lost',
      });
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    });

    it('remove_credential (destructive) requires CREDENTIALID or ENCODEDNUM/HOTSTAMP', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'remove_credential');
      expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
      expect(Object.keys(reg.schema).sort()).toEqual(['PERSONID', 'CARDFORMAT', 'ENCODEDNUM', 'HOTSTAMP', 'CREDENTIALID'].sort());
      const rejected = await reg.handler({ PERSONID: '1' });
      expect(rejected.isError).toBe(true);
      expect(calls).toEqual([]);
      const accepted = await reg.handler({ PERSONID: '1', CREDENTIALID: '9' });
      expect(accepted.isError).toBeUndefined();
      expect(calls).toEqual([{ command: NBAPI_COMMANDS.REMOVE_CREDENTIAL, params: { PERSONID: '1', CREDENTIALID: '9' } }]);
    });
  });
});

describe('registerAccessLevelTools', () => {
  it('registers exactly the five read tools when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_access_level', 'get_access_level_group', 'get_access_level_groups', 'get_access_levels', 'get_access_level_names'].sort()
    );
  });

  it('get_access_level requires ACCESSLEVELKEY, not ACCESSLEVELID, and gains RESOLVEGROUPNAMES (R1)', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_access_level');
    expect(Object.keys(reg.schema).sort()).toEqual(['ACCESSLEVELKEY', 'RESOLVEGROUPNAMES'].sort());
    await reg.handler({ ACCESSLEVELKEY: '7' });
    // The default fakeClient's GetAccessLevel response carries no TIMESPECGROUPKEY/READERGROUPKEY, so per R4
    // both axes' fetches are skipped and this is the same single call as before this change.
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL, params: { ACCESSLEVELKEY: '7' } }]);
    expect(reg.description).toContain('RESOLVEGROUPNAMES');
  });

  describe('get_access_level RESOLVEGROUPNAMES (specs/access-level-resolve-group-names.md)', () => {
    it('R2: resolves both TIMESPECGROUPNAME and READERGROUPNAME when RESOLVEGROUPNAMES is omitted (default true), and leaves an unmatched key as an empty string', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_LEVEL]: [
          {
            notFound: false,
            data: {
              ACCESSLEVELNAME: 'Master Door Access',
              ACCESSLEVELDESCRIPTION: '',
              READERGROUPKEY: '22',
              TIMESPECGROUPKEY: '999',
              THREATLEVELGROUPKEY: '',
            },
          },
        ],
        [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
          { notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: { TIMESPECGROUPKEY: '1', NAME: 'Always' } }, NEXTKEY: '-1' } },
        ],
        [NBAPI_COMMANDS.GET_READER_GROUPS]: [
          {
            notFound: false,
            data: {
              READERGROUPS: { READERGROUP: { READERGROUPKEY: '22', NAME: 'Master Door Access - all doors' } },
              NEXTKEY: '-1',
            },
          },
        ],
      });
      const server = new FakeServer();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_level');

      const result = await reg.handler({ ACCESSLEVELKEY: '1' });

      expect(calls.map((c) => c.command)).toEqual([
        NBAPI_COMMANDS.GET_ACCESS_LEVEL,
        NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS,
        NBAPI_COMMANDS.GET_READER_GROUPS,
      ]);
      const parsed = JSON.parse(result.content[0].text);
      // TIMESPECGROUPKEY '999' has no match in the fetched list -> ''.
      expect(parsed.TIMESPECGROUPNAME).toBe('');
      expect(parsed.READERGROUPNAME).toBe('Master Door Access - all doors');
      expect(parsed.READERGROUPKEY).toBe('22');
      expect(parsed.TIMESPECGROUPKEY).toBe('999');
      expect(parsed.THREATLEVELGROUPKEY).toBe('');
    });

    it('R3: RESOLVEGROUPNAMES: false makes exactly one GetAccessLevel call and adds no new keys', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_LEVEL]: [
          {
            notFound: false,
            data: {
              ACCESSLEVELNAME: 'Master Door Access',
              READERGROUPKEY: '22',
              TIMESPECGROUPKEY: '1',
              THREATLEVELGROUPKEY: '',
            },
          },
        ],
      });
      const server = new FakeServer();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_level');

      const result = await reg.handler({ ACCESSLEVELKEY: '1', RESOLVEGROUPNAMES: false });

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL, params: { ACCESSLEVELKEY: '1' } }]);
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed).sort()).toEqual(
        ['ACCESSLEVELNAME', 'READERGROUPKEY', 'TIMESPECGROUPKEY', 'THREATLEVELGROUPKEY'].sort()
      );
      expect(parsed.TIMESPECGROUPNAME).toBeUndefined();
      expect(parsed.READERGROUPNAME).toBeUndefined();
    });

    it('R4: an empty TIMESPECGROUPKEY skips only the GetTimeSpecGroups fetch, leaving READERGROUPNAME correctly resolved', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_LEVEL]: [
          { notFound: false, data: { ACCESSLEVELNAME: 'X', READERGROUPKEY: '22', TIMESPECGROUPKEY: '', THREATLEVELGROUPKEY: '' } },
        ],
        [NBAPI_COMMANDS.GET_READER_GROUPS]: [
          {
            notFound: false,
            data: {
              READERGROUPS: { READERGROUP: { READERGROUPKEY: '22', NAME: 'Master Door Access - all doors' } },
              NEXTKEY: '-1',
            },
          },
        ],
      });
      const server = new FakeServer();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_level');

      const result = await reg.handler({ ACCESSLEVELKEY: '1' });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS)).toHaveLength(0);
      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READER_GROUPS)).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.TIMESPECGROUPNAME).toBe('');
      expect(parsed.READERGROUPNAME).toBe('Master Door Access - all doors');
    });

    it('R5: a thrown GetReaderGroups call does not break the tool call -- READERGROUPNAME resolves to \'\' and TIMESPECGROUPNAME still resolves correctly', async () => {
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          if (command === NBAPI_COMMANDS.GET_ACCESS_LEVEL) {
            return { notFound: false, data: { ACCESSLEVELNAME: 'X', READERGROUPKEY: '22', TIMESPECGROUPKEY: '1', THREATLEVELGROUPKEY: '' } };
          }
          if (command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS) {
            return { notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: { TIMESPECGROUPKEY: '1', NAME: 'Always' } }, NEXTKEY: '-1' } };
          }
          if (command === NBAPI_COMMANDS.GET_READER_GROUPS) {
            throw new Error('transient GetReaderGroups failure');
          }
          throw new Error(`unexpected call: ${command}`);
        },
      } as unknown as NetboxClient;
      const server = new FakeServer();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_level');

      const result = await reg.handler({ ACCESSLEVELKEY: '1' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.TIMESPECGROUPNAME).toBe('Always');
      expect(parsed.READERGROUPNAME).toBe('');
    });

    it('R6: RESOLVEGROUPNAMES true (default) with a notFound GetAccessLevel response produces the same standard not-found text as the plain path, with no enrichment calls', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_LEVEL]: [{ notFound: true, data: undefined }],
      });
      const server = new FakeServer();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_level');

      const result = await reg.handler({ ACCESSLEVELKEY: '999' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      });
      expect(calls).toHaveLength(1);
    });

    it('R6: RESOLVEGROUPNAMES true (default) with a thrown NbapiFailError produces the same standard mapped error text as the plain path, with no enrichment calls', async () => {
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          throw new NbapiFailError('NOT PERMITTED');
        },
      } as unknown as NetboxClient;
      const server = new FakeServer();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_level');

      const result = await reg.handler({ ACCESSLEVELKEY: '1' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
      expect(calls).toHaveLength(1);
    });
  });

  it('get_access_levels takes STARTFROMKEY/STARTFROMNAME/WANTKEY and calls GetAccessLevels', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_access_levels');
    expect(Object.keys(reg.schema).sort()).toEqual(['STARTFROMKEY', 'STARTFROMNAME', 'WANTKEY'].sort());
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVELS, params: {} }]);
  });

  it('get_access_level_group calls GetAccessLevelGroup with ACCESSLEVELGROUPKEY, not ACCESSLEVELGROUPID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_access_level_group');
    expect(Object.keys(reg.schema)).toEqual(['ACCESSLEVELGROUPKEY']);
    await reg.handler({ ACCESSLEVELGROUPKEY: '9' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP, params: { ACCESSLEVELGROUPKEY: '9' } }]);
  });

  it('get_access_level_groups takes only STARTFROMKEY', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_access_level_groups');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS, params: {} }]);
  });

  it('get_access_level_names takes PARTITIONKEY/STARTFROMNAME and calls GetAccessLevelNames', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_access_level_names');
    expect(Object.keys(reg.schema).sort()).toEqual(['PARTITIONKEY', 'STARTFROMNAME'].sort());
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL_NAMES, params: {} }]);
  });

  describe('R15: access level / access level group write tools', () => {
    it('add_access_level requires ACCESSLEVELNAME + TIMESPECGROUPKEY and rejects both READERKEY and READERGROUPKEY', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'add_access_level');
      expect(Object.keys(reg.schema).sort()).toEqual(
        ['ACCESSLEVELNAME', 'TIMESPECGROUPKEY', 'ACCESSLEVELDESCRIPTION', 'READERKEY', 'READERGROUPKEY', 'THREATLEVELGROUPKEY'].sort()
      );
      const result = await reg.handler({
        ACCESSLEVELNAME: 'A',
        TIMESPECGROUPKEY: '1',
        READERKEY: '1',
        READERGROUPKEY: '2',
      });
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    });

    it('modify_access_level requires ACCESSLEVELKEY and TIMESPECGROUPKEY (the controller rejects ModifyAccessLevel without it); everything else optional', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'modify_access_level');
      expect(Object.keys(reg.schema).sort()).toEqual(
        ['ACCESSLEVELKEY', 'ACCESSLEVELNAME', 'ACCESSLEVELDESCRIPTION', 'READERKEY', 'READERGROUPKEY', 'TIMESPECGROUPKEY', 'THREATLEVELGROUPKEY'].sort()
      );
      expect((reg.schema.ACCESSLEVELKEY as { isOptional: () => boolean }).isOptional()).toBe(false);
      expect((reg.schema.TIMESPECGROUPKEY as { isOptional: () => boolean }).isOptional()).toBe(false);
      expect((reg.schema.ACCESSLEVELNAME as { isOptional: () => boolean }).isOptional()).toBe(true);
    });

    it('add_access_level_group requires NAME; DESCRIPTION/PARTITIONKEY/SYSTEMGROUP/ACCESSLEVELS optional', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_ON);
      expect(Object.keys(byName(server, 'add_access_level_group').schema).sort()).toEqual(
        ['NAME', 'DESCRIPTION', 'PARTITIONKEY', 'SYSTEMGROUP', 'ACCESSLEVELS'].sort()
      );
    });

    it('modify_access_level_group requires ACCESSLEVELGROUPKEY; NAME/DESCRIPTION/ACCESSLEVELS optional', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_ON);
      expect(Object.keys(byName(server, 'modify_access_level_group').schema).sort()).toEqual(
        ['ACCESSLEVELGROUPKEY', 'NAME', 'DESCRIPTION', 'ACCESSLEVELS'].sort()
      );
    });

    it('add_access_level_group wraps ACCESSLEVELS as <ACCESSLEVELS><ACCESSLEVEL>...', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_ON);
      await byName(server, 'add_access_level_group').handler({
        NAME: 'G',
        ACCESSLEVELS: [{ NAME: 'All Doors' }, { KEY: '7', PARTITIONKEY: '1' }],
      });
      expect(calls).toEqual([
        {
          command: NBAPI_COMMANDS.ADD_ACCESS_LEVEL_GROUP,
          params: { NAME: 'G', ACCESSLEVELS: { ACCESSLEVEL: [{ NAME: 'All Doors' }, { KEY: '7', PARTITIONKEY: '1' }] } },
        },
      ]);
    });

    it('delete_access_level / delete_access_level_group are destructive-only, each keyed by exactly one field', () => {
      const partial = new FakeServer();
      const { client } = fakeClient();
      registerAccessLevelTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
      expect(partial.registrations.map((r) => r.name)).not.toContain('delete_access_level');
      expect(partial.registrations.map((r) => r.name)).not.toContain('delete_access_level_group');

      const full = new FakeServer();
      registerAccessLevelTools(full as unknown as McpServer, client, WRITES_ON);
      const deleteLevel = byName(full, 'delete_access_level');
      expect(deleteLevel.description.startsWith('DESTRUCTIVE:')).toBe(true);
      expect(Object.keys(deleteLevel.schema)).toEqual(['ACCESSLEVELKEY']);
      const deleteGroup = byName(full, 'delete_access_level_group');
      expect(deleteGroup.description.startsWith('DESTRUCTIVE:')).toBe(true);
      expect(Object.keys(deleteGroup.schema)).toEqual(['ACCESSLEVELGROUPKEY']);
    });
  });
});

describe('registerPortalTools', () => {
  it('registers exactly get_portals, get_reader, get_readers, get_outputs, find_portals — no get_portal (singular)', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['find_portals', 'get_portals', 'get_reader', 'get_readers', 'get_outputs'].sort()
    );
    expect(server.registrations.map((r) => r.name)).not.toContain('get_portal');
  });

  it('get_portals takes only STARTFROMKEY and RESOLVEDESCRIPTIONS (no single-portal filter) and calls GetPortals', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_portals');
    expect(Object.keys(reg.schema).sort()).toEqual(['RESOLVEDESCRIPTIONS', 'STARTFROMKEY'].sort());
    // RESOLVEDESCRIPTIONS: false isolates this test to plain STARTFROMKEY pass-through --
    // the RESOLVEDESCRIPTIONS default-true enrichment path is covered separately below.
    await reg.handler({ STARTFROMKEY: 'abc', RESOLVEDESCRIPTIONS: false });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: 'abc' } }]);
  });

  describe('get_portals RESOLVEDESCRIPTIONS (spec: get-portals-resolve-descriptions)', () => {
    // Synthetic fixture shaped like a live NetBox 6.2.0 GetPortals page: a
    // one-reader portal collapses READERS.READER to a bare object, a
    // two-reader portal keeps it as an array, and one reader (READERKEY '99')
    // has no match in the GetReaders table (an unknown/deleted reader).
    const PORTALS_PAGE = [
      { PORTALKEY: '1', NAME: 'B1OF05A', READERS: { READER: { READERKEY: '1', NAME: 'B1OF05A READER', PORTALORDER: '1' } } },
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
      { PORTALKEY: '2', NAME: 'B1OF05B', READERS: { READER: { READERKEY: '99', NAME: 'UNKNOWN READER', PORTALORDER: '1' } } },
    ];
    const READERS_TABLE = [
      { READERKEY: '1', DESCRIPTION: 'WORKSHOP TO MAINTENANCE OFFICE' },
      { READERKEY: '7', DESCRIPTION: 'HALLWAY TO MAINTENANCE WORKSHOP' },
      { READERKEY: '10', DESCRIPTION: 'MAINTENANCE WORKSHOP TO HALLWAY' },
    ];

    it('R1: schema is exactly STARTFROMKEY and RESOLVEDESCRIPTIONS', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portals');
      expect(Object.keys(reg.schema).sort()).toEqual(['RESOLVEDESCRIPTIONS', 'STARTFROMKEY'].sort());
    });

    it('R2: RESOLVEDESCRIPTIONS omitted defaults to true: GetReaders is fetched once and every nested reader on the page gains DESCRIPTION, every other field unchanged', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_PORTALS]: [{ notFound: false, data: { PORTALS: { PORTAL: PORTALS_PAGE }, NEXTKEY: '-1' } }],
        [NBAPI_COMMANDS.GET_READERS]: [{ notFound: false, data: { READERS: { READER: READERS_TABLE }, NEXTKEY: '-1' } }],
      });
      registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portals');

      const result = await reg.handler({});

      // Three portals / four readers share one page -- exactly one GetReaders
      // fetch proves the fixed-cost full-table fetch, not once per portal/reader.
      const readerCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS);
      expect(readerCalls).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.NEXTKEY).toBe('-1');
      expect(parsed.PORTALS.PORTAL[0]).toMatchObject({
        PORTALKEY: '1',
        NAME: 'B1OF05A',
        READERS: {
          READER: [{ READERKEY: '1', NAME: 'B1OF05A READER', PORTALORDER: '1', DESCRIPTION: 'WORKSHOP TO MAINTENANCE OFFICE' }],
        },
      });
      expect(parsed.PORTALS.PORTAL[1].READERS.READER).toEqual([
        { READERKEY: '7', NAME: 'B1OF09 IN', PORTALORDER: '1', DESCRIPTION: 'HALLWAY TO MAINTENANCE WORKSHOP' },
        { READERKEY: '10', NAME: 'B1OF09 OUT', PORTALORDER: '2', DESCRIPTION: 'MAINTENANCE WORKSHOP TO HALLWAY' },
      ]);
      // Unknown/deleted reader (no GetReaders match) gets an empty DESCRIPTION, not omitted.
      expect(parsed.PORTALS.PORTAL[2].READERS.READER[0]).toMatchObject({ READERKEY: '99', DESCRIPTION: '' });
    });

    it('R3: RESOLVEDESCRIPTIONS: false makes zero GetReaders calls and returns readers exactly as GetPortals provided them (no DESCRIPTION key)', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({ notFound: false, data: { PORTALS: { PORTAL: PORTALS_PAGE }, NEXTKEY: '-1' } });
      registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portals');

      const result = await reg.handler({ STARTFROMKEY: 'abc', RESOLVEDESCRIPTIONS: false });

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: 'abc' } }]);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PORTALS.PORTAL).toEqual(PORTALS_PAGE);
      expect(parsed.PORTALS.PORTAL[0].READERS.READER).not.toHaveProperty('DESCRIPTION');
    });

    it('R4: RESOLVEDESCRIPTIONS true (default) with a notFound GetPortals response produces the same standard not-found text as RESOLVEDESCRIPTIONS: false would', async () => {
      const server = new FakeServer();
      const { client } = fakeClient({ notFound: true, data: undefined });
      registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portals');

      const result = await reg.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      });
    });

    it('R4: RESOLVEDESCRIPTIONS true (default) with a thrown NbapiFailError produces the same standard mapped error text as the plain path', async () => {
      const server = new FakeServer();
      const client = {
        call: async () => {
          throw new NbapiFailError('NOT PERMITTED');
        },
      } as unknown as NetboxClient;
      registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portals');

      const result = await reg.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
    });

    it('R5: description mentions RESOLVEDESCRIPTIONS and its default-true behavior', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portals');

      expect(reg.description).toContain('RESOLVEDESCRIPTIONS');
      expect(reg.description.toLowerCase()).toContain('true');
    });
  });

  it('get_reader requires READERKEY, not READERID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_reader');
    expect(Object.keys(reg.schema)).toEqual(['READERKEY']);
    await reg.handler({ READERKEY: '3' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_READER, params: { READERKEY: '3' } }]);
  });

  it('get_readers takes only STARTFROMKEY — no PORTALID filter exists on GetReaders', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_readers');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    expect(Object.keys(reg.schema)).not.toContain('PORTALID');
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_READERS, params: {} }]);
  });

  it('get_outputs takes only STARTFROMKEY and calls GetOutputs', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_outputs');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_OUTPUTS, params: {} }]);
  });

  describe('R9: portal/output action write tools', () => {
    it('registers lock_portal/unlock_portal/momentary_unlock_portal/dog_on_next_exit_portal/activate_output/deactivate_output only when writes are on', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerPortalTools(server as unknown as McpServer, client, WRITES_ON);
      const names = server.registrations.map((r) => r.name);
      for (const name of [
        'lock_portal',
        'unlock_portal',
        'momentary_unlock_portal',
        'dog_on_next_exit_portal',
        'activate_output',
        'deactivate_output',
      ]) {
        expect(names).toContain(name);
      }
    });

    it.each([
      ['lock_portal', NBAPI_COMMANDS.LOCK_PORTAL, 'PORTALKEY'],
      ['unlock_portal', NBAPI_COMMANDS.UNLOCK_PORTAL, 'PORTALKEY'],
      ['momentary_unlock_portal', NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL, 'PORTALKEY'],
      ['dog_on_next_exit_portal', NBAPI_COMMANDS.DOG_ON_NEXT_EXIT_PORTAL, 'PORTALKEY'],
      ['activate_output', NBAPI_COMMANDS.ACTIVATE_OUTPUT, 'OUTPUTKEY'],
      ['deactivate_output', NBAPI_COMMANDS.DEACTIVATE_OUTPUT, 'OUTPUTKEY'],
    ] as const)('%s requires only %s and calls %s', async (toolName, command, keyField) => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPortalTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, toolName);
      expect(Object.keys(reg.schema)).toEqual([keyField]);
      expect(reg.description.startsWith('WRITE:')).toBe(true);
      await reg.handler({ [keyField]: '99' });
      expect(calls).toEqual([{ command, params: { [keyField]: '99' } }]);
    });
  });
});

describe('registerEventsTools', () => {
  it('registers exactly get_event_history, list_events, get_access_history, get_reader_access_history when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_access_history', 'get_event_history', 'get_reader_access_history', 'list_events'].sort()
    );
  });

  it('get_event_history uses EVENTNAME/STARTDTTM/ENDDTTM/NEXTKEY, not STARTTIME/ENDTIME/PERSONID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_event_history');
    expect(Object.keys(reg.schema).sort()).toEqual(['EVENTNAME', 'STARTDTTM', 'ENDDTTM', 'NEXTKEY'].sort());
    expect(Object.keys(reg.schema)).not.toContain('STARTTIME');
    expect(Object.keys(reg.schema)).not.toContain('ENDTIME');
    expect(Object.keys(reg.schema)).not.toContain('PERSONID');
    expect(Object.keys(reg.schema)).not.toContain('extraParams');

    await reg.handler({
      EVENTNAME: undefined,
      STARTDTTM: '2026-09-01T00:00:00',
      ENDDTTM: '2026-09-14T00:00:00',
      NEXTKEY: undefined,
    });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.GET_EVENT_HISTORY,
        params: { STARTDTTM: '2026-09-01T00:00:00', ENDDTTM: '2026-09-14T00:00:00' },
      },
    ]);
  });

  describe('list_events (spec: list-events-resolve-partition-names)', () => {
    it('R1: schema is exactly RESOLVEPARTITIONNAMES', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');
      expect(Object.keys(reg.schema).sort()).toEqual(['RESOLVEPARTITIONNAMES']);
    });

    it('R2: RESOLVEPARTITIONNAMES omitted (default true) enriches every event with PARTITIONNAME via exactly one GetPartitions call, including an unmatched PARTITIONID resolving to an empty string', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.LIST_EVENTS]: [
          {
            notFound: false,
            data: {
              EVENTS: {
                EVENT: [
                  {
                    ID: '1',
                    NAME: 'Front Lobby Intercom Unlock Event',
                    PARTITIONID: '1',
                    ACTIONS: { ACTION: ['Log Event', 'Unlock Door'] },
                  },
                  {
                    ID: '8',
                    NAME: 'Front Lobby Auto Operator 01OF01A',
                    PARTITIONID: '1',
                    ACTIONS: { ACTION: ['Log Event', 'action 2', 'Action 1'] },
                  },
                  {
                    ID: '9',
                    NAME: 'Event In An Unknown Partition',
                    PARTITIONID: '99',
                    ACTIONS: { ACTION: ['Log Event'] },
                  },
                ],
              },
              NEXTKEY: '-1',
            },
          },
        ],
        [NBAPI_COMMANDS.GET_PARTITIONS]: [
          {
            notFound: false,
            data: {
              PARTITIONS: { PARTITION: { PARTITIONKEY: '1', NAME: 'Master', DESCRIPTION: 'The default partition' } },
              NEXTKEY: '-1',
            },
          },
        ],
      });
      const server = new FakeServer();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');

      const result = await reg.handler({});

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.LIST_EVENTS)).toHaveLength(1);
      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PARTITIONS)).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.EVENTS.EVENT).toEqual([
        {
          ID: '1',
          NAME: 'Front Lobby Intercom Unlock Event',
          PARTITIONID: '1',
          ACTIONS: { ACTION: ['Log Event', 'Unlock Door'] },
          PARTITIONNAME: 'Master',
        },
        {
          ID: '8',
          NAME: 'Front Lobby Auto Operator 01OF01A',
          PARTITIONID: '1',
          ACTIONS: { ACTION: ['Log Event', 'action 2', 'Action 1'] },
          PARTITIONNAME: 'Master',
        },
        {
          ID: '9',
          NAME: 'Event In An Unknown Partition',
          PARTITIONID: '99',
          ACTIONS: { ACTION: ['Log Event'] },
          PARTITIONNAME: '',
        },
      ]);
    });

    it('R2: RESOLVEPARTITIONNAMES explicitly true behaves the same as omitting it', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.LIST_EVENTS]: [
          { notFound: false, data: { EVENTS: { EVENT: [{ ID: '1', NAME: 'X', PARTITIONID: '1' }] } } },
        ],
        [NBAPI_COMMANDS.GET_PARTITIONS]: [
          { notFound: false, data: { PARTITIONS: { PARTITION: { PARTITIONKEY: '1', NAME: 'Master' } } } },
        ],
      });
      const server = new FakeServer();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');

      const result = await reg.handler({ RESOLVEPARTITIONNAMES: true });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PARTITIONS)).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.EVENTS.EVENT).toEqual([{ ID: '1', NAME: 'X', PARTITIONID: '1', PARTITIONNAME: 'Master' }]);
    });

    it('R3: RESOLVEPARTITIONNAMES explicitly false makes zero GetPartitions calls and returns events byte-identical to the pre-change ListEvents pass-through, with no PARTITIONNAME key added', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: {
          EVENTS: {
            EVENT: [
              {
                ID: '1',
                NAME: 'Front Lobby Intercom Unlock Event',
                PARTITIONID: '1',
                ACTIONS: { ACTION: ['Log Event', 'Unlock Door'] },
              },
            ],
          },
        },
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');

      const result = await reg.handler({ RESOLVEPARTITIONNAMES: false });

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.LIST_EVENTS, params: {} }]);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        EVENTS: {
          EVENT: [
            {
              ID: '1',
              NAME: 'Front Lobby Intercom Unlock Event',
              PARTITIONID: '1',
              ACTIONS: { ACTION: ['Log Event', 'Unlock Door'] },
            },
          ],
        },
      });
      expect(parsed.EVENTS.EVENT[0]).not.toHaveProperty('PARTITIONNAME');
    });

    it('R4: RESOLVEPARTITIONNAMES true (default) with a notFound ListEvents response produces the same standard not-found text as RESOLVEPARTITIONNAMES: false would, and never calls GetPartitions', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({ notFound: true, data: undefined });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');

      const result = await reg.handler({});

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.LIST_EVENTS, params: {} }]);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      });
    });

    it('R4: RESOLVEPARTITIONNAMES true (default) with a thrown NbapiFailError produces the same standard mapped error text as the plain path, and never calls GetPartitions', async () => {
      const server = new FakeServer();
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          throw new NbapiFailError('NOT PERMITTED');
        },
      } as unknown as NetboxClient;
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');

      const result = await reg.handler({});

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.LIST_EVENTS, params: {} }]);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
    });

    it("R5: a thrown GetPartitions call does not break the tool call -- every event's PARTITIONNAME resolves to '' with ACTIONS and other fields intact", async () => {
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          if (command === NBAPI_COMMANDS.LIST_EVENTS) {
            return {
              notFound: false,
              data: {
                EVENTS: {
                  EVENT: [
                    {
                      ID: '1',
                      NAME: 'Front Lobby Intercom Unlock Event',
                      PARTITIONID: '1',
                      ACTIONS: { ACTION: ['Log Event', 'Unlock Door'] },
                    },
                  ],
                },
              },
            };
          }
          if (command === NBAPI_COMMANDS.GET_PARTITIONS) {
            throw new Error('transient GetPartitions failure');
          }
          throw new Error(`unexpected call: ${command}`);
        },
      } as unknown as NetboxClient;
      const server = new FakeServer();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');

      const result = await reg.handler({});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.EVENTS.EVENT).toEqual([
        {
          ID: '1',
          NAME: 'Front Lobby Intercom Unlock Event',
          PARTITIONID: '1',
          ACTIONS: { ACTION: ['Log Event', 'Unlock Door'] },
          PARTITIONNAME: '',
        },
      ]);
    });

    it('R6: description mentions RESOLVEPARTITIONNAMES and its default-true behavior', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'list_events');

      expect(reg.description).toContain('RESOLVEPARTITIONNAMES');
      expect(reg.description.toLowerCase()).toContain('true');
    });
  });

  describe('get_access_history (spec: get-access-history-resolve-names)', () => {
    it('R1: schema is exactly AFTERLOGID/CARDFORMAT/ENCODEDNUM/HOTSTAMP/MAXRECORDS/ORDER/RESOLVENAMES/RESOLVEDESCRIPTIONS/STARTLOGID (the removed date-range fields are absent)', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      // An exact key-set equality already proves the removed date-range
      // fields are absent, without needing to spell out their names here --
      // this file also has an unrelated, legitimate date-filter field
      // reference in get_card_access_details' schema test above, for a
      // different NBAPI command this spec does not touch.
      expect(Object.keys(reg.schema).sort()).toEqual(
        [
          'AFTERLOGID',
          'CARDFORMAT',
          'ENCODEDNUM',
          'HOTSTAMP',
          'MAXRECORDS',
          'ORDER',
          'RESOLVENAMES',
          'RESOLVEDESCRIPTIONS',
          'STARTLOGID',
        ].sort()
      );
      expect(Object.keys(reg.schema)).not.toContain('STARTTIME');
      expect(Object.keys(reg.schema)).not.toContain('ENDTIME');
      expect(Object.keys(reg.schema)).not.toContain('PERSONID');
      expect(Object.keys(reg.schema)).not.toContain('extraParams');
    });

    it('R2: RESOLVENAMES omitted (and RESOLVEDESCRIPTIONS explicitly false) makes exactly one GetAccessHistory call, no GetPerson call, and returns the plain (unenriched) response', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: { ACCESSES: { ACCESS: [{ LOGID: '1', PERSONID: '00208' }] }, NEXTLOGID: '2' },
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      // RESOLVEDESCRIPTIONS: false isolates this test to RESOLVENAMES's own
      // plain-path behavior -- its default-true interaction is covered
      // separately below (RESOLVEDESCRIPTIONS spec).
      const result = await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', RESOLVEDESCRIPTIONS: false });

      expect(calls).toEqual([
        { command: NBAPI_COMMANDS.GET_ACCESS_HISTORY, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
      ]);
      expect(JSON.parse(result.content[0].text)).toEqual({
        ACCESSES: { ACCESS: [{ LOGID: '1', PERSONID: '00208' }] },
        NEXTLOGID: '2',
      });
    });

    it('R2: RESOLVENAMES explicitly false makes exactly one GetAccessHistory call, no GetPerson call, and returns the plain (unenriched) response', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: { ACCESSES: { ACCESS: [{ LOGID: '1', PERSONID: '00208' }] }, NEXTLOGID: '2' },
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVENAMES: false, RESOLVEDESCRIPTIONS: false, ENCODEDNUM: '0012345' });

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_HISTORY, params: { ENCODEDNUM: '0012345' } }]);
      expect(JSON.parse(result.content[0].text)).toEqual({
        ACCESSES: { ACCESS: [{ LOGID: '1', PERSONID: '00208' }] },
        NEXTLOGID: '2',
      });
    });

    it('R3: RESOLVENAMES true enriches every ACCESS record while preserving all original fields, leaving NEXTLOGID and the ACCESSES.ACCESS structure otherwise unchanged', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
          {
            notFound: false,
            data: {
              ACCESSES: {
                ACCESS: [
                  {
                    LOGID: '1',
                    PERSONID: '00208',
                    READER: 'R1',
                    READERKEY: '190',
                    PORTALKEY: '57',
                    DTTM: 'd1',
                    NODEDTTM: 'n1',
                    TYPE: '1',
                    REASON: '',
                  },
                  {
                    LOGID: '2',
                    PERSONID: '00209',
                    READER: 'R2',
                    READERKEY: '191',
                    PORTALKEY: '58',
                    DTTM: 'd2',
                    NODEDTTM: 'n2',
                    TYPE: '1',
                    REASON: '',
                  },
                ],
              },
              NEXTLOGID: '3',
            },
          },
        ],
        [NBAPI_COMMANDS.GET_PERSON]: [
          { notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', NOTES: 'VIP' } },
          { notFound: false, data: { PERSONID: '00209', FIRSTNAME: 'Ann', LASTNAME: 'Smith', NOTES: '' } },
        ],
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      // RESOLVEDESCRIPTIONS: false isolates this test to RESOLVENAMES's own
      // enrichment behavior -- their independence/combination is covered
      // separately below (RESOLVEDESCRIPTIONS spec).
      const result = await reg.handler({ RESOLVENAMES: true, RESOLVEDESCRIPTIONS: false });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.NEXTLOGID).toBe('3');
      expect(parsed.ACCESSES.ACCESS).toEqual([
        {
          LOGID: '1',
          PERSONID: '00208',
          READER: 'R1',
          READERKEY: '190',
          PORTALKEY: '57',
          DTTM: 'd1',
          NODEDTTM: 'n1',
          TYPE: '1',
          REASON: '',
          FIRSTNAME: 'Joey',
          LASTNAME: 'Maffiola',
          FULLNAME: 'Joey Maffiola',
          NOTES: 'VIP',
        },
        {
          LOGID: '2',
          PERSONID: '00209',
          READER: 'R2',
          READERKEY: '191',
          PORTALKEY: '58',
          DTTM: 'd2',
          NODEDTTM: 'n2',
          TYPE: '1',
          REASON: '',
          FIRSTNAME: 'Ann',
          LASTNAME: 'Smith',
          FULLNAME: 'Ann Smith',
          NOTES: '',
        },
      ]);

      const personCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON);
      expect(personCalls).toHaveLength(2);
    });

    it('R4: RESOLVENAMES true with a notFound GetAccessHistory response produces the same standard not-found text as the plain path', async () => {
      const server = new FakeServer();
      const { client } = fakeClient({ notFound: true, data: undefined });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVENAMES: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      });
    });

    it('R4: RESOLVENAMES true with a thrown NbapiFailError produces the same standard mapped error text as the plain path', async () => {
      const server = new FakeServer();
      const client = {
        call: async () => {
          throw new NbapiFailError('NOT PERMITTED');
        },
      } as unknown as NetboxClient;
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVENAMES: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
    });

    it('R8: description mentions RESOLVENAMES and GetPerson', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      expect(reg.description).toContain('RESOLVENAMES');
      expect(reg.description).toContain('GetPerson');
    });
  });

  describe('get_access_history RESOLVEDESCRIPTIONS (spec: get-access-history-resolve-descriptions)', () => {
    it('R3: RESOLVEDESCRIPTIONS omitted defaults to true: GetReaders is fetched once and every ACCESS record gains READERDESCRIPTION, leaving other fields untouched', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
          {
            notFound: false,
            data: {
              ACCESSES: {
                ACCESS: [
                  { LOGID: '1', PERSONID: '00208', READER: 'R1', READERKEY: '190', PORTALKEY: '57', DTTM: 'd1', NODEDTTM: 'n1', TYPE: '1', REASON: '' },
                  { LOGID: '2', PERSONID: '00209', READER: 'R2', READERKEY: '190', PORTALKEY: '57', DTTM: 'd2', NODEDTTM: 'n2', TYPE: '1', REASON: '' },
                ],
              },
              NEXTLOGID: '3',
            },
          },
        ],
        [NBAPI_COMMANDS.GET_READERS]: [
          { notFound: false, data: { READERS: { READER: { READERKEY: '190', DESCRIPTION: 'HALLWAY TO ROUND BED AREA' } }, NEXTKEY: '-1' } },
        ],
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({});

      // Two ACCESS records share READERKEY '190' -- exactly one GetReaders
      // fetch proves the fixed-cost full-table fetch, not once per record.
      const readerCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS);
      expect(readerCalls).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.NEXTLOGID).toBe('3');
      expect(parsed.ACCESSES.ACCESS[0]).toMatchObject({ LOGID: '1', READERKEY: '190', READERDESCRIPTION: 'HALLWAY TO ROUND BED AREA' });
      expect(parsed.ACCESSES.ACCESS[1]).toMatchObject({ LOGID: '2', READERKEY: '190', READERDESCRIPTION: 'HALLWAY TO ROUND BED AREA' });
    });

    it('R3: RESOLVEDESCRIPTIONS: false makes zero GetReaders calls and returns the plain (unenriched) response', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient({
        notFound: false,
        data: { ACCESSES: { ACCESS: [{ LOGID: '1', READERKEY: '190' }] }, NEXTLOGID: '2' },
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVEDESCRIPTIONS: false });

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_HISTORY, params: {} }]);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ACCESSES.ACCESS[0]).not.toHaveProperty('READERDESCRIPTION');
    });

    it('R2b: a failing GetReaders call does not break get_access_history -- the ACCESS records still return successfully, just without READERDESCRIPTION', async () => {
      const server = new FakeServer();
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          if (command === NBAPI_COMMANDS.GET_READERS) {
            throw new Error('transient GetReaders failure');
          }
          return {
            notFound: false,
            data: {
              ACCESSES: {
                ACCESS: [
                  { LOGID: '1', PERSONID: '00208', READER: 'R1', READERKEY: '190', PORTALKEY: '57', DTTM: 'd1', NODEDTTM: 'n1', TYPE: '1', REASON: '' },
                ],
              },
              NEXTLOGID: '2',
            },
          };
        },
      } as unknown as NetboxClient;
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({});

      expect(calls.some((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.NEXTLOGID).toBe('2');
      expect(parsed.ACCESSES.ACCESS).toEqual([
        {
          LOGID: '1',
          PERSONID: '00208',
          READER: 'R1',
          READERKEY: '190',
          PORTALKEY: '57',
          DTTM: 'd1',
          NODEDTTM: 'n1',
          TYPE: '1',
          REASON: '',
          READERDESCRIPTION: '',
        },
      ]);
    });

    it('RESOLVENAMES and RESOLVEDESCRIPTIONS are independent: RESOLVENAMES true + RESOLVEDESCRIPTIONS false calls GetPerson but never GetReaders', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
          { notFound: false, data: { ACCESSES: { ACCESS: [{ LOGID: '1', PERSONID: '00208', READERKEY: '190' }] }, NEXTLOGID: '2' } },
        ],
        [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVENAMES: true, RESOLVEDESCRIPTIONS: false });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON)).toHaveLength(1);
      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toHaveLength(0);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ACCESSES.ACCESS[0]).toMatchObject({ FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' });
      expect(parsed.ACCESSES.ACCESS[0]).not.toHaveProperty('READERDESCRIPTION');
    });

    it('RESOLVENAMES and RESOLVEDESCRIPTIONS true together enrich each record with both', async () => {
      const server = new FakeServer();
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_ACCESS_HISTORY]: [
          { notFound: false, data: { ACCESSES: { ACCESS: [{ LOGID: '1', PERSONID: '00208', READERKEY: '190' }] }, NEXTLOGID: '2' } },
        ],
        [NBAPI_COMMANDS.GET_PERSON]: [{ notFound: false, data: { PERSONID: '00208', FIRSTNAME: 'Joey', LASTNAME: 'Maffiola' } }],
        [NBAPI_COMMANDS.GET_READERS]: [
          { notFound: false, data: { READERS: { READER: { READERKEY: '190', DESCRIPTION: 'HALLWAY' } }, NEXTKEY: '-1' } },
        ],
      });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVENAMES: true, RESOLVEDESCRIPTIONS: true });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_PERSON)).toHaveLength(1);
      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_READERS)).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ACCESSES.ACCESS[0]).toMatchObject({ FIRSTNAME: 'Joey', LASTNAME: 'Maffiola', READERDESCRIPTION: 'HALLWAY' });
    });

    it('R5: RESOLVEDESCRIPTIONS true with a notFound GetAccessHistory response produces the same standard not-found text as RESOLVEDESCRIPTIONS: false would', async () => {
      const server = new FakeServer();
      const { client } = fakeClient({ notFound: true, data: undefined });
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVEDESCRIPTIONS: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
      });
    });

    it('R5: RESOLVEDESCRIPTIONS true with a thrown NbapiFailError produces the same standard mapped error text as the plain path', async () => {
      const server = new FakeServer();
      const client = {
        call: async () => {
          throw new NbapiFailError('NOT PERMITTED');
        },
      } as unknown as NetboxClient;
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      const result = await reg.handler({ RESOLVEDESCRIPTIONS: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
    });

    it('R6: description mentions RESOLVEDESCRIPTIONS and its default-true behavior', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_access_history');

      expect(reg.description).toContain('RESOLVEDESCRIPTIONS');
      expect(reg.description.toLowerCase()).toContain('true');
    });
  });

  describe('R19: trigger_event / insert_activity', () => {
    it('trigger_event requires EVENTNAME + EVENTACTION (enum) and calls TriggerEvent', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'trigger_event');
      expect(Object.keys(reg.schema).sort()).toEqual(['EVENTNAME', 'EVENTACTION', 'PARTITIONID'].sort());
      expect(reg.description.toLowerCase()).toContain('unverified');
      await reg.handler({ EVENTNAME: 'Door Alarm', EVENTACTION: 'ACTIVATE' });
      expect(calls).toEqual([
        { command: NBAPI_COMMANDS.TRIGGER_EVENT, params: { EVENTNAME: 'Door Alarm', EVENTACTION: 'ACTIVATE' } },
      ]);
    });

    it('insert_activity rejects both PORTALKEY and ELEVATORKEY given together', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'insert_activity');
      expect(Object.keys(reg.schema).sort()).toEqual(
        [
          'ACTIVITYTYPE',
          'DETAILS',
          'PORTALKEY',
          'ELEVATORKEY',
          'FLOORKEY',
          'READERKEY',
          'PERSONID',
          'CARDFORMAT',
          'ENCODEDNUM',
          'ACTIVITYTEXT',
        ].sort()
      );
      const result = await reg.handler({ ACTIVITYTYPE: 'USERACTIVITY', PORTALKEY: '1', ELEVATORKEY: '2' });
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    });

    it('insert_activity succeeds with just ACTIVITYTYPE', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerEventsTools(server as unknown as McpServer, client, WRITES_ON);
      const result = await byName(server, 'insert_activity').handler({ ACTIVITYTYPE: 'ACCESSGRANTED' });
      expect(result.isError).toBeUndefined();
      expect(calls).toEqual([{ command: NBAPI_COMMANDS.INSERT_ACTIVITY, params: { ACTIVITYTYPE: 'ACCESSGRANTED' } }]);
    });
  });
});
