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
`GetPortals`, `GetReader(s)`, `GetEventHistory`, `ListEvents`,
`GetAccessHistory`) — note there is no `GetPortal` (singular) command; only
`GetPortals` (plural, paginated, no single-portal filter) exists on the real
NBAPI. It is structurally incapable of adding, modifying,
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
| `NETBOX_BASE_URL`              | Yes      | —       | Base URL of the NetBox controller's web interface, e.g. `https://netbox.example.internal`. No trailing slash or path — the client appends `NETBOX_API_PATH` itself. |
| `NETBOX_USERNAME`               | Yes      | —       | NBAPI session-login username.                                                                       |
| `NETBOX_PASSWORD`               | Yes      | —       | NBAPI session-login password. Never logged, never written to any tracked file.                      |
| `NETBOX_ALLOW_INSECURE_TLS`     | No       | `false` | Set to `true`/`1`/`yes` to accept a self-signed/on-prem TLS certificate. **Explicit opt-in only** — any other value (including unset) keeps normal certificate verification. |
| `NETBOX_API_PATH`               | No       | `/nbws/goforms/nbapi` | The NBAPI path appended to `NETBOX_BASE_URL`. The default is the verified path on NetBox 6.x controllers. Only set this to override the default — e.g. to the legacy, pre-6.x path `/goforms/nbapi`, which returns **HTTP 410 Gone** on 6.x controllers (see Controller prerequisites below). A value without a leading `/` has one added automatically. |

If any of the three required variables is missing, the server prints a single
actionable line to stderr and exits with a non-zero status — it never prints
a stack trace on startup misconfiguration.

## Controller prerequisites

Before this server can talk to your controller, on the NetBox web UI go to
**Configuration → Site Settings → Network Controller → Data Integration** and
confirm all three of these are checked:

- **Enable V2**
- **Use Authentication**
- **Use login username/password for authentication (requires setup privilege)**

The NBAPI user account also needs a role with **NBAPI read access** (see the
NBAPI doc's "Creating User Roles for API" section) — a login that succeeds
but can't read the resources this server queries will surface as `FAIL` or
`APIERROR` responses per tool call.

### Troubleshooting

- **"Login succeeds but every other command returns `APIERROR 5`."** This is
  the live-observed symptom of the *Use login username/password for
  authentication (requires setup privilege)* checkbox being unticked, which
  puts the controller in MAC-authentication mode instead of session-login
  mode (MAC auth is out of scope for this server — see the spec). `Login`
  still returns `SUCCESS` with a session ID, but every subsequent command —
  including `Logout` — fails with `APIERROR 5`. Fix: tick that checkbox on
  the *Data Integration* tab. This server's client detects this exact
  pattern (a successful re-login followed by another `APIERROR 5`) and
  surfaces a tool error naming the checkbox directly.
- **"HTTP 410 Gone."** The configured `NETBOX_API_PATH` is not served by this
  controller. NetBox 6.x serves the NBAPI at `/nbws/goforms/nbapi` (the
  default this server uses); the 2020 doc's `/goforms/nbapi` path is
  deregistered on 6.x and returns 410 for every request. If you're on a
  pre-6.x controller, set `NETBOX_API_PATH=/goforms/nbapi` explicitly; if
  you're on 6.x and still see this, double-check `NETBOX_API_PATH` isn't set
  to something else by mistake.

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
| `get_card_access_details`    | `GetCardAccessDetails`   | `ENCODEDNUM`, `CARDFORMAT`    |
| `get_card_formats`           | `GetCardFormats`         | —                             |
| `get_access_level`           | `GetAccessLevel`         | `ACCESSLEVELKEY`               |
| `get_access_levels`          | `GetAccessLevels`        | — (optional `STARTFROMKEY`/`STARTFROMNAME`/`WANTKEY`) |
| `get_access_level_group`     | `GetAccessLevelGroup`    | `ACCESSLEVELGROUPKEY`          |
| `get_access_level_groups`    | `GetAccessLevelGroups`   | — (optional `STARTFROMKEY`)   |
| `get_portals`                | `GetPortals`             | — (optional `STARTFROMKEY`; no single-portal filter — returns each portal with its nested readers) |
| `get_reader`                 | `GetReader`              | `READERKEY`                   |
| `get_readers`                | `GetReaders`             | — (optional `STARTFROMKEY`; no portal-id filter) |
| `get_event_history`          | `GetEventHistory`        | — (optional `EVENTNAME`/`STARTDTTM`/`ENDDTTM`/`NEXTKEY`) |
| `list_events`                | `ListEvents`             | —                             |
| `get_access_history`         | `GetAccessHistory`       | — (optional `STARTLOGID`/`AFTERLOGID`/`ORDER`/`MAXRECORDS`/`ENCODEDNUM`/`HOTSTAMP`/`CARDFORMAT`/`OLDESTDTTM`/`NEWESTDTTM`) |

There is deliberately no `get_portal` (singular) tool — no such NBAPI command
exists; only `GetPortals` (plural) does. `get_card_access_details` and
`get_access_history` identify a card by `ENCODEDNUM`/`CARDFORMAT` (and
`get_access_history` optionally by `HOTSTAMP`), not by `PERSONID` — neither
command has a `PERSONID` parameter.

Every tool returns a thin JSON pass-through of that NBAPI command's response
fields — no reshaping. Each tool's input schema declares exactly the
documented PARAMS fields for its command — no invented, renamed, or
passthrough fields. All parameter names above are copied verbatim from the
NBAPI Command Reference (see `specs/archive/s2-netbox-mcp.md`) — none are invented or
guessed.

Session handling, retry-on-expired-session, and error mapping are all
automatic and match the NBAPI documentation:

- The first tool call triggers `Login`; the session ID is cached and reused
  for every later call in the same server run.
- If a call fails with `APIERROR 5` (auth failure / expired session), the
  client transparently re-logs-in once and retries the original command.
- An `<APIERROR>` response surfaces as a tool error like
  `"5: There was an authentication failure."`
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

This calls all 15 tools against a **real, configured** controller and prints
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

See `specs/archive/s2-netbox-mcp.md` for the full requirements this server was built
against (archived — all acceptance criteria passed, including live verification).
