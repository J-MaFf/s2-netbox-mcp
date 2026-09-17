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
  apiPath: '/nbws/goforms/nbapi',
  eventApiPath: '/nbws/goforms/nbapi',
  enableWrites: false,
  enableDestructive: false,
  unlockHolidayGroups: [8, 7, 6] as [number, number, number],
  unlockNamePrefix: 'MCP Unlock Window',
  liveTestPortalKey: undefined,
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

  it('posts to <baseUrl><apiPath>, defaulting to /nbws/goforms/nbapi (R20)', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetAPIVersion', { VERSION: '5.0' }));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetAPIVersion', {});

    for (const call of mock.calls) {
      expect(call.url).toBe('https://netbox.example.internal/nbws/goforms/nbapi');
    }
  });

  it('honours a NETBOX_API_PATH override for the request URL (R20)', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetAPIVersion', { VERSION: '5.0' }));

    const client = new NetboxClient({ ...CONFIG, apiPath: '/goforms/nbapi' }, mock.fetchImpl);
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

describe('NetboxClient non-2xx HTTP error surfacing (R21 / C15)', () => {
  it('surfaces a 410 with the status, the request path, and a NETBOX_API_PATH hint, with no credentials', async () => {
    const mock = createMockFetch();
    mock.queueXml('', 410);

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    let message = '';
    try {
      await client.call('GetAPIVersion', {});
      expect.unreachable('expected call to throw');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('410');
    expect(message).toContain('/nbws/goforms/nbapi');
    expect(message).toContain('NETBOX_API_PATH');
    expect(message).not.toContain(CONFIG.password);
    expect(message).not.toContain(CONFIG.username);
  });

  it('surfaces a 500 with the status and request path, with no credentials', async () => {
    const mock = createMockFetch();
    mock.queueXml('', 500);

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    let message = '';
    try {
      await client.call('GetAPIVersion', {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('500');
    expect(message).toContain('/nbws/goforms/nbapi');
    expect(message).not.toContain(CONFIG.password);
    expect(message).not.toContain(CONFIG.username);
  });
});

describe('NetboxClient APIERROR 5 after successful re-login (R22 / C16)', () => {
  it('names "Use login username/password" when Login succeeds but the retried command still gets APIERROR 5', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1')); // initial login
    mock.queueXml(API_ERROR_XML(5)); // original call fails
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-2')); // re-login succeeds
    mock.queueXml(API_ERROR_XML(5)); // retried call still fails

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    let message = '';
    try {
      await client.call('GetPortals', {});
      expect.unreachable('expected call to throw');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('Use login username/password');
  });

  it('does not name "Use login username/password" when Login itself returns APIERROR 5', async () => {
    const mock = createMockFetch();
    mock.queueXml(API_ERROR_XML(5)); // Login itself fails

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    let message = '';
    try {
      await client.call('GetPortals', {});
      expect.unreachable('expected call to throw');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('Use login username/password');
    expect(message).toContain('5');
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

describe('NetboxClient per-command request path (R6)', () => {
  it('posts TriggerEvent to NETBOX_EVENT_API_PATH when it differs from NETBOX_API_PATH, while another command still uses NETBOX_API_PATH', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('TriggerEvent'));
    mock.queueXml(SUCCESS_XML('GetPortals'));

    const client = new NetboxClient({ ...CONFIG, eventApiPath: '/appd/nbapi' }, mock.fetchImpl);
    await client.call('TriggerEvent', { EVENTNAME: 'Door Alarm', EVENTACTION: 'ACTIVATE' });
    await client.call('GetPortals', {});

    // calls[0] is Login (always on the main api path); calls[1] is TriggerEvent; calls[2] is GetPortals.
    expect(mock.calls[1].url).toBe('https://netbox.example.internal/appd/nbapi');
    expect(mock.calls[2].url).toBe('https://netbox.example.internal/nbws/goforms/nbapi');
  });

  it('posts TriggerEvent to the same path as everything else when NETBOX_EVENT_API_PATH is not overridden', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('TriggerEvent'));

    const client = new NetboxClient(CONFIG, mock.fetchImpl); // eventApiPath === apiPath (config default)
    await client.call('TriggerEvent', { EVENTNAME: 'Door Alarm', EVENTACTION: 'ACTIVATE' });

    expect(mock.calls[1].url).toBe('https://netbox.example.internal/nbws/goforms/nbapi');
  });

  it('Login and Logout always use NETBOX_API_PATH, never the event path', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetAPIVersion', { APIVERSION: '6.2.0' }));
    mock.queueXml(SUCCESS_XML('Logout'));

    const client = new NetboxClient({ ...CONFIG, eventApiPath: '/appd/nbapi' }, mock.fetchImpl);
    await client.call('GetAPIVersion', {}); // triggers Login, then GetAPIVersion
    await client.logout();

    for (const call of mock.calls) {
      expect(call.url).toBe('https://netbox.example.internal/nbws/goforms/nbapi');
    }
  });
});

describe('NetboxClient.lastServerDate (issue #102)', () => {
  it('parses the HTTP Date header from the most recent response', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'), 200, { Date: 'Thu, 17 Sep 2026 09:09:50 GMT' });
    mock.queueXml(SUCCESS_XML('GetAccessHistory'), 200, { Date: 'Thu, 17 Sep 2026 09:10:12 GMT' });

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    expect(client.lastServerDate).toBeUndefined(); // before any request
    await client.call('GetAccessHistory', { MAXRECORDS: '1' });

    // Reflects the *most recent* response (GetAccessHistory), not the Login response.
    expect(client.lastServerDate).toEqual(new Date('2026-09-17T09:10:12.000Z'));
  });

  it('is undefined when the response has no Date header', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1')); // no headers passed
    mock.queueXml(SUCCESS_XML('GetPortals'));

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetPortals', {});

    expect(client.lastServerDate).toBeUndefined();
  });

  it('is undefined when the Date header is present but unparseable', async () => {
    const mock = createMockFetch();
    mock.queueXml(LOGIN_SUCCESS_XML('SESS-1'));
    mock.queueXml(SUCCESS_XML('GetPortals'), 200, { Date: 'not a date' });

    const client = new NetboxClient(CONFIG, mock.fetchImpl);
    await client.call('GetPortals', {});

    expect(client.lastServerDate).toBeUndefined();
  });
});
