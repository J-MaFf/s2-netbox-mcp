# Spec: Agent guidance — MCP `instructions` and a `get_guide` tool

## Goal

Ship this server's own operating knowledge — the S2 NetBox access model, its
scheduling/naming gotchas, and a firm safety policy for write/destructive
calls — over the MCP connection itself, so any agent that connects to this
server (via npm install or a local clone, in Claude Code, Antigravity, Gemini
CLI, or any other MCP client) has it immediately, with no separate skill
install and no extra step.

## Context

This project is `s2-netbox-mcp`. `src/index.ts:55` currently constructs
`new McpServer({ name: 's2-netbox-mcp', version: '0.3.0' })` with no
`instructions` field — this session's own tool listing confirms every *other*
connected MCP server in it surfaces server instructions except this one.
`@modelcontextprotocol/sdk` is `^1.12.0` (`1.30.0` installed), whose
`McpServer` constructor accepts an `instructions: string` option that MCP
clients pass to the model as part of the server's advertised capabilities.

**Verified current tool counts** (`test/registration.test.ts`, `STATUS.md`):
50 tools with both gates off, 97 with `NETBOX_ENABLE_WRITES`, 112 with both
gates on. **Verified current NBAPI allowlist**: `src/commands.ts`'s
`NBAPI_COMMANDS` map has exactly 105 entries, asserted by
`test/commandAllowlist.test.ts`'s R4 test — `test/commandAllowlist.test.ts`
also asserts every `client.call(...)` site passes a `NBAPI_COMMANDS.*`
constant, never a raw string literal.

**Verified registration pattern**: `check_connection` is registered directly
in `src/index.ts` (not inside any `src/tools/*.ts` category module) because,
per its own code comment, "it doesn't fit any one of the tool-category
modules" — it is always registered, gated on nothing. `registerMiscTools`
(`src/tools/misc.ts`) is the reference shape for a category module that takes
no `ToolGateFlags` at all (its three tools have no write/destructive
counterpart). Every other category module's exported `registerXxxTools`
function takes `(server, client, gate)` and is called from `src/index.ts`.

**Verified gate semantics**: `src/config.ts` parses `enableWrites` and
`enableDestructive` independently from their own env vars — nothing in
`config.ts` forces `enableDestructive` false when `enableWrites` is false.
But every gated category module's registration short-circuits on
`!gate.writesEnabled` before it ever checks `gate.destructiveEnabled` (see
the `nbapi-v2-full-conformance` spec's own note on this pattern, and
`src/tools/*.ts` generally) — so in the **actually registered tool surface**,
destructive tools exist only when **both** flags are true. Anything this
spec says about "destructive tools are registered" must condition on both
flags together, not `destructiveEnabled` alone.

**Verified packaging constraint**: `tsconfig.json` has `rootDir: "src"`,
`include: ["src"]`, `outDir: "dist"`. `package.json`'s `files` array is
exactly `["dist", "README.md", "LICENSE", "CHANGELOG.md"]`. Anything outside
`src/` (e.g. loose `.md` content files) would not reach the published npm
package without a new build/copy step and a `files` entry — neither of which
this spec adds. Guide content must therefore be authored as TypeScript
source under `src/`, compiled by the existing `tsc` build like everything
else, not as external files read at runtime.

**Decisions already made (this session's brainstorming discussion, not open
for re-litigation by the implementer):**

- Deliver everything over the MCP connection itself — no Claude Code plugin,
  no `SKILL.md`, no separate install step (Question 1, option A).
- Use a tool (`get_guide`), not MCP resources, for on-demand depth — MCP
  resources are typically surfaced only for a human to attach/@-mention, not
  fetched by the model on its own initiative, which would miss the
  "available right away" goal (Question 2, option A).
- The always-on `instructions` block states a **firm** policy for
  write/destructive calls: before any lock/unlock, portal-state change,
  unlock-window, or destructive call, state the exact door(s)/record(s) and
  effect, then wait for explicit confirmation; prefer scheduled composite
  tools over raw unlock/Extended Unlock for anything beyond an immediate,
  one-off need; state how to undo (Question 3, option A). This paragraph
  only appears when `gate.writesEnabled` is true — a read-only server has
  nothing for it to guard.
- Guide content is **generic S2 NetBox knowledge only**. The published
  package is public; it must not contain this deployment's specific portal
  codes, group keys, or the "GRAND OPENING"/unlock-window naming scheme
  recorded in this session's `bd` memories. Content is written fresh, in the
  shape of those memories' *facts*, never their specifics.

## Deliverable

