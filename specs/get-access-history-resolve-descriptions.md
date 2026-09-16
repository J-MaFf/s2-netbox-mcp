# Spec: `RESOLVEDESCRIPTIONS` reader-description enrichment for the access-record tools

## Goal

Let the three tools that return raw reader/portal codes (`READER`/`PORTALNAME`, e.g.
`"02RB06"`) also surface the human-readable `READERDESCRIPTION` (e.g. `"HALLWAY TO ROUND BED
AREA"`) alongside them, by default — without a second manual lookup.

## Context

This project is `s2-netbox-mcp`. Three existing tools return access records keyed by
`READERKEY`, but none of them include the reader's human-readable `DESCRIPTION` — only its
code-like `NAME` (as `READER` or `PORTALNAME` depending on the tool):

- `get_access_history` (`src/tools/events.ts`) — per-record `READER`/`READERKEY`.
- `get_reader_access_history` (`src/readerAccessHistory.ts`/`src/tools/events.ts`) — per-record
  `READER`/`READERKEY`, but **every record shares the same `READERKEY`** (the tool's own
  `READERKEY` input parameter) — see R4 for why this changes where the field goes.
- `get_card_access_details` (`src/tools/person.ts`) — per-record `READERKEY`/`PORTALKEY`/
  `PORTALNAME` (confirmed live this session: `{"READERKEY": "52", "PORTALKEY": "18",
  "PORTALNAME": "02RB06"}` — `PORTALNAME` is a site code, not a description).

**Decisions already made (discussion, this session) — do not re-litigate these:**
- Defaults to **on** (`true`), not opt-in like `RESOLVENAMES`. Rationale: unlike person lookups
  (cost scales with how many distinct people appear in a result — unbounded), reader descriptions
  come from a **small, fixed universe** — this controller has 68 readers total, and `find_portals`
  already proves the whole set fetches in exactly 2 paginated calls (`GetPortals`/`GetReaders`)
  regardless of how many results the caller's query returns. The cost doesn't scale with result
  size, so there's no reason to make callers opt in to something this cheap.
- Adds a **new** field, `READERDESCRIPTION` — does not replace or rename the existing `READER`/
  `PORTALNAME` fields. Mirrors how `FULLNAME` was added without touching `FIRSTNAME`/`LASTNAME`.
- **Independent flag from `RESOLVENAMES`** — a caller can request names, descriptions, both, or
  neither. Not folded into one combined enrichment flag.

**Verified facts:**

- `src/portalSearch.ts` already proves the fetch-and-join pattern this spec reuses: `GetReaders`
  has no filter, so fetching every reader (`fetchAllPages(client, NBAPI_COMMANDS.GET_READERS,
  'READERS', 'READER')`, already shared via `src/paging.ts`) and joining by `READERKEY`
  client-side is the established approach — reuse the exact same `fetchAllPages` call, don't
  reinvent pagination for this.
- Every reader returned by `GetReaders` has `READERKEY`, `NAME`, `DESCRIPTION` (confirmed
  throughout this session's live queries).
- `get_reader_access_history`'s matches are **always** for one caller-supplied `READERKEY` — every
  record in its result has the identical description. Repeating the same string on every record
  would be pure duplication; this spec instead adds a single top-level `READERDESCRIPTION` field
  to that tool's result object (alongside its existing `READERKEY`/`scanWindow`/`matchCount`/
  `truncated` fields), not a per-record field. This is a deliberate asymmetry from the other two
  tools, not an inconsistency to "fix."
- `get_card_access_details` is separately gaining `RESOLVENAMES` in
  `specs/get-card-access-details-resolve-names.md` (a different, independent feature touching the
  same tool). Building that spec first (or this one first) doesn't matter functionally, but
  running both through forge back-to-back rather than in parallel avoids two branches editing the
  same `server.tool('get_card_access_details', ...)` block concurrently.

## Deliverable

- `src/readerDescriptions.ts` — **new** shared module: `fetchReaderDescriptions(client):
  Promise<Map<string, string>>` (READERKEY -> DESCRIPTION, empty map entries never included) and
  `enrichWithReaderDescriptions<T extends { READERKEY: string }>(client, records: T[]):
  Promise<(T & { READERDESCRIPTION: string })[]>`.
- `src/tools/events.ts` — **modified**: `get_access_history` and `get_reader_access_history` gain
  `RESOLVEDESCRIPTIONS`.
- `src/readerAccessHistory.ts` — **modified**: `getReaderAccessHistory` adds the single top-level
  `READERDESCRIPTION` field when requested.
