import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { asRecord, text } from './paging.js';

/**
 * Shared person-name enrichment, used by every composite tool that attaches
 * a badge-holder's name to a record carrying a `PERSONID` (currently
 * `get_reader_access_history` and `get_access_history`'s `RESOLVENAMES`
 * path — see `specs/archive/get-access-history-resolve-names.md` R5/R7).
 *
 * Extracted from `readerAccessHistory.ts`'s original private
 * `enrichWithPersonNames` and generalized to any record shape carrying a
 * `PERSONID`, so both call sites share one implementation instead of two
 * private copies drifting apart.
 *
 * Calls the person-lookup command (`NBAPI_COMMANDS.GET_PERSON`, read-only/
 * always registered) once per distinct **non-empty** `PERSONID` across the
 * given records — never once per record. This is per-request memoization
 * only: no cache persists between separate calls to this function, matching
 * this project's deliberate avoidance of host-side state (see README's "Out
 * of scope").
 */

export interface PersonEnrichment {
  FIRSTNAME: string;
  LASTNAME: string;
  FULLNAME: string;
  NOTES: string;
}

const EMPTY_ENRICHMENT: PersonEnrichment = { FIRSTNAME: '', LASTNAME: '', FULLNAME: '', NOTES: '' };

/**
 * R6: `''` when both `FIRSTNAME` and `LASTNAME` are empty; the non-empty one
 * alone (no extra whitespace) when exactly one is empty; `"FIRSTNAME
 * LASTNAME"` (single space) when both are non-empty.
 */
function computeFullName(firstName: string, lastName: string): string {
  if (firstName === '' && lastName === '') return '';
  if (firstName === '') return lastName;
  if (lastName === '') return firstName;
  return `${firstName} ${lastName}`;
}

/**
 * R5: attaches `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` (R6) to each of
 * `records` by calling the person-lookup command once per distinct
 * non-empty `PERSONID` (never once per record). A record whose `PERSONID`
 * is the empty string gets empty-string values for all four fields with
 * **no** lookup call made for it. A lookup failure (thrown error, or a
 * not-found-shaped result) for a given `PERSONID` never throws out of this
 * function — every record sharing that `PERSONID` gets empty-string values
 * for all four fields, and other `PERSONID`s are unaffected.
 */
export async function enrichWithPersonNames<T extends { PERSONID: string }>(
  client: NetboxClient,
  records: T[]
): Promise<(T & PersonEnrichment)[]> {
  const enrichmentByPersonId = new Map<string, PersonEnrichment>();
  const distinctPersonIds = [...new Set(records.map((record) => record.PERSONID))].filter((personId) => personId !== '');

  for (const personId of distinctPersonIds) {
    try {
      const result = await client.call(NBAPI_COMMANDS.GET_PERSON, { PERSONID: personId });
      if (result.notFound) {
        enrichmentByPersonId.set(personId, EMPTY_ENRICHMENT);
        continue;
      }
      const person = asRecord(result.data);
      const firstName = text(person.FIRSTNAME);
      const lastName = text(person.LASTNAME);
      enrichmentByPersonId.set(personId, {
        FIRSTNAME: firstName,
        LASTNAME: lastName,
        FULLNAME: computeFullName(firstName, lastName),
        NOTES: text(person.NOTES),
      });
    } catch {
      enrichmentByPersonId.set(personId, EMPTY_ENRICHMENT);
    }
  }

  return records.map((record) => ({
    ...record,
    ...(enrichmentByPersonId.get(record.PERSONID) ?? EMPTY_ENRICHMENT),
  }));
}
