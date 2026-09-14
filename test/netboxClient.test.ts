import { describe, expect, it } from 'vitest';
import { NetboxClient } from '../src/netboxClient.js';
import { NbapiApiError, NbapiFailError, API_ERROR_DESCRIPTIONS } from '../src/errors.js';
import {
  createMockFetch,
  LOGIN_SUCCESS_XML,
  SUCCESS_XML,
  NOT_FOUND_XML,
  FAIL_XML,
  API_ERROR_XML,
} from './testUtils.js';

const CONFIG = {
  baseUrl: 'https://netbox.example.internal',
  username: 'svc-account',
  password: 'super-secret-password',
  allowInsecureTls: false,
};

describe('NetboxClient session management (R4)', () => {
  it('logs in once and reuses the cached session across two sequential tool calls', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetPerson', { PERSONID: '1', LASTNAME: 'Smith' }));
    mock.queueXml(SUCCESS_XML('GetPortals'));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetPerson', { PERSONID: '1' });
    await client.call('GetPortals', {});

    const loginCalls = mock.calls.filter((c) => c.body.includes('name="Login"'));
    expect(loginCalls).toHaveLength(1);
    expect(mock.calls).toHaveLength(3);
  });

  it('posts to <baseUrl>/goforms/nbapi', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetAPIVersion', { VERSION: '5.0' }));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetAPIVersion', {});

    for (const call of mock.calls) {
      expect(call.url).toBe('https://netbox.example.internal/goforms/nbapi');
    }
  });

  it('never includes the raw password in the XML sent for anything other than the Login request', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetPerson', { PERSONID: '1' }));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetPerson', { PERSONID: '1' });

    expect(mock.calls[0].body).toContain(CONFIG.password);
    expect(mock.calls[1].body).not.toContain(CONFIG.password);
  });
});

describe('NetboxClient.login session id extraction (Command reference: Login)', () => {
  it('reads the session id from the sessionid attribute on the outer <NETBOX> response element, not a body field', async () => {
    const mock = createMockFetch();
    mock.queueXml('<NETBOX sessionid="ATTR-SESS"><RESPONSE command="Login"><CODE>SUCCESS</CODE></RESPONSE></NETBOX>');
    mock.queueXml(SUCCESS_XML('GetAPIVersion', { APIVERSION: '5.0' }));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetAPIVersion', {});

    expect(mock.calls[1].body).toContain('sessionid="ATTR-SESS"');
  });

  it('does not mistake a stray SESSIONID body field for the session id (no such field is documented)', async () => {
    const mock = createMockFetch();
    // A response with a bogus SESSIONID field inside DETAILS but no sessionid
    // attribute on <NETBOX> must NOT be treated as a successful login.
    mock.queueXml(
      '<NETBOX><RESPONSE command="Login"><CODE>SUCCESS</CODE><DETAILS><SESSIONID>BODY-FIELD</SESSIONID></DETAILS></RESPONSE></NETBOX>'
    );

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await expect(client.call('GetAPIVersion', {})).rejects.toThrow(/no session id/i);
  });
});

describe('NetboxClient DETAILS unwrapping (R11-R17 / C11)', () => {
  it('flattens the real documented envelope — fields nested in <RESPONSE><DETAILS> — into the returned data', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(
      '<NETBOX sessionid="SESS-1"><RESPONSE command="GetPerson" num="1"><CODE>SUCCESS</CODE>' +
        '<DETAILS><PERSONID>21001</PERSONID><FIRSTNAME>Isaac</FIRSTNAME><LASTNAME>Newton</LASTNAME></DETAILS>' +
        '</RESPONSE></NETBOX>'
    );

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    const result = await client.call('GetPerson', { PERSONID: '21001' });

    expect(result.notFound).toBe(false);
    // The result must be the flat field set from inside <DETAILS>, not
    // { DETAILS: { ... } } and not the <RESPONSE> element's own attributes.
    expect(result.data).toEqual({ PERSONID: '21001', FIRSTNAME: 'Isaac', LASTNAME: 'Newton' });
  });
});

