import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPersonTools } from '../src/tools/person.js';
import { registerAccessLevelTools } from '../src/tools/accessLevel.js';
import { registerPortalTools } from '../src/tools/portal.js';
import { registerEventsTools } from '../src/tools/events.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import type { NetboxClient } from '../src/netboxClient.js';

interface Registration {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

class FakeServer {
  registrations: Registration[] = [];
  tool(name: string, description: string, schema: Record<string, unknown>, handler: Registration['handler']): void {
    this.registrations.push({ name, description, schema, handler });
  }
}

function fakeClient(): { client: NetboxClient; calls: Array<{ command: string; params: unknown }> } {
  const calls: Array<{ command: string; params: unknown }> = [];
  const client = {
    call: async (command: string, params: unknown) => {
      calls.push({ command, params });
      return { notFound: false, data: { ok: true } };
    },
  } as unknown as NetboxClient;
  return { client, calls };
}

function byName(server: FakeServer, name: string): Registration {
  const reg = server.registrations.find((r) => r.name === name);
  if (!reg) throw new Error(`tool not registered: ${name}`);
  return reg;
}

describe('registerPersonTools', () => {
  it('registers exactly get_person, search_person_data, get_card_access_details, get_card_formats', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_card_access_details', 'get_card_formats', 'get_person', 'search_person_data'].sort()
    );
  });

  it('get_person schema matches the Command reference: PERSONID required, ALLPARTITIONS/ACCESSLEVELDETAILS/WANTCREDENTIALID optional', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_person');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['PERSONID', 'ALLPARTITIONS', 'ACCESSLEVELDETAILS', 'WANTCREDENTIALID'].sort()
    );
  });

  it('get_person calls GetPerson with the given PERSONID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
    await byName(server, 'get_person').handler({ PERSONID: '42' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PERSON, params: { PERSONID: '42' } }]);
  });

  it('search_person_data schema includes every documented filter field, including UDF1-UDF20', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
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
      'extraParams',
    ];
    for (const field of expectedNonUdf) {
      expect(keys).toContain(field);
    }
    for (let i = 1; i <= 20; i++) {
      expect(keys).toContain(`UDF${i}`);
    }
    // No invented fields beyond the documented set + the extraParams passthrough.
    expect(keys.sort()).toEqual([...expectedNonUdf, ...Array.from({ length: 20 }, (_, i) => `UDF${i + 1}`)].sort());
  });

  it('search_person_data merges named fields and extraParams', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
    await byName(server, 'search_person_data').handler({
      FIRSTNAME: 'Jane',
      LASTNAME: undefined,
      PERSONID: undefined,
      extraParams: { DEPARTMENT: 'IT' },
    });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.SEARCH_PERSON_DATA, params: { FIRSTNAME: 'Jane', DEPARTMENT: 'IT' } },
    ]);
  });

  it('get_card_access_details schema requires ENCODEDNUM + CARDFORMAT, not PERSONID', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_card_access_details');
    expect(Object.keys(reg.schema).sort()).toEqual(['CARDFORMAT', 'ENCODEDNUM', 'MAXRECORDS', 'OLDESTDTTM'].sort());
    expect(Object.keys(reg.schema)).not.toContain('PERSONID');
  });

  it('get_card_access_details calls GetCardAccessDetails with ENCODEDNUM and CARDFORMAT', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
    await byName(server, 'get_card_access_details').handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
    ]);
  });
});

