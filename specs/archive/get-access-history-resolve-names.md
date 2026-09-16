# Spec: `RESOLVENAMES` person-name enrichment for `get_access_history`

> **Archived, 2026-09-16.** Built via the forge skill in
> [PR #52](https://github.com/J-MaFf/s2-netbox-mcp/pull/52) (`Fixes #51`, also `Fixes #47`). All 12
> acceptance criteria passed (blind evaluator, round 1), including a live run against the real
> controller during generation (`RESOLVENAMES: true` enriched 999 records, e.g.
> `FULLNAME="Michi Nakano"`). One spec defect was found and corrected before evaluation: R12/C12's
> verify clause originally called for zero `OLDESTDTTM`/`NEWESTDTTM` occurrences across the whole
> of `test/tools.test.ts`, which would have meant deleting correct, unrelated coverage for
> `get_card_access_details`'s own legitimate `OLDESTDTTM` field — narrowed to
> `get_access_history`'s own schema assertion, as reflected in the R12/C12 text below.

## Goal

Let callers of `get_access_history` opt in to having each returned access record enriched with
the badge-holder's name (`FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES`), without changing the tool's
existing behavior for anyone who doesn't ask for it.

## Context

This project is `s2-netbox-mcp` (see `README.md`, `CLAUDE.md`, `STATUS.md`): a Node/TypeScript
MCP server wrapping LenelS2 S2 NetBox's NBAPI. `get_access_history` (`src/tools/events.ts`) is an
existing, published, always-registered pass-through tool wrapping the NBAPI `GetAccessHistory`
command.

**This session already built the same kind of enrichment once, for a different tool** —
`get_reader_access_history` (`src/readerAccessHistory.ts`) enriches access records with
`FIRSTNAME`/`LASTNAME` via one `GetPerson` call per distinct `PERSONID`, gracefully handling
lookup failures. This spec reuses that pattern rather than reinventing it (see R5/R7).

**Decisions already made (interview, this session) — do not re-litigate these:**
- Modify `get_access_history` in place (not a separate new tool).
- Person-name caching is per-request memoization only (one `GetPerson` call per distinct
  `PERSONID` per tool call) — no cross-request/TTL cache. Matches `get_reader_access_history`'s
  existing precedent; a cross-request cache would introduce host-side state this server has
  deliberately avoided elsewhere (README's "Out of scope": "Any... persistence on the MCP host").
- `get_access_history` drops date-range filtering entirely (`OLDESTDTTM`/`NEWESTDTTM` removed,
  no `STARTDATE`/`ENDDATE` replacement added) — see the next bullet for why.

**Verified facts (checked against the live controller this session, not assumed):**

- `get_access_history`'s current schema (`src/tools/events.ts`) is `STARTLOGID`, `AFTERLOGID`,
  `ORDER`, `MAXRECORDS`, `ENCODEDNUM`, `HOTSTAMP`, `CARDFORMAT`, `OLDESTDTTM`, `NEWESTDTTM`. The
  last two are broken: NBAPI's real field names for `GetAccessHistory`'s date filter are
  `STARTDATE`/`ENDDATE` (confirmed via the controller's own validation error text when a
  malformed value was sent) — already tracked as
  [#47](https://github.com/J-MaFf/s2-netbox-mcp/issues/47).
- **Even the correct names don't work.** A controlled live A/B test this session — identical
  query except for the date range, one range including today, one explicitly excluding it —
  returned the *identical* 5 most-recent records both times, proving the controller silently
  ignores `STARTDATE`/`ENDDATE` entirely rather than filtering by them (no error, just no effect).
  This is why date-range filtering is dropped rather than fixed: renaming the fields would stop
  the outright failure but produce silently wrong results (a caller asking for "August" silently
  getting "today" instead) — worse than an honest absence. This closes #47 by removal rather than
  rename.
- Every `ACCESS` record returned by `GetAccessHistory` already carries a `PERSONID` field
  (confirmed structure, e.g. `{"LOGID": "...", "PERSONID": "00208", "READER": "...",
  "READERKEY": "...", "PORTALKEY": "...", "DTTM": "...", "NODEDTTM": "...", "TYPE": "...",
  "REASON": ""}`). Some observed `PERSONID` values are operator-style (`_5`, `_10`) rather than
  plain numeric IDs.
- `GetPerson` (already in `NBAPI_COMMANDS`, already read-only/always registered — no allowlist
  change needed) returns `FIRSTNAME`, `LASTNAME`, and `NOTES` among its fields (confirmed via a
  live `search_person_data` call earlier this session). There is no "department" field on a
  NetBox person record — the request that prompted this spec said "optionally NOTES or
  department if available"; only `NOTES` is real, so that's what's used.
- `runNbapiTool` (`src/toolHelpers.ts`) takes a **synchronous** `formatSuccess(data): string`
  callback — it cannot run the async `GetPerson` enrichment inline. The `RESOLVENAMES: true` path
  must bypass `runNbapiTool` and hand-roll the same not-found/error mapping it does (matching
  `get_reader_access_history`'s/`find_portals`'s existing composite-tool pattern: `{ content:
  [{ type: 'text', text: formatAsJson(result) }] }` wrapped in try/catch with `toolErrorResult`,
  both from `src/toolHelpers.ts`).
- `src/paging.ts`'s `asRecord`/`asRecordList`/`text` helpers already normalize
  fast-xml-parser's single-item-collapses-to-bare-object behavior (used throughout
  `readerAccessHistory.ts`) — reuse them for `ACCESSES.ACCESS`, don't reinvent normalization.
- `test/tools.test.ts:646` has the existing schema/behavior test for `get_access_history` (asserts
  the exact param set and a plain pass-through call) — this needs updating, not a new parallel
  test file.

## Deliverable

- `src/personEnrichment.ts` — **new** shared module: extracts and generalizes
  `readerAccessHistory.ts`'s private `enrichWithPersonNames` into an exported, generic function
  usable by both tools (R5).
- `src/readerAccessHistory.ts` — **modified**: uses the shared helper instead of its own private
  copy (R7).
- `src/tools/events.ts` — **modified**: `get_access_history` gains `RESOLVENAMES`, loses
  `OLDESTDTTM`/`NEWESTDTTM` (R1-R4, R8).
- `test/personEnrichment.test.ts` — **new**: unit tests for the shared helper (R5, R6).
- `test/readerAccessHistory.test.ts` — **modified**: adjusted for the refactor (R7).
- `test/tools.test.ts` — **modified**: updated schema/behavior test for `get_access_history`
  (R2-R4, R12).
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated (R9-R11).

## Requirements

- R1. `get_access_history`'s Zod schema in `src/tools/events.ts` gains `RESOLVENAMES:
  z.boolean().optional()` (matching this project's existing boolean-param convention — see
  `dryRun` in `src/tools/unlockWindow.ts`/`dailyUnlockWindow.ts`), defaulting to `false`/off
  behavior when omitted. `OLDESTDTTM` and `NEWESTDTTM` are removed from the schema entirely. All
  other existing params (`STARTLOGID`, `AFTERLOGID`, `ORDER`, `MAXRECORDS`, `ENCODEDNUM`,
  `HOTSTAMP`, `CARDFORMAT`) are unchanged. [verify: a test asserts
  `Object.keys(schema).sort()` equals exactly `['AFTERLOGID', 'CARDFORMAT', 'ENCODEDNUM',
  'HOTSTAMP', 'MAXRECORDS', 'ORDER', 'RESOLVENAMES', 'STARTLOGID'].sort()`]
- R2. When `RESOLVENAMES` is omitted or `false`, the handler's behavior (the NBAPI call made and
  the result shape returned) is byte-identical to before this change: `runNbapiTool(client,
  NBAPI_COMMANDS.GET_ACCESS_HISTORY, mergeParams(otherParams))`, with no `GetPerson` call ever
  made. [verify: a unit test with `RESOLVENAMES` omitted and one with it explicitly `false` both
  assert exactly one `GetAccessHistory` call, no `GetPerson` call, and the plain (unenriched)
  response]
- R3. When `RESOLVENAMES` is `true`: call `GetAccessHistory` once with the other params
  (unchanged), extract the `ACCESS` record(s) from the response via `asRecordList(asRecord(...
  ).ACCESS)` (handling both the list and single-object-collapse shapes), enrich each with
  `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` via the shared helper (R5) while preserving every
  original field on each record, then return the **original response envelope shape**
  (`ACCESSES.ACCESS[]` with enriched records substituted in place, `NEXTLOGID` untouched) — not a
  reshaped/different envelope. [verify: a unit test with `RESOLVENAMES: true` and a scripted
  multi-record response asserts each returned record has every original field plus the four new
  ones, and that `NEXTLOGID` and the `ACCESSES.ACCESS` structure are otherwise unchanged]
- R4. `RESOLVENAMES` never changes error or not-found handling — only the shape of a *successful*
  result. A `notFound` `GetAccessHistory` response produces the same "Not found: ..." text
  `runNbapiTool` produces; a thrown `NbapiApiError`/`NbapiFailError` produces the same mapped
  error `toolErrorResult` produces — in both cases regardless of `RESOLVENAMES`. [verify: a unit
  test with `RESOLVENAMES: true` and a scripted `notFound` response asserts the standard
  not-found text; a unit test with `RESOLVENAMES: true` and a thrown `NbapiFailError` asserts the
  standard mapped error text]
- R5. `src/personEnrichment.ts` exports an interface `PersonEnrichment` (`FIRSTNAME: string`,
  `LASTNAME: string`, `FULLNAME: string`, `NOTES: string`) and a function `enrichWithPersonNames
  <T extends { PERSONID: string }>(client: NetboxClient, records: T[]): Promise<(T &
  PersonEnrichment)[]>`. It calls `GetPerson` once per distinct **non-empty** `PERSONID` across
  `records` (never once per record — mirrors the existing per-request memoization pattern in
  `readerAccessHistory.ts`, generalized). A record whose `PERSONID` is the empty string gets
  empty-string values for all four fields with **no** `GetPerson` call made for it. A `GetPerson`
  failure (thrown error, or a not-found-shaped result) for a given `PERSONID` never throws out of
  `enrichWithPersonNames` — every record sharing that `PERSONID` gets empty-string values for all
  four fields, and other `PERSONID`s are unaffected. [verify: a unit test with 3 records sharing 2
  distinct non-empty `PERSONID`s asserts exactly 2 `GetPerson` calls; a unit test with a record
  whose `PERSONID` is `''` asserts zero `GetPerson` calls for it and empty-string fields; a unit
  test where `GetPerson` throws for one `PERSONID` asserts that `PERSONID`'s records get
  empty-string fields while a different `PERSONID`'s records resolve normally and the function
  does not throw]
- R6. `FULLNAME` is computed as: `''` when both `FIRSTNAME` and `LASTNAME` are empty; the
  non-empty one alone (no extra whitespace) when exactly one is empty; `` `${FIRSTNAME}
  ${LASTNAME}` `` (single space between them) when both are non-empty. [verify: three unit tests,
  one per case, each asserting the exact `FULLNAME` string]
- R7. `src/readerAccessHistory.ts` is refactored to import and call the shared
  `enrichWithPersonNames` from `src/personEnrichment.ts` instead of its own private duplicate.
  `EnrichedAccessHistoryRecord` becomes `AccessHistoryRecord & PersonEnrichment` — an additive
  change (`get_reader_access_history`'s output gains `FULLNAME`/`NOTES`; `FIRSTNAME`/`LASTNAME`
  keep their existing meaning and no field is removed or renamed). [verify:
  `test/readerAccessHistory.test.ts`'s existing enrichment-related tests still pass after the
  refactor, plus an assertion that a returned match includes non-`undefined` `FULLNAME` and
  `NOTES` keys]
- R8. `get_access_history`'s tool description string is updated to state what `RESOLVENAMES` does,
  that it defaults to `false`, and that enabling it costs one extra `GetPerson` call per distinct
  person found in the result (naming the cost is why it's opt-in, not on by default). [verify: a
  test asserts the description string contains "RESOLVENAMES" and "GetPerson"]
- R9. README's documentation of `get_access_history` is updated: `OLDESTDTTM`/`NEWESTDTTM` no
  longer appear anywhere in `README.md`; `RESOLVENAMES` is documented in the read-tools section
  with its default and cost; a short note explains why date-range filtering isn't offered
  (confirmed live: the controller silently ignores the date-filter fields regardless of name),
  cross-referencing the same rationale already documented for `get_reader_access_history`.
  [verify: `grep -c OLDESTDTTM README.md` and `grep -c NEWESTDTTM README.md` are both `0`;
  `grep -n RESOLVENAMES README.md` finds an entry in the read-tools documentation]
- R10. `CHANGELOG.md` gets an `[Unreleased]` entry (or entries) covering: `RESOLVENAMES` added to
  `get_access_history`; `OLDESTDTTM`/`NEWESTDTTM` removed, closing
  [#47](https://github.com/J-MaFf/s2-netbox-mcp/issues/47) (they never worked, and don't filter
  even under the NBAPI-correct names `STARTDATE`/`ENDDATE`, confirmed via a live controlled A/B
  test); `get_reader_access_history`'s output gaining `FULLNAME`/`NOTES` as a side effect of the
  shared-helper refactor. [verify: `CHANGELOG.md`'s `[Unreleased]` section names `RESOLVENAMES`,
  references `#47`, and mentions the `get_reader_access_history` field addition]
- R11. `scripts/live-check.ts`'s existing `get_access_history` smoke-check is extended to also
  exercise `RESOLVENAMES: true` against the real controller and assert the returned records carry
  non-`undefined` `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` keys. [verify: `npm run test:live`
  output shows this case exercised, PASS]
- R12. `test/tools.test.ts`'s existing `get_access_history` schema/behavior test (currently at
  line ~646, asserting the exact pre-change param set) is updated to assert the new schema and
  that a plain (non-`RESOLVENAMES`) call is unaffected. **Correction from an earlier draft of
  this spec:** the verify clause originally called for zero occurrences of `OLDESTDTTM`/
  `NEWESTDTTM` anywhere in `test/tools.test.ts` — wrong, since that file also legitimately tests
  `get_card_access_details` (a different NBAPI command, out of scope here), whose own
  `OLDESTDTTM` field is real and untouched by this spec. Do not remove or alter that unrelated
  test. [verify: the updated test passes, and its own schema assertion (already covered by C1)
  contains neither `OLDESTDTTM` nor `NEWESTDTTM`]

## Out of scope

- **Any date-range filtering capability for `get_access_history`**, in any form — not a rename,
  not client-side post-filtering. Confirmed unworkable live this session (see Context); matches
  the decision already made for `get_reader_access_history`. Do not add `STARTDATE`/`ENDDATE` or
  any other date parameter back in.
- **Cross-request/TTL caching of person names.** Per-request memoization only (R5). Do not add
  any cache that persists between separate tool calls.
- Adding `RESOLVENAMES` (or any enrichment) to `get_event_history` or `list_events` — this spec
  touches only `get_access_history` and the shared helper's extraction from
  `readerAccessHistory.ts`.
- Any change to `get_access_history`'s `ORDER` parameter's behavior or documentation beyond
  leaving it exactly as-is — its semantics are unverified this session and out of scope to audit.
- "Department" or any other person field beyond `FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` — no
  such field exists on a NetBox person record.
- Any change to the 80-command NBAPI allowlist (`GetPerson`/`GetAccessHistory` are both already
  allowlisted).
- Any change to `get_reader_access_history`'s own filtering/pagination logic (its R1-R6 from
  `specs/archive/get-reader-access-history.md`) — only its enrichment call-site changes (R7
  above).
