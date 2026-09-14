import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPersonTools } from '../src/tools/person.js';
import { registerAccessLevelTools } from '../src/tools/accessLevel.js';
import { registerPortalTools } from '../src/tools/portal.js';
import { registerEventsTools } from '../src/tools/events.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

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
    expect(Object.keys(reg.schema).sort()).toEqual(['CARDFORMAT', 'ENCODEDNUM', 'MAXRECORDS', 'OLDESTDTTM'].sort());
    expect(Object.keys(reg.schema)).not.toContain('PERSONID');
  });

  it('get_card_access_details calls GetCardAccessDetails with ENCODEDNUM and CARDFORMAT', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPersonTools(server as unknown as McpServer, client, WRITES_OFF);
    await byName(server, 'get_card_access_details').handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
    ]);
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

    it('modify_credential rejects a call with both DISABLED and CARDSTATUS', async () => {
      const server = new FakeServer();
      const { client, calls } = fakeClient();
      registerPersonTools(server as unknown as McpServer, client, WRITES_ON);
      const result = await byName(server, 'modify_credential').handler({
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

  it('get_access_level requires ACCESSLEVELKEY, not ACCESSLEVELID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerAccessLevelTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_access_level');
    expect(Object.keys(reg.schema)).toEqual(['ACCESSLEVELKEY']);
    await reg.handler({ ACCESSLEVELKEY: '7' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ACCESS_LEVEL, params: { ACCESSLEVELKEY: '7' } }]);
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

    it('modify_access_level makes everything but ACCESSLEVELKEY optional', () => {
      const server = new FakeServer();
      const { client } = fakeClient();
      registerAccessLevelTools(server as unknown as McpServer, client, WRITES_ON);
      const reg = byName(server, 'modify_access_level');
      expect(Object.keys(reg.schema).sort()).toEqual(
        ['ACCESSLEVELKEY', 'ACCESSLEVELDESCRIPTION', 'READERKEY', 'READERGROUPKEY', 'TIMESPECGROUPKEY', 'THREATLEVELGROUPKEY'].sort()
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

    it('delete_access_level / delete_access_level_group are destructive-only', () => {
      const partial = new FakeServer();
      const { client } = fakeClient();
      registerAccessLevelTools(partial as unknown as McpServer, client, { writesEnabled: true, destructiveEnabled: false });
      expect(partial.registrations.map((r) => r.name)).not.toContain('delete_access_level');
      expect(partial.registrations.map((r) => r.name)).not.toContain('delete_access_level_group');

      const full = new FakeServer();
      registerAccessLevelTools(full as unknown as McpServer, client, WRITES_ON);
      expect(byName(full, 'delete_access_level').description.startsWith('DESTRUCTIVE:')).toBe(true);
      expect(byName(full, 'delete_access_level_group').description.startsWith('DESTRUCTIVE:')).toBe(true);
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

  it('get_portals takes only STARTFROMKEY (no single-portal filter) and calls GetPortals', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerPortalTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_portals');
    expect(Object.keys(reg.schema)).toEqual(['STARTFROMKEY']);
    await reg.handler({ STARTFROMKEY: 'abc' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: 'abc' } }]);
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
  it('registers exactly get_event_history, list_events, get_access_history when writes are off', () => {
    const server = new FakeServer();
    const { client } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
    expect(server.registrations.map((r) => r.name).sort()).toEqual(
      ['get_access_history', 'get_event_history', 'list_events'].sort()
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

  it('list_events takes no parameters and calls ListEvents', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'list_events');
    expect(Object.keys(reg.schema)).toEqual([]);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.LIST_EVENTS, params: {} }]);
  });

  it('get_access_history uses the documented log/card/date filters, not STARTTIME/ENDTIME/PERSONID', async () => {
    const server = new FakeServer();
    const { client, calls } = fakeClient();
    registerEventsTools(server as unknown as McpServer, client, WRITES_OFF);
    const reg = byName(server, 'get_access_history');
    expect(Object.keys(reg.schema).sort()).toEqual(
      ['STARTLOGID', 'AFTERLOGID', 'ORDER', 'MAXRECORDS', 'ENCODEDNUM', 'HOTSTAMP', 'CARDFORMAT', 'OLDESTDTTM', 'NEWESTDTTM'].sort()
    );
    expect(Object.keys(reg.schema)).not.toContain('STARTTIME');
    expect(Object.keys(reg.schema)).not.toContain('ENDTIME');
    expect(Object.keys(reg.schema)).not.toContain('PERSONID');
    expect(Object.keys(reg.schema)).not.toContain('extraParams');

    await reg.handler({ ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_ACCESS_HISTORY, params: { ENCODEDNUM: '0012345', CARDFORMAT: 'Standard26' } },
    ]);
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
