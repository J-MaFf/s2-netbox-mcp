import { describe, expect, it } from 'vitest';
import {
  loadConfigFromEnv,
  NetboxConfigError,
  DEFAULT_NETBOX_API_PATH,
  DEFAULT_UNLOCK_HOLIDAY_GROUPS,
  DEFAULT_UNLOCK_NAME_PREFIX,
  DEFAULT_DAILY_UNLOCK_HOLIDAY_GROUP,
  DEFAULT_DAILY_UNLOCK_NAME_PREFIX,
} from '../src/config.js';

const FULL_ENV = {
  NETBOX_BASE_URL: 'https://netbox.example.internal',
  NETBOX_USERNAME: 'svc-account',
  NETBOX_PASSWORD: 'super-secret-password',
};

describe('loadConfigFromEnv (R3)', () => {
  it('loads a valid full configuration', () => {
    const config = loadConfigFromEnv(FULL_ENV);
    expect(config).toEqual({
      baseUrl: 'https://netbox.example.internal',
      username: 'svc-account',
      password: 'super-secret-password',
      allowInsecureTls: false,
      apiPath: '/nbws/goforms/nbapi',
      eventApiPath: '/nbws/goforms/nbapi',
      enableWrites: false,
      enableDestructive: false,
      unlockHolidayGroups: [8, 7, 6],
      unlockNamePrefix: 'MCP Unlock Window',
      dailyUnlockHolidayGroup: 5,
      dailyUnlockNamePrefix: 'MCP Daily Unlock Window',
      liveTestPortalKey: undefined,
    });
  });

  it('strips a trailing slash from the base URL', () => {
    const config = loadConfigFromEnv({ ...FULL_ENV, NETBOX_BASE_URL: 'https://netbox.example.internal/' });
    expect(config.baseUrl).toBe('https://netbox.example.internal');
  });

  it.each(['NETBOX_BASE_URL', 'NETBOX_USERNAME', 'NETBOX_PASSWORD'] as const)(
    'throws a one-line NetboxConfigError naming %s when it is missing, with no value leaked',
    (missingVar) => {
      const env = { ...FULL_ENV };
      delete (env as Record<string, string | undefined>)[missingVar];

      let thrown: unknown;
      try {
        loadConfigFromEnv(env);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(NetboxConfigError);
      const err = thrown as NetboxConfigError;
      expect(err.message.split('\n')).toHaveLength(1);
      expect(err.message).toContain(missingVar);
      expect(err.message).not.toContain('super-secret-password');
    }
  );

  it('reports every missing variable when more than one is unset', () => {
    let thrown: unknown;
    try {
      loadConfigFromEnv({});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetboxConfigError);
    const err = thrown as NetboxConfigError;
    expect(err.message).toContain('NETBOX_BASE_URL');
    expect(err.message).toContain('NETBOX_USERNAME');
    expect(err.message).toContain('NETBOX_PASSWORD');
  });

  it('defaults NETBOX_ALLOW_INSECURE_TLS to false when unset', () => {
    expect(loadConfigFromEnv(FULL_ENV).allowInsecureTls).toBe(false);
  });

  it('only enables insecure TLS on an explicit truthy value', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ALLOW_INSECURE_TLS: 'true' }).allowInsecureTls).toBe(true);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ALLOW_INSECURE_TLS: '1' }).allowInsecureTls).toBe(true);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ALLOW_INSECURE_TLS: 'false' }).allowInsecureTls).toBe(false);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ALLOW_INSECURE_TLS: 'nope' }).allowInsecureTls).toBe(false);
  });
});

describe('loadConfigFromEnv apiPath resolution (R20 / C14)', () => {
  it('defaults NETBOX_API_PATH to /nbws/goforms/nbapi when unset', () => {
    expect(loadConfigFromEnv(FULL_ENV).apiPath).toBe('/nbws/goforms/nbapi');
    expect(loadConfigFromEnv(FULL_ENV).apiPath).toBe(DEFAULT_NETBOX_API_PATH);
  });

  it('defaults NETBOX_API_PATH to /nbws/goforms/nbapi when set to an empty string', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_API_PATH: '' }).apiPath).toBe('/nbws/goforms/nbapi');
  });

  it('honours a non-empty NETBOX_API_PATH override verbatim', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_API_PATH: '/goforms/nbapi' }).apiPath).toBe('/goforms/nbapi');
  });

  it('adds a missing leading slash to a NETBOX_API_PATH override', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_API_PATH: 'goforms/nbapi' }).apiPath).toBe('/goforms/nbapi');
  });
});

