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

  it('get_person calls GetPerson with the given PERSONID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client);
    await byName(server, 'get_person').handler({ PERSONID: '42' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PERSON, params: { PERSONID: '42' } }]);
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

  it('get_access_levels (list) takes no parameters and calls GetAccessLevels', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client);
    const reg = byName(server, 'get_access_levels');
    expect(Object.keys(reg.schema)).toEqual([]);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVELS, params: {} }]);
  });

  it('get_access_level_group calls GetAccessLevelGroup with ACCESSLEVELGROUPID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client);
    await byName(server, 'get_access_level_group').handler({ ACCESSLEVELGROUPID: '9' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL_GROUP, params: { ACCESSLEVELGROUPID: '9' } }]);
  });
});

describe('registerPortalTools', () => {
  it('registers exactly the four portal/reader tools', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_portal', 'get_portals', 'get_reader', 'get_readers'].sort()
    );
  });

  it('get_readers passes an optional PORTALID filter through', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client);
    await byName(server, 'get_readers').handler({ PORTALID: '3' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_READERS, params: { PORTALID: '3' } }]);
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

  it('get_event_history passes date-range and person filters through to GetEventHistory', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client);
    await byName(server, 'get_event_history').handler({
      STARTTIME: '2026-09-01T00:00:00',
      ENDTIME: '2026-09-14T00:00:00',
      PERSONID: undefined,
      extraParams: undefined,
    });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.GET_EVENT_HISTORY,
        params: { STARTTIME: '2026-09-01T00:00:00', ENDTIME: '2026-09-14T00:00:00' },
      },
    ]);
  });
});
