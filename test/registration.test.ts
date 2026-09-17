import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPersonTools } from '../src/tools/person.js';
import { registerAccessLevelTools } from '../src/tools/accessLevel.js';
import { registerPortalTools } from '../src/tools/portal.js';
import { registerEventsTools } from '../src/tools/events.js';
import { registerTimeSpecTools } from '../src/tools/timeSpec.js';
import { registerHolidayTools } from '../src/tools/holiday.js';
import { registerPortalGroupTools } from '../src/tools/portalGroup.js';
import { registerReaderGroupTools } from '../src/tools/readerGroup.js';
import { registerThreatLevelTools } from '../src/tools/threatLevel.js';
import { registerPartitionTools } from '../src/tools/partition.js';
import { registerHardwareTools } from '../src/tools/hardware.js';
import { registerAlarmTools } from '../src/tools/alarm.js';
import { registerMiscTools } from '../src/tools/misc.js';
import { registerUnlockWindowTools } from '../src/tools/unlockWindow.js';
import { registerDailyUnlockWindowTools } from '../src/tools/dailyUnlockWindow.js';
import { runNbapiTool, type ToolGateFlags } from '../src/toolHelpers.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeServer, fakeClient } from './testUtils.js';

/**
 * Mirrors src/index.ts's registration sequence exactly (check_connection +
 * every registerXxxTools call), against a FakeServer, so this test exercises
 * the *whole server's* registered tool surface for a given gate — the R1/R2
 * acceptance criterion (C1/C2) is about the server as a whole, not any one
 * module in isolation.
 */
function registerWholeServer(server: FakeServer, gate: ToolGateFlags): void {
  const { client } = fakeClient();
  server.tool(
    'check_connection',
    'Confirms the server can authenticate to the configured S2 NetBox controller and returns the NBAPI version string (wraps GetAPIVersion). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_API_VERSION, {})
  );
  registerPersonTools(server as unknown as McpServer, client, gate);
  registerAccessLevelTools(server as unknown as McpServer, client, gate);
  registerPortalTools(server as unknown as McpServer, client, gate);
  registerEventsTools(server as unknown as McpServer, client, gate);
  registerTimeSpecTools(server as unknown as McpServer, client, gate);
  registerHolidayTools(server as unknown as McpServer, client, gate);
  registerPortalGroupTools(server as unknown as McpServer, client, gate);
  registerReaderGroupTools(server as unknown as McpServer, client, gate);
  registerThreatLevelTools(server as unknown as McpServer, client, gate);
  registerPartitionTools(server as unknown as McpServer, client, gate);
  registerHardwareTools(server as unknown as McpServer, client, gate);
  registerAlarmTools(server as unknown as McpServer, client, gate);
  registerMiscTools(server as unknown as McpServer, client);
  registerUnlockWindowTools(server as unknown as McpServer, client, gate, { holidayGroups: [8, 7, 6], namePrefix: 'MCP Unlock Window' });
  registerDailyUnlockWindowTools(server as unknown as McpServer, client, gate, { holidayGroup: 5, namePrefix: 'MCP Daily Unlock Window' });
}

const READ_TOOLS = [
  'check_connection',
  'get_person',
  'search_person_data',
  'get_card_access_details',
  'get_card_formats',
  'get_access_level',
  'get_access_levels',
  'get_access_level_group',
  'get_access_level_groups',
  'get_access_level_names',
  'get_portals',
  'get_reader',
  'get_readers',
  'find_portals',
  'get_outputs',
  'get_event_history',
  'list_events',
  'get_access_history',
  'get_reader_access_history',
  'get_time_spec',
  'get_time_specs',
  'get_time_spec_group',
  'get_time_spec_groups',
  'get_holiday',
  'get_holidays',
  'get_portal_group',
  'get_portal_groups',
  'get_reader_group',
  'get_reader_groups',
  'get_partitions',
  'get_udf_lists',
  'get_udf_list_items',
  'get_elevators',
  'get_floors',
  'ping_app',
  'get_threat_levels',
  // R1: the read-only composite unlock-window status tool is always registered.
  'get_unlock_window',
  // Daily-unlock-window spec R9: likewise always registered.
  'get_daily_unlock_window',
  // NBAPI v2 full-conformance spec R2: the 12 new read tools.
  'get_portal_states',
  'get_portal_statuses',
  'get_locations',
  'get_alarms',
  'get_picture',
  'get_mercury_panels',
  'get_mercury_panel',
  'get_network_nodes',
  'get_network_node',
  'get_sios',
  'get_sio',
  'get_virtual_credential_request',
];

