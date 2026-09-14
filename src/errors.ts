/**
 * The six documented NBAPI `<APIERROR>` codes and their meanings, per the
 * NBAPI error model described in "Web-Based API for S2 NetBox and S2 Global"
 * (LenelS2, doc #API-UG-14).
 */
export const API_ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  1: 'The API failed to initialize.',
  2: 'The API is not enabled on the system.',
  3: 'The call contains an invalid API command.',
  4: 'The API was unable to parse the command request.',
  5: 'There was an authentication failure.',
  6: 'The XML code contains an unknown command.',
};

/** Formats an APIERROR code as "<code>: <documented description>". */
export function describeApiError(code: number): string {
  const description = API_ERROR_DESCRIPTIONS[code] ?? 'Undocumented APIERROR code.';
  return `${code}: ${description}`;
}

/** An NBAPI-level failure: the response contained an `<APIERROR>` element. */
export class NbapiApiError extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`NetBox NBAPI error ${describeApiError(code)}`);
    this.name = 'NbapiApiError';
    this.code = code;
  }
}

/** A command-level failure: the response's `<CODE>` was `FAIL`. */
export class NbapiFailError extends Error {
  readonly errmsg: string | undefined;

  constructor(errmsg: string | undefined) {
    super(errmsg ? `NetBox NBAPI command failed: ${errmsg}` : 'NetBox NBAPI command failed.');
    this.name = 'NbapiFailError';
    this.errmsg = errmsg;
  }
}
