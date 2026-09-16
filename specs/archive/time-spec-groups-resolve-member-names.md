# Spec: `RESOLVEMEMBERNAMES` member-name enrichment for `get_time_spec_groups`

## Goal

Let `get_time_spec_groups` resolve each group's bare `TIMESPECKEYS` member list into named entries
by default, instead of requiring a separate `get_time_specs` call to find out which schedules a
group's numeric member keys actually refer to.

## Context

This project is `s2-netbox-mcp`. `get_time_spec_groups` (`src/tools/timeSpec.ts:51-55`) is an
existing, always-registered pass-through tool wrapping NBAPI's `GetTimeSpecGroups` command.

**Verified live response shape** (checked this session against the real controller):

```json
{
  "TIMESPECGROUPS": {
    "TIMESPECGROUP": [
      { "TIMESPECGROUPKEY": "1", "NAME": "Always", "DESCRIPTION": "",
        "TIMESPECKEYS": { "TIMESPECKEY": "1" } },
      { "TIMESPECGROUPKEY": "28", "NAME": "GRAND OPENING", "DESCRIPTION": "...",
        "TIMESPECKEYS": { "TIMESPECKEY": "3" } }
    ]
  },
  "NEXTKEY": "-1"
}
```

Each group's own `TIMESPECGROUPKEY`/`NAME`/`DESCRIPTION` are already human-readable — not a gap.
`TIMESPECKEYS` is a collection of **bare key strings** (not `{KEY, NAME}` objects — unlike, e.g.,
`get_access_level_group`'s `ACCESSLEVELS` sub-list, which NBAPI itself already returns as
`{KEY, NAME}` pairs with no join required). `fast-xml-parser` collapses a one-member `TIMESPECKEY`
collection to a bare string (as shown above) rather than a list — this project already has a
purpose-built normalizer for exactly this shape, `keyList(container, item): string[]`
(`src/unlockWindow/managed.ts:115-121`, already `export`ed and used by
`src/unlockWindow/executor.ts`/`dailyExecutor.ts` for this identical `TIMESPECKEYS`/`TIMESPECKEY`
field). **Reuse `keyList` rather than writing a second bare-value-collection normalizer** — this is
a different primitive from `src/paging.ts`'s `asRecordList` (which normalizes collections of
*objects*, not bare strings, and would not correctly handle this field).

**Relocate `keyList` to `src/paging.ts` as part of this spec.** It currently lives in
`src/unlockWindow/managed.ts`, a feature-specific module -- importing a general tool module
(`src/tools/timeSpec.ts`) from an unlock-window-specific module would be an awkward cross-feature
dependency. `keyList` already depends only on `asRecord`/`text`/`splitKeys`, all three of which
already live in `src/paging.ts` (confirmed: `src/unlockWindow/managed.ts:3` already imports
`splitKeys` from `../paging.js`), so this is a pure relocation with no behavior change: move
`keyList`'s definition to `src/paging.ts`, export it from there, and update
`src/unlockWindow/managed.ts` to import it from `../paging.js` instead of defining it locally. Its
existing call sites in `src/unlockWindow/executor.ts`/`dailyExecutor.ts` (via `managed.ts`'s
re-export or direct import) must keep working unchanged.

