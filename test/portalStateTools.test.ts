import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPortalTools } from '../src/tools/portal.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { buildParamsXml, type NbapiParams } from '../src/xml.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

/**
 * XML-shape tests for the three NBAPI v2-only reads added to
 * src/tools/portal.ts by specs/nbapi-v2-full-conformance.md R2:
 * get_portal_states, get_portal_statuses and get_locations. The pre-existing
 * portal tools keep their own coverage in test/tools.test.ts.
 */

const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };

function server() {
  const fake = new FakeServer();
  const { client, calls } = fakeClient();
  registerPortalTools(fake as unknown as McpServer, client, WRITES_OFF);
  return { fake, calls };
}

describe('portal.ts: NBAPI v2 portal-state and location reads', () => {
  it('registers all three as read tools with no WRITE:/DESTRUCTIVE: prefix even with writes off', () => {
    const { fake } = server();
    for (const name of ['get_portal_states', 'get_portal_statuses', 'get_locations']) {
      const reg = byName(fake, name);
      expect(reg.description.startsWith('WRITE:')).toBe(false);
      expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(false);
    }
  });

  it('get_portal_states takes only the optional PORTALSTATES flag and calls GetPortalStates', async () => {
    const { fake, calls } = server();
    const reg = byName(fake, 'get_portal_states');
    expect(Object.keys(reg.schema)).toEqual(['PORTALSTATES']);
    const schema = reg.schema as Record<string, { isOptional: () => boolean; safeParse: (v: unknown) => { success: boolean } }>;
    expect(schema.PORTALSTATES.isOptional()).toBe(true);
    expect(schema.PORTALSTATES.safeParse(true).success).toBe(false);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTAL_STATES, params: {} }]);
    await reg.handler({ PORTALSTATES: 'TRUE' });
    expect(buildParamsXml(calls[1].params as NbapiParams)).toBe('<PORTALSTATES>TRUE</PORTALSTATES>');
  });

  it('get_portal_statuses declares the five documented filters and calls GetPortalStatuses', async () => {
    const { fake, calls } = server();
    const reg = byName(fake, 'get_portal_statuses');
    expect(Object.keys(reg.schema).sort()).toEqual(['ALLPARTITIONS', 'LOCATIONKEY', 'PARTITIONKEY', 'PORTALKEY', 'STATEKEY']);
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    for (const key of Object.keys(schema)) expect(schema[key].isOptional()).toBe(true);
    await reg.handler({ PORTALKEY: '56', LOCATIONKEY: '2' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PORTAL_STATUSES, params: { PORTALKEY: '56', LOCATIONKEY: '2' } }]);
  });

  it('get_locations takes ALLPARTITIONS plus the FAIL-documented STARTFROMKEY cursor and calls GetLocations', async () => {
    const { fake, calls } = server();
    const reg = byName(fake, 'get_locations');
    expect(Object.keys(reg.schema).sort()).toEqual(['ALLPARTITIONS', 'STARTFROMKEY']);
    await reg.handler({ ALLPARTITIONS: 'FALSE', STARTFROMKEY: '7' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_LOCATIONS, params: { ALLPARTITIONS: 'FALSE', STARTFROMKEY: '7' } },
    ]);
    expect(buildParamsXml(calls[0].params as NbapiParams)).toBe('<ALLPARTITIONS>FALSE</ALLPARTITIONS><STARTFROMKEY>7</STARTFROMKEY>');
  });
});
