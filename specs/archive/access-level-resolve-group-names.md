# Spec: `RESOLVEGROUPNAMES` group-name enrichment for `get_access_level`

> **Completed 2026-09-16.** Built via the forge loop in 1 round, all 11 acceptance criteria
> (C1-C10, C-final) passed cleanly, including live confirmation that the singular
> `GetTimeSpecGroup` command genuinely fails `NOT FOUND` on this controller. This is the 1st of
> 4 specs in a new enrichment batch following on from the `RESOLVENAMES`/`RESOLVEDESCRIPTIONS`
> work shipped in `v0.3.0`. Shipped in [PR #62](https://github.com/J-MaFf/s2-netbox-mcp/pull/62).

## Goal

Let `get_access_level` resolve its bare `TIMESPECGROUPKEY`/`READERGROUPKEY` foreign keys into
human-readable group names by default, instead of requiring a separate `get_time_spec_groups`/
`get_reader_groups` call (and a client-side key search through the full list) to find out which
group an access level actually grants time-window/reader access through.

## Context

This project is `s2-netbox-mcp`. `get_access_level` (`src/tools/accessLevel.ts:29-35`) is an
existing, always-registered pass-through tool wrapping NBAPI's `GetAccessLevel` command.

**Verified live response shape** (checked this session against the real controller,
`ACCESSLEVELKEY: "1"`):

```json
{
  "ACCESSLEVELNAME": "Master Door Access",
  "ACCESSLEVELDESCRIPTION": "",
  "READERGROUPKEY": "22",
  "TIMESPECGROUPKEY": "1",
  "THREATLEVELGROUPKEY": ""
}
```

Three bare foreign keys, zero accompanying names. This is the same class of gap
`RESOLVENAMES`/`RESOLVEDESCRIPTIONS` fixed for `PERSONID`/`READERKEY` elsewhere in this codebase
(see `specs/archive/get-access-history-resolve-names.md` and
`specs/archive/get-access-history-resolve-descriptions.md`), and this spec follows the same
established conventions:

- **Cost shape decides opt-in vs. opt-out**, per this codebase's own precedent: `RESOLVENAMES`
  (per-record `GetPerson` calls, cost scales with result size) defaults to `false`; `RESOLVEDESCRIPTIONS`
  (one fixed-cost full-table fetch regardless of result size) defaults to `true`. `get_access_level`
  returns exactly **one** `TIMESPECGROUPKEY` and **one** `READERGROUPKEY` per call — resolving them
  always costs exactly two extra full-table fetches, never scaling with anything. This matches the
  `RESOLVEDESCRIPTIONS` cost shape, so the new flag here defaults to **`true`** (opt-out).
- **New flag name**: `RESOLVEGROUPNAMES`, not `RESOLVENAMES`/`RESOLVEDESCRIPTIONS`. Reusing either
  existing flag name here would be misleading — `RESOLVENAMES` already means "resolve a `PERSONID`
  into a person's name, off by default" elsewhere in this server, and `RESOLVEDESCRIPTIONS` already
  means "resolve a `READERKEY` into a reader description" elsewhere. This flag resolves a different
  kind of foreign key (group keys) into a different kind of field (`NAME`, not `DESCRIPTION`), so it
  gets its own clearly-scoped name. `get_portal_group`'s own `UNLOCKTIMESPECGROUPKEY` resolution
  (a separate, later spec) reuses this exact same flag name and semantics, since it is the identical
  kind of lookup against the identical underlying table.
- **New sibling fields, not replacing anything**: `TIMESPECGROUPNAME` and `READERGROUPNAME` are
  added alongside the existing `TIMESPECGROUPKEY`/`READERGROUPKEY` — matching this codebase's
  "new fields are always additive" rule (see `READERDESCRIPTION`, `FULLNAME` precedent).

**Which underlying command to resolve against — verified live, this session:**

- `READERGROUPKEY` -> `get_reader_groups`/`GetReaderGroups`: confirmed live, `READERGROUPKEY: "22"`
  resolves to `NAME: "Master Door Access - all doors"` in the full list (`src/tools/readerGroup.ts`).
  There is no singular by-key reader-group read command safety concern documented for this
  controller (unlike time spec groups below), but for consistency with the time-spec-group
  resolver and to avoid relying on an unverified singular lookup, this spec also resolves reader
  group names via the full paginated list rather than a singular by-key call.
- `TIMESPECGROUPKEY` -> `get_time_spec_groups`/`GetTimeSpecGroups`, **not** the singular
  `get_time_spec_group`/`GetTimeSpecGroup`: **verified live, this session, that the singular
  lookup fails even for a genuinely existing group** — `get_time_spec_group(TIMESPECGROUPKEY: "28")`
  (a group confirmed present in `GetTimeSpecGroups`' own list, named "GRAND OPENING") returned
  `NOT FOUND`. This matches a previously-recorded finding for this controller (`GetTimeSpecGroup`
  by key always fails `NOT FOUND`; use `GetTimeSpecGroups`). The resolver in this spec must
  therefore fetch the full paginated `GetTimeSpecGroups` list and find the matching
  `TIMESPECGROUPKEY` client-side — the same robust pattern already used by
  `src/unlockWindow/managed.ts`'s own time-spec-group name lookups.
- `THREATLEVELGROUPKEY` is explicitly **out of scope** (see below) — no NBAPI read command for
  threat level groups exists in this server's command surface at all (confirmed:
  `src/tools/threatLevel.ts`'s own header comment states no read command exists for threat
  levels/groups), so this key cannot be resolved regardless of design.

**New shared modules this spec creates** (for reuse by a later, separate spec that also resolves
`TIMESPECGROUPKEY`, `specs/portal-group-resolve-group-names.md` — build this spec first):

- `src/timeSpecGroupNames.ts`: `fetchTimeSpecGroupNames(client): Promise<Map<string, string>>`
  (`TIMESPECGROUPKEY -> NAME`, one full paginated `GetTimeSpecGroups` fetch; never throws — same
  failure-safety shape as `src/readerDescriptions.ts`'s `fetchReaderDescriptions`, which resolves
  to an empty `Map` on any underlying fetch failure rather than losing the primary data).
- `src/readerGroupNames.ts`: `fetchReaderGroupNames(client): Promise<Map<string, string>>`
  (`READERGROUPKEY -> NAME`, one full paginated `GetReaderGroups` fetch; same never-throws shape).

Both mirror `src/readerDescriptions.ts`'s exact shape (a `Map`-returning fetch function, never
throws, used directly by the tool handler — no separate `enrichWithX` helper is needed here since
`get_access_level` enriches a single flat object, not a list of records).

