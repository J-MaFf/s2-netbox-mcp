import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTimeSpecTools } from '../src/tools/timeSpec.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { NbapiFailError } from '../src/errors.js';
import type { NbapiCallResult, NetboxClient } from '../src/netboxClient.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

/** A fake client that serves the given pages per command, in order, and
 * records every call -- used for get_time_spec_groups's RESOLVEMEMBERNAMES:
 * true tests, which need GetTimeSpecGroups and GetTimeSpecs to answer
 * differently within the same test (mirrors test/tools.test.ts's
 * scriptedEventsClient). */
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

const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };
const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

describe('registerTimeSpecTools (R8 reads)', () => {
  it('registers exactly the four read tools when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_time_spec', 'get_time_specs', 'get_time_spec_group', 'get_time_spec_groups'].sort()
    );
  });

  it('get_time_spec requires TIMESPECKEY and calls GetTimeSpec', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec');
    expect(Object.keys(reg.schema)).toEqual(['TIMESPECKEY']);
    await reg.handler({ TIMESPECKEY: '1' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_TIME_SPEC, params: { TIMESPECKEY: '1' } }]);
  });

  it('get_time_specs takes only STARTFROMKEY', async () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_time_specs').schema)).toEqual(['STARTFROMKEY']);
  });

  it('get_time_spec_group requires TIMESPECGROUPKEY', async () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(Object.keys(byName(server, 'get_time_spec_group').schema)).toEqual(['TIMESPECGROUPKEY']);
  });

  it('get_time_spec_groups takes STARTFROMKEY and RESOLVEMEMBERNAMES and calls GetTimeSpecGroups', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');
    expect(Object.keys(reg.schema).sort()).toEqual(['STARTFROMKEY', 'RESOLVEMEMBERNAMES'].sort());
    // RESOLVEMEMBERNAMES: false isolates this test to plain STARTFROMKEY pass-through --
    // the RESOLVEMEMBERNAMES default-true enrichment path is covered separately below.
    await reg.handler({ STARTFROMKEY: 'abc', RESOLVEMEMBERNAMES: false });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, params: { STARTFROMKEY: 'abc' } }]);
  });
});