**Design decision, distinct from every prior enrichment spec in this codebase:** the three prior
`RESOLVENAMES`/`RESOLVEDESCRIPTIONS` specs either added a new sibling field to an existing flat
record, or filled a new field directly onto an existing *nested object*. Here, the `TIMESPECKEY`
members are bare strings, not objects — there is no existing object to add a field to. When
`RESOLVEMEMBERNAMES` is true, each member of `TIMESPECKEYS.TIMESPECKEY` is therefore turned into an
object, `{TIMESPECKEY, NAME}`, matching this codebase's own established convention for *other*
group-membership sub-lists that NBAPI already returns as objects (`get_access_level_group`'s
`ACCESSLEVELS`, `get_reader_group`'s `READERS` — both already `{KEY, NAME}` shaped natively). This
keeps `TIMESPECKEYS` structurally consistent with those sibling group-membership lists once
resolved, rather than inventing a third shape. The `TIMESPECGROUPKEY` value itself is preserved
unchanged inside each member object.

**Flag name**: `RESOLVEMEMBERNAMES` — deliberately distinct from `RESOLVEGROUPNAMES` (the sibling
specs for `get_access_level`/`get_portal_group`, which resolve a single *group* key into a name)
and from `RESOLVENAMES`/`RESOLVEDESCRIPTIONS` (person/reader resolution elsewhere). This flag
resolves the *members inside* a group's own list, a different scope of lookup than either.
**Default `true` (opt-out)**: resolving all members of every group on a page costs exactly one
full paginated `GetTimeSpecs` fetch per call, regardless of how many groups or members are on the
page — the same fixed-cost shape as every other opt-out flag in this codebase.

**Why only the plural `get_time_spec_groups`, not the singular `get_time_spec_group`:** confirmed
live this session that the singular `get_time_spec_group` fails `NOT FOUND` even for a genuinely
existing group (`TIMESPECGROUPKEY: "28"`, confirmed present in the plural list) — a pre-existing,
separately-tracked controller quirk, not something this spec should build enrichment on top of.
This spec is scoped to the plural, paginated tool only.

## Deliverable

- `src/tools/timeSpec.ts` — **modified**: `get_time_spec_groups` gains `RESOLVEMEMBERNAMES`.
- `test/tools.test.ts` (or wherever `get_time_spec_groups` is currently tested — grep for it
  first) — **modified**: new test cases.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `get_time_spec_groups`'s Zod schema gains `RESOLVEMEMBERNAMES: z.boolean().optional()`,
  defaulting to `true` when omitted (opt-out). `STARTFROMKEY` is unchanged. [verify: a test
  asserts the schema has exactly `STARTFROMKEY` and `RESOLVEMEMBERNAMES`]
- R2. When `RESOLVEMEMBERNAMES` is effectively true (omitted or explicitly `true`): after fetching
  the requested page of time spec groups, call a `GetTimeSpecs`-backed name-fetch **once**
  (regardless of how many groups/members are on the page), then for every group on that page,
  normalize its `TIMESPECKEYS.TIMESPECKEY` field via `keyList` and replace it with a list of
  `{TIMESPECKEY, NAME}` objects — `NAME` is `''` if the key has no match in the fetched map (an
  unknown/deleted time spec). Every other field (`TIMESPECGROUPKEY`, group `NAME`, `DESCRIPTION`)
  is unchanged. [verify: a unit test with a scripted multi-group page (including at least one
  group with a single bare-string `TIMESPECKEY` and one with multiple) asserts every group's
  `TIMESPECKEYS.TIMESPECKEY` becomes a list of `{TIMESPECKEY, NAME}` objects with correct names,
  with exactly one underlying time-spec-name fetch regardless of how many groups/members are on
  the page, and an unmatched key resolves to `NAME: ''`]
- R3. When `RESOLVEMEMBERNAMES` is explicitly `false`: no `GetTimeSpecs` call is made, and groups
  are returned exactly as `GetTimeSpecGroups` provides them (`TIMESPECKEYS.TIMESPECKEY` stays bare
  string(s), no shape change) — byte-identical to this tool's behavior before this change.
  [verify: a unit test with `RESOLVEMEMBERNAMES: false` asserts zero `GetTimeSpecs` calls and
  `TIMESPECKEYS.TIMESPECKEY` unchanged from the raw fixture]
- R4. `RESOLVEMEMBERNAMES` never changes error or not-found handling — only the shape of a
  *successful* result. [verify: a unit test with `RESOLVEMEMBERNAMES: true` (the default) and a
  scripted not-found/error `GetTimeSpecGroups` response asserts the same not-found/error text as
  without this change]
- R5. If the underlying `GetTimeSpecs` fetch fails, every member's `NAME` resolves to an empty
  string (via the same never-throws pattern established by `fetchReaderDescriptions`) and the call
  still succeeds with every group's `TIMESPECGROUPKEY`/other fields intact. [verify: a unit test
  where the underlying `GetTimeSpecs` call throws asserts the tool call still returns
  successfully, with every member's `NAME: ''` and every group's own fields still correct]