- `src/tools/person.ts` — **modified**: `get_card_access_details` gains `RESOLVEDESCRIPTIONS`.
- `test/readerDescriptions.test.ts` — **new**: unit tests for the shared helper.
- `test/tools.test.ts`, `test/readerAccessHistory.test.ts` — **modified**: new test cases.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `src/readerDescriptions.ts` exports `fetchReaderDescriptions(client: NetboxClient):
  Promise<Map<string, string>>`, fetching every reader via `fetchAllPages(client,
  NBAPI_COMMANDS.GET_READERS, 'READERS', 'READER')` and building a `READERKEY -> DESCRIPTION` map
  (using `text()` from `src/paging.ts` to normalize each field). [verify: a unit test with a
  scripted multi-page `GetReaders` response asserts the returned map has one entry per reader,
  correctly keyed]
- R2. `src/readerDescriptions.ts` exports `enrichWithReaderDescriptions<T extends { READERKEY:
  string }>(client, records: T[]): Promise<(T & { READERDESCRIPTION: string })[]>`. It calls
  `fetchReaderDescriptions` **exactly once** regardless of how many records are passed (not once
  per record — same per-request-memoization spirit as `personEnrichment.ts`, but here it's a
  single full-table fetch rather than per-key lookups, since the reader table is small and
  unfiltered `GetReaders` already returns everything). A record whose `READERKEY` has no match in
  the map (an unknown or deleted reader) gets `READERDESCRIPTION: ''`. [verify: a unit test with 5
  records (some sharing `READERKEY`s) asserts exactly one `GetReaders` fetch (i.e., exactly one
  full paginated walk, not one per record); a unit test with a record whose `READERKEY` isn't in
  the fetched set asserts `READERDESCRIPTION: ''` for that record and does not throw]
