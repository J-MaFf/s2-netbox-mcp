import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS } from './commands.js';
import { fetchAllPages, text } from './paging.js';

/**
 * Shared reader-group-name enrichment, used by `get_access_level`'s
 * `RESOLVEGROUPNAMES` path (src/tools/accessLevel.ts) to resolve a bare
 * `READERGROUPKEY` into its human-readable `NAME`.
 *
 * Mirrors `src/readerDescriptions.ts`'s `fetchReaderDescriptions` shape
 * exactly: a `Map`-returning fetch function, never throws, used directly by
 * a tool handler — no separate `enrichWithX` helper, since callers of this
 * module enrich a single flat object (one `READERGROUPKEY` per call), not a
 * list of records.
 *
 * Resolves via the full paginated GetReaderGroups list, matching
 * client-side, rather than the singular GetReaderGroup command — for
 * consistency with `src/timeSpecGroupNames.ts`'s resolver (whose sibling
 * singular command, GetTimeSpecGroup, is verified broken on this
 * controller) and to avoid relying on an unverified singular lookup here
 * (see the spec's Context). So, like that module, this always does exactly
 * one full paginated GetReaderGroups walk per call, never a per-key
 * singular lookup.
 *
 * Per-request only: no cache persists between separate calls to this module
 * (see the spec's "Out of scope").
 */

/**
 * R2/R5 (specs/archive/access-level-resolve-group-names.md): fetches every reader
 * group via a fully paginated GetReaderGroups walk and builds a
 * `READERGROUPKEY -> NAME` map. A group whose `READERGROUPKEY` normalizes to
 * the empty string is skipped (not a real group identity to key on), so the
 * map never gains a bogus `'' -> name` entry that could wrongly match a
 * response whose own `READERGROUPKEY` happens to be empty.
 *
 * This function itself never throws. If the underlying GetReaderGroups
 * fetch fails (transient error, permissions, anything else), that failure is
 * caught right here and the function resolves to an **empty** `Map` instead
 * of rejecting — the same failure-safety shape as
 * `fetchReaderDescriptions`/`fetchTimeSpecGroupNames` (R5): since
 * `RESOLVEGROUPNAMES` defaults to `true` (opt-out), an enrichment hiccup
 * must never silently break the primary GetAccessLevel call for a caller
 * who didn't even explicitly ask for group names. An empty map here is
 * indistinguishable, by design, from "no groups matched" — callers treat an
 * unmatched `READERGROUPKEY` as `READERGROUPNAME: ''` either way.
 */
export async function fetchReaderGroupNames(client: NetboxClient): Promise<Map<string, string>> {
  try {
    const groups = await fetchAllPages(client, NBAPI_COMMANDS.GET_READER_GROUPS, 'READERGROUPS', 'READERGROUP');
    const namesByReaderGroupKey = new Map<string, string>();
    for (const group of groups) {
      const readerGroupKey = text(group.READERGROUPKEY);
      if (readerGroupKey === '') continue;
      namesByReaderGroupKey.set(readerGroupKey, text(group.NAME));
    }
    return namesByReaderGroupKey;
  } catch {
    return new Map();
  }
}