- Any write/mutation capability — `get_access_history` stays a read tool, always registered, never
  gated behind `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE`.

## Constraints

- TypeScript, matching this project's existing style; no new runtime dependencies.
- No invented NBAPI field names anywhere (project-wide rule; see `src/commands.ts`'s own
  docstring) — every parameter name sent to `GetAccessHistory`/`GetPerson` must already appear in
  their existing tool registrations in this codebase.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean (CI requires this —
  `.github/workflows/ci.yml`).
- Follow this repo's issue-first workflow (see `CONTRIBUTING.md`): open a GitHub issue before
  implementing (referencing that it also closes #47), branch as `feat/<short-description>`,
  reference `Fixes #N` (and close `#47`) in the PR, update `CHANGELOG.md` in the same PR as the
  code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set, with `OLDESTDTTM`/
  `NEWESTDTTM` absent.
- C2 (from R2): PASS iff tests prove `RESOLVENAMES` omitted and explicitly `false` both produce
  the pre-change call/result with zero `GetPerson` calls.
- C3 (from R3): PASS iff a test proves every original field survives enrichment and the envelope
  shape is unchanged.
- C4 (from R4): PASS iff tests prove not-found and error handling are identical regardless of
  `RESOLVENAMES`.
- C5 (from R5): PASS iff tests prove per-distinct-`PERSONID` call count, empty-`PERSONID`
  skip-with-no-call, and lookup-failure isolation (one bad `PERSONID` doesn't affect others or
  throw).
- C6 (from R6): PASS iff three tests prove the exact `FULLNAME` value in each of the three cases.
- C7 (from R7): PASS iff `readerAccessHistory.test.ts` still passes post-refactor and a test
  confirms `FULLNAME`/`NOTES` appear on its output.
- C8 (from R8): PASS iff the description string can be shown to mention "RESOLVENAMES" and
  "GetPerson".
- C9 (from R9): PASS iff README.md has zero occurrences of `OLDESTDTTM`/`NEWESTDTTM` and at least
  one documented mention of `RESOLVENAMES` in the read-tools section.
- C10 (from R10): PASS iff CHANGELOG.md's `[Unreleased]` section names `RESOLVENAMES`, `#47`, and
  the `get_reader_access_history` field addition.
- C11 (from R11): PASS iff `npm run test:live` output (or a description of a manual run against
  the live controller) shows the `RESOLVENAMES: true` case exercised successfully.
- C12 (from R12): PASS iff the updated `test/tools.test.ts` passes and the `get_access_history`
  schema assertion within it (the same one C1 checks) contains neither `OLDESTDTTM` nor
  `NEWESTDTTM` — the file's separate, unrelated `get_card_access_details` test legitimately
  keeps its own real `OLDESTDTTM` field and is not part of this check.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and a domain expert familiar with this codebase's existing composite-tool pattern
  (`find_portals`, `get_reader_access_history`) would accept this implementation as consistent
  with it without substantive changes.

## Open questions

None.
