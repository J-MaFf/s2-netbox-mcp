import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHardwareTools } from '../src/tools/hardware.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { buildParamsXml, type NbapiParams } from '../src/xml.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

/**
 * Per-tool XML-shape tests for src/tools/hardware.ts (NBAPI v2 full
 * conformance spec R2-R5/C2-C5), mirroring test/threatLevelTools.test.ts:
 * each tool's schema key set is pinned to the v2 guide's Calling Parameters
 * list, and each handler is driven once to assert the exact PARAMS map (and,
 * for the nested Mercury blocks, the exact serialised XML) it sends.
 */

const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };
const WRITES_ONLY = { writesEnabled: true, destructiveEnabled: false };
const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };

const READ_TOOLS = [
  'get_mercury_panels',
  'get_mercury_panel',
  'get_network_nodes',
  'get_network_node',
  'get_sios',
  'get_sio',
];
const WRITE_TOOLS = ['add_mercury_panel', 'modify_mercury_panel', 'add_network_node', 'modify_network_node', 'add_sio', 'modify_sio'];
const DESTRUCTIVE_TOOLS = ['delete_mercury_panel', 'delete_network_node', 'delete_sio'];

function server(gate: { writesEnabled: boolean; destructiveEnabled: boolean }) {
  const fake = new FakeServer();
  const { client, calls } = fakeClient();
  registerHardwareTools(fake as unknown as McpServer, client, gate);
  return { fake, calls };
}

describe('registerHardwareTools: gating (R2-R4)', () => {
  it('registers only the six read tools when writes are off', () => {
    const { fake } = server(WRITES_OFF);
    expect(fake.registrations.map((r) => r.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it('adds the six non-destructive write tools, but no destructive tool, when writes alone are on', () => {
    const { fake } = server(WRITES_ONLY);
    const names = fake.registrations.map((r) => r.name);
    expect(names.sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const destructive of DESTRUCTIVE_TOOLS) expect(names).not.toContain(destructive);
  });

  it('adds the three destructive tools only when both gates are on', () => {
    const { fake } = server(WRITES_ON);
    expect(fake.registrations.map((r) => r.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS].sort());
  });

  it('every write tool description starts with WRITE: and every destructive one with DESTRUCTIVE:', () => {
    const { fake } = server(WRITES_ON);
    for (const name of WRITE_TOOLS) expect(byName(fake, name).description.startsWith('WRITE:')).toBe(true);
    for (const name of DESTRUCTIVE_TOOLS) expect(byName(fake, name).description.startsWith('DESTRUCTIVE:')).toBe(true);
  });

  it('the module header cites the v2 guide and the not-live-verified caveat (R7)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/tools/hardware.ts', import.meta.url), 'utf8');
    expect(source).toContain('NBAPI version 2');
    expect(source).toContain('April 2025');
    expect(source).toContain('API2-UG-8');
    expect(source).toContain('NOT LIVE-VERIFIED');
  });
});

describe('registerHardwareTools: read tools (R2)', () => {
  it('get_mercury_panels declares the four documented filters and calls GetMercuryPanels', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_mercury_panels');
    expect(Object.keys(reg.schema).sort()).toEqual(['ALLPARTITIONS', 'MERCURYKEY', 'NAME', 'PARTITIONKEY']);
    await reg.handler({ ALLPARTITIONS: 'TRUE' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_MERCURY_PANELS, params: { ALLPARTITIONS: 'TRUE' } }]);
  });

  it('get_mercury_panel requires MERCURYKEY alone and calls GetMercuryPanel', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_mercury_panel');
    expect(Object.keys(reg.schema)).toEqual(['MERCURYKEY']);
    await reg.handler({ MERCURYKEY: '24' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_MERCURY_PANEL, params: { MERCURYKEY: '24' } }]);
  });

  it('get_network_nodes declares the five documented filters and calls GetNetworkNodes', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_network_nodes');
    expect(Object.keys(reg.schema).sort()).toEqual(['ALLPARTITIONS', 'NAME', 'NODEKEY', 'PARTITIONKEY', 'UNIQUEIDENTIFIER']);
    await reg.handler({ NAME: 'N1' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_NETWORK_NODES, params: { NAME: 'N1' } }]);
  });

  it('get_network_node takes a required NODEKEY plus an optional PARTITIONKEY and calls GetNetworkNode', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_network_node');
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    expect(Object.keys(schema).sort()).toEqual(['NODEKEY', 'PARTITIONKEY']);
    expect(schema.NODEKEY.isOptional()).toBe(false);
    expect(schema.PARTITIONKEY.isOptional()).toBe(true);
    await reg.handler({ NODEKEY: '3' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_NETWORK_NODE, params: { NODEKEY: '3' } }]);
  });

  it('get_sios is keyed by MERCURYKEY (there is no unfiltered SIO listing) and calls GetSios', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_sios');
    expect(Object.keys(reg.schema)).toEqual(['MERCURYKEY']);
    await reg.handler({ MERCURYKEY: '24' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_SIOS, params: { MERCURYKEY: '24' } }]);
  });

  it('get_sio sends SIOKEY, following the Calling Parameters list rather than the example MERCURYKEY', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_sio');
    expect(Object.keys(reg.schema)).toEqual(['SIOKEY']);
    await reg.handler({ SIOKEY: '9' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_SIO, params: { SIOKEY: '9' } }]);
  });
});

