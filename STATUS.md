# Project Status

## What This Is

A local MCP server exposing LenelS2 S2 NetBox NBAPI operations (persons/credentials, access
levels, portals/readers/outputs, time specs, holidays, portal/reader groups, threat levels,
events/activity, partitions/UDF lists) as Claude-callable tools, so NetBox data can be queried —
and, when explicitly enabled, changed — conversationally instead of via hand-built XML/HTTP calls.
Node/TypeScript, stdio transport, session-login auth only. Read-only by default; write tools are
gated behind `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` (see README "Write access"). On top
of the pass-through tools it offers composite ones: `find_portals`, `set_portals_state`, and a
managed unlock window (`schedule_unlock_window` / `cancel_unlock_window` / `get_unlock_window`)
that the controller enforces itself (README "Scheduled unlock windows"). See
`specs/s2-netbox-mcp-write.md` for the write-tools spec (archived
`specs/archive/s2-netbox-mcp.md` is the original read-only v1 spec — all its acceptance criteria
passed).

## Current State — 2026-09-14

On branch `feat/netbox-unlock-window` (stacked on `feat/netbox-write-tools`, PR #10), implementing
issue #9 — **stage 2 of 2** of the write-tools spec. Stage 1 (issue #8, PR #10) added the
80-command allowlist, nested `PARAMS` XML, the write gates and R7 config, 18 read tools, and 45
pass-through write tools. This stage adds:

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

Tool surface: 35 read tools with writes off; 72 with `NETBOX_ENABLE_WRITES`; 83 with
`NETBOX_ENABLE_DESTRUCTIVE` as well. `main` still has the read-only v0.2.0 surface (16 tools) —
neither stacked branch is merged yet.

391 unit tests pass (24 files), `npm run typecheck` and `npm run build` are clean, and
`npm run test:live` reports 34/34 PASS against the real NetBox 6.2.0 controller, issuing no write
command. **`npm run test:live:write` has not been run yet in this stage** — the CRUD phase and the
door test are for the operator to run after notifying the user (see README "Live write smoke
test"); the user records whether the designated portal `02OF01A` was observed unlocked during the
window and locked afterwards.

### Components

| File | Description |
|---|---|
| `src/index.ts` | MCP server entrypoint; registers `check_connection` plus every `registerXxxTools` module (including `registerUnlockWindowTools`), gated by `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE`; handles startup/shutdown |
| `src/paging.ts` | The shared "fully paginated" NEXTKEY loop (`fetchAllPages` / `fetchAllPagesWith`) plus the XML-record helpers, used by every composite tool |
| `src/portalSearch.ts` | `find_portals` logic: pages GetPortals + GetReaders, joins reader descriptions by READERKEY, term search |
| `src/portalState.ts` | `set_portals_state` logic: one Lock/Unlock/MomentaryUnlock per portal, sequential, outcome partitioning |
| `src/unlockWindow/planner.ts` | Pure R23 planner (`planUnlockWindow`), date-time parsing/validation, R22 clock/31-day checks |
| `src/unlockWindow/managed.ts` | Managed-object naming (R27), read-back normalisation (`TRUE`/`FALSE`, `HH:MM:SS`, `YYYY-MM-DD HH:MM:SS`, comma key strings), typed paginated readers |
| `src/unlockWindow/executor.ts` | `scheduleUnlockWindow` (R22/R24/R25/R28), `cancelUnlockWindow` (R26), `getUnlockWindow` (R26) |
| `src/tools/unlockWindow.ts` | Registers `get_unlock_window` (always) and `schedule_unlock_window` / `cancel_unlock_window` (writes on) |
| `src/netboxClient.ts` | NBAPI XML client: session login/logout, retry-once-on-expiry, error mapping, per-command request path, RESPONSE-level field merge |
| `src/config.ts` | Environment-variable configuration, including the write-tool gates and the unlock-window variables |
| `src/commands.ts` | The closed 80-command NBAPI allowlist |
| `src/xml.ts` | NBAPI XML request building (nested/array PARAMS) / response parsing |
| `src/errors.ts` | APIERROR code descriptions, `NbapiApiError`/`NbapiFailError` |
| `src/toolHelpers.ts` | `runNbapiTool`, `ToolGateFlags`, `formatWriteSuccess`, `clientGuardError`/`destructiveFlagRequired`, `wrapList` |
| `src/tools/*.ts` | One module per tool category: `person`, `accessLevel`, `portal` (incl. `find_portals`, `set_portals_state`), `events`, `timeSpec`, `holiday`, `portalGroup`, `readerGroup`, `threatLevel`, `partition`, `misc`, `unlockWindow` |
| `scripts/live-check.ts` | Opt-in live read-only smoke test (`npm run test:live`) — all 34 pass-through/`find_portals` read tools |
| `scripts/live-check-write.ts`, `scripts/liveCheckWriteHelpers.ts` | Opt-in live write smoke test (`npm run test:live:write`) and its unit-tested pure helpers |
| `test/fakeNetbox.ts` | Stateful in-memory controller double for the composite tools' tests (reproduces the live 6.2.0 quirks) |

### Resolved Issues

| Issue | Description | PR |
|---|---|---|
| [#2](https://github.com/J-MaFf/s2-netbox-mcp/issues/2) | Build read-only S2 NetBox MCP server | [#3](https://github.com/J-MaFf/s2-netbox-mcp/pull/3) |
| [#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4) | NetBox 6.x endpoint (`/nbws/goforms/nbapi`), 410/APIERROR-5 diagnostics, README prerequisites, `extraParams` field-name cleanup, live-check empty-collection accommodation | [#5](https://github.com/J-MaFf/s2-netbox-mcp/pull/5) |
| [#6](https://github.com/J-MaFf/s2-netbox-mcp/issues/6) | `find_portals`: search doors by name or reader description | [#7](https://github.com/J-MaFf/s2-netbox-mcp/pull/7) |

### Open Issues

| Issue | Description | Status |
|---|---|---|
| [#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8) | NBAPI write tools (stage 1: allowlist, gates, 18 read + 45 write pass-through tools) | Implemented on `feat/netbox-write-tools`; [PR #10](https://github.com/J-MaFf/s2-netbox-mcp/pull/10) open for review |
| [#9](https://github.com/J-MaFf/s2-netbox-mcp/issues/9) | Managed unlock windows, `set_portals_state`, live write smoke test (stage 2) | Implemented on `feat/netbox-unlock-window` (stacked on PR #10); live write check not yet run |

## Natural Next Steps

1. Operator: run `npm run test:live:write` (CRUD phase), then — after notifying the user with the
   exact unlock/relock times and getting a go-ahead — `npm run test:live:write -- --go` (or
   `--start HH:MM`), and record in the completion note whether portal `02OF01A` was observed
   unlocked during the window and locked afterwards (C20).
2. Open the stacked PR for this branch against `feat/netbox-write-tools`, referencing issue #9
   (`Fixes #9`); merge bottom-up after PR #10, restacking onto `main` per git-policies; stop at the
   merge gate for human approval.
3. Readers with no `DESCRIPTION` on the controller can only be found by name via `find_portals`.
   Filling those in on NetBox makes it complete.

## Prerequisites to Run

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `NETBOX_BASE_URL`, `NETBOX_USERNAME`,
   `NETBOX_PASSWORD` for a NetBox controller configured per README's "Controller prerequisites".
   Set `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` only if you want the write tools — the
   NBAPI user's role needs Read-Write API privilege in that case. `NETBOX_UNLOCK_HOLIDAY_GROUPS`
   (default `8,7,6`) must name holiday groups nothing else on the controller uses.
3. `npm run build && npm start` (or register with Claude Code via the README's MCP config snippet).
4. `npm test` for the mocked unit suite; `npm run test:live` for the opt-in live read-only smoke
   test; `npm run test:live:write` for the opt-in live write smoke test (see README).