describe('loadConfigFromEnv NETBOX_ENABLE_WRITES / NETBOX_ENABLE_DESTRUCTIVE (R7)', () => {
  it('default both to false', () => {
    const config = loadConfigFromEnv(FULL_ENV);
    expect(config.enableWrites).toBe(false);
    expect(config.enableDestructive).toBe(false);
  });

  it('only a truthy value (1/true/yes, case-insensitive) enables each flag', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ENABLE_WRITES: 'true' }).enableWrites).toBe(true);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ENABLE_WRITES: '1' }).enableWrites).toBe(true);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ENABLE_WRITES: 'YES' }).enableWrites).toBe(true);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ENABLE_WRITES: 'false' }).enableWrites).toBe(false);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ENABLE_WRITES: 'nope' }).enableWrites).toBe(false);

    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ENABLE_DESTRUCTIVE: 'true' }).enableDestructive).toBe(true);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_ENABLE_DESTRUCTIVE: 'no' }).enableDestructive).toBe(false);
  });
});

describe('loadConfigFromEnv NETBOX_EVENT_API_PATH (R6/R7)', () => {
  it('defaults to the resolved NETBOX_API_PATH when unset', () => {
    expect(loadConfigFromEnv(FULL_ENV).eventApiPath).toBe('/nbws/goforms/nbapi');
  });

  it('defaults to the resolved NETBOX_API_PATH when set to an empty string', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_EVENT_API_PATH: '' }).eventApiPath).toBe('/nbws/goforms/nbapi');
  });

  it('tracks a custom NETBOX_API_PATH when NETBOX_EVENT_API_PATH is unset', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_API_PATH: '/goforms/nbapi' }).eventApiPath).toBe('/goforms/nbapi');
  });

  it('honours a non-empty NETBOX_EVENT_API_PATH override verbatim, independent of NETBOX_API_PATH', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_EVENT_API_PATH: '/appd/nbapi' }).eventApiPath).toBe('/appd/nbapi');
  });

  it('adds a missing leading slash to a NETBOX_EVENT_API_PATH override', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_EVENT_API_PATH: 'appd/nbapi' }).eventApiPath).toBe('/appd/nbapi');
  });
});

describe('loadConfigFromEnv NETBOX_UNLOCK_HOLIDAY_GROUPS (R7)', () => {
  it('defaults to 8,7,6', () => {
    expect(DEFAULT_UNLOCK_HOLIDAY_GROUPS).toBe('8,7,6');
    expect(loadConfigFromEnv(FULL_ENV).unlockHolidayGroups).toEqual([8, 7, 6]);
  });

  it('accepts 1-3 distinct integers in 1..8', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_HOLIDAY_GROUPS: '1' }).unlockHolidayGroups).toEqual([1]);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_HOLIDAY_GROUPS: '1,2' }).unlockHolidayGroups).toEqual([1, 2]);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_HOLIDAY_GROUPS: '8, 7, 6' }).unlockHolidayGroups).toEqual([8, 7, 6]);
  });

  it('treats an empty override as unset (falls back to the default, not rejected)', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_HOLIDAY_GROUPS: '' }).unlockHolidayGroups).toEqual([8, 7, 6]);
  });

  it.each(['0', '9', '1,1', '1,2,3,4', 'a,b', '1,', ','])(
    'rejects an invalid value (%s) with a one-line NetboxConfigError naming the variable and the rule',
    (raw) => {
      let thrown: unknown;
      try {
        loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_HOLIDAY_GROUPS: raw });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NetboxConfigError);
      const err = thrown as NetboxConfigError;
      expect(err.message.split('\n')).toHaveLength(1);
      expect(err.message).toContain('NETBOX_UNLOCK_HOLIDAY_GROUPS');
    }
  );
});

describe('loadConfigFromEnv NETBOX_UNLOCK_NAME_PREFIX (R7)', () => {
  it('defaults to "MCP Unlock Window"', () => {
    expect(DEFAULT_UNLOCK_NAME_PREFIX).toBe('MCP Unlock Window');
    expect(loadConfigFromEnv(FULL_ENV).unlockNamePrefix).toBe('MCP Unlock Window');
  });

  it('accepts a 1-40 character override', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_NAME_PREFIX: 'X' }).unlockNamePrefix).toBe('X');
    const fortyChars = 'A'.repeat(40);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_NAME_PREFIX: fortyChars }).unlockNamePrefix).toBe(fortyChars);
  });

  it('treats an empty override as unset (default)', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_NAME_PREFIX: '' }).unlockNamePrefix).toBe('MCP Unlock Window');
  });

  it('rejects an over-long (41+ character) override with a one-line NetboxConfigError naming the variable', () => {
    let thrown: unknown;
    try {
      loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_NAME_PREFIX: 'A'.repeat(41) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetboxConfigError);
    const err = thrown as NetboxConfigError;
    expect(err.message.split('\n')).toHaveLength(1);
    expect(err.message).toContain('NETBOX_UNLOCK_NAME_PREFIX');
  });
});

