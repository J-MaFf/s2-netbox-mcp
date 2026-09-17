import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAlarmTools } from '../src/tools/alarm.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { buildParamsXml, type NbapiParams } from '../src/xml.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

/** Per-tool XML-shape tests for src/tools/alarm.ts (NBAPI v2 full conformance
 * spec R2/R3/R7), mirroring test/threatLevelTools.test.ts. */

const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };
const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };

function server(gate: { writesEnabled: boolean; destructiveEnabled: boolean }) {
  const fake = new FakeServer();
  const { client, calls } = fakeClient();
  registerAlarmTools(fake as unknown as McpServer, client, gate);
  return { fake, calls };
}

describe('registerAlarmTools', () => {
  it('registers only get_alarms when writes are off', () => {
    const { fake } = server(WRITES_OFF);
    expect(fake.registrations.map((r) => r.name)).toEqual(['get_alarms']);
  });

  it('registers get_alarms plus add_duty_log when writes are on, and no destructive tool', () => {
    const { fake } = server(WRITES_ON);
    expect(fake.registrations.map((r) => r.name).sort()).toEqual(['add_duty_log', 'get_alarms']);
    expect(byName(fake, 'add_duty_log').description.startsWith('WRITE:')).toBe(true);
    expect(byName(fake, 'get_alarms').description.startsWith('WRITE:')).toBe(false);
  });

  it('get_alarms declares the six documented filters and calls GetAlarms', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_alarms');
    expect(Object.keys(reg.schema).sort()).toEqual(['ACTIVITYID', 'ALLPARTITIONS', 'EVENTID', 'ID', 'OWNERID', 'PARTITIONKEY']);
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    for (const key of Object.keys(schema)) expect(schema[key].isOptional()).toBe(true);
    await reg.handler({});
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ALARMS, params: {} }]);
  });

  it('get_alarms sends only the filters that were supplied, as TRUE/FALSE strings', async () => {
    const { fake, calls } = server(WRITES_OFF);
    await byName(fake, 'get_alarms').handler({ ALLPARTITIONS: 'TRUE', OWNERID: '42' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_ALARMS, params: { ALLPARTITIONS: 'TRUE', OWNERID: '42' } }]);
    expect(buildParamsXml(calls[0].params as NbapiParams)).toBe('<ALLPARTITIONS>TRUE</ALLPARTITIONS><OWNERID>42</OWNERID>');
  });

  it('add_duty_log requires PERSONID + LOGTEXT and keeps ACTIVITYID/PARTITIONKEY optional', async () => {
    const { fake, calls } = server(WRITES_ON);
    const reg = byName(fake, 'add_duty_log');
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    expect(Object.keys(schema).sort()).toEqual(['ACTIVITYID', 'LOGTEXT', 'PARTITIONKEY', 'PERSONID']);
    expect(schema.PERSONID.isOptional()).toBe(false);
    expect(schema.LOGTEXT.isOptional()).toBe(false);
    expect(schema.ACTIVITYID.isOptional()).toBe(true);
    expect(schema.PARTITIONKEY.isOptional()).toBe(true);
    const result = await reg.handler({ PERSONID: '1006', LOGTEXT: 'MCP livecheck duty log' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.ADD_DUTY_LOG, params: { PERSONID: '1006', LOGTEXT: 'MCP livecheck duty log' } },
    ]);
    expect(result.content[0].text).toContain('SUCCESS');
  });

  it('the module header cites the v2 doc and the not-live-verified caveat (R7)', () => {
    const source = readFileSync(new URL('../src/tools/alarm.ts', import.meta.url), 'utf8');
    expect(source).toContain('NBAPI version 2');
    expect(source).toContain('April 2025');
    expect(source).toContain('API2-UG-8');
    expect(source).toContain('NOT LIVE-VERIFIED');
  });
});