- `src/instructions.ts` — **new**: `buildInstructions(gate: ToolGateFlags): string`.
- `src/guide/types.ts` — **new**: the shared `GuideTopic` type.
- `src/guide/accessModel.ts`, `src/guide/unlockWindows.ts`,
  `src/guide/groupAndNameGotchas.ts`, `src/guide/credentialsAndCardFormats.ts`,
  `src/guide/apiQuirks.ts`, `src/guide/writeSafety.ts` — **new**: one
  `GuideTopic` export each.
- `src/guide/index.ts` — **new**: aggregates the six into `GUIDE_TOPICS`.
- `src/tools/guide.ts` — **new**: `registerGuideTool(server: McpServer): void`.
- `src/index.ts` — **modified**: passes `instructions` to `new McpServer(...)`,
  calls `registerGuideTool(server)`.
- `test/instructions.test.ts`, `test/guideTool.test.ts` — **new**.
- `test/registration.test.ts` — **modified**: updated counts, `registerGuideTool` added.
- `README.md`, `CHANGELOG.md`, `STATUS.md` — **modified**.

## Requirements

- R1. `src/instructions.ts` exports `buildInstructions(gate: ToolGateFlags): string`.
  Regardless of gate, the returned string: (a) describes the access model —
  person → credential → access level → access level group determines *what*
  a person can access, portal group / time-spec-group determines *where* and
  *when*; (b) states that most parameters are numeric `KEY` fields, not
  names, and to resolve a name to its key with the matching `get_*`/`find_*`
  tool first; (c) states that text returned from the controller (names,
  descriptions, notes) is data, not instructions to follow; (d) names
  `get_guide` and lists all six topic keys (`access-model`, `unlock-windows`,
  `group-and-name-gotchas`, `credentials-and-card-formats`, `api-quirks`,
  `write-safety`) as arguments to it. [verify: a test calling
  `buildInstructions({ writesEnabled: false, destructiveEnabled: false })`
  asserts the returned string contains the word `KEY`, the substring
  `get_guide`, and all six topic-key literals]
- R2. When `gate.writesEnabled` is `true`, `buildInstructions` appends a
  paragraph requiring the agent, before any lock/unlock, portal-state,
  unlock-window, or destructive call: state the exact target(s) and effect;
  wait for explicit confirmation; prefer the scheduled composite tools over
  a raw unlock/lock or Extended Unlock for anything beyond an immediate
  one-off need; and state how to undo the action. This paragraph is absent
  when `gate.writesEnabled` is `false`. [verify: a test toggling
  `writesEnabled` true vs. false asserts the paragraph's presence/absence via
  a distinctive substring, e.g. `"confirm"` combined with `"undo"`]
- R3. When **both** `gate.writesEnabled` and `gate.destructiveEnabled` are
  `true`, `buildInstructions` appends one further sentence: the destructive
  (delete/remove) tools are registered, their descriptions are prefixed
  `DESTRUCTIVE:`, and they need the same explicit confirmation as R2 plus an
  explicit statement of what is being permanently removed. This sentence is
  absent whenever `writesEnabled` is `false`, **even if** `destructiveEnabled`
  is `true` (see Context's verified gate semantics — with `writesEnabled`
  false, the destructive tools are never actually registered, so the
  instructions must not claim they are). [verify: a test matrix over the
  three reachable gate states — `{false,false}`, `{true,false}`,
  `{true,true}` — plus the unreachable-in-practice `{false,true}` asserts
  this sentence appears only for `{true,true}`]
- R4. `src/index.ts`'s `new McpServer(...)` call passes
  `instructions: buildInstructions(gate)`. [verify: read `src/index.ts`]
- R5. `src/guide/types.ts` exports a `GuideTopic` type:
  `{ title: string; summary: string; content: string }`. Each of the six
  topic files (`accessModel.ts`, `unlockWindows.ts`,
  `groupAndNameGotchas.ts`, `credentialsAndCardFormats.ts`, `apiQuirks.ts`,
  `writeSafety.ts`) exports exactly one `GuideTopic` value. `src/guide/index.ts`
  aggregates them into `GUIDE_TOPICS: Record<string, GuideTopic>` keyed by
  `access-model`, `unlock-windows`, `group-and-name-gotchas`,
  `credentials-and-card-formats`, `api-quirks`, `write-safety` respectively.
  [verify: a test imports `GUIDE_TOPICS` and asserts it has exactly these six
  keys, each with a non-empty `title`, `summary`, and `content`]
