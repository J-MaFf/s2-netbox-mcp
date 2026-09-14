import { describe, expect, it } from 'vitest';
import { loadConfigFromEnv, NetboxConfigError, DEFAULT_NETBOX_API_PATH } from '../src/config.js';

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