describe('NetboxClient retry-once-on-expiry (R5)', () => {
  it('re-logs-in exactly once on APIERROR 5 and retries the original command, which then succeeds', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1')); // initial login
    mock.queueXml(API_ERROR_XML(5)); // original GetPerson call fails: expired session
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-2')); // automatic re-login
    mock.queueXml(SUCCESS_XML('GetPerson', { PERSONID: '1', LASTNAME: 'Smith' })); // retried call succeeds

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    const result = await client.call('GetPerson', { PERSONID: '1' });

    expect(result.notFound).toBe(false);
    expect(result.data).toEqual({ PERSONID: '1', LASTNAME: 'Smith' });

    const loginCalls = mock.calls.filter((c) => c.body.includes('name="Login"'));
    expect(loginCalls).toHaveLength(2);
    expect(mock.calls).toHaveLength(4);

    // The retried request must use the freshly re-logged-in session id.
    const retriedCall = mock.calls[3];
    expect(retriedCall.body).toContain('sessionid="SESS-2"');
  });

  it('does not retry more than once — a second consecutive APIERROR 5 surfaces as an error', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(API_ERROR_XML(5));
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-2'));
    mock.queueXml(API_ERROR_XML(5));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await expect(client.call('GetPerson', { PERSONID: '1' })).rejects.toBeInstanceOf(NbapiApiError);
  });
});

describe('NetboxClient error surfacing (R7-R9)', () => {
  for (const codeStr of Object.keys(API_ERROR_DESCRIPTIONS)) {
    const code = Number(codeStr);
    it(`maps APIERROR ${code} to its documented description`, async () => {
      const mock = createMockFetch();
      mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
      mock.queueXml(API_ERROR_XML(code));
      if (code === 5) {
        // Code 5 triggers the R5 retry-once-on-expiry path: a re-login and one
        // retried call, which here also fails, so the retry's own failure is
        // what should ultimately surface.
        mock.queueXml(LOGIN_SUCCESS_XML('SESS-2'));
        mock.queueXml(API_ERROR_XML(code));
      }
      const client = new NetboxClient(CONFIG, mock.fetchImpl);

      try {
        await client.call('GetPortals', {});
        expect.unreachable('expected call to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NbapiApiError);
        expect((err as NbapiApiError).message).toContain(String(code));
        expect((err as NbapiApiError).message).toContain(API_ERROR_DESCRIPTIONS[code]);
      }
    });
  }

  it('surfaces CODE=FAIL with the ERRMSG text verbatim', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(FAIL_XML('GetPerson', 'PERSONID 999 is not a valid person.'));
    const client = new NetboxClient(CONFIG, mock.fetchImpl);

    await expect(client.call('GetPerson', { PERSONID: '999' })).rejects.toMatchObject({
      message: expect.stringContaining('PERSONID 999 is not a valid person.'),
    });
  });

  it('returns CODE=NOT FOUND as a normal (non-throwing) result', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(NOT_FOUND_XML('GetPerson'));
    const client = new NetboxClient(CONFIG, mock.fetchImpl);

    const result = await client.call('GetPerson', { PERSONID: '999' });
    expect(result).toEqual({ notFound: true, data: undefined });
  });
});

describe('NetboxClient.logout (R6)', () => {
  it('sends Logout with the active session id and clears the cached session', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetPortals'));
    mock.queueXml(SUCCESS_XML('Logout'));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetPortals', {});
    expect(client.hasSession).toBe(true);

    await client.logout();

    const logoutCalls = mock.calls.filter((c) => c.body.includes('name="Logout"'));
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0].body).toContain('sessionid="SESS-1"');
    expect(client.hasSession).toBe(false);
  });

  it('is a no-op when no session is active', async () => {
    const mock = createMockFetch();
    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.logout();
    expect(mock.calls).toHaveLength(0);
  });

  it('never throws, even if the Logout request itself fails', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetPortals'));
    mock.queueXml(API_ERROR_XML(2));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetPortals', {});
    await expect(client.logout()).resolves.toBeUndefined();
  });
});
