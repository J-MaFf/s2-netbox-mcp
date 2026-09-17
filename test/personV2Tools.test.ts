import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPersonTools } from '../src/tools/person.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { buildParamsXml, type NbapiParams } from '../src/xml.js';
import { FakeServer, byName, fakeClient } from './testUtils.js';

/**
 * XML-shape tests for the four NBAPI v2-only person tools added to
 * src/tools/person.ts by specs/nbapi-v2-full-conformance.md R2-R4/R6:
 * get_picture plus the three VirtualCredentialRequest tools. The pre-existing
 * person tools keep their own coverage in test/tools.test.ts.
 */

const WRITES_OFF = { writesEnabled: false, destructiveEnabled: false };
const WRITES_ONLY = { writesEnabled: true, destructiveEnabled: false };
const WRITES_ON = { writesEnabled: true, destructiveEnabled: true };

function server(gate: { writesEnabled: boolean; destructiveEnabled: boolean }, result?: { notFound: boolean; data: unknown }) {
  const fake = new FakeServer();
  const { client, calls } = fakeClient(result);
  registerPersonTools(fake as unknown as McpServer, client, gate);
  return { fake, calls };
}

describe('person.ts: get_picture (R2/R6)', () => {
  it('is registered with writes off, requires PERSONID alone, and calls GetPicture', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_picture');
    expect(reg.description.startsWith('WRITE:')).toBe(false);
    expect(Object.keys(reg.schema)).toEqual(['PERSONID']);
    await reg.handler({ PERSONID: '1006' });
    expect(calls).toEqual([{ command: NBAPI_COMMANDS.GET_PICTURE, params: { PERSONID: '1006' } }]);
    expect(buildParamsXml(calls[0].params as NbapiParams)).toBe('<PERSONID>1006</PERSONID>');
  });

  it("describes the response's Base64 JPEG payload and warns that it may be large (C6)", () => {
    const { fake } = server(WRITES_OFF);
    const { description } = byName(fake, 'get_picture');
    expect(description).toContain('Base64');
    expect(description).toContain('PICTURE');
    expect(description).toMatch(/large/i);
  });

  it('passes the PICTURE payload through unmodified (C6)', async () => {
    // A recognisable stand-in for a Base64 JPEG: the real thing is the same
    // shape, just far longer.
    const PICTURE = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJ';
    const data = {
      PERSONID: '1006',
      PICTUREURL: 'kim_arnold.jpg',
      LASTNAME: 'Arnold',
      FIRSTNAME: 'Kim',
      LASTMOD: '2025-04-01 09:15:00',
      PICTURE,
    };
    const { fake } = server(WRITES_OFF, { notFound: false, data });
    const result = await byName(fake, 'get_picture').handler({ PERSONID: '1006' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text) as Record<string, string>;
    expect(parsed.PICTURE).toBe(PICTURE);
    expect(parsed).toEqual(data);
  });
});

describe('person.ts: virtual (mobile) credential tools (R2-R4)', () => {
  it('get_virtual_credential_request is a read tool requiring PERSONID + CARDFORMAT', async () => {
    const { fake, calls } = server(WRITES_OFF);
    const reg = byName(fake, 'get_virtual_credential_request');
    const schema = reg.schema as Record<string, { isOptional: () => boolean }>;
    expect(Object.keys(schema).sort()).toEqual(['CARDFORMAT', 'PERSONID']);
    expect(schema.PERSONID.isOptional()).toBe(false);
    expect(schema.CARDFORMAT.isOptional()).toBe(false);
    await reg.handler({ PERSONID: '123', CARDFORMAT: 'LenelS2 48bit Corp 1000' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.GET_VIRTUAL_CREDENTIAL_REQUEST, params: { PERSONID: '123', CARDFORMAT: 'LenelS2 48bit Corp 1000' } },
    ]);
  });

  it('add_virtual_credential_request is registered only with writes on and carries the WRITE: prefix', async () => {
    const off = server(WRITES_OFF);
    expect(off.fake.registrations.map((r) => r.name)).not.toContain('add_virtual_credential_request');

    const { fake, calls } = server(WRITES_ONLY);
    const reg = byName(fake, 'add_virtual_credential_request');
    expect(reg.description.startsWith('WRITE:')).toBe(true);
    expect(Object.keys(reg.schema).sort()).toEqual(['CARDFORMAT', 'PERSONID']);
    const result = await reg.handler({ PERSONID: '123', CARDFORMAT: 'LenelS2 48bit Corp 1000' });
    expect(calls).toEqual([
      { command: NBAPI_COMMANDS.ADD_VIRTUAL_CREDENTIAL_REQUEST, params: { PERSONID: '123', CARDFORMAT: 'LenelS2 48bit Corp 1000' } },
    ]);
    expect(result.content[0].text).toContain('SUCCESS');
  });

  it('remove_virtual_credential_request needs both gates and carries the DESTRUCTIVE: prefix', async () => {
    const writesOnly = server(WRITES_ONLY);
    expect(writesOnly.fake.registrations.map((r) => r.name)).not.toContain('remove_virtual_credential_request');

    const { fake, calls } = server(WRITES_ON);
    const reg = byName(fake, 'remove_virtual_credential_request');
    expect(reg.description.startsWith('DESTRUCTIVE:')).toBe(true);
    expect(Object.keys(reg.schema).sort()).toEqual(['CARDFORMAT', 'PERSONID']);
    const result = await reg.handler({ PERSONID: '123', CARDFORMAT: 'LenelS2 48bit Corp 1000' });
    expect(calls).toEqual([
      {
        command: NBAPI_COMMANDS.REMOVE_VIRTUAL_CREDENTIAL_REQUEST,
        params: { PERSONID: '123', CARDFORMAT: 'LenelS2 48bit Corp 1000' },
      },
    ]);
    expect(result.content[0].text).toContain('SUCCESS');
  });
});