## Deliverable

- `src/timeSpecGroupNames.ts` — **new file**: `fetchTimeSpecGroupNames`.
- `src/readerGroupNames.ts` — **new file**: `fetchReaderGroupNames`.
- `src/tools/accessLevel.ts` — **modified**: `get_access_level` gains `RESOLVEGROUPNAMES`.
- `test/tools.test.ts` (or wherever `get_access_level` is currently tested — grep for it first;
  also add unit tests for the two new modules, matching `test/readerDescriptions.test.ts`'s
  conventions if such a file exists, or co-locate in `test/tools.test.ts` if not) — **modified/new**.
- `scripts/live-check.ts`, `README.md`, `CHANGELOG.md` — updated.

## Requirements

- R1. `get_access_level`'s Zod schema gains `RESOLVEGROUPNAMES: z.boolean().optional()`, defaulting
  to `true` when omitted (opt-out). `ACCESSLEVELKEY` is unchanged and remains the only other field.
  [verify: a test asserts `Object.keys(schema).sort()` equals exactly
  `['ACCESSLEVELKEY', 'RESOLVEGROUPNAMES'].sort()`]
- R2. When `RESOLVEGROUPNAMES` is effectively true (omitted or explicitly `true`): after calling
  `GetAccessLevel`, read `TIMESPECGROUPKEY` and `READERGROUPKEY` from the response. For each
  non-empty key, resolve its name via `fetchTimeSpecGroupNames`/`fetchReaderGroupNames`
  respectively and add `TIMESPECGROUPNAME`/`READERGROUPNAME` as new sibling fields on the response
  (alongside the existing `ACCESSLEVELNAME`/`ACCESSLEVELDESCRIPTION`/`READERGROUPKEY`/
  `TIMESPECGROUPKEY`/`THREATLEVELGROUPKEY`). An unmatched key (present in the response but not
  found in the fetched map) resolves to an empty-string name. [verify: a unit test with a scripted
  `GetAccessLevel` response plus scripted `GetTimeSpecGroups`/`GetReaderGroups` list responses
  asserts both new fields are correctly populated, and a separate test with a key that has no
  match in the fetched list asserts that key's name field is `''`]
- R3. When `RESOLVEGROUPNAMES` is explicitly `false`: no `GetTimeSpecGroups`/`GetReaderGroups`
  calls are made, and the response is returned exactly as `GetAccessLevel` provides it (no
  `TIMESPECGROUPNAME`/`READERGROUPNAME` keys added) — byte-identical to this tool's behavior
  before this change. [verify: a unit test with `RESOLVEGROUPNAMES: false` asserts exactly one
  `GetAccessLevel` call and zero other calls, and no new keys on the result]
- R4. An empty/absent `TIMESPECGROUPKEY` or `READERGROUPKEY` independently skips that axis's fetch
  entirely (no `GetTimeSpecGroups`/`GetReaderGroups` call for that axis) and yields an empty-string
  name for that field, without affecting the other axis's resolution. [verify: a unit test with
  `TIMESPECGROUPKEY: ''` and a populated `READERGROUPKEY` asserts exactly one `GetReaderGroups`
  call (zero `GetTimeSpecGroups` calls), `TIMESPECGROUPNAME: ''`, and a correctly resolved
  `READERGROUPNAME`]