- R6. The tool description is updated to state what `RESOLVEMEMBERNAMES` does, that it defaults to
  `true`, that it applies only to `get_time_spec_groups` (not the singular tool), and that it costs
  one `GetTimeSpecs` full-table fetch per call (not per group/member). [verify: a test asserts the
  description string contains "RESOLVEMEMBERNAMES" and "true" (or "default")]
- R7. `README.md`'s documentation of `get_time_spec_groups` documents `RESOLVEMEMBERNAMES` and the
  `{TIMESPECKEY, NAME}` shape change it causes when enabled (the default). [verify: `grep -n
  RESOLVEMEMBERNAMES README.md` finds an entry for `get_time_spec_groups`]
- R8. `CHANGELOG.md` gets an `[Unreleased]` entry for this addition.
  [verify: `CHANGELOG.md`'s `[Unreleased]` section names `get_time_spec_groups` and
  `RESOLVEMEMBERNAMES`]
- R9. `scripts/live-check.ts`'s existing `get_time_spec_groups` smoke-check (if one exists — check
  first) is extended to confirm at least one group's member on a real page has a non-empty `NAME`
  after this change. If no existing smoke-check covers this tool yet, add one. [verify: `npm run
  test:live` output shows this exercised, PASS]

## Out of scope

- The singular `get_time_spec_group` tool — confirmed broken (`NOT FOUND`) on this controller
  independent of this spec; not touched here.
- Any change to `get_time_spec_groups`' own `STARTFROMKEY`/pagination behavior — only the content
  of whatever page is returned changes.
- `add_time_spec_group`/`modify_time_spec_group`/`delete_time_spec_group` (write tools) — untouched.
- Resolving `HOLIDAYGROUPS` (a numeric 1-8 tag on time specs themselves, not an NBAPI entity with
  its own lookup command) — not the same class of gap.
- Cross-request/TTL caching of the fetched time-spec-name map.
- Any change to the 80-command NBAPI allowlist.

## Constraints

- Relocate `keyList` from `src/unlockWindow/managed.ts` to `src/paging.ts` (see Context) and reuse
  it from there for normalizing `TIMESPECKEYS.TIMESPECKEY` — do not write a second
  bare-value-collection normalizer, and do not leave `keyList` defined in a feature-specific module
  while a general tool module imports it.
- The relocation must not change `keyList`'s behavior or break any existing caller — run the full
  existing test suite (including `src/unlockWindow/*` tests) to confirm, not just the new tests
  this spec adds.
- TypeScript, matching this project's existing style; no new runtime dependencies.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set.
- C2 (from R2): PASS iff a test proves every group's members become correctly-named
  `{TIMESPECKEY, NAME}` objects with exactly one underlying fetch, including the no-match case.
- C3 (from R3): PASS iff a test proves `RESOLVEMEMBERNAMES: false` makes zero `GetTimeSpecs` calls
  and leaves `TIMESPECKEYS` unchanged.
- C4 (from R4): PASS iff a test proves error/not-found handling is unaffected.
- C5 (from R5): PASS iff a test proves a `GetTimeSpecs` failure still yields a successful call with
  every member's `NAME` empty and every group's own fields intact.
- C6 (from R6): PASS iff the description string mentions `RESOLVEMEMBERNAMES` and its default.
- C7 (from R7): PASS iff README.md documents `RESOLVEMEMBERNAMES` for `get_time_spec_groups`.
- C8 (from R8): PASS iff CHANGELOG.md names this addition.
- C9 (from R9): PASS iff `npm run test:live` (or a description of a manual run) shows this
  exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures (including all pre-existing `src/unlockWindow/*` tests, proving the `keyList` relocation
  didn't break anything), and the implementation reuses the relocated `keyList` from
  `src/paging.ts` rather than reimplementing it or importing it from `src/unlockWindow/managed.ts`.

## Open questions

None.
