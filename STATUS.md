# Project Status

## What This Is

A local MCP server exposing LenelS2 S2 NetBox NBAPI operations (persons/credentials, access
levels, portals/readers/outputs, time specs, holidays, portal/reader groups, threat levels,
events/activity, partitions/UDF lists) as MCP tools usable from any MCP-compatible client (Claude,
Gemini/Antigravity, etc.), so NetBox data can be queried — and, when explicitly enabled, changed —
conversationally instead of via hand-built XML/HTTP calls. Node/TypeScript, stdio transport,
session-login auth only. Read-only by default; write tools are gated behind
`NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` (see README "Write access"). On top of the
pass-through tools it offers composite ones: `find_portals`, `get_reader_access_history`,
`set_portals_state`, a managed unlock window (`schedule_unlock_window` / `cancel_unlock_window` /
`get_unlock_window`), and a managed **daily recurring** unlock window
(`schedule_daily_unlock_window` / `cancel_daily_unlock_window` / `get_daily_unlock_window`) — the
unlock windows are enforced by the controller itself (README "Scheduled unlock windows" /
"Scheduled daily unlock windows"). Several read tools also accept opt-in/opt-out `RESOLVENAMES`/
`RESOLVEDESCRIPTIONS` flags to resolve a bare `PERSONID`/`READERKEY` to a human-readable name
inline (README "Tools exposed"). See `specs/archive/s2-netbox-mcp-write.md` for the write-tools
spec (archived `specs/archive/s2-netbox-mcp.md` is the original read-only v1 spec — all its
acceptance criteria passed).