- R5. If `fetchTimeSpecGroupNames` or `fetchReaderGroupNames` itself fails (the underlying
  `GetTimeSpecGroups`/`GetReaderGroups` call throws), that axis's name resolves to an empty string
  and the call still succeeds with the primary `GetAccessLevel` data intact — never let an
  enrichment failure lose the primary data, matching `fetchReaderDescriptions`'s established
  failure-safety shape. [verify: a unit test where `GetReaderGroups` throws asserts the tool call
  still returns successfully, with `READERGROUPNAME: ''` and `TIMESPECGROUPNAME` still correctly
  resolved]
- R6. `RESOLVEGROUPNAMES` never changes error or not-found handling for `GetAccessLevel` itself —
  only the shape of a *successful* result. [verify: a unit test with `RESOLVEGROUPNAMES: true`
  (the default) and a scripted not-found/error `GetAccessLevel` response asserts the same
  not-found/error text as without this change, and that no enrichment calls are made]
- R7. The tool description is updated to state what `RESOLVEGROUPNAMES` does, that it defaults to
  `true`, that `THREATLEVELGROUPKEY` is never resolved (no NBAPI read command exists for threat
  level groups), and that each axis costs one small full-table fetch regardless of anything else.
  [verify: a test asserts the description string contains "RESOLVEGROUPNAMES"]
- R8. `README.md`'s documentation of `get_access_level` documents `RESOLVEGROUPNAMES`, its default,
  and the `THREATLEVELGROUPKEY` limitation. [verify: `grep -n RESOLVEGROUPNAMES README.md` finds
  an entry for `get_access_level`]
- R9. `CHANGELOG.md` gets an `[Unreleased]` entry for this addition.
  [verify: `CHANGELOG.md`'s `[Unreleased]` section names `get_access_level` and
  `RESOLVEGROUPNAMES`]
- R10. `scripts/live-check.ts`'s existing `get_access_level` smoke-check (if one exists — check
  first) is extended to confirm `RESOLVEGROUPNAMES: true` (the default) resolves at least one
  non-empty group name against the real controller. If no existing smoke-check covers this tool
  yet, add one. [verify: `npm run test:live` output shows this case exercised, PASS]

## Out of scope

- `THREATLEVELGROUPKEY` resolution — no NBAPI read command for threat level groups exists in this
  server's command surface; this field is left exactly as-is (bare key, possibly empty).
- `get_access_levels` (plural) — confirmed live this session that it returns bare access-level
  *names* only (no keys, no `TIMESPECGROUPKEY`/`READERGROUPKEY` per entry), so there is nothing to
  enrich on that tool.
- Any change to `ACCESSLEVELNAME`/`ACCESSLEVELDESCRIPTION` — already human-readable.
- Any write/mutation capability.
- Cross-request/TTL caching of the fetched group-name maps.
- Any change to the 80-command NBAPI allowlist (`GetTimeSpecGroups`/`GetReaderGroups` are both
  already allowlisted).

## Constraints

- TypeScript, matching this project's existing style; no new runtime dependencies.
- Resolve `TIMESPECGROUPKEY` via the full paginated `GetTimeSpecGroups` list, never the singular
  `GetTimeSpecGroup` — verified broken (`NOT FOUND`) on this controller for a genuinely existing
  group.
- No invented NBAPI field names.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before implementing, branch as
  `feat/<short-description>`, reference `Fixes #N` in the PR, update `CHANGELOG.md` in the same
  PR as the code.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the exact new schema key set.
- C2 (from R2): PASS iff tests prove both new fields resolve correctly, including the
  no-match-in-list case.
- C3 (from R3): PASS iff a test proves `RESOLVEGROUPNAMES: false` makes zero extra calls and adds
  no new keys.
- C4 (from R4): PASS iff a test proves an empty key on one axis skips only that axis's fetch and
  yields an empty name, without affecting the other axis.
- C5 (from R5): PASS iff a test proves a `GetReaderGroups` (or `GetTimeSpecGroups`) failure still
  yields a successful call with an empty-string name for just that axis.
- C6 (from R6): PASS iff a test proves not-found/error handling is unaffected by
  `RESOLVEGROUPNAMES`.
- C7 (from R7): PASS iff the description string mentions "RESOLVEGROUPNAMES".
- C8 (from R8): PASS iff README.md documents `RESOLVEGROUPNAMES` for `get_access_level`.
- C9 (from R9): PASS iff CHANGELOG.md's `[Unreleased]` section names this addition.
- C10 (from R10): PASS iff `npm run test:live` (or a description of a manual run) shows this case
  exercised.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all succeed with zero
  failures, and the implementation resolves `TIMESPECGROUPKEY` via the paginated list (not the
  broken singular lookup).

## Open questions

None.