const NON_DESTRUCTIVE_WRITE_TOOLS = [
  'add_person',
  'modify_person',
  'add_credential',
  'modify_credential',
  'add_access_level',
  'modify_access_level',
  'add_access_level_group',
  'modify_access_level_group',
  'lock_portal',
  'unlock_portal',
  'momentary_unlock_portal',
  'dog_on_next_exit_portal',
  'activate_output',
  'deactivate_output',
  'trigger_event',
  'insert_activity',
  'add_time_spec',
  'modify_time_spec',
  'add_time_spec_group',
  'modify_time_spec_group',
  'add_holiday',
  'modify_holiday',
  'add_portal_group',
  'modify_portal_group',
  'add_reader_group',
  'modify_reader_group',
  'set_threat_level',
  'add_threat_level',
  'modify_threat_level',
  'add_threat_level_group',
  'modify_threat_level_group',
  'add_partition',
  'switch_partition',
  'modify_udf_list_items',
  // R1/R10/R22/R26: the composite write tools, registered with NETBOX_ENABLE_WRITES only.
  'set_portals_state',
  'schedule_unlock_window',
  'cancel_unlock_window',
  // Daily-unlock-window spec R4/R8: likewise, registered only with NETBOX_ENABLE_WRITES.
  'schedule_daily_unlock_window',
  'cancel_daily_unlock_window',
  // NBAPI v2 full-conformance spec R3: the 8 new non-destructive write tools.
  'add_duty_log',
  'add_virtual_credential_request',
  'add_mercury_panel',
  'modify_mercury_panel',
  'add_network_node',
  'modify_network_node',
  'add_sio',
  'modify_sio',
];

// The composite write tools need a stateful controller to succeed, so their
// SUCCESS text is asserted in test/portalState.test.ts,
// test/unlockWindowSchedule.test.ts, test/unlockWindowCancelGet.test.ts,
// test/dailyUnlockWindowSchedule.test.ts and test/dailyUnlockWindowCancelGet.test.ts
// against FakeNetbox; here they are only checked for the WRITE: prefix.
const COMPOSITE_WRITE_TOOLS = [
  'set_portals_state',
  'schedule_unlock_window',
  'cancel_unlock_window',
  'schedule_daily_unlock_window',
  'cancel_daily_unlock_window',
];

// The 15 destructive tools — the original 11 (R2) plus the 4 added by
// specs/archive/nbapi-v2-full-conformance.md R4 — named exactly as the specs list them.
const DESTRUCTIVE_TOOLS = [
  'delete_access_level',
  'delete_access_level_group',
  'delete_holiday',
  'delete_portal_group',
  'delete_reader_group',
  'delete_time_spec',
  'delete_time_spec_group',
  'remove_credential',
  'remove_person',
  'remove_threat_level',
  'remove_threat_level_group',
  'remove_virtual_credential_request',
  'delete_mercury_panel',
  'delete_network_node',
  'delete_sio',
];