describe('registerHardwareTools: Mercury panel writes (R3/R5)', () => {
  const NETWORK = { IPADDRESS: '10.45.0.2', TLSSECURE: 'FALSE' };

  it('add_mercury_panel declares the documented fields and serialises NETWORK/SIOCHANNELSETTINGS as nested elements', async () => {
    const { fake, calls } = server(WRITES_ONLY);
    const reg = byName(fake, 'add_mercury_panel');
    expect(Object.keys(reg.schema).sort()).toEqual(['ENABLED', 'NAME', 'NETWORK', 'PARTITIONKEY', 'SIOCHANNELSETTINGS', 'TIMEZONE', 'TYPE']);
    await reg.handler({
      NAME: 'MP_New_4502',
      TYPE: 'MP4502',
      ENABLED: 'TRUE',
      PARTITIONKEY: '1',
      NETWORK,
      SIOCHANNELSETTINGS: { SIOCHANNEL0: 'MSP1' },
    });
    expect(calls[0].command).toBe(NBAPI_COMMANDS.ADD_MERCURY_PANEL);

    // C5: the nested blocks must reach the wire as nested elements, and the
    // doc-"boolean" fields as TRUE/FALSE strings -- never `true`.
    const xml = buildParamsXml(calls[0].params as NbapiParams);
    expect(xml).toContain('<NETWORK><IPADDRESS>10.45.0.2</IPADDRESS><TLSSECURE>FALSE</TLSSECURE></NETWORK>');
    expect(xml).toContain('<SIOCHANNELSETTINGS><SIOCHANNEL0>MSP1</SIOCHANNEL0></SIOCHANNELSETTINGS>');
    expect(xml).toContain('<ENABLED>TRUE</ENABLED>');
    expect(xml).not.toContain('<ENABLED>true</ENABLED>');
    // Never flattened: IPADDRESS must not appear as a direct PARAMS child.
    expect(xml).not.toMatch(/^<IPADDRESS>/);
  });

  it('add_mercury_panel TYPE is a closed enum that rejects an undocumented panel type', () => {
    const { fake } = server(WRITES_ONLY);
    const schema = byName(fake, 'add_mercury_panel').schema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(schema.TYPE.safeParse('MP4502').success).toBe(true);
    expect(schema.TYPE.safeParse('Pro4200').success).toBe(true);
    expect(schema.TYPE.safeParse('MP9999').success).toBe(false);
    expect(schema.ENABLED.safeParse(true).success).toBe(false);
  });

  it('modify_mercury_panel requires MERCURYKEY/NAME/ENABLED/NETWORK and keeps TYPE/PARTITIONKEY optional', async () => {
    const { fake, calls } = server(WRITES_ONLY);
    const reg = byName(fake, 'modify_mercury_panel');
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    expect(Object.keys(schema).sort()).toEqual([
      'ENABLED',
      'MERCURYKEY',
      'NAME',
      'NETWORK',
      'PARTITIONKEY',
      'SIOCHANNELSETTINGS',
      'TIMEZONE',
      'TYPE',
    ]);
    expect(schema.MERCURYKEY.isOptional()).toBe(false);
    expect(schema.NETWORK.isOptional()).toBe(false);
    expect(schema.TYPE.isOptional()).toBe(true);
    expect(schema.PARTITIONKEY.isOptional()).toBe(true);
    await reg.handler({ MERCURYKEY: '24', NAME: 'MP1', ENABLED: 'FALSE', NETWORK });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.MODIFY_MERCURY_PANEL, params: { MERCURYKEY: '24', NAME: 'MP1', ENABLED: 'FALSE', NETWORK } },
    ]);
  });

  it('delete_mercury_panel takes exactly one key and calls DeleteMercuryPanel', async () => {
    const { fake, calls } = server(WRITES_ON);
    const reg = byName(fake, 'delete_mercury_panel');
    expect(Object.keys(reg.schema)).toEqual(['MERCURYKEY']);
    await reg.handler({ MERCURYKEY: '24' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.DELETE_MERCURY_PANEL, params: { MERCURYKEY: '24' } }]);
  });
});

