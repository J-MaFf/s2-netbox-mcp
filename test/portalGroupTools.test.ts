import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPortalGroupTools } from '../src/tools/portalGroup.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

/** A fake client that serves the given responses per command, in order, and
 * records every call — used for get_portal_group's RESOLVEGROUPNAMES: true
 * tests, which need GetPortalGroup and GetTimeSpecGroups to answer
 * differently within the same test (mirrors test/tools.test.ts's own
 * scriptedEventsClient, used for get_access_level's identical-shaped
 * RESOLVEGROUPNAMES tests). */
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

describe('registerPortalGroupTools (R8 reads)', () => {
  it('registers exactly get_portal_group and get_portal_groups when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(['get_portal_group', 'get_portal_groups'].sort());
  });

  it('get_portal_group requires PORTALGROUPKEY and gains RESOLVEGROUPNAMES (R1/R7)', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_portal_group');
    expect(Object.keys(reg.schema).sort()).toEqual(['PORTALGROUPKEY', 'RESOLVEGROUPNAMES'].sort());
    expect(reg.description).toContain('RESOLVEGROUPNAMES');
    await reg.handler({ PORTALGROUPKEY: '26' });
    // The default fakeClient's GetPortalGroup response carries no UNLOCKTIMESPECGROUPKEY, so per R4
    // the fetch is skipped and this is the same single call as before this change.
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTAL_GROUP, params: { PORTALGROUPKEY: '26' } }]);
  });

  describe('get_portal_group RESOLVEGROUPNAMES (specs/portal-group-resolve-group-names.md)', () => {
    // This controller nests a singular GetPortalGroup's fields under a
    // PORTALGROUP key rather than returning them flat (verified live this
    // session, e.g. {"PORTALGROUP":{"PORTALGROUPKEY":"26",...}}) -- the same
    // quirk src/unlockWindow/managed.ts's fetchPortalGroup already handles
    // defensively. These scripted responses use that real wrapped shape.
    it('R2: resolves UNLOCKTIMESPECGROUPNAME when RESOLVEGROUPNAMES is omitted (default true), with exactly one GetTimeSpecGroups call and PORTALS left unchanged', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_PORTAL_GROUP]: [
          {
            notFound: false,
            data: {
              PORTALGROUP: {
                PORTALGROUPKEY: '26',
                NAME: 'LAB ALL ACCESS',
                DESCRIPTION: 'ACCESS TO MAIN LAB DOORS',
                PORTALS: { PORTAL: { PORTALKEY: '51', NAME: '01OF20B' } },
                UNLOCKTIMESPECGROUPKEY: '1',
                THREATLEVELGROUPKEY: '',
              },
            },
          },
        ],
        [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
          { notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: { TIMESPECGROUPKEY: '1', NAME: 'Always' } }, NEXTKEY: '-1' } },
        ],
      });
      const server = new FakeServer();
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '26' });

      expect(calls.map((c) => c.command)).toEqual([NBAPI_COMMANDS.GET_PORTAL_GROUP, NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PORTALGROUP.UNLOCKTIMESPECGROUPNAME).toBe('Always');
      expect(parsed.PORTALGROUP.UNLOCKTIMESPECGROUPKEY).toBe('1');
      expect(parsed.PORTALGROUP.PORTALS).toEqual({ PORTAL: { PORTALKEY: '51', NAME: '01OF20B' } });
      expect(parsed.PORTALGROUP.THREATLEVELGROUPKEY).toBe('');
      expect(parsed.PORTALGROUP.NAME).toBe('LAB ALL ACCESS');
    });

    it('R2: an UNLOCKTIMESPECGROUPKEY with no match in the fetched list resolves to an empty-string UNLOCKTIMESPECGROUPNAME', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_PORTAL_GROUP]: [
          {
            notFound: false,
            data: {
              PORTALGROUP: { PORTALGROUPKEY: '29', NAME: 'GRAND OPENING - All Doors', UNLOCKTIMESPECGROUPKEY: '999', THREATLEVELGROUPKEY: '' },
            },
          },
        ],
        [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
          { notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: { TIMESPECGROUPKEY: '1', NAME: 'Always' } }, NEXTKEY: '-1' } },
        ],
      });
      const server = new FakeServer();
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '29' });

      expect(calls.map((c) => c.command)).toEqual([NBAPI_COMMANDS.GET_PORTAL_GROUP, NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PORTALGROUP.UNLOCKTIMESPECGROUPNAME).toBe('');
    });

    it('R2: also resolves correctly when GetPortalGroup returns fields flat (not wrapped in PORTALGROUP)', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_PORTAL_GROUP]: [
          { notFound: false, data: { PORTALGROUPKEY: '26', NAME: 'LAB ALL ACCESS', UNLOCKTIMESPECGROUPKEY: '1', THREATLEVELGROUPKEY: '' } },
        ],
        [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [
          { notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: { TIMESPECGROUPKEY: '1', NAME: 'Always' } }, NEXTKEY: '-1' } },
        ],
      });
      const server = new FakeServer();
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '26' });

      expect(calls.map((c) => c.command)).toEqual([NBAPI_COMMANDS.GET_PORTAL_GROUP, NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.UNLOCKTIMESPECGROUPNAME).toBe('Always');
      expect(parsed.PORTALGROUP).toBeUndefined();
    });

    it('R3: RESOLVEGROUPNAMES: false makes exactly one GetPortalGroup call and adds no new key', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_PORTAL_GROUP]: [
          {
            notFound: false,
            data: {
              PORTALGROUP: {
                PORTALGROUPKEY: '26',
                NAME: 'LAB ALL ACCESS',
                DESCRIPTION: 'ACCESS TO MAIN LAB DOORS',
                PORTALS: { PORTAL: { PORTALKEY: '51', NAME: '01OF20B' } },
                UNLOCKTIMESPECGROUPKEY: '1',
                THREATLEVELGROUPKEY: '',
              },
            },
          },
        ],
      });
      const server = new FakeServer();
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '26', RESOLVEGROUPNAMES: false });

      expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTAL_GROUP, params: { PORTALGROUPKEY: '26' } }]);
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed)).toEqual(['PORTALGROUP']);
      expect(Object.keys(parsed.PORTALGROUP).sort()).toEqual(
        ['PORTALGROUPKEY', 'NAME', 'DESCRIPTION', 'PORTALS', 'UNLOCKTIMESPECGROUPKEY', 'THREATLEVELGROUPKEY'].sort()
      );
      expect(parsed.PORTALGROUP.UNLOCKTIMESPECGROUPNAME).toBeUndefined();
    });

    it('R4: an empty UNLOCKTIMESPECGROUPKEY skips the GetTimeSpecGroups fetch and yields an empty UNLOCKTIMESPECGROUPNAME', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_PORTAL_GROUP]: [
          { notFound: false, data: { PORTALGROUP: { PORTALGROUPKEY: '5', NAME: 'X', UNLOCKTIMESPECGROUPKEY: '', THREATLEVELGROUPKEY: '' } } },
        ],
      });
      const server = new FakeServer();
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '5' });

      expect(calls.filter((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS)).toHaveLength(0);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PORTALGROUP.UNLOCKTIMESPECGROUPNAME).toBe('');
    });

    it("R5: a thrown GetTimeSpecGroups call does not break the tool call -- UNLOCKTIMESPECGROUPNAME resolves to '' and PORTALS stays intact", async () => {
      const calls: Array<{ command: string; params: unknown }> = [];
      const client = {
        call: async (command: string, params: unknown) => {
          calls.push({ command, params });
          if (command === NBAPI_COMMANDS.GET_PORTAL_GROUP) {
            return {
              notFound: false,
              data: {
                PORTALGROUP: {
                  PORTALGROUPKEY: '26',
                  NAME: 'LAB ALL ACCESS',
                  DESCRIPTION: 'ACCESS TO MAIN LAB DOORS',
                  PORTALS: { PORTAL: { PORTALKEY: '51', NAME: '01OF20B' } },
                  UNLOCKTIMESPECGROUPKEY: '1',
                  THREATLEVELGROUPKEY: '',
                },
              },
            };
          }
          if (command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS) {
            throw new Error('transient GetTimeSpecGroups failure');
          }
          throw new Error(`unexpected call: ${command}`);
        },
      } as unknown as NetboxClient;
      const server = new FakeServer();
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '26' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.PORTALGROUP.UNLOCKTIMESPECGROUPNAME).toBe('');
      expect(parsed.PORTALGROUP.PORTALS).toEqual({ PORTAL: { PORTALKEY: '51', NAME: '01OF20B' } });
    });

    it('R6: RESOLVEGROUPNAMES true (default) with a notFound GetPortalGroup response produces the same standard not-found text as the plain path, with no enrichment calls', async () => {
      const { client, calls } = scriptedEventsClient({
        [NBAPI_COMMANDS.GET_PORTAL_GROUP]: [{ notFound: true, data: undefined }],
      });
      const server = new FakeServer();
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '999' });

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
      registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
      const reg = byName(server, 'get_portal_group');

      const result = await reg.handler({ PORTALGROUPKEY: '1' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
        isError: true,
      });
      expect(calls).toHaveLength(1);
    });
  });

  it('get_portal_groups takes only STARTFROMKEY', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_portal_groups').schema)).toEqual(['STARTFROMKEY']);
  });
});