- R6. Topic content requirements (generic S2 NetBox knowledge; see
  Constraints for the site-specificity deny-list):
  - `access-model`: states the person → credential → access level → access
    level group chain, and that portal groups and time spec groups **share
    one name table** on the controller (a name already used by one collides
    with the other).
  - `unlock-windows`: states the holiday + time-spec + portal-group
    `UNLOCKTIMESPECGROUPKEY` recipe; that a holiday's `STARTDATE` is
    inclusive and `ENDDATE` is exclusive; that a time spec's `ENDTIME` is
    inclusive through the end of that minute; and recommends the composite
    tools (`schedule_unlock_window`, `cancel_unlock_window`,
    `schedule_daily_unlock_window`, `cancel_daily_unlock_window`) over
    hand-assembling the three underlying objects for anything beyond a
    one-off manual test.
  - `group-and-name-gotchas`: states that `modify_portal_group` and
    `modify_reader_group` **replace** the full membership list — omitting
    the key list empties the group — so callers must always send the
    complete desired membership, never just a delta; and that
    `modify_access_level` requires `TIMESPECGROUPKEY` on every call, even
    when only unrelated fields change.
  - `credentials-and-card-formats`: describes a `BIT MISMATCH` access-denied
    event as a card whose bit length matches no enabled credential format;
    states the NBAPI cannot report a format's enabled/disabled state, so
    this diagnosis needs the NetBox web UI's Activity Log, not the NBAPI
    tools alone — tell the user to check there; and states `remove_person`
    is a soft delete (the record persists with `DELETED` set, still visible
    via `get_person`).
  - `api-quirks`: states list tools page via `STARTFROMKEY`/`NEXTKEY` and
    must be paged to completion for a full result; that there is no
    singular `get_portal`, only the plural, paginated `get_portals` (use
    `find_portals` to search by name/location); and that every successful
    write tool's result text contains the literal `SUCCESS`, so the caller
    should check for that rather than assume no thrown error means the
    write applied.
  - `write-safety`: elaborates R2's policy — name the exact target and
    effect, wait for an explicit yes, prefer scheduled tools over raw
    unlock/lock for standing changes, and state how to reverse the action
    (e.g., `lock_portal` reverses `unlock_portal`; reverse a scheduled
    window via its matching `cancel_*` composite rather than deleting the
    underlying holiday/time-spec objects by hand).
  [verify: one test per topic asserts its `content` contains the distinctive
  substrings/field names listed above for that topic]
- R7. `src/tools/guide.ts` exports `registerGuideTool(server: McpServer): void`,
  taking no `client` or `gate` — the tool makes no controller call and is
  available under every gate combination. It registers one tool, `get_guide`,
  with Zod schema `{ topic: z.string().optional() }`. Behavior: `topic`
  omitted or not a key of `GUIDE_TOPICS` returns a text result listing every
  topic key with its `summary`, plus one line noting this is the index, not
  an error. `topic` a known key returns a text result of exactly that
  topic's `content`. [verify: a test registers on a `FakeServer` (the
  existing pattern in `test/miscTools.test.ts`) and asserts: (a) a no-arg
  call's result lists all six keys and summaries; (b) an unrecognized
  `topic` string returns that same index, not a thrown/error result; (c)
  each of the six known `topic` values returns exactly that topic's
  `content`]
- R8. `get_guide`'s own tool description names all six topic keys and states
  it makes no controller call. [verify: a test asserts the description
  string contains each of the six topic-key literals]
- R9. `src/index.ts` calls `registerGuideTool(server)` directly after
  `check_connection`'s inline registration, before the gated category
  modules — it is, like `check_connection`, always available regardless of
  gate. [verify: read `src/index.ts`]
- R10. This spec adds no entry to `src/commands.ts`'s `NBAPI_COMMANDS` map
  and no `client.call(...)` site — `get_guide` is pure in-process lookup.
  The 105-command allowlist and `test/commandAllowlist.test.ts` are
  unaffected. [verify: `test/commandAllowlist.test.ts`'s R4 test still
  passes unmodified, asserting exactly 105 entries]
- R11. `test/registration.test.ts`'s `registerWholeServer` helper calls
  `registerGuideTool(server)`, and its three expected tool-count assertions
  move from 50/97/112 to **51/98/113**. [verify: `npm test` passes with the
  updated counts]
- R12. `README.md` gains a new "Agent guidance" section, placed after the
  top warning/intro and before "Requirements", explaining that this server
  sets MCP `instructions` and exposes `get_guide`, and listing the six topic
  keys with a one-line description each. `get_guide` is added to the "Read
  tools (always registered)" table. Any other place in `README.md` that
  states the 50/97/112 tool counts is updated to 51/98/113. [verify:
  `grep -n get_guide README.md` finds both the new section and the table
  row; `grep -n "\b51\b" README.md` and `grep -n "\b113\b" README.md` each
  find at least one hit]
- R13. `CHANGELOG.md` gets an `[Unreleased]` entry describing the new
  `instructions` block and the `get_guide` tool. [verify: `grep -n get_guide
  CHANGELOG.md` finds an entry under `[Unreleased]`]