Published on [npm](https://www.npmjs.com/package/s2-netbox-mcp) and the [official MCP
Registry](https://registry.modelcontextprotocol.io) as `io.github.J-MaFf/s2-netbox-mcp`; submitted
to the mcp.so directory. Releases publish themselves via GitHub Actions + npm Trusted Publishing
(OIDC) on every `v*` tag push — no manual `npm login`/token ever needed again. The same workflow
then creates the matching GitHub Release from that tag's CHANGELOG entry.

## Current State — 2026-09-17

### Full NBAPI v2 command conformance (`v0.4.0`)

Issue [#100](https://github.com/J-MaFf/s2-netbox-mcp/issues/100), branch
`feat/nbapi-v2-full-conformance`, spec `specs/archive/nbapi-v2-full-conformance.md`. The server now wraps
**every** command the April-2025 NBAPI v2 guide (#API2-UG-8) documents and that fits a
request/response tool, and both vendor guides have been diffed against it end to end.

**Numbers, as asserted by the test suite:**

| Measure | Before | After |
|---|---|---|
| `NBAPI_COMMANDS` allowlist (`src/commands.ts`) | 81 | **105** |
| Tools with both gates off (read-only) | 38 | **50** |
| Tools with `NETBOX_ENABLE_WRITES` | 77 | **97** |
| Tools with both gates on | 88 | **112** |
| Unit tests (`npx vitest run`) | 662 in 33 files | **745 in 38 files** |
| `scripts/live-check.ts` checks | 45 | **64** |

The 24 new commands, all v2-only: `GetPortalStates`, `GetPortalStatuses`, `GetLocations`,
`GetAlarms`, `GetPicture`, `GetVirtualCredentialRequest`, `AddVirtualCredentialRequest`,
`RemoveVirtualCredentialRequest`, `AddDutyLog`, and the full Mercury panel / network node / SIO
hardware surface (`Get`/`Add`/`Modify`/`Delete` for each). Two new tool modules,
`src/tools/hardware.ts` and `src/tools/alarm.ts`, plus additions to `src/tools/portal.ts` and
`src/tools/person.ts`.

`get_portal_statuses` is the notable one: it is the first NBAPI read of **live** portal state this
server has had. Everything else reads configuration; this returns the current state of each door.

**Live read verification — run 2026-09-17 against the reference controller (NetBox 6.2.0):**

```
Summary: 64 tools checked, 64 passed, 0 failed.
```

All 12 new read tools PASS or SKIP-pass, and so do the four read behaviours the unreleased batch
had shipped without live coverage (`get_threat_levels`, the `PARTITIONKEY` filter on
`get_access_levels`/`get_access_level_groups`, the nine new `search_person_data` filters, and
`get_holidays`' empty `PARAMS` block). One live finding came out of it: `SearchPersonData`
validates `CARDSTATUS` against the controller's configured card statuses, so the check reuses a
status read off a real card rather than an invented string.

**Live write verification — run 2026-09-17 against the reference controller (NetBox 6.2.0),
maintainer-supervised (`npx tsx scripts/live-check-write.ts`):**

```
Summary: 42 step(s), 41 passed, 1 failed.
```

All four new steps passed: `modify_time_spec`'s `NAME` rename, `add_time_spec_group`'s seeded
`TIMESPECKEYS`, both `add_person` steps for the #79 probe, and `add_duty_log`. The single failure
is a pre-existing, unrelated controller-clock-skew guard (not new in this PR) — it also skipped
the script's separate real-portal-unlock phase (c) as a result. The `set_threat_level_locations`
supervised `--action` was not exercised in this run.

> **#79 finding, resolved.** Does setting `USERNAME` make `ROLE`/`AUTHTYPE` mandatory on
> `AddPerson`? **Yes.** `AddPerson` with no `USERNAME`/`ROLE`/`AUTHTYPE` still succeeds (the
> regression guard holds — the earlier optional-fields change from
> [#79](https://github.com/J-MaFf/s2-netbox-mcp/issues/79) didn't break the no-auth-fields path).
> `AddPerson` with `USERNAME` set but `ROLE`/`AUTHTYPE` omitted **fails** with
> `ERRMSG "Missing ROLE"`. Conclusion: callers must supply `USERNAME`, `ROLE`, and `AUTHTYPE`
> together, or omit all three — there is no valid partial combination.

**Command diff.** [`docs/reference/nbapi-command-diff.md`](docs/reference/nbapi-command-diff.md) is
a 118-row, command-by-command and parameter-by-parameter comparison of the v1-2024 guide, the
v2-2025 guide and this server. Three findings from it are now recorded permanently rather than
left to be rediscovered:

- **Elevators and floors have no write API.** Neither guide documents any
  `Add`/`Modify`/`Delete` command for either. This closes what was item 2 of the previous "Natural
  Next Steps" — `get_elevators`/`get_floors` are read-only because the vendor API is.
- **The server already speaks v2.** Same `/nbws/goforms/nbapi` endpoint, same XML envelope, same
  "Enable V2" switch the README already requires. The v1 end-of-support notice does not affect it.
- **Data Operations has no API.** It is a web-UI and NAS-polling feature; there is nothing to wrap,
  and no tooling was built.

**Hardware caveat.** The twelve Mercury/network-node/SIO tools are **not live-verified**: the
reference controller has no Mercury panels and no SIOs, so their reads SKIP-pass and their writes
have never been issued against real hardware. `src/tools/hardware.ts`'s header and the README both
say so. Live-exercising hardware CRUD was deliberately out of scope.

## Previous State — 2026-09-16

### Person/reader-description enrichment across access-record tools (`v0.3.0`)

A five-part sequential push (spec -> forge loop per part, one PR each) making every read tool
that returns a bare `PERSONID` or `READERKEY` optionally resolve it to a human-readable name,
instead of requiring a separate `get_person`/`get_readers` lookup to decode who or where:

1. **`get_reader_access_history`** (issue [#46](https://github.com/J-MaFf/s2-netbox-mcp/issues/46),
   [PR #48](https://github.com/J-MaFf/s2-netbox-mcp/pull/48)) — new composite tool: a single
   reader's access (grant/deny) history, since `GetAccessHistory` itself has no `READERKEY`
   filter. Filters client-side over a bounded `SCANWINDOW` (default 2000 most-recent records) via
   its own `AFTERLOGID`/`NEXTLOGID` pagination loop, seeded by a cheap `MAXRECORDS: '1'` call that
   discovers the current max `LOGID`. Each match's `PERSONID` is enriched with a name (one
   `GetPerson` call per distinct person), capped at `MAXMATCHES` (default 100) with a `truncated`
   flag.
2. **`get_access_history` `RESOLVENAMES`** (issue
   [#51](https://github.com/J-MaFf/s2-netbox-mcp/issues/51), fixing the broken
   `OLDESTDTTM`/`NEWESTDTTM` date-range params along the way — issue
   [#47](https://github.com/J-MaFf/s2-netbox-mcp/issues/47) — [PR #52](https://github.com/J-MaFf/s2-netbox-mcp/pull/52)):
   opt-in (`false` by default) per-record `PERSONID` -> name resolution via the new
   `src/personEnrichment.ts` (`enrichWithPersonNames`, one `GetPerson` call per distinct
   `PERSONID`, memoized per request, failures isolated to just that person's records). Live A/B
   testing proved this controller silently ignores `OLDESTDTTM`/`NEWESTDTTM`/`STARTDATE`/`ENDDATE`
   regardless of name, so date-range filtering was removed rather than "fixed."
3. **`RESOLVEDESCRIPTIONS` on `get_access_history` / `get_reader_access_history` /
   `get_card_access_details`** (issue [#53](https://github.com/J-MaFf/s2-netbox-mcp/issues/53),
   [PR #54](https://github.com/J-MaFf/s2-netbox-mcp/pull/54)): opt-*out* (`true` by default,
   inverted from `RESOLVENAMES`, since a full `GetReaders` fetch is one small fixed-cost table
   regardless of result size) `READERKEY` -> `DESCRIPTION` resolution via the new
   `src/readerDescriptions.ts` (`fetchReaderDescriptions`, one full-table fetch per call; never
   throws — a `GetReaders` failure degrades to an empty map rather than losing the primary access
   data, a fix made after round-1 evaluation caught the original per-caller catch missing
   `get_reader_access_history`'s own direct call site).
4. **`get_card_access_details` `RESOLVENAMES`** (issue
   [#55](https://github.com/J-MaFf/s2-netbox-mcp/issues/55),
   [PR #56](https://github.com/J-MaFf/s2-netbox-mcp/pull/56)): this tool's response carries
   exactly one `PERSONID` at the top level (one card = one person), so the single `GetPerson`
   lookup's four fields land on the top level of the response, not duplicated per `ACCESS` record
   — cheaper than `get_access_history`'s per-record case.
5. **`get_portals` `RESOLVEDESCRIPTIONS`** (issue
   [#57](https://github.com/J-MaFf/s2-netbox-mcp/issues/57),
   [PR #58](https://github.com/J-MaFf/s2-netbox-mcp/pull/58)): opt-out, `true` by default, reusing
   `fetchReaderDescriptions`. Unlike the sibling tools above (which add a new sibling
   `READERDESCRIPTION` field to flat records), this fills `DESCRIPTION` in directly on each nested
   reader object, using the reader's own native `GetReaders` field name, since `get_portals`'s
   readers are nested objects rather than flat records.

All five were built via the `blueprint` -> `forge` spec-driven loop (5 specs, all archived under
`specs/archive/`); [#49](https://github.com/J-MaFf/s2-netbox-mcp/issues/49) (README's client
registration section made client-agnostic, [PR #50](https://github.com/J-MaFf/s2-netbox-mcp/pull/50))
and [#44](https://github.com/J-MaFf/s2-netbox-mcp/issues/44) (this file's previous refresh,
[PR #45](https://github.com/J-MaFf/s2-netbox-mcp/pull/45)) landed alongside them. `get_reader_access_history`
is the only new tool name; every other change is an additive optional field on an existing tool.

Tool surface on `main` now: **38** read tools with writes off; **77** with `NETBOX_ENABLE_WRITES`;
**88** with `NETBOX_ENABLE_DESTRUCTIVE` as well (up from 37/76/87 for the new `get_threat_levels`
read tool — issue [#77](https://github.com/J-MaFf/s2-netbox-mcp/issues/77), added after a full
conformance review against the vendor's April-2025 NBAPI v2 doc found the command was documented
but never wired into the 80-command allowlist; see `docs/reference/NetBox_API_V2.pdf`).
659 unit tests pass (33 files), `npm run typecheck` and `npm run build` are clean, and
`npm run test:live` (39/39) has verified every enrichment path against the real controller.

## Previous State — 2026-09-15

Both stages of the write-tools spec (now archived at `specs/archive/s2-netbox-mcp-write.md`) are
complete and live-verified, and both are merged into `main`. Stage 1 (issue #8) added the
80-command allowlist, nested `PARAMS` XML, the write gates and R7 config, 18 read tools, and 45
pass-through write tools — [PR #10](https://github.com/J-MaFf/s2-netbox-mcp/pull/10) (merged).
Stage 2 (issue #9), on `feat/netbox-unlock-window` stacked on top, added:

- `set_portals_state` (composite write): bulk lock / unlock / momentary-unlock, sequential, never
  aborting, with `succeeded` / `alreadyInState` / `failed` partitions.
- The managed unlock window: a pure planner (`src/unlockWindow/planner.ts`, R23) separated from
  the executor (`src/unlockWindow/executor.ts`) that issues the NBAPI calls in the exact R25 order,
  with the R22 rejections, the R24 side-effect check (`acknowledgeSideEffects` / `dryRun`), the
  read-back verification, R26 cancel (tolerated refusals under `leftBehind`) and status
  (`get_unlock_window`, always registered), the R27 managed-name guard, and R28 idempotency. Time
  spec group membership is read from paginated `GetTimeSpecGroups`, never from `GetTimeSpecGroup`
  (which fails on the verified 6.2.0 controller).
- `scripts/live-check-write.ts` (`npm run test:live:write`, R30): CRUD round-trips under the
  `MCP livecheck` prefix, and — only with `--go`, after the user has been notified of the exact
  unlock/relock times — a real 2-minute window on `NETBOX_LIVE_TEST_PORTALKEY`.
- The shared NEXTKEY paging helper (`src/paging.ts`) and RESPONSE-level field merging in the
  client.

[PR #11](https://github.com/J-MaFf/s2-netbox-mcp/pull/11) (stacked on PR #10, merged) added it.
[PR #14](https://github.com/J-MaFf/s2-netbox-mcp/pull/14) (issues #12/#13, merged) then extended
`npm run test:live:write` with round-trips for people/credentials, access levels, threat levels,
`InsertActivity`, a UDF list item, and `SwitchPartition`, plus the `trigger_event_activate`/
`trigger_event_deactivate` supervised actions — the only live verification path for `TriggerEvent`.

Tool surface on `main` (before the daily-unlock-window work below): 35 read tools with writes off;
72 with `NETBOX_ENABLE_WRITES`; 83 with `NETBOX_ENABLE_DESTRUCTIVE` as well. All three PRs above
are merged, and `v0.1.1` has since been tagged (LICENSE + archived-spec path redaction).

Three findings came out of the live write check and are folded into the spec/README/CHANGELOG:

- Group names are unique **across** group types on the controller, so the managed time spec group
  is named `"<prefix> time specs"`, never `"<prefix>"` (which the portal group already uses).
- `ModifyPortalGroup`/`ModifyReaderGroup` **replace** the group's entire membership rather than
  appending to it, so the full portal/reader key list must be sent on every modify.
- The controller's clock was found to be off by roughly 4 hours 35 minutes; the user corrected it,
  and `npm run test:live:write`'s door phase now measures clock skew and refuses to proceed above
  a 2-minute threshold rather than schedule a window against the wrong clock.

### Daily recurring unlock window (`v0.2.0`)

Adds a companion to the managed unlock window above: `schedule_daily_unlock_window` /
`cancel_daily_unlock_window` / `get_daily_unlock_window` express "unlock these doors from
*dailyStartTime* to *dailyEndTime*, every day from *startDate* through *endDate*" — a single
partial-day window that recurs daily across a date range, which `schedule_unlock_window` cannot
express without keeping doors unlocked overnight on days strictly between the first and last.

- A pure planner (`src/unlockWindow/dailyPlanner.ts`) always produces exactly **one** segment (no
  first/middle/last splitting is ever needed for this shape of request) separated from the
  executor (`src/unlockWindow/dailyExecutor.ts`), which reuses `src/unlockWindow/managed.ts`'s
  existing fetchers/normalisers rather than duplicating them.
- A dedicated reserved holiday group, `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` (default `5`), validated
  at startup to never collide with `NETBOX_UNLOCK_HOLIDAY_GROUPS`, and its own name prefix,
  `NETBOX_DAILY_UNLOCK_NAME_PREFIX` (default `MCP Daily Unlock Window`) — so the two features use
  disjoint holiday groups and disjoint managed-object names and may both be active at once.
- The same side-effect check, read-back verification, rollback-on-failure, tolerated-refusal
  cancel, and idempotency guarantees as the continuous feature, scoped to this feature's own plan
  and prefix (a concurrently-active continuous window is reported like any other foreign object,
  not special-cased).
- `scripts/live-check-write-daily.ts` (`npm run test:live:write:daily`): CRUD round-trips under the
  `MCP livecheck daily` prefix, the same controller-clock-skew gate, and — only with `--go` — a
  real 2-minute daily window on `NETBOX_LIVE_TEST_PORTALKEY`. Kept as a separate `npm` script
  rather than chained onto `npm run test:live:write` with `&&`, because npm appends `-- --go` to
  the end of a chained script string, which would silently misdirect the flag to the wrong script.

Tool surface after this work: 36 read tools with writes off; 75 with `NETBOX_ENABLE_WRITES`; 86
with `NETBOX_ENABLE_DESTRUCTIVE` as well. `package.json` bumped to `0.2.0` (new backward-compatible
feature, per semver).

521 unit tests pass (27 files), `npm run typecheck` and `npm run build` are clean. `npm run
test:live:write:daily -- --go` was run live the same day: a real 14:15-14:17 window on portal
`02OF01A`, unlock and relock confirmed in person, 16/16 steps PASS, `cancel_daily_unlock_window`
left the portal group on `Never` with no managed holiday/time spec remaining. One finding from
that run: on this host's PowerShell, `npm run test:live:write:daily -- --go` silently drops the
`--go` flag (`npm warn Unknown cli config "--go"`) — `npx tsx scripts/live-check-write-daily.ts
--go` is the reliable invocation (now documented in README, and the same caveat applies to the
continuous feature's `npm run test:live:write -- --go`).

### Growth & adoption (`v0.2.1`–`v0.2.3`, milestone closed)

A five-part push to make the server installable and findable by people other than the maintainer,
tracked as the GitHub milestone "Growth & adoption (v1)" (11/11 issues closed, now closed):

1. **Release hygiene** — `v0.2.0` through `v0.2.3` tagged and released, each with a CHANGELOG entry.
2. **npm** — `package.json` flipped `private: false`, `bin`/`files`/`repository`/`keywords` added, a
   `#!/usr/bin/env node` shebang added to `src/index.ts` so `npm install -g` gives a runnable
   `s2-netbox-mcp` command. First publish had to go through `npm publish` from a real interactive
   terminal (npm's 2FA/OTP web-confirmation URL is deliberately redacted from any non-TTY output,
   so it can't be completed through an automated/piped session).
3. **CI + contribution scaffolding** — `.github/workflows/ci.yml` (typecheck/test/build on every
   push/PR, now a required status check on the Main Branch Ruleset), `CONTRIBUTING.md`, issue/PR
   templates. `package-lock.json` is now tracked (was silently excluded by a machine-wide global
   gitignore rule, not this repo's own).
4. **npm Trusted Publishing** — `.github/workflows/publish.yml` publishes to npm via OIDC on every
   `v*` tag push (npm CLI >=11.5.1, Node >=22.14 in the workflow). Configured on npmjs.com's package
   Settings -> Trusted Publisher (org `J-MaFf`, repo `s2-netbox-mcp`, workflow `publish.yml`,
   "Allow npm publish" checked). Every version published this way gets an automatic SLSA
   provenance attestation. `Publishing access` on npmjs.com is set to "Require two-factor
   authentication and disallow bypass 2fa tokens."
5. **MCP directory listings** — `server.json` added (npm's `mcpName` field cross-references it);
   published to the official MCP Registry as `io.github.J-MaFf/s2-netbox-mcp` via the
   `mcp-publisher` CLI (GitHub device-code auth, re-run after every version bump to keep the
   registry's version pointer current). Submitted to mcp.so
   ([chatmcp/mcpso#4163](https://github.com/chatmcp/mcpso/issues/4163)). PulseMCP has new
   submissions paused platform-wide; Glama appears to auto-crawl GitHub topics (no action taken);
   Smithery requires the maintainer's own GitHub OAuth connection through their dashboard (not
   done).
6. **Security posture** — `SECURITY.md` (private vulnerability reporting + physical-safety blast
   radius by config level), a `> [!WARNING]` callout near the top of README.md, and three repo
   settings turned on that were previously off: GitHub private vulnerability reporting, secret
   scanning, and secret scanning push protection (Dependabot security updates was already on).

Two follow-on patch releases (`v0.2.2`, `v0.2.3`) were version-only: one to add npm's required
`mcpName` field, one purely to refresh npm's published README after a couple of unrelated wording
fixes ([#38](https://github.com/J-MaFf/s2-netbox-mcp/issues/38),
[#40](https://github.com/J-MaFf/s2-netbox-mcp/issues/40)) — npm snapshots the README at publish
time and has no live sync from GitHub, so any README-only change needs a new version to reach npm.

### Components

| File | Description |
|---|---|
| `src/index.ts` | MCP server entrypoint; registers `check_connection` plus every `registerXxxTools` module (including `registerUnlockWindowTools`/`registerDailyUnlockWindowTools`), gated by `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE`; handles startup/shutdown |
| `src/paging.ts` | The shared "fully paginated" NEXTKEY loop (`fetchAllPages` / `fetchAllPagesWith`) plus the XML-record helpers, used by every composite tool |
| `src/portalSearch.ts` | `find_portals` logic: pages GetPortals + GetReaders, joins reader descriptions by READERKEY, term search |
| `src/portalState.ts` | `set_portals_state` logic: one Lock/Unlock/MomentaryUnlock per portal, sequential, outcome partitioning |
| `src/readerAccessHistory.ts` | `get_reader_access_history` logic: client-side `READERKEY` filter over a bounded `AFTERLOGID`/`NEXTLOGID` scan window, `MAXMATCHES` cap |
| `src/personEnrichment.ts` | `enrichWithPersonNames`: shared `PERSONID` -> name resolution (`RESOLVENAMES`), one `GetPerson` call per distinct person, per-request memoized, failure-isolated |
| `src/readerDescriptions.ts` | `fetchReaderDescriptions`/`enrichWithReaderDescriptions`: shared `READERKEY` -> `DESCRIPTION` resolution (`RESOLVEDESCRIPTIONS`), one full-table `GetReaders` fetch per call, never throws |
| `src/unlockWindow/planner.ts` | Pure R23 planner (`planUnlockWindow`), date-time parsing/validation, R22 clock/31-day checks |
| `src/unlockWindow/managed.ts` | Managed-object naming (R27), read-back normalisation (`TRUE`/`FALSE`, `HH:MM:SS`, `YYYY-MM-DD HH:MM:SS`, comma key strings), typed paginated readers |
| `src/unlockWindow/executor.ts` | `scheduleUnlockWindow` (R22/R24/R25/R28), `cancelUnlockWindow` (R26), `getUnlockWindow` (R26) |
| `src/tools/unlockWindow.ts` | Registers `get_unlock_window` (always) and `schedule_unlock_window` / `cancel_unlock_window` (writes on) |
| `src/unlockWindow/dailyPlanner.ts` | Pure daily-window planner (`planDailyUnlockWindow`, always one segment), date/time parsing/validation, clock/31-day checks |
| `src/unlockWindow/dailyExecutor.ts` | `scheduleDailyUnlockWindow`, `cancelDailyUnlockWindow`, `getDailyUnlockWindow` — reuses `managed.ts`'s fetchers/normalisers |
| `src/tools/dailyUnlockWindow.ts` | Registers `get_daily_unlock_window` (always) and `schedule_daily_unlock_window` / `cancel_daily_unlock_window` (writes on) |
| `src/netboxClient.ts` | NBAPI XML client: session login/logout, retry-once-on-expiry, error mapping, per-command request path, RESPONSE-level field merge |
| `src/config.ts` | Environment-variable configuration, including the write-tool gates and the unlock-window variables |
| `src/commands.ts` | The closed 105-command NBAPI allowlist — full command-level conformance with the April-2025 NBAPI v2 guide |
| `src/tools/hardware.ts` | Mercury panel / network node / SIO tools (6 reads, 6 writes, 3 destructive deletes). Nested `NETWORK`/`SIOCHANNELSETTINGS` blocks, closed `TYPE` enums, `TRUE`/`FALSE` string booleans. **Not live-verified** — no Mercury/SIO hardware on the reference controller |
| `src/tools/alarm.ts` | `get_alarms` (read) and `add_duty_log` (write). The v2 alarm-queue workflow commands (`AckAlarm`, `AckEvent`, `AlarmClearActions`, `AlarmSetOwner`, `EventClearActions`) are deliberately not wired in |
| `docs/reference/nbapi-command-diff.md` | The three-way command diff: v1-2024 guide vs v2-2025 guide vs this server, 118 command rows plus a parameter-level diff of all 81 pre-existing commands, and the elevators/floors, protocol and Data Operations findings |
| `src/xml.ts` | NBAPI XML request building (nested/array PARAMS) / response parsing |
| `src/errors.ts` | APIERROR code descriptions, `NbapiApiError`/`NbapiFailError` |
| `src/toolHelpers.ts` | `runNbapiTool`, `ToolGateFlags`, `formatWriteSuccess`, `clientGuardError`/`destructiveFlagRequired`, `wrapList` |
| `src/tools/*.ts` | One module per tool category: `person`, `accessLevel`, `portal` (incl. `find_portals`, `set_portals_state`), `events`, `timeSpec`, `holiday`, `portalGroup`, `readerGroup`, `threatLevel`, `partition`, `hardware`, `alarm`, `misc`, `unlockWindow`, `dailyUnlockWindow` |
| `scripts/live-check.ts` | Opt-in live read-only smoke test (`npm run test:live`) — 64 checks covering every always-registered read tool |
| `scripts/live-check-write.ts`, `scripts/liveCheckWriteHelpers.ts` | Opt-in live write smoke test (`npm run test:live:write`) and its unit-tested pure helpers |
| `scripts/live-check-write-daily.ts` | Opt-in live write smoke test for the daily window (`npm run test:live:write:daily`) |
| `test/fakeNetbox.ts` | Stateful in-memory controller double for the composite tools' tests (reproduces the live 6.2.0 quirks) |
| `server.json` | Official MCP Registry metadata (`io.github.J-MaFf/s2-netbox-mcp`); version kept in sync with `package.json` |
| `.github/workflows/ci.yml` | Typecheck/test/build on every push/PR against `main`; a required status check |
| `.github/workflows/publish.yml` | Publishes to npm via OIDC Trusted Publishing on every `v*` tag push, then creates the matching GitHub Release from that tag's CHANGELOG entry |
| `CONTRIBUTING.md` | Issue-first workflow, branch naming, PR conventions for outside contributors |
| `SECURITY.md` | Private vulnerability reporting instructions; physical-safety blast radius by config level |

### Resolved Issues

| Issue | Description | PR |
|---|---|---|
| [#2](https://github.com/J-MaFf/s2-netbox-mcp/issues/2) | Build read-only S2 NetBox MCP server | [#3](https://github.com/J-MaFf/s2-netbox-mcp/pull/3) |
| [#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4) | NetBox 6.x endpoint (`/nbws/goforms/nbapi`), 410/APIERROR-5 diagnostics, README prerequisites, `extraParams` field-name cleanup, live-check empty-collection accommodation | [#5](https://github.com/J-MaFf/s2-netbox-mcp/pull/5) |
| [#6](https://github.com/J-MaFf/s2-netbox-mcp/issues/6) | `find_portals`: search doors by name or reader description | [#7](https://github.com/J-MaFf/s2-netbox-mcp/pull/7) |
| [#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8) | NBAPI write tools (stage 1: allowlist, gates, 18 read + 45 write pass-through tools) | [#10](https://github.com/J-MaFf/s2-netbox-mcp/pull/10) |
| [#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9) | Managed unlock windows, `set_portals_state`, live write smoke test (stage 2); live door test passed | [#11](https://github.com/J-MaFf/s2-netbox-mcp/pull/11) |
| [#12](https://github.com/J-MaFf/s2-netbox-mcp/issues/12) | Track live-verification status of every MCP tool; added `trigger_event_activate`/`trigger_event_deactivate` supervised actions | [#14](https://github.com/J-MaFf/s2-netbox-mcp/pull/14) |
| [#13](https://github.com/J-MaFf/s2-netbox-mcp/issues/13) | Live round-trips for people, credentials, access levels, threat levels, activity, UDF, partitions in `test:live:write` | [#14](https://github.com/J-MaFf/s2-netbox-mcp/pull/14) |
| [#15](https://github.com/J-MaFf/s2-netbox-mcp/issues/15) | Prepare and publish the first tagged release (`v0.1.0`) | [#16](https://github.com/J-MaFf/s2-netbox-mcp/pull/16) |
| [#17](https://github.com/J-MaFf/s2-netbox-mcp/issues/17) | README leaked maintainer's personal Windows path in the MCP config example | [#18](https://github.com/J-MaFf/s2-netbox-mcp/pull/18) |
| [#19](https://github.com/J-MaFf/s2-netbox-mcp/issues/19) | Add LICENSE (MIT); redact local Windows username from archived specs | [#20](https://github.com/J-MaFf/s2-netbox-mcp/pull/20) |
| [#21](https://github.com/J-MaFf/s2-netbox-mcp/issues/21) | Cut v0.1.1 (LICENSE + archived-spec path redaction) | [#22](https://github.com/J-MaFf/s2-netbox-mcp/pull/22) |
| [#23](https://github.com/J-MaFf/s2-netbox-mcp/issues/23) | Daily recurring unlock window (`schedule_daily_unlock_window`/`cancel_daily_unlock_window`/`get_daily_unlock_window`); live door test passed | [#24](https://github.com/J-MaFf/s2-netbox-mcp/pull/24) |
| [#26](https://github.com/J-MaFf/s2-netbox-mcp/issues/26) | Tag and publish v0.2.0 | [#31](https://github.com/J-MaFf/s2-netbox-mcp/pull/31) |
| [#27](https://github.com/J-MaFf/s2-netbox-mcp/issues/27) | Make s2-netbox-mcp installable via npm | [#32](https://github.com/J-MaFf/s2-netbox-mcp/pull/32) |
| [#28](https://github.com/J-MaFf/s2-netbox-mcp/issues/28) | CI + CONTRIBUTING.md + issue/PR templates | [#35](https://github.com/J-MaFf/s2-netbox-mcp/pull/35) |
| [#29](https://github.com/J-MaFf/s2-netbox-mcp/issues/29) | Submit to MCP server directories (official Registry, mcp.so) | [#36](https://github.com/J-MaFf/s2-netbox-mcp/pull/36) |
| [#33](https://github.com/J-MaFf/s2-netbox-mcp/issues/33) | npm Trusted Publishing via GitHub Actions | [#34](https://github.com/J-MaFf/s2-netbox-mcp/pull/34) |
| [#38](https://github.com/J-MaFf/s2-netbox-mcp/issues/38) | Improve README read-only tools list readability | [#37](https://github.com/J-MaFf/s2-netbox-mcp/pull/37) |
| [#40](https://github.com/J-MaFf/s2-netbox-mcp/issues/40) | Fix write and destructive tools section wording in README | [#39](https://github.com/J-MaFf/s2-netbox-mcp/pull/39) |
| [#41](https://github.com/J-MaFf/s2-netbox-mcp/issues/41) | Cut v0.2.3 to sync npm's published README | [#42](https://github.com/J-MaFf/s2-netbox-mcp/pull/42) |
| [#30](https://github.com/J-MaFf/s2-netbox-mcp/issues/30) | SECURITY.md + physical-safety README messaging + repo security settings | [#43](https://github.com/J-MaFf/s2-netbox-mcp/pull/43) |
| [#44](https://github.com/J-MaFf/s2-netbox-mcp/issues/44) | Refresh stale STATUS.md | [#45](https://github.com/J-MaFf/s2-netbox-mcp/pull/45) |
| [#46](https://github.com/J-MaFf/s2-netbox-mcp/issues/46) | Add `get_reader_access_history` composite tool | [#48](https://github.com/J-MaFf/s2-netbox-mcp/pull/48) |
| [#49](https://github.com/J-MaFf/s2-netbox-mcp/issues/49) | README's MCP client registration section made client-agnostic (Claude Code, Antigravity, Gemini CLI) | [#50](https://github.com/J-MaFf/s2-netbox-mcp/pull/50) |
| [#47](https://github.com/J-MaFf/s2-netbox-mcp/issues/47) / [#51](https://github.com/J-MaFf/s2-netbox-mcp/issues/51) | `get_access_history` `RESOLVENAMES` person-name enrichment; removed broken `OLDESTDTTM`/`NEWESTDTTM` date-range params | [#52](https://github.com/J-MaFf/s2-netbox-mcp/pull/52) |
| [#53](https://github.com/J-MaFf/s2-netbox-mcp/issues/53) | `RESOLVEDESCRIPTIONS` reader-description enrichment on `get_access_history`/`get_reader_access_history`/`get_card_access_details` | [#54](https://github.com/J-MaFf/s2-netbox-mcp/pull/54) |
| [#55](https://github.com/J-MaFf/s2-netbox-mcp/issues/55) | `get_card_access_details` `RESOLVENAMES` person-name enrichment (single top-level lookup) | [#56](https://github.com/J-MaFf/s2-netbox-mcp/pull/56) |
| [#57](https://github.com/J-MaFf/s2-netbox-mcp/issues/57) | `get_portals` `RESOLVEDESCRIPTIONS` reader-description enrichment (nested reader objects) | [#58](https://github.com/J-MaFf/s2-netbox-mcp/pull/58) |
| [#100](https://github.com/J-MaFf/s2-netbox-mcp/issues/100) | NBAPI v2 full conformance: the 24 remaining v2 commands (allowlist 81 -> 105, tools 38/77/88 -> 50/97/112), live verification of the 12 new reads plus four unreleased read gaps (64/64 on 2026-09-17), maintainer-run write verification (41/42 on 2026-09-17; the #79 `ROLE`/`AUTHTYPE` question resolved), the three-way command diff report, and the README/STATUS/CHANGELOG refresh | [#101](https://github.com/J-MaFf/s2-netbox-mcp/pull/101) |
| [#102](https://github.com/J-MaFf/s2-netbox-mcp/issues/102) | `live-check-write`'s clock-skew guard now reads the controller's own HTTP `Date` response header (fresh on every request) as the primary source, falling back to the newest access-record DTTM only if that header is unavailable — distinguishes real controller drift from a merely-quiet reader | [#103](https://github.com/J-MaFf/s2-netbox-mcp/pull/103) |
| [#104](https://github.com/J-MaFf/s2-netbox-mcp/issues/104) | Cut v0.4.0 (minor: 24 new NBAPI v2 tools, live verification, command diff report, HTTP-Date clock-skew improvement — all additive, no removed/renamed tools) | [#105](https://github.com/J-MaFf/s2-netbox-mcp/pull/105) |
| [#106](https://github.com/J-MaFf/s2-netbox-mcp/issues/106) | `publish.yml` now creates the GitHub Release (notes = the tag's CHANGELOG entry) after a successful npm publish; `v0.4.0` and `v0.2.2` Releases backfilled by hand | [#107](https://github.com/J-MaFf/s2-netbox-mcp/pull/107) |
| [#108](https://github.com/J-MaFf/s2-netbox-mcp/issues/108) | README Requirements: Node.js includes npm, and can be installed on Windows with `winget install OpenJS.NodeJS.LTS` | [#109](https://github.com/J-MaFf/s2-netbox-mcp/pull/109) |

### Open Issues

None on GitHub. One tracked in `bd` only (not a shippable code unit): setting up the Antigravity
desktop app + `s2-netbox-mcp` for a second user (Angela) — her NetBox operator account already has
the same `full system setup` role as the maintainer's, so the write/destructive gating has to be
enforced client-side via her `mcp_config.json`, not by the NetBox account itself.

## Natural Next Steps

1. **Smithery listing**, if wanted: it requires connecting the maintainer's own GitHub account
   through Smithery's dashboard (OAuth), which cannot be automated from here.
2. **MAC authentication is still blocked** on an undocumented checksum. Neither vendor guide
   explains how the MAC digest is computed, so session login remains the only supported auth path
   (README Out-of-scope). Nothing in the v2 guide changed this.
3. **Optional: use `get_portal_statuses` for unlock-window read-back.** `get_unlock_window` and
   `get_daily_unlock_window` currently infer whether a window is active from the managed portal
   group, time specs and holidays — configuration, not reality. `get_portal_statuses` now gives the
   doors' actual state, so those tools could report "the controller says these portals are in
   Extended Unlock right now" instead of "they should be". Deliberately not done in
   [#100](https://github.com/J-MaFf/s2-netbox-mcp/issues/100); noted here as the obvious follow-on.
4. **Watch for a third NTP drift on the controller.** It drifted twice in two days (4h35m on
   2026-09-15, 00:12:43 on 2026-09-17) despite NTP being configured (three `*.us.pool.ntp.org`
   servers, Configuration -> Network Resources -> Time Server). The maintainer ran "Run time sync
   now" on 2026-09-17, which stepped the clock back in sync (confirmed via the controller's HTTP
   `Date` header, per [#102](https://github.com/J-MaFf/s2-netbox-mcp/issues/102)'s clock-skew
   improvement). A follow-up check is scheduled for 2026-09-25; if it's drifted a third time, the
   next step is checking whether the controller can actually reach `pool.ntp.org` on UDP 123
   (outbound NTP blocked would explain configured-but-still-drifting), not just re-running the
   manual sync again.
5. Readers with no `DESCRIPTION` on the controller can only be found by name via `find_portals`.
   Filling those in on NetBox makes it complete.

Two items that used to live here are now **answered and closed**, per
[`docs/reference/nbapi-command-diff.md`](docs/reference/nbapi-command-diff.md): the elevator/floor
write question (there are no such commands in either guide, so there is nothing to build) and the
"diff the newer NBAPI guides" task ([#75](https://github.com/J-MaFf/s2-netbox-mcp/issues/75) — done
2026-09-17).

## Prerequisites to Run

1. `npm install -g s2-netbox-mcp` (published package), or `npm install` in a clone for local dev
2. Copy `.env.example` to `.env` and fill in `NETBOX_BASE_URL`, `NETBOX_USERNAME`,
   `NETBOX_PASSWORD` for a NetBox controller configured per README's "Controller prerequisites".
   Set `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` only if you want the write tools — the
   NBAPI user's role needs Read-Write API privilege in that case. `NETBOX_UNLOCK_HOLIDAY_GROUPS`
   (default `8,7,6`) must name holiday groups nothing else on the controller uses.
3. `npm run build && npm start` (or register with Claude Code via the README's MCP config snippet).
4. `npm test` for the mocked unit suite; `npm run test:live` for the opt-in live read-only smoke
   test; `npm run test:live:write` for the opt-in live write smoke test (see README).
