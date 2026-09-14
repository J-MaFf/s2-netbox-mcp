# Project Status

## What This Is

A local MCP server exposing read-only LenelS2 S2 NetBox NBAPI operations (persons/credentials,
access levels, portals/readers, event/access history) as Claude-callable tools, so NetBox data can
be queried conversationally instead of hand-built XML/HTTP calls. Node/TypeScript, stdio
transport, session-login auth only. See `specs/archive/s2-netbox-mcp.md` for the full spec
(archived — all acceptance criteria passed).

## Current State — 2026-09-14

All known issues resolved; `main` is clean pending review/merge of PR #5. All 18 acceptance
criteria + the catch-all pass, including live verification: `npm run test:live` reports 15/15
PASS against the real NetBox 6.2.0 controller (`check_connection` shows `6.2.0`). 89 unit tests,
clean typecheck/build, read-only 17-command allowlist enforced.

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
| [#4](https://github.com/J-MaFf/s2-netbox-mcp/issues/4) | NetBox 6.x endpoint (`/nbws/goforms/nbapi`), 410/APIERROR-5 diagnostics, README prerequisites, `extraParams` field-name cleanup, live-check empty-collection accommodation | [#5](https://github.com/J-MaFf/s2-netbox-mcp/pull/5) |

### Open Issues

None. PR #5 is awaiting the user's merge approval.

## Natural Next Steps

1. Merge PR #5 (human-gated — not auto-merged per this user's git-policies).
2. After merging, `git cleanup` to remove the merged feature branch.

## Prerequisites to Run

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `NETBOX_BASE_URL`, `NETBOX_USERNAME`,
   `NETBOX_PASSWORD` for a NetBox controller configured per README's "Controller prerequisites".
3. `npm run build && npm start` (or register with Claude Code via the README's MCP config snippet).
4. `npm test` for the mocked unit suite; `npm run test:live` for the opt-in live smoke test.
