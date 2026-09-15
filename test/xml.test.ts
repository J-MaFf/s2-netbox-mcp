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

describe('buildParamsXml nested PARAMS (R5)', () => {
  it('wraps an array of scalars under a wrapper key: PORTALKEYS -> <PORTALKEYS><PORTALKEY>...', () => {
    const xml = buildParamsXml({ PORTALKEYS: { PORTALKEY: ['30', '32'] } });
    expect(xml).toBe('<PORTALKEYS><PORTALKEY>30</PORTALKEY><PORTALKEY>32</PORTALKEY></PORTALKEYS>');
  });

  it('serialises a top-level array as repeated sibling elements (no wrapper): modify_portal_group’s PORTALKEY', () => {
    const xml = buildParamsXml({ PORTALGROUPKEY: '56', PORTALKEY: ['1', '2'] });
    expect(xml).toBe('<PORTALGROUPKEY>56</PORTALGROUPKEY><PORTALKEY>1</PORTALKEY><PORTALKEY>2</PORTALKEY>');
  });

  it('wraps an array of bare-name strings: ACCESSLEVELS -> <ACCESSLEVELS><ACCESSLEVEL>...', () => {
    const xml = buildParamsXml({ ACCESSLEVELS: { ACCESSLEVEL: ['A', 'B'] } });
    expect(xml).toBe('<ACCESSLEVELS><ACCESSLEVEL>A</ACCESSLEVEL><ACCESSLEVEL>B</ACCESSLEVEL></ACCESSLEVELS>');
  });

  it('wraps an array of objects (block syntax): ACCESSLEVELS -> <ACCESSLEVELS><ACCESSLEVEL><ACCESSLEVELNAME>...', () => {
    const xml = buildParamsXml({ ACCESSLEVELS: { ACCESSLEVEL: [{ ACCESSLEVELNAME: 'A', DELETE: '1' }] } });
    expect(xml).toBe('<ACCESSLEVELS><ACCESSLEVEL><ACCESSLEVELNAME>A</ACCESSLEVELNAME><DELETE>1</DELETE></ACCESSLEVEL></ACCESSLEVELS>');
  });

  it('serialises VEHICLES -> <VEHICLES><VEHICLE>... preserving object key order', () => {
    const xml = buildParamsXml({ VEHICLES: { VEHICLE: [{ VEHICLEMAKE: 'Honda', VEHICLELICNUM: '123 PGA' }] } });
    expect(xml).toBe('<VEHICLES><VEHICLE><VEHICLEMAKE>Honda</VEHICLEMAKE><VEHICLELICNUM>123 PGA</VEHICLELICNUM></VEHICLE></VEHICLES>');
  });

  it('serialises two LISTITEM blocks in the given order, each with its own key order', () => {
    const xml = buildParamsXml({
      LISTITEMS: {
        LISTITEM: [
          { ITEMKEY: '1', DELETE: '1' },
          { DELETE: '0', ITEMNAME: 'X', CUSTOMKEY: '_3' },
        ],
      },
    });
    expect(xml).toBe(
      '<LISTITEMS>' +
        '<LISTITEM><ITEMKEY>1</ITEMKEY><DELETE>1</DELETE></LISTITEM>' +
        '<LISTITEM><DELETE>0</DELETE><ITEMNAME>X</ITEMNAME><CUSTOMKEY>_3</CUSTOMKEY></LISTITEM>' +
        '</LISTITEMS>'
    );
  });

  it('escapes XML special characters in a nested value', () => {
    const xml = buildParamsXml({ VEHICLES: { VEHICLE: [{ VEHICLEMAKE: `O'Reilly & <Co>` }] } });
    expect(xml).toBe('<VEHICLES><VEHICLE><VEHICLEMAKE>O&apos;Reilly &amp; &lt;Co&gt;</VEHICLEMAKE></VEHICLE></VEHICLES>');
  });

  it('drops undefined array items as well as undefined top-level values', () => {
    const xml = buildParamsXml({ PORTALKEY: ['1', undefined, '2'] });
    expect(xml).toBe('<PORTALKEY>1</PORTALKEY><PORTALKEY>2</PORTALKEY>');
  });

  it('nests to arbitrary depth', () => {
    const xml = buildParamsXml({ A: { B: { C: '1' } } });
    expect(xml).toBe('<A><B><C>1</C></B></A>');
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

  it('merges RESPONSE-level fields (the doc\'s AddTimeSpecGroup shape) into the data, with DETAILS winning and attributes excluded', () => {
    const direct = interpretResponse(
      parseResponseXml('<NETBOX><RESPONSE command="AddTimeSpecGroup" num="3"><CODE>SUCCESS</CODE><TIMESPECGROUPKEY>9</TIMESPECGROUPKEY></RESPONSE></NETBOX>')
    );
    expect(direct).toEqual({ kind: 'success', data: { TIMESPECGROUPKEY: '9' } });

    const both = interpretResponse(
      parseResponseXml(
        '<NETBOX><RESPONSE command="X"><CODE>SUCCESS</CODE><EXTRA>1</EXTRA><KEY>outer</KEY><DETAILS><KEY>inner</KEY></DETAILS></RESPONSE></NETBOX>'
      )
    );
    expect(both).toEqual({ kind: 'success', data: { EXTRA: '1', KEY: 'inner' } });
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
