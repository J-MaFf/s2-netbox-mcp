# Spec: `RESOLVEDESCRIPTIONS` reader-description enrichment for `get_portals`

> **Completed 2026-09-16.** Built via the forge loop in 1 round, all 9 acceptance criteria
> (C1-C8, C-final) passed cleanly, including the fast-xml-parser bare-object single-reader
> edge case. This was the last of four sequential RESOLVENAMES/RESOLVEDESCRIPTIONS enrichment
> specs. Shipped in [PR #58](https://github.com/J-MaFf/s2-netbox-mcp/pull/58).

## Goal

Let `get_portals` fill in each nested reader's human-readable `DESCRIPTION` by default, instead of
requiring a separate `find_portals` search or a manual `get_readers` call to decode what a portal
actually is.

## Context

This project is `s2-netbox-mcp`. `get_portals` (`src/tools/portal.ts`) wraps NBAPI's `GetPortals`
command, returning each portal with a nested `READERS` list — but per `find_portals`'s own code
comments (`src/portalSearch.ts`), `GetPortals` **never includes `DESCRIPTION`** on those nested
readers, only `READERKEY`/`NAME`/`PORTALORDER`. `NAME`, both on the portal and on each nested
reader, is a site code (e.g. `"01OF05A"`), not a human-readable location — that only exists as
each reader's own `DESCRIPTION`, which `GetReaders` (a separate command) provides.

**This spec depends on, and reuses, the sibling spec's shared module** —
`specs/archive/get-access-history-resolve-descriptions.md` introduces `src/readerDescriptions.ts` with
`fetchReaderDescriptions(client): Promise<Map<string, string>>` (READERKEY -> DESCRIPTION, one
full-table `GetReaders` fetch). **Build that spec first**; this one imports from the module it
creates rather than duplicating the fetch-and-map logic.

**Decision already made (discussion, this session):** `RESOLVEDESCRIPTIONS` defaults to **on**
(`true`), matching the sibling spec's rationale — the reader table is small and fixed-cost to
fetch regardless of result size (this controller has 68 readers; a full fetch is exactly the same
2 paginated `GetReaders` calls whether `get_portals` returns 1 portal or all 68).

**Key difference from the sibling spec:** that spec adds a *new sibling field*
(`READERDESCRIPTION`) to *flat* access records. `get_portals`'s readers are *nested* objects that
already have a `NAME` field and a documented-but-always-empty `DESCRIPTION` slot conceptually
(it's `GetReaders`' own native field, just never populated by `GetPortals`). This spec **fills in
`DESCRIPTION` directly on each nested reader object** using its natural field name — not a
differently-named field — since that's the exact field `GetReaders` already uses for the same
data; inventing a second name for it here would be inconsistent with the rest of this codebase's
reader-shape conventions (see `get_readers`' own response, and `EnrichedAccessHistoryRecord` in
`src/readerAccessHistory.ts`, which already uses plain field names for enriched data rather than
prefixed ones where a natural name exists).

**Verified facts:**

- `get_portals`' response shape (`src/tools/portal.ts`, wraps `GetPortals`, paginated via
  `STARTFROMKEY`/`NEXTKEY`): `{ PORTALS: { PORTAL: [{ PORTALKEY, NAME, READERS: { READER: [{
  READERKEY, NAME, PORTALORDER }] } }] }, NEXTKEY }`. `fast-xml-parser` collapses a one-child
  `READER` collection to a bare object rather than a list — `src/paging.ts`'s `asRecordList`
  already normalizes this (used throughout `portalSearch.ts`); reuse it here too.
- `get_portals` is paginated (`STARTFROMKEY`/`NEXTKEY`, via the existing `fetchAllPages`-style
  flow already in `src/tools/portal.ts`) — this spec enriches **whatever single page** the caller
  requested, it does not change `get_portals`' own pagination behavior or force-fetch every page.

## Deliverable

