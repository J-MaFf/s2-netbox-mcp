import { describe, expect, it } from 'vitest';
import { API_ERROR_DESCRIPTIONS, describeApiError, NbapiApiError, NbapiFailError } from '../src/errors.js';

describe('APIERROR mapping (R7)', () => {
  it('documents exactly the six APIERROR codes', () => {
    expect(Object.keys(API_ERROR_DESCRIPTIONS).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('formats each code as "<code>: <description>"', () => {
    for (const [codeStr, description] of Object.entries(API_ERROR_DESCRIPTIONS)) {
      expect(describeApiError(Number(codeStr))).toBe(`${codeStr}: ${description}`);
    }
  });

  it('matches the example given in the spec for code 2', () => {
    expect(describeApiError(2)).toBe('2: The API is not enabled on the system.');
  });

  it('NbapiApiError surfaces the numeric code and its documented meaning in the message', () => {
    for (const codeStr of Object.keys(API_ERROR_DESCRIPTIONS)) {
      const code = Number(codeStr);
      const err = new NbapiApiError(code);
      expect(err.message).toContain(String(code));
      expect(err.message).toContain(API_ERROR_DESCRIPTIONS[code]);
    }
  });
});

describe('NbapiFailError (R8)', () => {
  it('includes the ERRMSG text verbatim', () => {
    const err = new NbapiFailError('Person 999 does not exist.');
    expect(err.message).toContain('Person 999 does not exist.');
  });

  it('handles a missing ERRMSG gracefully', () => {
    const err = new NbapiFailError(undefined);
    expect(err.message).toBeTruthy();
  });
});