describe('loadConfigFromEnv NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP (daily-unlock-window spec R1)', () => {
  it('defaults to 5', () => {
    expect(DEFAULT_DAILY_UNLOCK_HOLIDAY_GROUP).toBe('5');
    expect(loadConfigFromEnv(FULL_ENV).dailyUnlockHolidayGroup).toBe(5);
  });

  it('accepts a valid override not present in NETBOX_UNLOCK_HOLIDAY_GROUPS', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP: '2' }).dailyUnlockHolidayGroup).toBe(2);
  });

  it('treats an empty override as unset (falls back to the default)', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP: '' }).dailyUnlockHolidayGroup).toBe(5);
  });

  it.each(['0', '9', 'a', '1,2', '10'])(
    'rejects a value that is not a single integer in 1..8 with a one-line NetboxConfigError naming the variable',
    (raw) => {
      let thrown: unknown;
      try {
        loadConfigFromEnv({ ...FULL_ENV, NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP: raw });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NetboxConfigError);
      const err = thrown as NetboxConfigError;
      expect(err.message.split('\n')).toHaveLength(1);
      expect(err.message).toContain('NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP');
    }
  );

  it('rejects a value equal to any group in the resolved NETBOX_UNLOCK_HOLIDAY_GROUPS list, naming both variables', () => {
    let thrown: unknown;
    try {
      loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_HOLIDAY_GROUPS: '8,7,6', NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP: '7' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetboxConfigError);
    const err = thrown as NetboxConfigError;
    expect(err.message.split('\n')).toHaveLength(1);
    expect(err.message).toContain('NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP');
    expect(err.message).toContain('NETBOX_UNLOCK_HOLIDAY_GROUPS');
  });

  it('rejects the default (5) colliding with a custom NETBOX_UNLOCK_HOLIDAY_GROUPS', () => {
    let thrown: unknown;
    try {
      loadConfigFromEnv({ ...FULL_ENV, NETBOX_UNLOCK_HOLIDAY_GROUPS: '5' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetboxConfigError);
    expect((thrown as NetboxConfigError).message).toContain('NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP');
  });
});

describe('loadConfigFromEnv NETBOX_DAILY_UNLOCK_NAME_PREFIX (daily-unlock-window spec R1)', () => {
  it('defaults to "MCP Daily Unlock Window"', () => {
    expect(DEFAULT_DAILY_UNLOCK_NAME_PREFIX).toBe('MCP Daily Unlock Window');
    expect(loadConfigFromEnv(FULL_ENV).dailyUnlockNamePrefix).toBe('MCP Daily Unlock Window');
  });

  it('accepts a 1-40 character override', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_DAILY_UNLOCK_NAME_PREFIX: 'X' }).dailyUnlockNamePrefix).toBe('X');
    const fortyChars = 'A'.repeat(40);
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_DAILY_UNLOCK_NAME_PREFIX: fortyChars }).dailyUnlockNamePrefix).toBe(fortyChars);
  });

  it('treats an empty override as unset (default)', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_DAILY_UNLOCK_NAME_PREFIX: '' }).dailyUnlockNamePrefix).toBe('MCP Daily Unlock Window');
  });

  it('rejects an over-long (41+ character) override with a one-line NetboxConfigError naming the variable', () => {
    let thrown: unknown;
    try {
      loadConfigFromEnv({ ...FULL_ENV, NETBOX_DAILY_UNLOCK_NAME_PREFIX: 'A'.repeat(41) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetboxConfigError);
    const err = thrown as NetboxConfigError;
    expect(err.message.split('\n')).toHaveLength(1);
    expect(err.message).toContain('NETBOX_DAILY_UNLOCK_NAME_PREFIX');
  });
});

describe('loadConfigFromEnv NETBOX_LIVE_TEST_PORTALKEY (R7)', () => {
  it('defaults to undefined', () => {
    expect(loadConfigFromEnv(FULL_ENV).liveTestPortalKey).toBeUndefined();
  });

  it('passes through a configured value verbatim', () => {
    expect(loadConfigFromEnv({ ...FULL_ENV, NETBOX_LIVE_TEST_PORTALKEY: '56' }).liveTestPortalKey).toBe('56');
  });
});
