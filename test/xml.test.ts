import { describe, expect, it } from 'vitest';
import { buildRequestXml, buildParamsXml, parseResponseXml } from '../src/xml.js';
import { interpretResponse } from '../src/netboxClient.js';

describe('buildRequestXml (R2)', () => {
  it('produces the documented NETBOX-API/COMMAND/PARAMS structure with uppercase element names', () => {
    const xml = buildRequestXml({
      sessionId: 'SESS123',
      command: 'GetPerson',
      num: 2,
      params: { PERSONID: '42' },
    });

    expect(xml).toBe(
      '<NETBOX-API sessionid="SESS123"><COMMAND name="GetPerson" num="2"><PARAMS><PERSONID>42</PERSONID></PARAMS></COMMAND></NETBOX-API>'
    );
  });

  it('omits the sessionid attribute when no session is active (e.g. Login)', () => {
    const xml = buildRequestXml({
      sessionId: null,
      command: 'Login',
      num: 1,
      params: { USERNAME: 'alice', PASSWORD: 'hunter2' },
    });

    expect(xml).toBe(
      '<NETBOX-API><COMMAND name="Login" num="1"><PARAMS><USERNAME>alice</USERNAME><PASSWORD>hunter2</PASSWORD></PARAMS></COMMAND></NETBOX-API>'
    );
  });

  it('upper-cases PARAMS element names defensively even if a caller passes a lowercase key', () => {
    const xml = buildParamsXml({ personid: '7' });
    expect(xml).toBe('<PERSONID>7</PERSONID>');
  });

  it('escapes XML special characters in param values', () => {
    const xml = buildParamsXml({ LASTNAME: `O'Brien & <Sons>` });
    expect(xml).toBe('<LASTNAME>O&apos;Brien &amp; &lt;Sons&gt;</LASTNAME>');
  });

  it('omits params whose value is undefined', () => {
    const xml = buildParamsXml({ PERSONID: '1', FIRSTNAME: undefined });
    expect(xml).toBe('<PERSONID>1</PERSONID>');
  });
});

describe('parseResponseXml + interpretResponse', () => {
  it('interprets a SUCCESS response, unwrapping <DETAILS> as the data (not the <RESPONSE> element itself)', () => {
    const parsed = parseResponseXml(
      '<NETBOX><RESPONSE command="GetPortals"><CODE>SUCCESS</CODE><DETAILS><PORTAL><NAME>Front Door</NAME></PORTAL></DETAILS></RESPONSE></NETBOX>'
    );
    const result = interpretResponse(parsed);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.data).toEqual({ PORTAL: { NAME: 'Front Door' } });
    }
  });

  it('interprets an APIERROR response nested inside <RESPONSE> (inside <NETBOX>), with no CODE/DETAILS', () => {
    const parsed = parseResponseXml('<NETBOX><RESPONSE><APIERROR>5</APIERROR></RESPONSE></NETBOX>');
    const result = interpretResponse(parsed);
    expect(result).toEqual({ kind: 'apierror', code: 5 });
  });

  it('interprets a FAIL response with ERRMSG nested inside <DETAILS>', () => {
    const parsed = parseResponseXml(
      '<NETBOX><RESPONSE command="GetPerson"><CODE>FAIL</CODE><DETAILS><ERRMSG>Bad PERSONID</ERRMSG></DETAILS></RESPONSE></NETBOX>'
    );
    const result = interpretResponse(parsed);
    expect(result).toEqual({ kind: 'fail', errmsg: 'Bad PERSONID' });
  });

  it('interprets a NOT FOUND response (no DETAILS block)', () => {
    const parsed = parseResponseXml('<NETBOX><RESPONSE command="GetPerson"><CODE>NOT FOUND</CODE></RESPONSE></NETBOX>');
    const result = interpretResponse(parsed);
    expect(result).toEqual({ kind: 'not_found' });
  });
});
