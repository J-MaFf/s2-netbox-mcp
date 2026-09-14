# Project Status

## What This Is

A local MCP server exposing LenelS2 S2 NetBox NBAPI operations (persons/credentials, access
levels, portals/readers/outputs, time specs, holidays, portal/reader groups, threat levels,
events/activity, partitions/UDF lists) as Claude-callable tools, so NetBox data can be queried —
and, when explicitly enabled, changed — conversationally instead of via hand-built XML/HTTP calls.
Node/TypeScript, stdio transport, session-login auth only. Read-only by default; write tools are
gated behind `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` (see README "Write access"). See
`specs/s2-netbox-mcp-write.md` for the write-tools spec (archived
`specs/archive/s2-netbox-mcp.md` is the original read-only v1 spec — all its acceptance criteria
passed).

## Current State — 2026-09-14

On branch `feat/netbox-write-tools`, implementing issue #8 **stage 1 of 2** (the spec is landed as
two stacked PRs). This stage adds: the 80-command `NBAPI_COMMANDS` allowlist (up from 17), nested
`PARAMS` XML serialisation, the `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` gates and the
other R7 config variables, 18 new read tools, and 45 pass-through write tools (11 of them
additionally gated as destructive). `main` still has the read-only v0.2.0 surface (16 tools) —
this branch is not yet merged.

**Not in this stage** (stage 2, tracked separately): `set_portals_state`, the composite managed
unlock-window tools (`schedule_unlock_window`, `cancel_unlock_window`, `get_unlock_window`), and
the live write smoke test (`scripts/live-check-write.ts` / `npm run test:live:write`).

307 unit tests pass (18 files), `npm run typecheck` and `npm run build` are clean, and `npm run test:live`
reports 34/34 PASS against the real NetBox 6.2.0 controller (16 pre-existing read tools + the 18
added this stage), issuing no write command.

### Components

| File | Description |
|---|---|
| `src/index.ts` | MCP server entrypoint; registers `check_connection` plus every `registerXxxTools` module, gated by `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE`; handles startup/shutdown |
| `src/portalSearch.ts` | `find_portals` logic: pages GetPortals + GetReaders, joins reader descriptions by READERKEY, term search |
| `src/netboxClient.ts` | NBAPI XML client: session login/logout, retry-once-on-expiry, error mapping, per-command request path (TriggerEvent -> `NETBOX_EVENT_API_PATH`) |
| `src/config.ts` | Environment-variable configuration, including the R7 write-tool gates and the (reserved, stage-2) unlock-window variables |
| `src/commands.ts` | The closed 80-command NBAPI allowlist |
| `src/xml.ts` | NBAPI XML request building (now with nested/array PARAMS support) / response parsing |
| `src/errors.ts` | APIERROR code descriptions, `NbapiApiError`/`NbapiFailError` |
| `src/toolHelpers.ts` | `runNbapiTool`, `ToolGateFlags`, `formatWriteSuccess`, `clientGuardError`/`destructiveFlagRequired`, `wrapList` |
| `src/tools/*.ts` | One module per tool category: `person`, `accessLevel`, `portal`, `events` (extended with write tools), plus new `timeSpec`, `holiday`, `portalGroup`, `readerGroup`, `threatLevel`, `partition`, `misc` |
| `scripts/live-check.ts` | Opt-in live smoke test (`npm run test:live`) — now covers all 34 read tools |

### Resolved Issues

| Issue | Description | PR |
|---|---|---|
| [#2](https://github.com/J-MaFf/s2-netbox-mcp/issues/2) | Build read-only S2 NetBox MCP server | [#3](https://github.com/J-MaFf/s2-netbox-mcp/pull/3) |
| [#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4) | NetBox 6.x endpoint (`/nbws/goforms/nbapi`), 410/APIERROR-5 diagnostics, README prerequisites, `extraParams` field-name cleanup, live-check empty-collection accommodation | [#5](https://github.com/J-MaFf/s2-netbox-mcp/pull/5) |
| [#6](https://github.com/J-MaFf/s2-netbox-mcp/issues/6) | `find_portals`: search doors by name or reader description | [#7](https://github.com/J-MaFf/s2-netbox-mcp/pull/7) |

### Open Issues

| Issue | Description | Status |
|---|---|---|
| [#8](https://github.com/J-MaFf/s2-netbox-mcp/issues/8) | NBAPI write tools + managed unlock windows | Stage 1 (this branch) in progress; stage 2 (composite unlock-window tools, live write smoke test) not started |

## Natural Next Steps

1. Open the PR for this stage, referencing issue #8; stop at the merge gate for human approval.
2. Stage 2: implement `set_portals_state`, `schedule_unlock_window`, `cancel_unlock_window`,
   `get_unlock_window`, the pure planner in `src/unlockWindow/`, and
   `scripts/live-check-write.ts` (`npm run test:live:write`), per R10/R22-R30 of
   `specs/s2-netbox-mcp-write.md`.
3. Readers with no `DESCRIPTION` on the controller can only be found by name via `find_portals`.
   Filling those in on NetBox makes it complete.

## Prerequisites to Run

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `NETBOX_BASE_URL`, `NETBOX_USERNAME`,
   `NETBOX_PASSWORD` for a NetBox controller configured per README's "Controller prerequisites".
   Set `NETBOX_ENABLE_WRITES`/`NETBOX_ENABLE_DESTRUCTIVE` only if you want the write tools — the
   NBAPI user's role needs Read-Write API privilege in that case.
3. `npm run build && npm start` (or register with Claude Code via the README's MCP config snippet).
4. `npm test` for the mocked unit suite; `npm run test:live` for the opt-in live read-only smoke
   test.
