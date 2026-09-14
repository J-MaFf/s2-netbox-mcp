import { describe, expect, it } from 'vitest';
import { runNbapiTool, mergeParams, formatAsJson } from '../src/toolHelpers.js';
import { NbapiApiError, NbapiFailError } from '../src/errors.js';
import type { NetboxClient } from '../src/netboxClient.js';

function fakeClient(impl: NetboxClient['call']): NetboxClient {
  return { call: impl } as unknown as NetboxClient;
}

describe('runNbapiTool', () => {
  it('returns a normal (non-error) JSON result on success', async () => {
    const client = fakeClient(async () => ({ notFound: false, data: { PERSONID: '1', LASTNAME: 'Smith' } }));
    const result = await runNbapiTool(client, 'GetPerson', { PERSONID: '1' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(formatAsJson({ PERSONID: '1', LASTNAME: 'Smith' }));
  });

  it('returns a normal (non-error) result stating not-found for NOT FOUND (R9)', async () => {
    const client = fakeClient(async () => ({ notFound: true, data: undefined }));
    const result = await runNbapiTool(client, 'GetPerson', { PERSONID: '999' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.toLowerCase()).toContain('not found');
  });

  it('maps NbapiApiError to an MCP tool error (R7)', async () => {
    const client = fakeClient(async () => {
      throw new NbapiApiError(2);
    });
    const result = await runNbapiTool(client, 'GetPortals', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('2: The API is not enabled on the system.');
  });

  it('maps NbapiFailError to an MCP tool error including ERRMSG verbatim (R8)', async () => {
    const client = fakeClient(async () => {
      throw new NbapiFailError('Invalid PERSONID supplied.');
    });
    const result = await runNbapiTool(client, 'GetPerson', { PERSONID: 'bogus' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid PERSONID supplied.');
  });

  it('maps unexpected errors to an MCP tool error without swallowing them', async () => {
    const client = fakeClient(async () => {
      throw new Error('ECONNRESET');
    });
    const result = await runNbapiTool(client, 'GetPortals', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ECONNRESET');
  });
});

describe('mergeParams', () => {
  it('passes named fields through as a flat PARAMS map, ignoring undefined values', () => {
    expect(mergeParams({ FIRSTNAME: 'Jane', LASTNAME: undefined })).toEqual({ FIRSTNAME: 'Jane' });
  });

  it('works with a single field', () => {
    expect(mergeParams({ STARTFROMKEY: '5' })).toEqual({ STARTFROMKEY: '5' });
  });
});