- `src/tools/portal.ts` — **modified**: `get_portals` gains `RESOLVEDESCRIPTIONS`.
- `test/tools.test.ts` (or wherever `get_portals` is tested — check `test/portalSearch.test.ts`/
  `test/tools.test.ts` first) — **modified**: new test cases.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `get_portals`'s Zod schema gains `RESOLVEDESCRIPTIONS: z.boolean().optional()`, defaulting
  to `true` when omitted (opt-out, same inverted-default pattern as the sibling spec — call this
  out explicitly in the description, same as that spec's R3/R6). `STARTFROMKEY` is unchanged.
  [verify: a test asserts the schema has exactly `STARTFROMKEY` and `RESOLVEDESCRIPTIONS`]
- R2. When `RESOLVEDESCRIPTIONS` is effectively true (omitted or explicitly `true`): after fetching
  the requested page of portals, call `fetchReaderDescriptions` (imported from
  `src/readerDescriptions.ts`, the sibling spec's module) **once**, then for every nested reader
  in every portal on that page, set its `DESCRIPTION` field from the map (`''` if the reader's
  `READERKEY` has no match — an unknown/deleted reader). Every other field (`PORTALKEY`, portal
  `NAME`, `READERKEY`, reader `NAME`, `PORTALORDER`) is unchanged. [verify: a unit test with a
  scripted multi-portal, multi-reader page asserts every nested reader gains a `DESCRIPTION` field
  matching the fetched map, with exactly one `GetReaders` full-table fetch regardless of how many
  portals/readers are on the page]
- R3. When `RESOLVEDESCRIPTIONS` is explicitly `false`: no `GetReaders` call is made, and nested
  readers are returned exactly as `GetPortals` provides them (no `DESCRIPTION` key added) —
  byte-identical to this tool's behavior before this change. [verify: a unit test with
  `RESOLVEDESCRIPTIONS: false` asserts zero `GetReaders` calls and no `DESCRIPTION` key on any
  nested reader]
- R4. `RESOLVEDESCRIPTIONS` never changes error or not-found handling — only the shape of a
  *successful* result. [verify: a unit test with `RESOLVEDESCRIPTIONS: true` (the default) and a
  scripted not-found/error `GetPortals` response asserts the same not-found/error text as without
  this change]
- R5. The tool description is updated to state what `RESOLVEDESCRIPTIONS` does, that it defaults
  to `true`, and that it costs one `GetReaders` full-table fetch per call (not per portal/reader).
  [verify: a test asserts the description string contains "RESOLVEDESCRIPTIONS" and "true" (or
  "default")]
- R6. `README.md`'s documentation of `get_portals` documents `RESOLVEDESCRIPTIONS`, and notes that
  `find_portals` remains the tool to use for *searching* by description/name — this addition makes
  plain listing richer, it doesn't replace the search tool. [verify: `grep -n RESOLVEDESCRIPTIONS
  README.md` finds an entry for `get_portals`]
- R7. `CHANGELOG.md` gets an `[Unreleased]` entry for this addition.
  [verify: `CHANGELOG.md`'s `[Unreleased]` section names `get_portals` and
  `RESOLVEDESCRIPTIONS`]
- R8. `scripts/live-check.ts`'s existing `get_portals` smoke-check is extended to confirm at least
  one nested reader on a real page has a non-empty `DESCRIPTION` after this change. [verify:
  `npm run test:live` output shows this exercised, PASS]

## Out of scope

- Any change to `get_portals`' own `STARTFROMKEY`/`NEXTKEY` pagination behavior — only the content
  of whatever page is returned changes.
- Any `PORTALDESCRIPTION`-equivalent for the portal itself — portals don't have their own
  description field on this controller; only readers do.
- Changing `find_portals` in any way — it already does its own equivalent join for search
  purposes and is untouched by this spec.
- Caching `fetchReaderDescriptions`'s result across separate tool calls.
- Any write/mutation capability.
- Any change to the 80-command NBAPI allowlist.

## Constraints

- Requires `specs/archive/get-access-history-resolve-descriptions.md` to be implemented first —
  `src/readerDescriptions.ts` must exist before this spec can import from it. Do not duplicate
  `fetchReaderDescriptions`'s logic if that dependency isn't ready yet; block instead.
- TypeScript, matching this project's existing style; no new runtime dependencies.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set.
- C2 (from R2): PASS iff a test proves every nested reader gains the correct `DESCRIPTION` with
  exactly one `GetReaders` fetch.
- C3 (from R3): PASS iff a test proves `RESOLVEDESCRIPTIONS: false` makes zero `GetReaders` calls
  and adds no `DESCRIPTION` key.
- C4 (from R4): PASS iff a test proves error/not-found handling is unaffected.
- C5 (from R5): PASS iff the description string mentions `RESOLVEDESCRIPTIONS` and its default.
- C6 (from R6): PASS iff README.md documents this for `get_portals` and distinguishes it from
  `find_portals`.
- C7 (from R7): PASS iff CHANGELOG.md names this addition.
- C8 (from R8): PASS iff `npm run test:live` (or a description of a manual run) shows this
  exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and the implementation imports `fetchReaderDescriptions` from the sibling spec's
  module rather than reimplementing it.

## Open questions

None.
