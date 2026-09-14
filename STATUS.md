# Project Status

## What This Is

A local MCP server exposing read-only LenelS2 S2 NetBox NBAPI operations (persons/credentials,
access levels, portals/readers, event/access history) as Claude-callable tools, so NetBox data can
be queried conversationally instead of hand-built XML/HTTP calls. Node/TypeScript, stdio
transport, session-login auth only. See `specs/s2-netbox-mcp.md` for the full spec.

## Current State — 2026-09-14

All code-level acceptance criteria pass (89 unit tests, clean typecheck/build, read-only command
allowlist enforced). **Live verification against the real controller (C11, and half of C18) is
still pending** — it requires running `npm run test:live` with the real `.env` against the live
NetBox 6.2.0 controller, which this working environment does not have permission to do
automatically (a production physical-access-control system). See "Open Issues" below.

### Components

| File | Description |
|---|---|
| `src/index.ts` | MCP server entrypoint; registers all 15 tools, handles startup/shutdown |
| `src/netboxClient.ts` | NBAPI XML client: session login/logout, retry-once-on-expiry, error mapping |
| `src/config.ts` | Environment-variable configuration (`NETBOX_BASE_URL`/`USERNAME`/`PASSWORD`/`API_PATH`/`ALLOW_INSECURE_TLS`) |
| `src/commands.ts` | The closed 17-command NBAPI allowlist |
| `src/xml.ts` | NBAPI XML request building / response parsing |
| `src/errors.ts` | APIERROR code descriptions, `NbapiApiError`/`NbapiFailError` |
| `src/tools/*.ts` | One module per tool category (person, accessLevel, portal, events) |
| `scripts/live-check.ts` | Opt-in live smoke test (`npm run test:live`) — the C11/C18 evidence harness |

### Resolved Issues

| Issue | Description | PR |
|---|---|---|
| [#2](https://github.com/J-MaFf/s2-netbox-mcp/issues/2) | Build read-only S2 NetBox MCP server | [#3](https://github.com/J-MaFf/s2-netbox-mcp/pull/3) |
| [#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4) | NetBox 6.x endpoint (`/nbws/goforms/nbapi`), 410/APIERROR-5 diagnostics, README prerequisites, `extraParams` field-name cleanup | (this PR) |

### Open Issues

- **Live verification blocked on production-system permission.** `npm run test:live` needs to run
  with the real `.env` (host/username/password for the live NetBox 6.2.0 controller) to satisfy
  C11 and the live half of C18. The orchestrating session's auto-mode classifier denies this
  automatically ("Production Reads") since it's a live physical-access-control system — this needs
  either the user running `npm run test:live` themselves and reporting the result, or explicit
  per-session permission to run it. Tracked via beads issue `s2-netbox-mcp-aej`.

## Natural Next Steps

1. Run `npm run test:live` against the real controller (user-run, or explicitly approved) and
   confirm all 15 PASS lines plus `check_connection` showing `6.2.0`.
2. Once live-verified, close beads issue `s2-netbox-mcp-aej`, archive `specs/s2-netbox-mcp.md` to
   `specs/archive/`, and merge this PR.

## Prerequisites to Run

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `NETBOX_BASE_URL`, `NETBOX_USERNAME`,
   `NETBOX_PASSWORD` for a NetBox controller configured per README's "Controller prerequisites".
3. `npm run build && npm start` (or register with Claude Code via the README's MCP config snippet).
4. `npm test` for the mocked unit suite; `npm run test:live` for the opt-in live smoke test.