- R2b. **Resolved ambiguity, added after round 1 generation:** if `fetchReaderDescriptions`'s
  `GetReaders` call itself throws (e.g. a transient/permissions failure — distinct from R2's
  per-record "no match in the map" case, which isn't a failure at all), `enrichWithReaderDescriptions`
  must **not** propagate that error. It must catch it and return every input record with
  `READERDESCRIPTION: ''`, exactly as if every `READERKEY` were simply unmatched. Rationale:
  `RESOLVEDESCRIPTIONS` defaults to `true` (R3/R4), so an enrichment hiccup must never silently
  break the primary call for every caller who didn't even explicitly ask for descriptions — this
  mirrors `enrichWithPersonNames`'s existing per-`PERSONID` failure isolation, generalized to a
  single all-or-nothing fetch (there's no smaller unit to isolate a failure to here, so the whole
  fetch degrades together rather than throwing). [verify: a unit test where the `GetReaders` call
  is scripted to throw asserts `enrichWithReaderDescriptions` does not throw and returns every
  record with `READERDESCRIPTION: ''`; a further unit test confirms this propagates correctly
  through all three tools — `RESOLVEDESCRIPTIONS` true with a failing `GetReaders` still returns
  the primary data (access records / card details) successfully, just without descriptions]
- R3. `get_access_history` and `get_card_access_details` each gain `RESOLVEDESCRIPTIONS:
  z.boolean().optional()`, **defaulting to `true`** when omitted (opt-*out*, not opt-in — the
  first boolean param in this codebase with that default; call this out explicitly in both tool
  descriptions since it inverts the usual "optional defaults to off" pattern used everywhere
  else, e.g. `RESOLVENAMES`, `dryRun`). When effectively true (omitted or explicitly `true`), each
  returned access record is passed through `enrichWithReaderDescriptions`, adding
  `READERDESCRIPTION` per record, preserving every other original field and the response envelope
  shape exactly as `RESOLVENAMES` already does for `get_access_history` (per that sibling spec).
  When explicitly `false`, no `GetReaders` call is made and records are unchanged. [verify: a
  unit test with `RESOLVEDESCRIPTIONS` omitted asserts a `GetReaders` fetch happened and records
  carry `READERDESCRIPTION`; a unit test with `RESOLVEDESCRIPTIONS: false` asserts zero
  `GetReaders` calls and no `READERDESCRIPTION` field added]
- R4. `get_reader_access_history` gains `RESOLVEDESCRIPTIONS: z.boolean().optional()`, defaulting
  to `true`. When effectively true, `getReaderAccessHistory`'s result gains a single top-level
  `READERDESCRIPTION: string` field (the description for the tool's own `READERKEY` input
  parameter, looked up via `fetchReaderDescriptions` — **not** `enrichWithReaderDescriptions`,
  since there is exactly one relevant `READERKEY`, already known, not one per match) — `''` if
  that `READERKEY` has no match. `matches` array elements are **not** individually given a
  `READERDESCRIPTION` field (see Context for why). When explicitly `false`, no `GetReaders` call
  is made and the top-level field is omitted entirely (not present as `''` — genuinely absent, so
  a caller can distinguish "not requested" from "requested but reader unknown"). [verify: a unit
  test with `RESOLVEDESCRIPTIONS` omitted asserts the top-level result has `READERDESCRIPTION`
  and individual `matches` entries do not; a unit test with `RESOLVEDESCRIPTIONS: false` asserts
  the key is absent from the result and zero `GetReaders` calls were made]
- R5. `RESOLVEDESCRIPTIONS` never changes error or not-found handling for any of the three tools —
  only the shape of a *successful* result, mirroring `RESOLVENAMES`'s existing error-handling
  parity requirement. [verify: for each of the three tools, a unit test with
  `RESOLVEDESCRIPTIONS: true` and a scripted not-found/error response asserts the same
  not-found/error text as `RESOLVEDESCRIPTIONS: false` would produce]
- R6. Tool descriptions for all three tools are updated to state what `RESOLVEDESCRIPTIONS` does,
  that it **defaults to true** (explicitly flagged as the inverted-default case), and — for
  `get_access_history`/`get_card_access_details` — that it costs one `GetReaders` full-table fetch
  per call (not per record). [verify: a test per tool asserts the description string contains
  "RESOLVEDESCRIPTIONS" and "true" (or "default")]
- R7. `README.md` documents `RESOLVEDESCRIPTIONS` for all three tools, including the default-on
  behavior and the top-level-vs-per-record distinction for `get_reader_access_history`. [verify:
  `grep -n RESOLVEDESCRIPTIONS README.md` finds entries for all three tools]
- R8. `CHANGELOG.md` gets an `[Unreleased]` entry covering the new shared module and all three
  tool changes. [verify: `CHANGELOG.md`'s `[Unreleased]` section names `RESOLVEDESCRIPTIONS` and
  all three affected tools]
- R9. `scripts/live-check.ts`'s existing smoke-checks for all three tools are extended to confirm
  `READERDESCRIPTION` (or the top-level equivalent for `get_reader_access_history`) is present and
  non-empty for at least one real record/reader on the live controller. [verify: `npm run
  test:live` output shows all three cases exercised, PASS]

## Out of scope

- `get_portals` gaining reader descriptions on its nested `READERS[]` — different response shape
  (nested object to fill in, not a flat sibling field to add), covered by a separate spec
  (`specs/get-portals-resolve-descriptions.md`) that reuses this spec's
  `fetchReaderDescriptions` helper but applies it differently.
- Any `PORTALDESCRIPTION`-style enrichment of the `PORTALKEY`/`PORTALNAME` fields themselves —
  only reader descriptions are in scope; portals don't have their own separate description field
  on this controller (confirmed: `GetPortals` has no `DESCRIPTION` field at all, only `NAME`).
- Caching `fetchReaderDescriptions`'s result across separate tool calls — per-request only, same
  boundary already drawn for person-name enrichment.
- Any change to `RESOLVENAMES`'s behavior, defaults, or implementation — this spec only adds the
  independent `RESOLVEDESCRIPTIONS` flag alongside it.
- Any write/mutation capability.
- Any change to the 80-command NBAPI allowlist (`GetReaders` is already allowlisted).

## Constraints

- TypeScript, matching this project's existing style; no new runtime dependencies.
- Reuse `fetchAllPages`/`asRecord`/`asRecordList`/`text` from `src/paging.ts` — do not write a
  second `GetReaders` pagination loop.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves `fetchReaderDescriptions` correctly builds the map from a
  multi-page scripted response.
- C2 (from R2): PASS iff tests prove single-fetch-regardless-of-record-count and graceful handling
  of an unmatched `READERKEY`.
- C2b (from R2b): PASS iff a test proves a thrown `GetReaders` failure does not propagate out of
  `enrichWithReaderDescriptions` (every record gets `READERDESCRIPTION: ''` instead), and at least
  one of the three tools' own tests confirms the primary data still returns successfully when the
  description fetch fails.
- C3 (from R3): PASS iff tests prove default-on behavior and explicit-`false` opt-out for both
  `get_access_history` and `get_card_access_details`.
- C4 (from R4): PASS iff tests prove the top-level (not per-match) field placement and its
  presence/absence based on the flag.
- C5 (from R5): PASS iff tests prove error/not-found handling is unaffected by
  `RESOLVEDESCRIPTIONS` across all three tools.
- C6 (from R6): PASS iff each tool's description string mentions `RESOLVEDESCRIPTIONS` and its
  default.
- C7 (from R7): PASS iff README.md documents all three tools' `RESOLVEDESCRIPTIONS` behavior.
- C8 (from R8): PASS iff CHANGELOG.md names the new module and all three tool changes.
- C9 (from R9): PASS iff `npm run test:live` (or a description of a manual run) shows all three
  cases exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and the implementation is consistent with this codebase's existing shared-helper
  pattern (`personEnrichment.ts`) without duplicating logic across the three call sites.

## Open questions

None.