describe('get_time_spec_groups RESOLVEMEMBERNAMES (spec: time-spec-groups-resolve-member-names)', () => {
  // Synthetic fixture shaped like the live NetBox 6.2.0 GetTimeSpecGroups
  // page described in the spec's Context: a one-member group collapses
  // TIMESPECKEYS.TIMESPECKEY to a bare string, a multi-member group keeps it
  // as an array, and one member (TIMESPECKEY '99') has no match in the
  // GetTimeSpecs table (an unknown/deleted time spec).
  const GROUPS_PAGE = [
    { TIMESPECGROUPKEY: '1', NAME: 'Always', DESCRIPTION: '', TIMESPECKEYS: { TIMESPECKEY: '1' } },
    {
      TIMESPECGROUPKEY: '28',
      NAME: 'GRAND OPENING',
      DESCRIPTION: 'grand opening hours',
      TIMESPECKEYS: { TIMESPECKEY: ['3', '4'] },
    },
    { TIMESPECGROUPKEY: '30', NAME: 'Unknown member', DESCRIPTION: '', TIMESPECKEYS: { TIMESPECKEY: '99' } },
  ];
  const TIME_SPECS_TABLE = [
    { TIMESPECKEY: '1', NAME: 'Always' },
    { TIMESPECKEY: '3', NAME: 'GRAND OPENING' },
    { TIMESPECKEY: '4', NAME: 'Business Hours' },
  ];

  it('R1: schema is exactly STARTFROMKEY and RESOLVEMEMBERNAMES', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');
    expect(Object.keys(reg.schema).sort()).toEqual(['STARTFROMKEY', 'RESOLVEMEMBERNAMES'].sort());
  });

  it('R2: RESOLVEMEMBERNAMES omitted defaults to true: GetTimeSpecs is fetched once and every group on the page gains {TIMESPECKEY, NAME} members, with an unmatched key resolving to NAME: \'\', and every other field unchanged', async () => {
    const server = new FakeServer();
    const { client, calls } = scriptedClient({
      [NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS]: [{ notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: GROUPS_PAGE }, NEXTKEY: '-1' } }],
      [NBAPI_COMMANDS.GET_TIME_SPECS]: [{ notFound: false, data: { TIMESPECS: { TIMESPEC: TIME_SPECS_TABLE }, NEXTKEY: '-1' } }],
    });
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');

    const result = await reg.handler({});

    // Three groups / four members share one page -- exactly one GetTimeSpecs
    // fetch proves the fixed-cost full-table fetch, not once per group/member.
    const specCalls = calls.filter((c) => c.command === NBAPI_COMMANDS.GET_TIME_SPECS);
    expect(specCalls).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.NEXTKEY).toBe('-1');
    expect(parsed.TIMESPECGROUPS.TIMESPECGROUP[0]).toMatchObject({
      TIMESPECGROUPKEY: '1',
      NAME: 'Always',
      DESCRIPTION: '',
      TIMESPECKEYS: { TIMESPECKEY: [{ TIMESPECKEY: '1', NAME: 'Always' }] },
    });
    expect(parsed.TIMESPECGROUPS.TIMESPECGROUP[1]).toMatchObject({
      TIMESPECGROUPKEY: '28',
      NAME: 'GRAND OPENING',
      DESCRIPTION: 'grand opening hours',
      TIMESPECKEYS: {
        TIMESPECKEY: [
          { TIMESPECKEY: '3', NAME: 'GRAND OPENING' },
          { TIMESPECKEY: '4', NAME: 'Business Hours' },
        ],
      },
    });
    // Unknown/deleted time spec (no GetTimeSpecs match) gets an empty NAME, not omitted.
    expect(parsed.TIMESPECGROUPS.TIMESPECGROUP[2]).toMatchObject({
      TIMESPECGROUPKEY: '30',
      TIMESPECKEYS: { TIMESPECKEY: [{ TIMESPECKEY: '99', NAME: '' }] },
    });
  });

  it('R3: RESOLVEMEMBERNAMES: false makes zero GetTimeSpecs calls and returns TIMESPECKEYS exactly as GetTimeSpecGroups provided it (bare string(s), no shape change)', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient({ notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: GROUPS_PAGE }, NEXTKEY: '-1' } });
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');

    const result = await reg.handler({ STARTFROMKEY: 'abc', RESOLVEMEMBERNAMES: false });

    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, params: { STARTFROMKEY: 'abc' } }]);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.TIMESPECGROUPS.TIMESPECGROUP).toEqual(GROUPS_PAGE);
  });

  it('R4: RESOLVEMEMBERNAMES true (default) with a notFound GetTimeSpecGroups response produces the same standard not-found text as RESOLVEMEMBERNAMES: false would', async () => {
    const server = new FakeServer();
    const { client } = fakeClient({ notFound: true, data: undefined });
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');

    const result = await reg.handler({});

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Not found: the NetBox controller returned NOT FOUND for this query.' }],
    });
  });

  it('R4: RESOLVEMEMBERNAMES true (default) with a thrown NbapiFailError produces the same standard mapped error text as the plain path', async () => {
    const server = new FakeServer();
    const client = {
      call: async () => {
        throw new NbapiFailError('NOT PERMITTED');
      },
    } as unknown as NetboxClient;
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');

    const result = await reg.handler({});

    expect(result).toEqual({
      content: [{ type: 'text', text: 'NetBox NBAPI command failed: NOT PERMITTED' }],
      isError: true,
    });
  });

  it('R5: a GetTimeSpecs failure still yields a successful call with every member NAME empty and every group\'s own fields intact', async () => {
    const server = new FakeServer();
    const client = {
      call: async (command: string) => {
        if (command === NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS) {
          return { notFound: false, data: { TIMESPECGROUPS: { TIMESPECGROUP: GROUPS_PAGE }, NEXTKEY: '-1' } };
        }
        throw new Error('transient GetTimeSpecs failure');
      },
    } as unknown as NetboxClient;
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');

    const result = await reg.handler({});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.TIMESPECGROUPS.TIMESPECGROUP[0]).toMatchObject({
      TIMESPECGROUPKEY: '1',
      NAME: 'Always',
      TIMESPECKEYS: { TIMESPECKEY: [{ TIMESPECKEY: '1', NAME: '' }] },
    });
    expect(parsed.TIMESPECGROUPS.TIMESPECGROUP[1]).toMatchObject({
      TIMESPECGROUPKEY: '28',
      NAME: 'GRAND OPENING',
      TIMESPECKEYS: {
        TIMESPECKEY: [
          { TIMESPECKEY: '3', NAME: '' },
          { TIMESPECKEY: '4', NAME: '' },
        ],
      },
    });
  });

  it('R6: description mentions RESOLVEMEMBERNAMES and its default-true behavior', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_time_spec_groups');

    expect(reg.description).toContain('RESOLVEMEMBERNAMES');
    expect(reg.description.toLowerCase()).toContain('true');
  });
});