describe('R13: portal group write tools', () => {
  it('add_portal_group requires NAME + PORTALKEYS and wraps PORTALKEYS as <PORTALKEYS><PORTALKEY>...', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'add_portal_group');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['NAME', 'DESCRIPTION', 'UNLOCKTIMESPECGROUPKEY', 'THREATLEVELGROUPKEY', 'PORTALKEYS'].sort()
    );
    await reg.handler({ NAME: 'LAB ALL ACCESS', PORTALKEYS: ['30', '32'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.ADD_PORTAL_GROUP,
        params: { NAME: 'LAB ALL ACCESS', PORTALKEYS: { PORTALKEY: ['30', '32'] } },
      },
    ]);
  });

  it('modify_portal_group requires PORTALKEYS and wraps it as <PORTALKEYS><PORTALKEY>..., same as add', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalGroupTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'modify_portal_group');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['PORTALGROUPKEY', 'PORTALKEYS', 'NAME', 'DESCRIPTION', 'UNLOCKTIMESPECGROUPKEY', 'THREATLEVELGROUPKEY'].sort()
    );
    await reg.handler({ PORTALGROUPKEY: '56', PORTALKEYS: ['1', '2'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.MODIFY_PORTAL_GROUP,
        params: { PORTALGROUPKEY: '56', PORTALKEYS: { PORTALKEY: ['1', '2'] } },
      },
    ]);
  });

  it('delete_portal_group is destructive-only', () => {
    const partial = new FakeServer();
    const { client } = fakeClient();
    registerPortalGroupTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_portal_group');

    const full = new FakeServer();
    registerPortalGroupTools(full as unknown as McpServer, client, WRITES_ON);
    const reg = byName(full, 'delete_portal_group');
    expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(reg.schema)).toEqual(['PORTALGROUPKEY']);
  });
});
