# s2-netbox-mcp

A local, **read-only** MCP server that exposes LenelS2 S2 NetBox NBAPI
operations — persons/credentials, access levels, portals/readers, and
events/history — as Claude-callable tools.

> **Not** the open-source netboxlabs.com "NetBox" DCIM/IPAM tool. This targets
> LenelS2's **S2 NetBox** physical access-control appliance and its NBAPI
> (`Web-Based API for S2 NetBox and S2 Global`, LenelS2 doc #API-UG-14).

This server issues **only** query/read NBAPI commands (`Login`, `Logout`,
`GetAPIVersion`, `GetPerson`, `SearchPersonData`, `GetCardAccessDetails`,
`GetCardFormats`, `GetAccessLevel(s)`, `GetAccessLevelGroup(s)`,
`GetPortal(s)`, `GetReader(s)`, `GetEventHistory`, `ListEvents`,
`GetAccessHistory`). It is structurally incapable of adding, modifying,
deleting, locking/unlocking, activating/deactivating, or triggering anything
on the controller — no such command is implemented or reachable through any
tool.

## Requirements

- Node.js >= 18.17 (tested on Node 24)
- An S2 NetBox controller reachable from wherever this server runs, with the
  NBAPI enabled and configured for **session-login authentication** (not MAC
  authentication — see the spec for why that's out of scope for v1)
- A NetBox operator account with API access and read permission on the
  resources you want to query

## Setup

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in real values (or provide the same
variables directly in your shell / in the Claude Code MCP server config's
`env` block — see below). **Never commit `.env`** — it's already gitignored.

```bash
cp .env.example .env
# edit .env
```

Start the server directly to sanity-check it boots (it just waits on stdio
for an MCP client — Ctrl+C to stop; this also sends `Logout` if a session was
opened):

```bash
npm start
```

## Environment variables

| Variable                      | Required | Default | Description                                                                                       |
| ------------------------------ | -------- | ------- | --------------------------------------------------------------------------------------------------- |
| `NETBOX_BASE_URL`              | Yes      | —       | Base URL of the NetBox controller's web interface, e.g. `https://netbox.example.internal`. No trailing slash or path — the client appends `/goforms/nbapi` itself. |
| `NETBOX_USERNAME`               | Yes      | —       | NBAPI session-login username.                                                                       |
| `NETBOX_PASSWORD`               | Yes      | —       | NBAPI session-login password. Never logged, never written to any tracked file.                      |
| `NETBOX_ALLOW_INSECURE_TLS`     | No       | `false` | Set to `true`/`1`/`yes` to accept a self-signed/on-prem TLS certificate. **Explicit opt-in only** — any other value (including unset) keeps normal certificate verification. |

If any of the three required variables is missing, the server prints a single
actionable line to stderr and exits with a non-zero status — it never prints
a stack trace on startup misconfiguration.

## Registering with Claude Code

Add this to your Claude Code MCP server configuration (e.g. via
`claude mcp add-json s2-netbox-mcp '<json>'`, or directly in your
`.mcp.json` / `claude_desktop_config.json`-style config file under
`mcpServers`):

```json
{
  "mcpServers": {
    "s2-netbox-mcp": {
      "command": "node",
      "args": ["C:\\Users\\jmaffiola\\Documents\\Scripts\\s2-netbox-mcp\\dist\\index.js"],
      "env": {
        "NETBOX_BASE_URL": "https://netbox.example.internal",
        "NETBOX_USERNAME": "svc-account",
        "NETBOX_PASSWORD": "REPLACE_ME",
        "NETBOX_ALLOW_INSECURE_TLS": "false"
      }
    }
  }
}
```

Replace the `args` path with the actual absolute path to `dist/index.js` on
your machine, and replace the `env` values with your real controller details
(or omit `env` entirely and rely on a `.env` file next to the project if you
prefer — either works, since `src/index.ts` loads `.env` via `dotenv` before
reading `process.env`). Run `npm run build` first so `dist/index.js` exists.

## Tools exposed

| Tool                       | Wraps NBAPI command    | Required params            |
| --------------------------- | ----------------------- | ---------------------------- |
| `check_connection`           | `GetAPIVersion`          | —                             |
| `get_person`                 | `GetPerson`              | `PERSONID`                    |
| `search_person_data`         | `SearchPersonData`       | — (all filters optional)      |
| `get_card_access_details`    | `GetCardAccessDetails`   | `PERSONID`                    |
| `get_card_formats`           | `GetCardFormats`         | —                             |
| `get_access_level`           | `GetAccessLevel`         | `ACCESSLEVELID`                |
| `get_access_levels`          | `GetAccessLevels`        | —                             |
| `get_access_level_group`     | `GetAccessLevelGroup`    | `ACCESSLEVELGROUPID`            |
| `get_access_level_groups`    | `GetAccessLevelGroups`   | —                             |
| `get_portal`                 | `GetPortal`              | `PORTALID`                    |
| `get_portals`                | `GetPortals`             | —                             |
| `get_reader`                 | `GetReader`              | `READERID`                    |
| `get_readers`                | `GetReaders`             | — (optional `PORTALID` filter) |
| `get_event_history`          | `GetEventHistory`        | — (optional date range/`PERSONID`) |
| `list_events`                | `ListEvents`             | —                             |
| `get_access_history`         | `GetAccessHistory`       | — (optional date range/`PERSONID`) |

Every tool returns a thin JSON pass-through of that NBAPI command's response
fields — no reshaping. A few tools that take broader/uncertain optional
filters (`search_person_data`, `get_event_history`, `get_access_history`,
`list_events`) also accept an `extraParams` object of
`{ "FIELDNAME": "value" }` pairs for any other documented NBAPI PARAMS field
not modeled as a named parameter.

Session handling, retry-on-expired-session, and error mapping are all
automatic and match the NBAPI documentation:

- The first tool call triggers `Login`; the session ID is cached and reused
  for every later call in the same server run.
- If a call fails with `APIERROR 5` (auth failure / expired session), the
  client transparently re-logs-in once and retries the original command.
- An `<APIERROR>` response surfaces as a tool error like
  `"5: Authentication failure — invalid username/password, or an
  invalid/expired session ID."`
- A `<CODE>FAIL</CODE>` response surfaces as a tool error including the
  controller's `ERRMSG` text verbatim.
- A `<CODE>NOT FOUND</CODE>` response (e.g. an unknown `PERSONID`) is
  returned as a normal, non-error result stating "not found" — it is not
  thrown as an exception.
- `SIGINT`/`SIGTERM` trigger `Logout` for any active session before the
  process exits.

## Testing

```bash
npm test
```

Runs the full unit test suite against a hand-rolled, in-memory HTTP stub —
no network access and no live controller are required or contacted.

### Live smoke test (optional)

```bash
npm run test:live
```

This calls all 16 tools against a **real, configured** controller and prints
a PASS/FAIL line per tool plus a summary, exiting non-zero if anything
failed. It only runs if `NETBOX_BASE_URL`, `NETBOX_USERNAME`, and
`NETBOX_PASSWORD` are all set (loaded from `.env` if present); otherwise it
prints one line saying live testing was skipped and exits 0. It never prints
the value of `NETBOX_PASSWORD`, under any circumstance. `npm test` never runs
this script and never requires `.env` to exist.

## A caution carried from the NBAPI documentation

If this (or any) NetBox instance syncs person/access-level data from Active
Directory, any *write* to those fields via NBAPI gets silently overwritten on
the next AD sync. Not directly relevant to this read-only server, but worth
keeping in mind if this project is ever extended with write tools.

## Out of scope (v1)

- Any write/control NBAPI command (adding, modifying, deleting,
  locking/unlocking, activating/deactivating, triggering, etc.)
- Photo ID handling (`GetPicture` and photo upload)
- `StreamEvents` / the persistent `/appdevent/nbapi/event` push feed
- MAC-based authentication (session-login only)
- The S2 Global API variant
- Any GUI/dashboard beyond the MCP tool surface
- Publishing/packaging this server, or a CI/CD pipeline

See `specs/s2-netbox-mcp.md` for the full requirements this server was built
against.