describe('R11: time spec write tools', () => {
  it('add_time_spec requires NAME and exposes the documented optionals including MONDAY-SUNDAY and HOLIDAYGROUPS', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    const keys = Object.keys(byName(server, 'add_time_spec').schema);
    expect(keys.sort()).toEqual(
      [
        'NAME',
        'DESCRIPTION',
        'STARTTIME',
        'ENDTIME',
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
        'SATURDAY',
        'SUNDAY',
        'HOLIDAYGROUPS',
      ].sort()
    );
  });

  it('add_time_spec calls AddTimeSpec with the flat PARAMS map', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    await byName(server, 'add_time_spec').handler({ NAME: 'Daytime', STARTTIME: '09:00', ENDTIME: '17:00', MONDAY: '1' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.ADD_TIME_SPEC, params: { NAME: 'Daytime', STARTTIME: '09:00', ENDTIME: '17:00', MONDAY: '1' } },
    ]);
  });

  it('modify_time_spec requires TIMESPECKEY and accepts an optional NAME to rename the time spec', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    const schema = byName(server, 'modify_time_spec').schema as Record<string, { isOptional: () => boolean }>;
    expect(Object.keys(schema)).toContain('TIMESPECKEY');
    expect(schema.TIMESPECKEY.isOptional()).toBe(false);
    expect(Object.keys(schema)).toContain('NAME');
    expect(schema.NAME.isOptional()).toBe(true);
  });

  it('modify_time_spec forwards NAME to ModifyTimeSpec', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    await byName(server, 'modify_time_spec').handler({ TIMESPECKEY: '8', NAME: 'Renamed Hours' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.MODIFY_TIME_SPEC, params: { TIMESPECKEY: '8', NAME: 'Renamed Hours' } },
    ]);
  });

  it('add_time_spec_group requires NAME, DESCRIPTION/TIMESPECKEYS optional', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    expect(Object.keys(byName(server, 'add_time_spec_group').schema).sort()).toEqual(
      ['NAME', 'DESCRIPTION', 'TIMESPECKEYS'].sort()
    );
  });

  it('add_time_spec_group wraps TIMESPECKEYS as <TIMESPECKEYS><TIMESPECKEY>... to seed initial membership', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    await byName(server, 'add_time_spec_group').handler({ NAME: 'Maintenance Staff', TIMESPECKEYS: ['1', '2', '3'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.ADD_TIME_SPEC_GROUP,
        params: { NAME: 'Maintenance Staff', TIMESPECKEYS: { TIMESPECKEY: ['1', '2', '3'] } },
      },
    ]);
  });

  it('modify_time_spec_group wraps TIMESPECKEYS as <TIMESPECKEYS><TIMESPECKEY>...', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerTimeSpecTools(server as unknown as McpServer, client, WRITES_ON);
    const reg = byName(server, 'modify_time_spec_group');
    expect(Object.keys(reg.schema).sort()).toEqual(['TIMESPECGROUPKEY', 'NAME', 'DESCRIPTION', 'TIMESPECKEYS'].sort());
    await reg.handler({ TIMESPECGROUPKEY: '5', TIMESPECKEYS: ['1', '2'] });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.MODIFY_TIME_SPEC_GROUP,
        params: { TIMESPECGROUPKEY: '5', TIMESPECKEYS: { TIMESPECKEY: ['1', '2'] } },
      },
    ]);
  });

  it('delete_time_spec / delete_time_spec_group are destructive-only', () => {
    const partial = new FakeServer();
    const { client } = fakeClient();
    registerTimeSpecTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_time_spec');
    expect(partial.registrations.map((r) => r.name)).not.toContain('delete_time_spec_group');

    const full = new FakeServer();
    registerTimeSpecTools(full as unknown as McpServer, client, WRITES_ON);
    expect(byName(full, 'delete_time_spec').description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(byName(full, 'delete_time_spec').schema)).toEqual(['TIMESPECKEY']);
    expect(byName(full, 'delete_time_spec_group').description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(byName(full, 'delete_time_spec_group').schema)).toEqual(['TIMESPECGROUPKEY']);
  });
});