describe('registerHardwareTools: network node writes (R3/R5)', () => {
  it('add_network_node declares the documented fields with a case-sensitive TYPE enum', async () => {
    const { fake, calls } = server(WRITES_ONLY);
    const reg = byName(fake, 'add_network_node');
    expect(Object.keys(reg.schema).sort()).toEqual([
      'AUTODISCOVERENABLED',
      'CONFIGLOCKEDENABLED',
      'DHCPENABLED',
      'ENABLED',
      'GATEWAY',
      'IPADDRESS',
      'NAME',
      'NETMASK',
      'NETWORKCONTROLLERIPADDRESS',
      'PARTITIONKEY',
      'REALTIMEDISKPOLICYENABLED',
      'SECONDARYCONTROLLERIPADDRESS',
      'TIMEZONE',
      'TYPE',
      'UNIQUEIDENTIFIER',
    ]);
    const schema = reg.schema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(schema.TYPE.safeParse('MicroNode Plus').success).toBe(true);
    expect(schema.TYPE.safeParse('micronode plus').success).toBe(false);
    await reg.handler({
      NAME: 'N1',
      TYPE: 'Node',
      ENABLED: 'TRUE',
      PARTITIONKEY: '1',
      UNIQUEIDENTIFIER: '0011223344556677',
      DHCPENABLED: 'FALSE',
      IPADDRESS: '10.0.0.5',
    });
    expect(calls[0].command).toBe(NBAPI_COMMANDS.ADD_NETWORK_NODE);
    expect(buildParamsXml(calls[0].params as NbapiParams)).toContain('<DHCPENABLED>FALSE</DHCPENABLED>');
  });

  it('modify_network_node requires only NODEKEY and omits UNIQUEIDENTIFIER/TYPE/PARTITIONKEY', async () => {
    const { fake, calls } = server(WRITES_ONLY);
    const reg = byName(fake, 'modify_network_node');
    const keys = Object.keys(reg.schema);
    expect(keys).toContain('NODEKEY');
    expect(keys).not.toContain('UNIQUEIDENTIFIER');
    expect(keys).not.toContain('TYPE');
    expect(keys).not.toContain('PARTITIONKEY');
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    expect(schema.NODEKEY.isOptional()).toBe(false);
    for (const key of keys.filter((k) => k !== 'NODEKEY')) expect(schema[key].isOptional()).toBe(true);
    await reg.handler({ NODEKEY: '3', NAME: 'N2' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.MODIFY_NETWORK_NODE, params: { NODEKEY: '3', NAME: 'N2' } }]);
  });

  it('delete_network_node takes exactly one key and calls DeleteNetworkNode', async () => {
    const { fake, calls } = server(WRITES_ON);
    const reg = byName(fake, 'delete_network_node');
    expect(Object.keys(reg.schema)).toEqual(['NODEKEY']);
    await reg.handler({ NODEKEY: '3' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.DELETE_NETWORK_NODE, params: { NODEKEY: '3' } }]);
  });
});

describe('registerHardwareTools: SIO writes (R3/R5)', () => {
  it('add_sio declares the documented fields and sends REVINPUT as a TRUE/FALSE string', async () => {
    const { fake, calls } = server(WRITES_ONLY);
    const reg = byName(fake, 'add_sio');
    expect(Object.keys(reg.schema).sort()).toEqual([
      'ADDRESS',
      'CHANNEL',
      'HOSTNAME',
      'IPADDRESS',
      'MERCURYKEY',
      'MODEL',
      'NAME',
      'PASSWORD',
      'REVINPUT',
      'USERNAME',
    ]);
    await reg.handler({ MERCURYKEY: '24', NAME: 'New18-1', MODEL: 'MS-ICS', CHANNEL: '0', ADDRESS: '6', REVINPUT: 'FALSE' });
    expect(calls[0].command).toBe(NBAPI_COMMANDS.ADD_SIO);
    expect(buildParamsXml(calls[0].params as NbapiParams)).toBe(
      '<MERCURYKEY>24</MERCURYKEY><NAME>New18-1</NAME><MODEL>MS-ICS</MODEL><CHANNEL>0</CHANNEL><ADDRESS>6</ADDRESS><REVINPUT>FALSE</REVINPUT>'
    );
  });

  it('modify_sio requires SIOKEY/NAME/REVINPUT and does not expose the unchangeable MODEL', async () => {
    const { fake, calls } = server(WRITES_ONLY);
    const reg = byName(fake, 'modify_sio');
    expect(Object.keys(reg.schema).sort()).toEqual([
      'ADDRESS',
      'CHANNEL',
      'HOSTNAME',
      'IPADDRESS',
      'NAME',
      'PASSWORD',
      'REVINPUT',
      'SIOKEY',
      'USERNAME',
    ]);
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    expect(schema.SIOKEY.isOptional()).toBe(false);
    expect(schema.NAME.isOptional()).toBe(false);
    expect(schema.REVINPUT.isOptional()).toBe(false);
    await reg.handler({ SIOKEY: '9', NAME: 'New18-1', REVINPUT: 'TRUE' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.MODIFY_SIO, params: { SIOKEY: '9', NAME: 'New18-1', REVINPUT: 'TRUE' } }]);
  });

  it('delete_sio sends SIOKEY, following the Calling Parameters list rather than the example NODEKEY', async () => {
    const { fake, calls } = server(WRITES_ON);
    const reg = byName(fake, 'delete_sio');
    expect(Object.keys(reg.schema)).toEqual(['SIOKEY']);
    await reg.handler({ SIOKEY: '9' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.DELETE_SIO, params: { SIOKEY: '9' } }]);
  });
});