describe('registerAccessLevelTools', () => {
  it('registers exactly the four access-level tools', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_access_level', 'get_access_level_group', 'get_access_level_groups', 'get_access_levels'].sort()
    );
  });

  it('get_access_level requires ACCESSLEVELKEY, not ACCESSLEVELID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_access_level');
    expect(Object.keys(reg.schema)).toEqual(['ACCESSLEVELKEY']);
    await reg.handler({ ACCESSLEVELKEY: '7' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL, params: { ACCESSLEVELKEY: '7' } }]);
  });

  it('get_access_levels takes STARTFROMKEY/STARTFROMNAME/WANTKEY and calls GetAccessLevels', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_access_levels');
    expect(Object.keys(reg.schema).sort()).toEqual(['STARTFROMKEY', 'STARTFROMNAME', 'WANTKEY'].sort());
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVELS, params: {} }]);
  });

  it('get_access_level_group calls GetAccessLevelGroup with ACCESSLEVELGROUPKEY, not ACCESSLEVELGROUPID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_access_level_group');
    expect(Object.keys(reg.schema)).toEqual(['ACCESSLEVELGROUPKEY']);
    await reg.handler({ ACCESSLEVELGROUPKEY: '9' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP, params: { ACCESSLEVELGROUPKEY: '9' } }]);
  });

  it('get_access_level_groups takes only STARTFROMKEY', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_access_level_groups');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUPS, params: {} }]);
  });
});

describe('registerPortalTools', () => {
  it('registers exactly get_portals, get_reader, get_readers — no get_portal (singular)', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(['get_portals', 'get_reader', 'get_readers'].sort());
    expect(server.registrations.map((r) => r.name)).not.toContain('get_portal');
  });

  it('get_portals takes only STARTFROMKEY (no single-portal filter) and calls GetPortals', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_portals');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    await reg.handler({ STARTFROMKEY: 'abc' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: 'abc' } }]);
  });

  it('get_reader requires READERKEY, not READERID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_reader');
    expect(Object.keys(reg.schema)).toEqual(['READERKEY']);
    await reg.handler({ READERKEY: '3' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_READER, params: { READERKEY: '3' } }]);
  });

  it('get_readers takes only STARTFROMKEY — no PORTALID filter exists on GetReaders', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_readers');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    expect(Object.keys(reg.schema)).not.toContain('PORTALID');
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_READERS, params: {} }]);
  });
});

describe('registerEventsTools', () => {
  it('registers exactly get_event_history, list_events, get_access_history', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_access_history', 'get_event_history', 'list_events'].sort()
    );
  });

  it('get_event_history uses EVENTNAME/STARTDTTM/ENDDTTM/NEXTKEY, not STARTTIME/ENDTIME/PERSONID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_event_history');
    expect(Object.keys(reg.schema).sort()).toEqual(['EVENTNAME', 'STARTDTTM', 'ENDDTTM', 'NEXTKEY', 'extraParams'].sort());
    expect(Object.keys(reg.schema)).not.toContain('STARTTIME');
    expect(Object.keys(reg.schema)).not.toContain('ENDTIME');
    expect(Object.keys(reg.schema)).not.toContain('PERSONID');

    await reg.handler({
      EVENTNAME: undefined,
      STARTDTTM: '2026-09-01T00:00:00',
      ENDDTTM: '2026-09-14T00:00:00',
      NEXTKEY: undefined,
      extraParams: undefined,
    });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.GET_EVENT_HISTORY,
        params: { STARTDTTM: '2026-09-01T00:00:00', ENDDTTM: '2026-09-14T00:00:00' },
      },
    ]);
  });

  it('list_events takes no parameters and calls ListEvents', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client);
    const reg = byName(server, 'list_events');
    expect(Object.keys(reg.schema)).toEqual([]);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.LIST_EVENTS, params: {} }]);
  });

  it('get_access_history uses the documented log/card/date filters, not STARTTIME/ENDTIME/PERSONID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_access_history');
    expect(Object.keys(reg.schema).sort()).toEqual(
      [
        'STARTLOGID',
        'AFTERLOGID',
        'ORDER',
        'MAXRECORDS',
        'ENCODEDNUM',
        'HOTSTAMP',
        'CARDFORMAT',
        'OLDESTDTTM',
        'NEWESTDTTM',
        'extraParams',
      ].sort()
    );
    expect(Object.keys(reg.schema)).not.toContain('STARTTIME');
    expect(Object.keys(reg.schema)).not.toContain('ENDTIME');
    expect(Object.keys(reg.schema)).not.toContain('PERSONID');

    await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26', extraParams: undefined });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_ACCESS_HISTORY, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
    ]);
  });
});