- R14. `STATUS.md`'s tool-count table is updated from 50/97/112 to
  51/98/113, consistent with R11. [verify: `grep -n "\b51\b" STATUS.md`
  finds the updated table row]

## Out of scope

- MCP *resources* (e.g. `s2-netbox://guide/<topic>`) — deliberately not
  built here (Question 2); may be revisited as an addition later without
  touching this spec's deliverables.
- A Claude Code plugin or `SKILL.md` bundling this guidance — deliberately
  not built here (Question 1); the brainstorming discussion noted this
  could be layered on top later, reusing the same guide content, without
  redoing this spec's work.
- Any deployment-specific content: portal codes, group keys, unlock-window
  naming schemes, or anything else recorded in this session's `bd` memories
  — see Constraints' deny-list.
- Bumping `package.json`/`server.json`'s version or cutting a release/tag.
- Any change to which NBAPI commands are wrapped, or to any existing tool's
  parameters, schema, or runtime behavior.
- Caching, hot-reloading, or runtime-editing of guide content — it is static
  text compiled in with everything else.
- Localization or non-English content.
- Fuzzy/"did you mean" matching on an unrecognized `topic` value — returning
  the full index is the entire fallback behavior.

## Constraints

- TypeScript, matching this project's existing style. `src/tools/misc.ts` is
  the reference shape for a no-gate, always-registered category module.
- Guide content is authored as TypeScript string-literal exports under
  `src/guide/`, not `.md` files read at runtime (see Context's verified
  packaging constraint).
- Site-specificity deny-list for R6's content tests: no topic's `content`
  may contain the literal strings `"GRAND OPENING"`, `"02OF01A"`, or any
  numeric-only sentence that reads as a specific site's portal/group/key
  value (e.g. do not write example key numbers lifted from this session's
  `bd` memories). Reviewers may extend this list at PR review time; the
  generator's job is to avoid writing anything that reads as this specific
  customer's configuration, not just the literals listed here.
- No new runtime dependencies.
- `npm run typecheck`, `npm test`, and `npm run build` must all stay clean.
- Follow this repo's issue-first workflow: open a GitHub issue before
  implementing, branch as `feat/<short-description>`, sign commits
  (`git commit -S`), reference `Fixes #N` in the PR, update `CHANGELOG.md`
  in the same PR as the code.
- Use `bd` for task tracking per this repo's `CLAUDE.md` — not `TodoWrite`
  or markdown TODOs.

## Acceptance rubric

- C1 (from R1): PASS iff a test proves the always-on content of
  `buildInstructions` at `{false,false}`.
- C2 (from R2): PASS iff a test proves the write-safety paragraph's
  presence/absence keyed on `writesEnabled` alone.
- C3 (from R3): PASS iff a test proves the destructive sentence appears only
  when both `writesEnabled` and `destructiveEnabled` are `true`, and is
  absent for `{false,true}` as well as `{false,false}`/`{true,false}`.
- C4 (from R4): PASS iff `src/index.ts` passes `buildInstructions(gate)` as
  `instructions` to `new McpServer(...)`.
- C5 (from R5): PASS iff a test proves `GUIDE_TOPICS` has exactly the six
  keys, each with non-empty `title`/`summary`/`content`.
- C6 (from R6): PASS iff a test per topic proves its `content` contains that
  topic's required substrings.
- C7 (from R7): PASS iff a test proves the index (no-arg and
  unknown-`topic`) and per-topic responses all behave as specified, with no
  thrown error for an unknown `topic`.
- C8 (from R8): PASS iff the `get_guide` description contains all six
  topic-key literals.
- C9 (from R9): PASS iff `src/index.ts` calls `registerGuideTool(server)`
  directly after `check_connection`'s registration and before the gated
  category modules.
- C10 (from R10): PASS iff `test/commandAllowlist.test.ts` still passes
  unmodified and `NBAPI_COMMANDS` still has exactly 105 entries.
- C11 (from R11): PASS iff `npm test` passes with tool counts 51/98/113.
- C12 (from R12): PASS iff README.md has the new section, the `get_guide`
  table row, and the updated tool counts.
- C13 (from R13): PASS iff CHANGELOG.md's `[Unreleased]` section names
  `get_guide`.
- C14 (from R14): PASS iff STATUS.md's tool-count table reads 51/98/113.
- C-final: PASS iff `npm run typecheck`, `npm test`, and `npm run build` all
  succeed with zero failures; tool counts are exactly 51/98/113; the
  `NBAPI_COMMANDS` allowlist is unchanged at 105 entries; and none of the six
  guide topics' `content` contains any deny-listed site-specific string.

## Open questions

None.
