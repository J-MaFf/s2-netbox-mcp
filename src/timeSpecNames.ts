import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { fetchAllPages, text } from './paging.js';

/**
 * Shared time-spec-name enrichment, used by `get_time_spec_groups`'s
 * `RESOLVEMEMBERNAMES` path (src/tools/timeSpec.ts) to resolve each group's
 * bare `TIMESPECKEYS.TIMESPECKEY` member key(s) into their human-readable
 * `NAME`s -- see specs/archive/time-spec-groups-resolve-member-names.md.
 *
 * Mirrors `src/readerDescriptions.ts`'s `fetchReaderDescriptions` and
 * `src/timeSpecGroupNames.ts`'s `fetchTimeSpecGroupNames` shape exactly: a
 * `Map`-returning fetch function that never throws, called directly by the
 * tool handler -- no separate `enrichWithX` helper, since the caller here
 * enriches every member of every group on a page in one pass, not a flat
 * list of records each keyed by a single field.
 *
 * Always does exactly one full paginated GetTimeSpecs walk per call,
 * regardless of how many groups/members are on the get_time_spec_groups page
 * being enriched -- never a per-key singular GetTimeSpec lookup.
 *
 * Per-request only: no cache persists between separate calls to this module
 * (see the spec's "Out of scope").
 */

/**
 * R2/R5: fetches every time spec via a fully paginated GetTimeSpecs walk and
 * builds a `TIMESPECKEY -> NAME` map. A time spec whose `TIMESPECKEY`
 * normalizes to the empty string is skipped (not a real time spec identity
 * to key on), so the map never gains a bogus `'' -> name` entry that could
 * wrongly match a group member whose own key happens to be empty.
 *
 * This function itself never throws. If the underlying GetTimeSpecs fetch
 * fails (transient error, permissions, anything else), that failure is
 * caught right here and the function resolves to an **empty** `Map` instead
 * of rejecting -- the same failure-safety shape as `fetchReaderDescriptions`
 * and `fetchTimeSpecGroupNames`. Since `RESOLVEMEMBERNAMES` defaults to
 * `true` (opt-out), an enrichment hiccup must never silently break the
 * primary GetTimeSpecGroups call for a caller who didn't even explicitly ask
 * for member names. An empty map here is indistinguishable, by design, from
 * "no time specs matched" -- callers treat every member key as unmatched
 * (`NAME: ''`) either way.
 */
export async function fetchTimeSpecNames(client: NetboxClient): Promise<Map<string, string>> {
  try {
    const specs = await fetchAllPages(client, NBAPI_COMMANDS.GET_TIME_SPECS, 'TIMESPECS', 'TIMESPEC');
    const namesByTimeSpecKey = new Map<string, string>();
    for (const spec of specs) {
      const timeSpecKey = text(spec.TIMESPECKEY);
      if (timeSpecKey === '') continue;
      namesByTimeSpecKey.set(timeSpecKey, text(spec.NAME));
    }
    return namesByTimeSpecKey;
  } catch {
    return new Map();
  }
}
