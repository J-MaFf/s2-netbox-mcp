import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { fetchAllPages, text } from './paging.js';

/**
 * Shared time-spec-group-name enrichment, used by `get_access_level`'s
 * `RESOLVEGROUPNAMES` path (src/tools/accessLevel.ts) to resolve a bare
 * `TIMESPECGROUPKEY` into its human-readable `NAME`, and reused as-is by a
 * later, separate spec that resolves `get_portal_group`'s own
 * `UNLOCKTIMESPECGROUPKEY` (specs/archive/portal-group-resolve-group-names.md) —
 * see specs/archive/access-level-resolve-group-names.md's Context.
 *
 * Mirrors `src/readerDescriptions.ts`'s `fetchReaderDescriptions` shape
 * exactly: a `Map`-returning fetch function, never throws, used directly by
 * a tool handler — no separate `enrichWithX` helper, since callers of this
 * module enrich a single flat object (one `TIMESPECGROUPKEY` per call), not
 * a list of records.
 *
 * Resolves via the full paginated GetTimeSpecGroups list and matches
 * client-side — never the singular GetTimeSpecGroup command, which is
 * verified broken on this controller: it returns CODE=FAIL/ERRMSG=
 * "NOT FOUND" even for a genuinely existing group (see
 * src/unlockWindow/managed.ts's own `fetchTimeSpecGroups` and the spec's
 * Context for the live verification). So, like that module, this always
 * does exactly one full paginated GetTimeSpecGroups walk per call, never a
 * per-key singular lookup.
 *
 * Per-request only: no cache persists between separate calls to this module
 * (see the spec's "Out of scope").
 */

/**
 * R2/R5 (specs/archive/access-level-resolve-group-names.md): fetches every time
 * spec group via a fully paginated GetTimeSpecGroups walk and builds a
 * `TIMESPECGROUPKEY -> NAME` map. A group whose `TIMESPECGROUPKEY`
 * normalizes to the empty string is skipped (not a real group identity to
 * key on), so the map never gains a bogus `'' -> name` entry that could
 * wrongly match a response whose own `TIMESPECGROUPKEY` happens to be empty.
 *
 * This function itself never throws. If the underlying GetTimeSpecGroups
 * fetch fails (transient error, permissions, anything else), that failure is
 * caught right here and the function resolves to an **empty** `Map` instead
 * of rejecting — the same failure-safety shape as
 * `fetchReaderDescriptions` (R5): since `RESOLVEGROUPNAMES` defaults to
 * `true` (opt-out), an enrichment hiccup must never silently break the
 * primary GetAccessLevel call for a caller who didn't even explicitly ask
 * for group names. An empty map here is indistinguishable, by design, from
 * "no groups matched" — callers treat an unmatched `TIMESPECGROUPKEY` as
 * `TIMESPECGROUPNAME: ''` either way.
 */
export async function fetchTimeSpecGroupNames(client: NetboxClient): Promise<Map<string, string>> {
  try {
    const groups = await fetchAllPages(client, NBAPI_COMMANDS.GET_TIME_SPEC_GROUPS, 'TIMESPECGROUPS', 'TIMESPECGROUP');
    const namesByTimeSpecGroupKey = new Map<string, string>();
    for (const group of groups) {
      const timeSpecGroupKey = text(group.TIMESPECGROUPKEY);
      if (timeSpecGroupKey === '') continue;
      namesByTimeSpecGroupKey.set(timeSpecGroupKey, text(group.NAME));
    }
    return namesByTimeSpecGroupKey;
  } catch {
    return new Map();
  }
}