describe('R1/C1: registration matrix', () => {
  it('registers exactly the 50 read tools (the 38 pre-existing + the 12 NBAPI v2 read tools) when NETBOX_ENABLE_WRITES is off', () => {
    const server = new FakeServer();
    registerWholeServer(server, { writesEnabled: false, destructiveEnabled: false });
    expect(server.registrations.map((r) => r.name).sort()).toEqual([...READ_TOOLS].sort());
    expect(server.registrations).toHaveLength(50);
  });

  it('with writes off, no tool that can issue a write command is registered', () => {
    const server = new FakeServer();
    registerWholeServer(server, { writesEnabled: false, destructiveEnabled: false });
    const names = server.registrations.map((r) => r.name);
    for (const name of [...NON_DESTRUCTIVE_WRITE_TOOLS, ...DESTRUCTIVE_TOOLS]) {
      expect(names).not.toContain(name);
    }
  });

  it('destructiveEnabled alone (writesEnabled false) registers no write tool at all', () => {
    const server = new FakeServer();
    registerWholeServer(server, { writesEnabled: false, destructiveEnabled: true });
    expect(server.registrations.map((r) => r.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it('registers the 50 read tools + 47 non-destructive write tools (42 pass-through + 5 composite) when writes are on and destructive is off', () => {
    const server = new FakeServer();
    registerWholeServer(server, { writesEnabled: true, destructiveEnabled: false });
    const names = server.registrations.map((r) => r.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...NON_DESTRUCTIVE_WRITE_TOOLS].sort());
    expect(names).toHaveLength(97);
    for (const destructive of DESTRUCTIVE_TOOLS) {
      expect(names).not.toContain(destructive);
    }
  });

  it('registers all 112 tools (50 read + 47 write + 15 destructive) when both flags are on', () => {
    const server = new FakeServer();
    registerWholeServer(server, { writesEnabled: true, destructiveEnabled: true });
    const names = server.registrations.map((r) => r.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...NON_DESTRUCTIVE_WRITE_TOOLS, ...DESTRUCTIVE_TOOLS].sort());
    expect(names).toHaveLength(112);
  });
});

describe('R3/C3: every write tool description is prefixed and every write success text contains SUCCESS', () => {
  // Minimal valid arguments per write tool, chosen to satisfy every
  // client-side guard (R9-R20) so the handler reaches runNbapiTool/
  // formatWriteSuccess rather than returning a guard error.
  const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
    add_person: { LASTNAME: 'Smith' },
    modify_person: { PERSONID: '1' },
    remove_person: { PERSONID: '1' },
    add_credential: { PERSONID: '1', CARDFORMAT: 'Standard26', ENCODEDNUM: '0012345' },
    modify_credential: { PERSONID: '1' },
    remove_credential: { PERSONID: '1', CREDENTIALID: '9' },
    add_access_level: { ACCESSLEVELNAME: 'A', TIMESPECGROUPKEY: '1' },
    modify_access_level: { ACCESSLEVELKEY: '1' },
    delete_access_level: { ACCESSLEVELKEY: '1' },
    add_access_level_group: { NAME: 'G' },
    modify_access_level_group: { ACCESSLEVELGROUPKEY: '1' },
    delete_access_level_group: { ACCESSLEVELGROUPKEY: '1' },
    lock_portal: { PORTALKEY: '1' },
    unlock_portal: { PORTALKEY: '1' },
    momentary_unlock_portal: { PORTALKEY: '1' },
    dog_on_next_exit_portal: { PORTALKEY: '1' },
    activate_output: { OUTPUTKEY: '1' },
    deactivate_output: { OUTPUTKEY: '1' },
    trigger_event: { EVENTNAME: 'E', EVENTACTION: 'ACTIVATE' },
    insert_activity: { ACTIVITYTYPE: 'USERACTIVITY' },
    add_time_spec: { NAME: 'T' },
    modify_time_spec: { TIMESPECKEY: '1' },
    add_time_spec_group: { NAME: 'G' },
    modify_time_spec_group: { TIMESPECGROUPKEY: '1' },
    delete_time_spec: { TIMESPECKEY: '1' },
    delete_time_spec_group: { TIMESPECGROUPKEY: '1' },
    add_holiday: { HOLIDAYNAME: 'H', STARTDATE: '2026-01-01', ENDDATE: '2026-01-02' },
    modify_holiday: { HOLIDAYKEY: '1' },
    delete_holiday: { HOLIDAYKEY: '1' },
    add_portal_group: { NAME: 'G', PORTALKEYS: ['1'] },
    modify_portal_group: { PORTALGROUPKEY: '1', PORTALKEYS: ['1'] },
    delete_portal_group: { PORTALGROUPKEY: '1' },
    add_reader_group: { NAME: 'G', READERKEYS: ['1'] },
    modify_reader_group: { READERGROUPKEY: '1' },
    delete_reader_group: { READERGROUPKEY: '1' },
    set_threat_level: { LEVELNAME: 'High' },
    add_threat_level: { LEVELNAME: 'High' },
    modify_threat_level: { LEVELNAME: 'High', SEQNUM: '1' },
    remove_threat_level: { LEVELNAME: 'High' },
    add_threat_level_group: { LEVELGROUPNAME: 'G' },
    modify_threat_level_group: { LEVELGROUPNAME: 'G', LEVELNAMES: ['High'] },
    remove_threat_level_group: { LEVELGROUPNAME: 'G' },
    add_partition: { NAME: 'P', TIMEZONE: 'UTC' },
    switch_partition: { PARTITIONKEY: '1' },
    modify_udf_list_items: { UDFLISTKEY: '1', LISTITEMS: [{ ITEMNAME: 'X', DELETE: '0' }] },
    // NBAPI v2 full-conformance spec R3/R4.
    add_duty_log: { PERSONID: '1', LOGTEXT: 'note' },
    add_virtual_credential_request: { PERSONID: '1', CARDFORMAT: 'Standard26' },
    remove_virtual_credential_request: { PERSONID: '1', CARDFORMAT: 'Standard26' },
    add_mercury_panel: {
      NAME: 'MP1',
      TYPE: 'MP4502',
      ENABLED: 'TRUE',
      PARTITIONKEY: '1',
      NETWORK: { IPADDRESS: '10.45.0.2', TLSSECURE: 'FALSE' },
    },
    modify_mercury_panel: { MERCURYKEY: '1', NAME: 'MP1', ENABLED: 'TRUE', NETWORK: { IPADDRESS: '10.45.0.2', TLSSECURE: 'FALSE' } },
    delete_mercury_panel: { MERCURYKEY: '1' },
    add_network_node: {
      NAME: 'N1',
      TYPE: 'Node',
      ENABLED: 'TRUE',
      PARTITIONKEY: '1',
      UNIQUEIDENTIFIER: '0011223344556677',
      DHCPENABLED: 'TRUE',
    },
    modify_network_node: { NODEKEY: '1' },
    delete_network_node: { NODEKEY: '1' },
    add_sio: { MERCURYKEY: '1', NAME: 'S1', MODEL: 'MS-ICS', CHANNEL: '0', ADDRESS: '6', REVINPUT: 'FALSE' },
    modify_sio: { SIOKEY: '1', NAME: 'S1', REVINPUT: 'FALSE' },
    delete_sio: { SIOKEY: '1' },
  };

  it('covers every pass-through write and destructive tool name with a sample-args entry', () => {
    const passThrough = NON_DESTRUCTIVE_WRITE_TOOLS.filter((name) => !COMPOSITE_WRITE_TOOLS.includes(name));
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual([...passThrough, ...DESTRUCTIVE_TOOLS].sort());
  });

  const server = new FakeServer();
  registerWholeServer(server, { writesEnabled: true, destructiveEnabled: true });

  for (const reg of server.registrations) {
    if (COMPOSITE_WRITE_TOOLS.includes(reg.name)) {
      it(`${reg.name}: composite write tool description starts with "WRITE:" (its SUCCESS text is asserted against FakeNetbox in its own test file)`, () => {
        expect(reg.description.startsWith('WRITE:')).toBe(true);
      });
    } else if (DESTRUCTIVE_TOOLS.includes(reg.name)) {
      it(`${reg.name}: description starts with "DESTRUCTIVE:" and success text contains SUCCESS`, async () => {
        expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
        const result = await reg.handler(SAMPLE_ARGS[reg.name]);
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('SUCCESS');
      });
    } else if (NON_DESTRUCTIVE_WRITE_TOOLS.includes(reg.name)) {
      it(`${reg.name}: description starts with "WRITE:" and success text contains SUCCESS`, async () => {
        expect(reg.description.startsWith('WRITE:')).toBe(true);
        const result = await reg.handler(SAMPLE_ARGS[reg.name]);
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('SUCCESS');
      });
    } else {
      it(`${reg.name}: read tool description does not use the WRITE:/DESTRUCTIVE: prefixes`, () => {
        expect(reg.description.startsWith('WRITE:')).toBe(false);
        expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(false);
      });
    }
  }
});
