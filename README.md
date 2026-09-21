# s2-netbox-mcp

A local MCP server that exposes LenelS2 S2 NetBox NBAPI operations —
persons/credentials, access levels, portals/readers/outputs, time specs,
holidays, portal/reader groups, threat levels, events/activity, and
partitions/UDF lists — as MCP tools usable from any MCP-compatible client
(Claude, Gemini/Antigravity, etc.).

> **Not** the open-source netboxlabs.com "NetBox" DCIM/IPAM tool. This targets
> LenelS2's **S2 NetBox** physical access-control appliance and its NBAPI
> (`Web-Based API for S2 NetBox and S2 Global`, LenelS2 doc #API-UG-14).
> Newer NBAPI **v1** (doc #API-UG-22, April 2024) and **v2** (doc #API2-UG-8,
> April 2025) guides also exist — see [`docs/reference/`](docs/reference/)
> for reference copies. Both have now been diffed against this server's tool
> surface command by command and parameter by parameter:
> [`docs/reference/nbapi-command-diff.md`](docs/reference/nbapi-command-diff.md)
> records the result, including which documented commands are deliberately
> not implemented and why.

> [!WARNING]
> **This connects to a real physical security system.** With the wrong
> configuration, an AI agent using this server could unlock doors or modify
> access-control data on a live building. It is **read-only by default** —
> writes and destructive operations (lock/unlock, add/modify/delete) each
> require their own explicit opt-in environment variable (see **Write
> access** below) — but you are responsible for what you enable and which
> MCP client/model you point at it. See `SECURITY.md` before deploying
> anything beyond read-only against a production controller.

**Read-only by default.** With no write-related environment variables set,
this server registers only query/read NBAPI commands:

- `Login`
- `Logout`
- `GetAPIVersion`
- `GetPerson`
- `SearchPersonData`
- `GetCardAccessDetails`
- `GetCardFormats`
- `GetAccessLevel(s)`
- `GetAccessLevelGroup(s)`
- `GetPortals`
- `GetReader(s)`
- `GetOutputs`
- `GetTimeSpec(s)`
- `GetTimeSpecGroup(s)`
- `GetHoliday(s)`
- `GetPortalGroup(s)`
- `GetReaderGroup(s)`
- `GetAccessLevelNames`
- `GetPartitions`
- `GetUDFLists`
- `GetUDFListItems`
- `GetElevators`
- `GetFloors`
- `PingApp`
- `GetEventHistory`
- `ListEvents`
- `GetAccessHistory`

By default, this server registers only the query/read commands listed above.
It does not register any write, delete, or control operations against the
controller until you explicitly opt in via the environment variables in
**Write access** below. Among the read-only tools, four are composites,
`find_portals`, `get_unlock_window`, `get_daily_unlock_window`, and
`get_reader_access_history`, which issue only read commands. Note there is no
`GetPortal` (singular) command; only `GetPortals` (plural, paginated, no
single-portal filter) exists on the real NBAPI.

## Requirements

- Node.js >= 18.17 (tested on Node 24), which includes npm. If Node.js isn't installed, on
  Windows you can install it with `winget install OpenJS.NodeJS.LTS`, then open a new
  terminal so `node`/`npm` are on your `PATH`
- An S2 NetBox controller reachable from wherever this server runs, with the
  NBAPI enabled and configured for **session-login authentication** (not MAC
  authentication — see the spec for why that's out of scope for v1)
- A NetBox operator account with API access and read permission on the
  resources you want to query

## Setup

Two ways to get the server:

**Option A — npm (no clone needed):**

```bash
npm install -g s2-netbox-mcp
```

This installs the `s2-netbox-mcp` binary; point your MCP client's `command` at
`s2-netbox-mcp` directly (no `node dist/index.js` needed).

**Option B — clone and build:**

```bash
npm install
npm run build
```

Either way, copy `.env.example` to `.env` and fill in real values (or provide the same
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
| `NETBOX_ENABLE_WRITES`          | No       | `false` | Set to `true`/`1`/`yes` to register the write tools (see **Write access** below). Unset (or any other value) leaves the server strictly read-only. |
| `NETBOX_ENABLE_DESTRUCTIVE`     | No       | `false` | Set to `true`/`1`/`yes`, **together with** `NETBOX_ENABLE_WRITES`, to additionally register the 11 destructive tools (see **Write access** below). |
| `NETBOX_EVENT_API_PATH`         | No       | tracks `NETBOX_API_PATH` | Request path used only for `trigger_event`. Unset/empty tracks whatever `NETBOX_API_PATH` resolves to; a non-empty override is used verbatim (leading `/` added if missing) — e.g. the doc's pre-6.x Event API path `/appd/nbapi`, if your controller serves it separately. |
| `NETBOX_UNLOCK_HOLIDAY_GROUPS`  | No       | `8,7,6` | The holiday groups reserved for the managed unlock window, in `first,middle,last` segment order — see **Scheduled unlock windows** below. Must be 1-3 distinct integers in `1..8`, comma-separated; reserve groups nothing else on the controller uses. |
| `NETBOX_UNLOCK_NAME_PREFIX`     | No       | `MCP Unlock Window` | Name prefix of every object the managed unlock window creates: the portal group (`<prefix>`), the time spec group (`<prefix> time specs`), and the per-segment holidays/time specs (`<prefix> first/middle/last`). 1-40 characters so the longest name (`<prefix> time specs`) fits the 64-character NAME limit. |
| `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` | No | `5` | The single holiday group reserved for the managed **daily recurring** unlock window — see **Scheduled daily unlock windows** below. Must be a single integer in `1..8`, and must not be a member of `NETBOX_UNLOCK_HOLIDAY_GROUPS` (the two features' reserved groups can never collide). |
| `NETBOX_DAILY_UNLOCK_NAME_PREFIX` | No | `MCP Daily Unlock Window` | Name prefix of every object the managed daily unlock window creates: the portal group (`<prefix>`), the time spec group (`<prefix> time specs`), and the one holiday/time spec (`<prefix> schedule`). 1-40 characters so the longest name fits the 64-character NAME limit. |
| `NETBOX_LIVE_TEST_PORTALKEY`    | No       | — | The `PORTALKEY` of the one door you designate safe to physically unlock during `npm run test:live:write`/`npm run test:live:write:daily`. Read only by those scripts, never by the server itself. |

If any of the three required variables is missing, the server prints a single
actionable line to stderr and exits with a non-zero status — it never prints
a stack trace on startup misconfiguration.

## Write access

Write/control tools exist in this server but are **not registered** unless
you explicitly opt in:

- **`NETBOX_ENABLE_WRITES=true`** registers the write tools listed in the
  "Write tools" table below — the 45 pass-through tools (creating, modifying,
  locking/unlocking, activating, and triggering) plus the three composite
  write tools `set_portals_state`, `schedule_unlock_window`, and
  `cancel_unlock_window`. Left unset (the default), the server's tool
  surface is exactly the read tools below — byte-for-byte the same read-only
  posture as before this variable existed.
- The two unlock-window composites delete **only** the holidays and time
  specs they themselves own (named `<prefix> first|middle|last` — see
  **Scheduled unlock windows**), and do so without `NETBOX_ENABLE_DESTRUCTIVE`
  because those objects are server-owned; they never delete anything else.
- **`NETBOX_ENABLE_DESTRUCTIVE=true`**, set **in addition to**
  `NETBOX_ENABLE_WRITES`, registers the 11 **destructive** tools (each
  description is `DESTRUCTIVE:`-prefixed): `delete_access_level`,
  `delete_access_level_group`, `delete_holiday`, `delete_portal_group`,
  `delete_reader_group`, `delete_time_spec`, `delete_time_spec_group`,
  `remove_credential`, `remove_person`, `remove_threat_level`,
  `remove_threat_level_group`. Two ordinarily non-destructive write tools
  also independently refuse one specific destructive-shaped call when this
  flag is off, regardless of whether the tool itself is registered:
  `modify_person` refuses a call with `DELETED="TRUE"` or
  `PERSONPURGE="TRUE"`, and `modify_udf_list_items` refuses a call where any
  list item has `DELETE="1"` — both name `NETBOX_ENABLE_DESTRUCTIVE` in the
  error and send nothing to the controller.
- Every write tool's description starts with `WRITE:` (or `DESTRUCTIVE:` for
  the 11 above), and every successful write's result text contains the
  literal `SUCCESS` followed by the controller's response data as pretty
  JSON (which may be `{}` when the command returns no data), so you can
  always tell a write actually happened.
- Client-side guards (e.g. "give either `READERKEY` or `READERGROUPKEY`, not
  both") reject malformed calls with a tool error **before** any NBAPI
  command is issued — no partial or guessed request ever reaches the
  controller.

Set these the same way as the other variables — in `.env` (see
`.env.example`) or your MCP server config's `env` block.

## Controller prerequisites

Before this server can talk to your controller, on the NetBox web UI go to
**Configuration → Site Settings → Network Controller → Data Integration** and
confirm all three of these are checked:

- **Enable V2**
- **Use Authentication**
- **Use login username/password for authentication (requires setup privilege)**

The NBAPI user account also needs a role with **NBAPI read access** (see the
NBAPI doc's "Setting Up User Roles for the API" section) — a login that
succeeds but can't read the resources this server queries will surface as
`FAIL` or `APIERROR` responses per tool call. If you set
`NETBOX_ENABLE_WRITES`, that role needs **Read-Write** API privilege instead
(Configuration → Site Settings → User Roles → API Privilege) — Read-Only
suffices only for the read tools.

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

## Registering with an MCP client

This server works with any MCP client that speaks the standard `mcpServers`
stdio config shape — Claude Code, Antigravity, and Gemini CLI have all been
verified against it directly. Which JSON to use depends on which **Setup**
option you picked above:

**If you installed via npm (Setup Option A):**

```json
{
  "mcpServers": {
    "s2-netbox-mcp": {
      "command": "s2-netbox-mcp",
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

**If you cloned and built locally (Setup Option B):**

```json
{
  "mcpServers": {
    "s2-netbox-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/s2-netbox-mcp/dist/index.js"],
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

Where to put that JSON depends on the client:

| Client | Config file | Notes |
| --- | --- | --- |
| Claude Code | `.mcp.json` in your project, or `claude_desktop_config.json` | Or add non-interactively via `claude mcp add-json s2-netbox-mcp '<json>'` |
| Antigravity | `~/.gemini/config/mcp_config.json` (Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`) | Global — applies to every Antigravity session |
| Gemini CLI | `~/.gemini/settings.json`, under its own `mcpServers` key | Or add non-interactively via `gemini mcp add s2-netbox-mcp <command> [args] -e KEY=value` |

All three use the identical `mcpServers` object shape shown above — only the
surrounding file and location differ.

## Tools exposed

### Read tools (always registered)

| Tool                       | Wraps NBAPI command    | Required params            |
| --------------------------- | ----------------------- | ---------------------------- |
| `check_connection`           | `GetAPIVersion`          | —                             |
| `get_person`                 | `GetPerson`              | `PERSONID`                    |
| `search_person_data`         | `SearchPersonData`       | — (all filters optional)      |
| `get_card_access_details`    | `GetCardAccessDetails`   | `ENCODEDNUM`, `CARDFORMAT` (optional `MAXRECORDS`/`OLDESTDTTM`/`RESOLVENAMES`/`RESOLVEDESCRIPTIONS`) |
| `get_card_formats`           | `GetCardFormats`         | —                             |
| `get_access_level`           | `GetAccessLevel`         | `ACCESSLEVELKEY` (optional `RESOLVEGROUPNAMES`) |
| `get_access_levels`          | `GetAccessLevels`        | — (optional `PARTITIONKEY`/`STARTFROMKEY`/`STARTFROMNAME`/`WANTKEY`) |
| `get_access_level_group`     | `GetAccessLevelGroup`    | `ACCESSLEVELGROUPKEY`          |
| `get_access_level_groups`    | `GetAccessLevelGroups`   | — (optional `STARTFROMKEY`/`PARTITIONKEY`) |
| `get_access_level_names`     | `GetAccessLevelNames`    | — (optional `PARTITIONKEY`/`STARTFROMNAME`) |
| `get_portals`                | `GetPortals`             | — (optional `STARTFROMKEY`/`RESOLVEDESCRIPTIONS`; no single-portal filter — returns each portal with its nested readers) |
| `get_reader`                 | `GetReader`              | `READERKEY`                   |
| `get_readers`                | `GetReaders`             | — (optional `STARTFROMKEY`; no portal-id filter) |
| `get_outputs`                | `GetOutputs`             | — (optional `STARTFROMKEY`)   |
| `find_portals`               | `GetPortals` + `GetReaders` (composite) | `query` (search terms) |
| `get_event_history`          | `GetEventHistory`        | — (optional `EVENTNAME`/`STARTDTTM`/`ENDDTTM`/`NEXTKEY`) |
| `list_events`                | `ListEvents`             | — (optional `RESOLVEPARTITIONNAMES`, default `true`) |
| `get_access_history`         | `GetAccessHistory`       | — (optional `STARTLOGID`/`AFTERLOGID`/`ORDER`/`MAXRECORDS`/`ENCODEDNUM`/`HOTSTAMP`/`CARDFORMAT`/`RESOLVENAMES`/`RESOLVEDESCRIPTIONS`) |
| `get_reader_access_history`  | `GetAccessHistory` + `GetPerson` + `GetReaders` (composite) | `READERKEY` (optional `SCANWINDOW`/`MAXMATCHES`/`RESOLVEDESCRIPTIONS`) |
| `get_time_spec`              | `GetTimeSpec`            | `TIMESPECKEY`                 |
| `get_time_specs`             | `GetTimeSpecs`           | — (optional `STARTFROMKEY`)   |
| `get_time_spec_group`        | `GetTimeSpecGroup`       | `TIMESPECGROUPKEY`            |
| `get_time_spec_groups`       | `GetTimeSpecGroups`      | — (optional `STARTFROMKEY`/`RESOLVEMEMBERNAMES`) |
| `get_holiday`                | `GetHoliday`             | `HOLIDAYKEY`                  |
| `get_holidays`               | `GetHolidays`            | — (no calling parameters)     |
| `get_portal_group`           | `GetPortalGroup`         | `PORTALGROUPKEY` (optional `RESOLVEGROUPNAMES`) |
| `get_portal_groups`          | `GetPortalGroups`        | — (optional `STARTFROMKEY`/`RESOLVEGROUPNAMES`) |
| `get_reader_group`           | `GetReaderGroup`         | `READERGROUPKEY`              |
| `get_reader_groups`          | `GetReaderGroups`        | — (optional `STARTFROMKEY`)   |
| `get_partitions`             | `GetPartitions`          | —                             |
| `get_udf_lists`              | `GetUDFLists`            | —                             |
| `get_udf_list_items`         | `GetUDFListItems`        | `UDFLISTKEY`                  |
| `get_elevators`               | `GetElevators`           | — (optional `STARTFROMKEY`)   |
| `get_floors`                 | `GetFloors`              | — (optional `STARTFROMKEY`)   |
| `ping_app`                   | `PingApp`                | —                             |
| `get_threat_levels`          | `GetThreatLevels`        | — (optional `ALLPARTITIONS`)  |
| `get_unlock_window`          | `GetPortalGroups` + `GetPortalGroup` + `GetTimeSpecGroups` + `GetTimeSpecs` + `GetHolidays` + `GetHoliday` (composite) | — |
| `get_daily_unlock_window`    | `GetPortalGroups` + `GetPortalGroup` + `GetTimeSpecGroups` + `GetTimeSpecs` + `GetHolidays` (composite) | — |
| `get_portal_states`          | `GetPortalStates`        | — (optional `PORTALSTATES`)   |
| `get_portal_statuses`        | `GetPortalStatuses`      | — (optional `ALLPARTITIONS`/`PORTALKEY`/`STATEKEY`/`PARTITIONKEY`/`LOCATIONKEY`; the live state of each door, not its configuration) |
| `get_locations`              | `GetLocations`           | — (optional `ALLPARTITIONS`/`STARTFROMKEY`) |
| `get_alarms`                 | `GetAlarms`              | — (optional `ALLPARTITIONS`/`PARTITIONKEY`/`ID`/`EVENTID`/`ACTIVITYID`/`OWNERID`) |
| `get_picture`                | `GetPicture`             | `PERSONID` (returns a Base64 JPEG in `PICTURE`; may be large) |
| `get_virtual_credential_request` | `GetVirtualCredentialRequest` | `PERSONID`, `CARDFORMAT`  |
| `get_mercury_panels`         | `GetMercuryPanels`       | — (optional `ALLPARTITIONS`/`PARTITIONKEY`/`MERCURYKEY`/`NAME`) |
| `get_mercury_panel`          | `GetMercuryPanel`        | `MERCURYKEY`                  |
| `get_network_nodes`          | `GetNetworkNodes`        | — (optional `ALLPARTITIONS`/`PARTITIONKEY`/`NODEKEY`/`UNIQUEIDENTIFIER`/`NAME`) |
| `get_network_node`           | `GetNetworkNode`         | `NODEKEY` (optional `PARTITIONKEY`) |
| `get_sios`                   | `GetSios`                | `MERCURYKEY` (no unfiltered SIO listing exists) |
| `get_sio`                    | `GetSio`                 | `SIOKEY`                      |

There is deliberately no `get_portal` (singular) tool — no such NBAPI command
exists; only `GetPortals` (plural) does. `get_card_access_details` and
`get_access_history` identify a card by `ENCODEDNUM`/`CARDFORMAT` (and
`get_access_history` optionally by `HOTSTAMP`), not by `PERSONID` — neither
command has a `PERSONID` parameter.

Every read tool except `find_portals` returns a thin JSON pass-through of
that NBAPI command's response fields — no reshaping. Each tool's input
schema declares exactly the documented PARAMS fields for its command — no
invented, renamed, or passthrough fields. All NBAPI parameter names above
are copied verbatim from the NBAPI Command Reference (see
`specs/archive/s2-netbox-mcp-write.md` and the archived `specs/archive/s2-netbox-mcp.md`)
— none are invented or guessed.

Nine tools are composites — they combine several NBAPI commands and reshape
the result instead of passing one command through: `find_portals`,
`get_unlock_window`, `get_daily_unlock_window`, and `get_reader_access_history`
(read-only, always registered), and `set_portals_state`,
`schedule_unlock_window`, `cancel_unlock_window`, `schedule_daily_unlock_window`,
and `cancel_daily_unlock_window` (write, registered only with
`NETBOX_ENABLE_WRITES`). Every composite reads list commands fully
paginated (following `NEXTKEY` until `-1`, or `AFTERLOGID`/`NEXTLOGID` over a
bounded `SCANWINDOW` for `get_reader_access_history`) and issues only
commands from the closed allowlist. `set_portals_state` locks, unlocks (Extended Unlock until
locked again), or momentarily unlocks many portals in one call — the given
`portalKeys` or every portal — issuing one command per portal sequentially and
never stopping on a single failure; its result partitions the portals into
`succeeded`, `alreadyInState` (the controller's "Portal state not changed"),
and `failed`, and is an error only when `failed` is non-empty. The five
unlock-window tools are described under **Scheduled unlock windows** and
**Scheduled daily unlock windows** below.

`find_portals` is for finding a door when you only know
where it is. Portal names are site codes (`01OF05A`), and the only
human-readable location text on the controller is each reader's `DESCRIPTION`.
`GetPortals` doesn't return it, and neither command takes a filter. So
`find_portals` reads every page of `GetPortals` and `GetReaders`, joins them by
`READERKEY`, and returns the portals where every term of `query` appears
(case-insensitive) in the portal name, a reader name, or a reader description.
For example, `"maintenance office"` matches a reader described as
`BREAKROOM TO MAINTENANCE OFFICE`. Each match includes its readers' names and
descriptions. The result also lists `portalsWithoutDescriptions`: portals none
of whose readers has a description, which can only be found by name. It issues
no commands beyond those two.

`get_portals` itself also accepts `RESOLVEDESCRIPTIONS` (default **`true`** —
on by default, the same opt-*out* default as every other `RESOLVEDESCRIPTIONS`
flag in this codebase): unless explicitly set to `false`, it fills in each
nested reader's own `DESCRIPTION` field — `GetPortals` never populates it,
only `READERKEY`/`NAME`/`PORTALORDER` — via one `GetReaders` full-table fetch
per call (not per portal/reader), using the same `src/readerDescriptions.ts`
helper as the other `RESOLVEDESCRIPTIONS` tools. Unlike those tools, which add
a new sibling field (`READERDESCRIPTION`) to flat records, this fills
`DESCRIPTION` in directly on each nested reader object, since that's that
reader's own native `GetReaders` field name. Set `RESOLVEDESCRIPTIONS: false`
to get readers back exactly as `GetPortals` returns them, with no
`GetReaders` call. This makes plain `get_portals` listings self-describing;
it doesn't replace `find_portals`, which remains the tool for *searching* by
name or description rather than just listing.

`get_reader_access_history` is for finding out who actually badges through a
given reader — useful, for example, when a reader has no `DESCRIPTION` and
`find_portals` can't locate it by name. `GetAccessHistory` has no
`READERKEY`/`PORTALKEY` filter, so this tool reads and filters client-side.
Rather than a date range (a real one proved unworkable live — see
`specs/archive/get-reader-access-history.md`'s Goal section), it scans a fixed-size
window of the most recent `SCANWINDOW` system-wide records (default 2000):
one cheap `MAXRECORDS: '1'` call discovers the current maximum `LOGID`, then
the tool walks forward from `maxLogid - SCANWINDOW` via its own
`AFTERLOGID`/`NEXTLOGID` pagination loop (a separate shape from `NEXTKEY`),
keeping only the records whose `READERKEY` matches. Each matching record's
`PERSONID` is enriched with `FIRSTNAME`/`LASTNAME` via one `GetPerson` call
per distinct person (a lookup failure — e.g. for an operator-style
`PERSONID` — leaves those two fields blank rather than failing the call).
The result is capped at `MAXMATCHES` (default 100, earliest matches first)
with a `truncated` flag. `get_reader_access_history` also accepts
`RESOLVEDESCRIPTIONS` (default **`true`** — on by default, the one
opt-*out* boolean in this codebase; every other optional boolean flag
defaults to off): unless explicitly set to `false`, it attaches a single
top-level `READERDESCRIPTION` field — the human-readable description of the
call's own `READERKEY` — via one `GetReaders` full-table fetch. It is
deliberately **not** duplicated onto each `matches` entry, since every match
already shares that identical `READERKEY` by construction. Set
`RESOLVEDESCRIPTIONS: false` to omit the field entirely (not present at all,
distinguishable from an unknown reader's `''`) and skip the `GetReaders`
call.

`get_access_history` optionally enriches each returned record with the
badge-holder's name via `RESOLVENAMES: true` (default `false`): when set, it
calls `GetPerson` once per distinct `PERSONID` found in the result (the same
per-request memoization as `get_reader_access_history`, via the shared
`src/personEnrichment.ts` helper — no cross-request cache) and adds
`FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` to each record, preserving every
original field. This costs one extra `GetPerson` call per distinct person in
the result, which is why it's opt-in rather than on by default.
`get_access_history` has no date-range filter: its previous date-range
parameters were removed entirely, closing
[#47](https://github.com/J-MaFf/s2-netbox-mcp/issues/47) — they didn't match
`GetAccessHistory`'s real NBAPI field names, and a live controlled A/B test
this session found that even the correct field names don't work: the
controller silently ignores them and returns the same records regardless of
the requested range, no error, just no effect. Renaming would have only
traded a loud failure for a silently wrong one, so date-range filtering is
dropped rather than fixed — the same reasoning already documented above for
`get_reader_access_history`.

`get_access_history` and `get_card_access_details` both also accept
`RESOLVEDESCRIPTIONS` (default **`true`** — on by default; the same
opt-*out* default as `get_reader_access_history`'s own `RESOLVEDESCRIPTIONS`
above, and unlike `RESOLVENAMES`, which defaults to off): unless explicitly
set to `false`, each returned record is enriched with the reader's
human-readable `READERDESCRIPTION` alongside its existing `READER` (or
`PORTALNAME`, for `get_card_access_details`) code, preserving every other
field. Both tools share the same `src/readerDescriptions.ts` helper
`get_reader_access_history` uses. It defaults to on rather than off because,
unlike person-name enrichment, the underlying `GetReaders` fetch has a fixed
cost — this controller's entire reader table (68 readers) fetches in exactly
2 paginated calls regardless of how many result records are returned, so
there's no scaling cost to make callers opt in to. Set
`RESOLVEDESCRIPTIONS: false` to skip the `GetReaders` call and get the plain
(unenriched) response. On both `get_access_history` and
`get_card_access_details`, `RESOLVENAMES` and `RESOLVEDESCRIPTIONS` are
independent flags — either, both, or neither may be requested in the same
call.

`get_card_access_details` also accepts its own `RESOLVENAMES: true` (default
`false`), enriching the response with the card owner's
`FIRSTNAME`/`LASTNAME`/`FULLNAME`/`NOTES` via the same shared
`src/personEnrichment.ts` helper `get_access_history` uses. Unlike
`get_access_history` (whose response can carry many distinct `PERSONID`s, one
per record), `GetCardAccessDetails`' response carries exactly one `PERSONID`
at the top level — a card belongs to one person — so this costs a single
`GetPerson` call per tool call, not one per distinct person. The four
enrichment fields land on the **top level** of the response, alongside
`PERSONID`/`DISABLED`/`EXPDATE`, rather than being duplicated onto every
`ACCESS` record.

`get_access_level` accepts `RESOLVEGROUPNAMES` (default **`true`** — on by
default, the same opt-*out* default as the other `RESOLVE*` flags above,
since `GetAccessLevel` carries exactly one `TIMESPECGROUPKEY` and one
`READERGROUPKEY` per call, so resolving both always costs exactly one
fixed-size `GetTimeSpecGroups` fetch and one fixed-size `GetReaderGroups`
fetch, never scaling with anything): unless explicitly set to `false`, it
resolves the response's bare `TIMESPECGROUPKEY`/`READERGROUPKEY` foreign
keys into new sibling `TIMESPECGROUPNAME`/`READERGROUPNAME` fields, using
the new `src/timeSpecGroupNames.ts`/`src/readerGroupNames.ts` helpers.
`TIMESPECGROUPKEY` is resolved via the full paginated `GetTimeSpecGroups`
list, filtering client-side for the matching key — **never** the singular
`GetTimeSpecGroup` command, which is verified broken on this controller: it
returns `CODE=FAIL`/`ERRMSG="NOT FOUND"` even for a genuinely existing group
(the same finding already documented for `src/unlockWindow/managed.ts`).
`READERGROUPKEY` is resolved the same way, via the full paginated
`GetReaderGroups` list, for consistency. An empty/absent key on either axis
independently skips that axis's fetch and yields `''` for just that axis's
name, without affecting the other. `THREATLEVELGROUPKEY` is **never**
resolved and is left exactly as-is — no NBAPI read command for threat level
groups exists in this server's command surface at all. If the underlying
`GetTimeSpecGroups`/`GetReaderGroups` fetch itself fails, that axis's name
resolves to `''` and the call still succeeds with the primary
`GetAccessLevel` data intact — an enrichment failure never loses the primary
data. Set `RESOLVEGROUPNAMES: false` to skip both fetches and get the
response back exactly as `GetAccessLevel` provides it.

`get_portal_group` accepts the same `RESOLVEGROUPNAMES` flag (default
**`true`**, same opt-*out* default and identical kind of lookup as
`get_access_level`'s own `RESOLVEGROUPNAMES` above): unless explicitly set to
`false`, it resolves the response's bare `UNLOCKTIMESPECGROUPKEY` foreign key
into a new sibling `UNLOCKTIMESPECGROUPNAME` field, reusing the same
`src/timeSpecGroupNames.ts` helper (and so the same full-paginated-list
resolution, never the broken singular `GetTimeSpecGroup` command). A single
`GetPortalGroup` response carries exactly one `UNLOCKTIMESPECGROUPKEY`, so
this always costs exactly one fixed-size `GetTimeSpecGroups` fetch, never
scaling with anything. The already-human-readable `PORTALS` sub-list
(`{PORTALKEY, NAME}` per portal) is left completely unchanged.
`THREATLEVELGROUPKEY` is **never** resolved — no NBAPI read command for
threat level groups exists in this server's command surface. An
empty/absent `UNLOCKTIMESPECGROUPKEY` skips the fetch entirely and yields
`''` for the name; if the underlying `GetTimeSpecGroups` fetch itself fails,
`UNLOCKTIMESPECGROUPNAME` resolves to `''` and the call still succeeds with
the primary `GetPortalGroup` data (including `PORTALS`) intact. Set
`RESOLVEGROUPNAMES: false` to skip the fetch and get the response back
exactly as `GetPortalGroup` provides it.

`get_portal_groups` accepts the same `RESOLVEGROUPNAMES` flag (default
**`true`**, same opt-*out* default and field name as the singular
`get_portal_group` above — this is its explicitly-planned follow-on):
unless explicitly set to `false`, it resolves every returned group's bare
`UNLOCKTIMESPECGROUPKEY` foreign key into a new sibling
`UNLOCKTIMESPECGROUPNAME` field, reusing the same
`src/timeSpecGroupNames.ts` helper. Unlike the singular tool (whose response
carries exactly one `UNLOCKTIMESPECGROUPKEY`, so it does at most one
*conditional* fetch), this plural tool builds the
`fetchTimeSpecGroupNames` map **once per call** — only if at least one group
on the page carries a non-empty `UNLOCKTIMESPECGROUPKEY` (zero
`GetTimeSpecGroups` calls if every group's key on the page is empty) — then
looks every group up against that same shared map, the same one-fetch-per-
page cost shape as `get_time_spec_groups`'s own `RESOLVEMEMBERNAMES` above,
never one fetch per group. Unlike `GetPortalGroup` (singular), `GetPortalGroups`'
response is already flat per item — `DETAILS.PORTALGROUPS.PORTALGROUP[]`, no
per-item `PORTALGROUP` wrapper — so no per-item unwrap is applied; that
wrapper quirk belongs only to the singular command's own response envelope.
The already-human-readable `PORTALS` sub-list (`{PORTALKEY, NAME}` per
portal) is left completely unchanged on every group.
`THREATLEVELGROUPKEY` is **never** resolved — no NBAPI read command for
threat level groups exists in this server's command surface. A group with an
empty/absent `UNLOCKTIMESPECGROUPKEY` gets `UNLOCKTIMESPECGROUPNAME: ''`
without needing a match; a group whose key has no match in the fetched map
also gets `''`. If the underlying `GetTimeSpecGroups` fetch itself fails,
every group's `UNLOCKTIMESPECGROUPNAME` resolves to `''` and the call still
succeeds with every group's other fields (including `PORTALS`) intact — an
enrichment failure never loses the primary data. Set `RESOLVEGROUPNAMES:
false` to skip the fetch and get groups back exactly as `GetPortalGroups`
provides them.

`list_events` accepts `RESOLVEPARTITIONNAMES` (default **`true`** — on by
default, the same opt-*out* default as the other `RESOLVE*` flags above):
unless explicitly set to `false`, each returned event's bare `PARTITIONID`
is resolved into a new sibling `PARTITIONNAME` field via one `GetPartitions`
fetch per call — not per event, since `GetPartitions` takes no
`STARTFROMKEY` at all and always answers every partition in a single
response, so the cost never scales with how many events come back. This is
backed by the new `src/partitionNames.ts` helper, mirroring
`src/readerDescriptions.ts`'s shape exactly (a `Map`-returning fetch
function that never throws). An event whose `PARTITIONID` has no match in
the fetched map resolves to `PARTITIONNAME: ''`, and if the underlying
`GetPartitions` fetch itself fails, every event's `PARTITIONNAME` resolves
to `''` and the call still succeeds with every other field (including
`ACTIONS`) intact — an enrichment failure never loses the primary data. Set
`RESOLVEPARTITIONNAMES: false` to skip the `GetPartitions` call and get the
response back exactly as `ListEvents` provides it.

`get_time_spec_groups` accepts `RESOLVEMEMBERNAMES` (default **`true`** — on
by default, the same opt-*out* default as the other `RESOLVE*` flags above,
since resolving every group's members on a page always costs exactly one
fixed-size `GetTimeSpecs` fetch, never scaling with how many groups/members
are on the page): unless explicitly set to `false`, each group's
`TIMESPECKEYS.TIMESPECKEY` field — which `GetTimeSpecGroups` returns as bare
`TIMESPECKEY` string(s) — is replaced with a list of `{TIMESPECKEY, NAME}`
objects, matching this codebase's own convention for other group-membership
sub-lists that NBAPI already returns as objects natively (`get_access_level_group`'s
`ACCESSLEVELS`, `get_reader_group`'s `READERS`). A member key with no match
in the fetched `GetTimeSpecs` table (an unknown/deleted time spec) resolves
to `NAME: ''` rather than being omitted. Every other field
(`TIMESPECGROUPKEY`, the group's own `NAME`, `DESCRIPTION`) is unchanged. The
name lookup uses the new `src/timeSpecNames.ts` helper — one full paginated
`GetTimeSpecs` fetch per call, regardless of how many groups/members are on
the page — and reuses `keyList` (`src/paging.ts`, relocated from
`src/unlockWindow/managed.ts`) to normalize the bare-key collection. If the
underlying `GetTimeSpecs` fetch itself fails, every member's `NAME` resolves
to `''` and the call still succeeds with every group's own fields intact —
an enrichment failure never loses the primary data. `RESOLVEMEMBERNAMES`
applies only to this plural tool, not the singular `get_time_spec_group`,
which is verified broken (`CODE=FAIL`/`ERRMSG="NOT FOUND"`) on this
controller even for a genuinely existing group, independent of this change.
Set `RESOLVEMEMBERNAMES: false` to skip the fetch and get `TIMESPECKEYS`
back exactly as `GetTimeSpecGroups` provides it (bare string or array of
strings).

### Write tools and Destructive tools

`write` (needs only `NETBOX_ENABLE_WRITES`) and `destructive` (needs
`NETBOX_ENABLE_WRITES` **and** `NETBOX_ENABLE_DESTRUCTIVE`). Every write
tool's input schema declares exactly the documented PARAMS fields for its
command, matching required/optional as documented — see the "Write access"
section above for the gating rules and the shared `SUCCESS`/`WRITE:`/
`DESTRUCTIVE:` conventions.

| Tool                         | Wraps NBAPI command      | Required params                              | Tier        |
| ----------------------------- | ------------------------- | ----------------------------------------------- | ----------- |
| `lock_portal`                 | `LockPortal`               | `PORTALKEY`                                      | write       |
| `unlock_portal`               | `UnlockPortal`             | `PORTALKEY`                                      | write       |
| `momentary_unlock_portal`     | `MomentaryUnlockPortal`    | `PORTALKEY`                                      | write       |
| `dog_on_next_exit_portal`     | `DogOnNextExitPortal`      | `PORTALKEY`                                      | write       |
| `activate_output`             | `ActivateOutput`           | `OUTPUTKEY`                                      | write       |
| `deactivate_output`           | `DeactivateOutput`         | `OUTPUTKEY`                                      | write       |
| `add_time_spec`               | `AddTimeSpec`              | `NAME`                                           | write       |
| `modify_time_spec`            | `ModifyTimeSpec`           | `TIMESPECKEY`                                    | write       |
| `add_time_spec_group`         | `AddTimeSpecGroup`         | `NAME`                                           | write       |
| `modify_time_spec_group`      | `ModifyTimeSpecGroup`      | `TIMESPECGROUPKEY`                               | write       |
| `delete_time_spec`            | `DeleteTimeSpec`           | `TIMESPECKEY`                                    | destructive |
| `delete_time_spec_group`      | `DeleteTimeSpecGroup`      | `TIMESPECGROUPKEY`                               | destructive |
| `add_holiday`                 | `AddHoliday`               | `HOLIDAYNAME`, `STARTDATE`, `ENDDATE`, `HOLIDAYGROUPS` | write       |
| `modify_holiday`              | `ModifyHoliday`            | `HOLIDAYKEY`                                     | write       |
| `delete_holiday`              | `DeleteHoliday`            | `HOLIDAYKEY`                                     | destructive |
| `add_portal_group`            | `AddPortalGroup`           | `NAME`, `PORTALKEYS`, `UNLOCKTIMESPECGROUPKEY`   | write       |
| `modify_portal_group`         | `ModifyPortalGroup`        | `PORTALGROUPKEY`, `PORTALKEYS`                   | write       |
| `delete_portal_group`         | `DeletePortalGroup`        | `PORTALGROUPKEY`                                 | destructive |
| `add_reader_group`            | `AddReaderGroup`           | `NAME`, `READERKEYS`                             | write       |
| `modify_reader_group`         | `ModifyReaderGroup`        | `READERGROUPKEY`, `READERKEYS`                   | write       |
| `delete_reader_group`         | `DeleteReaderGroup`        | `READERGROUPKEY`                                 | destructive |
| `add_access_level`            | `AddAccessLevel`           | `ACCESSLEVELNAME`, `TIMESPECGROUPKEY`             | write       |
| `modify_access_level`         | `ModifyAccessLevel`        | `ACCESSLEVELKEY`, `TIMESPECGROUPKEY`             | write       |
| `delete_access_level`         | `DeleteAccessLevel`        | `ACCESSLEVELKEY`                                 | destructive |
| `add_access_level_group`      | `AddAccessLevelGroup`      | `NAME`                                           | write       |
| `modify_access_level_group`   | `ModifyAccessLevelGroup`   | `ACCESSLEVELGROUPKEY`                            | write       |
| `delete_access_level_group`   | `DeleteAccessLevelGroup`   | `ACCESSLEVELGROUPKEY`                            | destructive |
| `add_person`                  | `AddPerson`                | `LASTNAME`                                       | write       |
| `modify_person`               | `ModifyPerson`             | `PERSONID`                                       | write       |
| `remove_person`               | `RemovePerson`             | `PERSONID`                                       | destructive |
| `add_credential`              | `AddCredential`            | `PERSONID`, `CARDFORMAT` (+ `ENCODEDNUM` or `HOTSTAMP`) | write |
| `modify_credential`           | `ModifyCredential`         | `PERSONID`                                       | write       |
| `remove_credential`           | `RemoveCredential`         | `PERSONID` (+ `CREDENTIALID` or `ENCODEDNUM`/`HOTSTAMP`) | destructive |
| `set_threat_level`            | `SetThreatLevel`           | `LEVELNAME` (optional `LOCATIONKEYS`)            | write       |
| `add_threat_level`            | `AddThreatLevel`           | `LEVELNAME`                                      | write       |
| `modify_threat_level`         | `ModifyThreatLevel`        | `LEVELNAME`, `SEQNUM`, `COLOR`                   | write       |
| `remove_threat_level`         | `RemoveThreatLevel`        | `LEVELNAME`                                      | destructive |
| `add_threat_level_group`      | `AddThreatLevelGroup`      | `LEVELGROUPNAME`                                 | write       |
| `modify_threat_level_group`   | `ModifyThreatLevelGroup`   | `LEVELGROUPNAME`, `LEVELNAMES`                    | write       |
| `remove_threat_level_group`   | `RemoveThreatLevelGroup`   | `LEVELGROUPNAME`                                 | destructive |
| `trigger_event`               | `TriggerEvent`             | `EVENTNAME`, `EVENTACTION`                        | write       |
| `insert_activity`             | `InsertActivity`           | `ACTIVITYTYPE`                                   | write       |
| `add_partition`               | `AddPartition`             | `NAME`, `TIMEZONE`                                | write       |
| `switch_partition`            | `SwitchPartition`          | `PARTITIONKEY`                                   | write       |
| `modify_udf_list_items`       | `ModifyUDFListItems`       | `UDFLISTKEY`, `LISTITEMS`                         | write       |
| `set_portals_state`           | `LockPortal` / `UnlockPortal` / `MomentaryUnlockPortal` per portal, after `GetPortals` (composite) | `action` (`portalKeys` optional; omitted = every portal) | write |
| `schedule_unlock_window`      | `AddHoliday`/`ModifyHoliday`, `AddTimeSpec`/`ModifyTimeSpec`, `AddTimeSpecGroup`/`ModifyTimeSpecGroup`, `AddPortalGroup`/`ModifyPortalGroup`, plus `DeleteTimeSpec`/`DeleteHoliday` of leftover managed segments, plus reads (composite) | `start`, `end` (`portalKeys`, `acknowledgeSideEffects`, `dryRun` optional) | write |
| `cancel_unlock_window`        | `ModifyPortalGroup`, `DeleteHoliday`, `ModifyTimeSpecGroup`, `DeleteTimeSpec` — managed objects only — plus reads (composite) | — | write |
| `schedule_daily_unlock_window` | `AddHoliday`/`ModifyHoliday`, `AddTimeSpec`/`ModifyTimeSpec`, `AddTimeSpecGroup`/`ModifyTimeSpecGroup`, `AddPortalGroup`/`ModifyPortalGroup`, plus reads (composite) | `startDate`, `endDate`, `dailyStartTime`, `dailyEndTime` (`portalKeys`, `acknowledgeSideEffects`, `dryRun` optional) | write |
| `cancel_daily_unlock_window`  | `ModifyPortalGroup`, `DeleteHoliday`, `ModifyTimeSpecGroup`, `DeleteTimeSpec` — managed objects only — plus reads (composite) | — | write |
| `add_duty_log`                | `AddDutyLog`               | `PERSONID`, `LOGTEXT` (optional `ACTIVITYID`/`PARTITIONKEY`) | write |
| `add_virtual_credential_request` | `AddVirtualCredentialRequest` | `PERSONID`, `CARDFORMAT`                  | write       |
| `remove_virtual_credential_request` | `RemoveVirtualCredentialRequest` | `PERSONID`, `CARDFORMAT`            | destructive |
| `add_mercury_panel`           | `AddMercuryPanel`          | `NAME`, `TYPE`, `ENABLED`, `PARTITIONKEY`, `NETWORK` (nested: `IPADDRESS`, `TLSSECURE`) | write |
| `modify_mercury_panel`        | `ModifyMercuryPanel`       | `MERCURYKEY`, `NAME`, `ENABLED`, `NETWORK` (nested: `IPADDRESS`, `TLSSECURE`) | write |
| `delete_mercury_panel`        | `DeleteMercuryPanel`       | `MERCURYKEY`                                     | destructive |
| `add_network_node`            | `AddNetworkNode`           | `NAME`, `TYPE`, `ENABLED`, `PARTITIONKEY`, `UNIQUEIDENTIFIER`, `DHCPENABLED` | write |
| `modify_network_node`         | `ModifyNetworkNode`        | `NODEKEY`                                        | write       |
| `delete_network_node`         | `DeleteNetworkNode`        | `NODEKEY`                                        | destructive |
| `add_sio`                     | `AddSio`                   | `MERCURYKEY`, `NAME`, `MODEL`, `CHANNEL`, `ADDRESS`, `REVINPUT` | write |
| `modify_sio`                  | `ModifySio`                | `SIOKEY`, `NAME`, `REVINPUT`                     | write       |
| `delete_sio`                  | `DeleteSio`                | `SIOKEY`                                         | destructive |

The twelve hardware tools (`*_mercury_panel`, `*_network_node`, `*_sio` —
six writes and three destructive deletes, plus the six reads in the table
above) are **not live-verified**: the reference controller this project is
developed against has no Mercury panels and no SIOs, so their read tools
SKIP-pass in `npm run test:live` and their write tools have never been issued
against real hardware. They are built to the April-2025 NBAPI v2 guide alone
— see the header comment in `src/tools/hardware.ts` and
[`docs/reference/nbapi-command-diff.md`](docs/reference/nbapi-command-diff.md).

`modify_portal_group` and `modify_reader_group` always replace the group's
membership with the `PORTALKEYS`/`READERKEYS` you send — on this controller
(6.2.0, verified live) an omitted or unparsed list empties the group instead
of leaving it unchanged, so both tools require the complete membership.

`trigger_event` is **unverified live on 6.x**; `NETBOX_EVENT_API_PATH` is
available to override the request path if your controller serves the Event
API separately from the main NBAPI path (see the environment variable table
above).

`switch_partition` changes the partition for **every later call made by this
server process**, not just the caller's own next request — the NBAPI session
is cached and reused, and `SwitchPartition` has no per-call scope.

#### Person / credential tools and Active Directory

If this NetBox instance syncs person/access-level data from Active
Directory, any *write* this server makes to a synced field is silently
overwritten on the next AD sync — `add_person` and `modify_person` both
carry this caution in their tool descriptions. Separately, `modify_person`'s
`ACCESSLEVELS` has two syntaxes: a plain list of access-level name strings
**replaces** the person's entire set of access levels, while a list of
`{ ACCESSLEVELNAME, DELETE?, ACTDATE?, EXPDATE?, AUTOREMOVE? }` blocks is
additive (adds/removes individual levels without touching the rest). Mixing
the two syntaxes in one call is rejected client-side before any command is
sent.

## Scheduled unlock windows

"Unlock these doors from *start* to *end*" is one call —
`schedule_unlock_window` — and the **controller itself enforces the
schedule**: no process has to stay alive to relock the doors, so the MCP host
can go away the moment the call returns.

**How it works (the same objects an operator creates by hand).** The window is
realised as a *Holiday* covering the dates, a *Time Spec* with **no weekdays**
and only one holiday group ticked, and a *Portal Group* whose *Unlock Time
Spec* is that time spec's group. A time spec with no weekdays and holiday
group *G* ticked is active only on dates covered by a holiday in group *G*, so
the portals unlock exactly on the window's dates and clock range. A window
that spans midnight is split into up to three segments — `first` (start time →
23:59 on the start date), `middle` (00:00 → 23:59 on every date strictly
between, if any) and `last` (00:00 → end time on the end date) — each with its
own holiday + time spec pair.

**Managed objects and the single-window model.** Everything the tool creates
is named with `NETBOX_UNLOCK_NAME_PREFIX` (default `MCP Unlock Window`): the
portal group is named exactly `<prefix>`, the time spec group `<prefix> time
specs` (never `<prefix>` — group names are unique across group types on this
controller, so a portal group and a time spec group cannot share a name), and
the per-segment holidays and time specs `<prefix> first`, `<prefix> middle`,
`<prefix> last`. Names are the identity. There is **one managed window at a
time**: scheduling a new one rewrites those same objects (modifying what
exists, adding what is missing, deleting leftover segments from the previous
window), and calling it twice with the same arguments is idempotent (only
Modify/Get commands, same keys). The composite tools never modify or delete
any object whose name is not exactly one of those; a user-created object
that happens to carry one of those names is treated as managed. The apply
order is fixed — resolve portals, managed time spec group, per-segment
holiday + time spec, group membership, delete leftovers, managed portal group
— and every step is read back and compared to the plan before the tool
reports `verified: true`; any mismatch is a tool error describing the field.
If any apply step fails, the tool rolls back by deleting every managed
holiday and time spec written so far (mirroring `cancel_unlock_window`'s
cleanup) before returning the error, so no partial window is left active;
the error text names the failed step, the controller's message, and what the
rollback removed.

**Reserved holiday groups.** NetBox has exactly eight holiday groups (1–8),
shared by every time spec on the controller. `NETBOX_UNLOCK_HOLIDAY_GROUPS`
(default `8,7,6`) reserves one group per segment kind (`first`, `middle`,
`last`, in that order). Reserve groups nothing else on the controller uses.
With fewer than three groups configured, only windows needing that many
segments can be scheduled (one group = same-day windows only); the tool never
doubles up a group, because two segments sharing one would each unlock on the
other's dates.

**The side-effect check and `acknowledgeSideEffects`.** A holiday in group
*G* suppresses, on its dates, every time spec that does **not** tick *G* — an
access level whose time spec ticks only groups 1–3, say, would lose access
during a window that uses group 8. Before writing anything,
`schedule_unlock_window` reads every time spec and holiday and reports
`suppressedTimeSpecs` (time specs other than `Never` and its own that lack a
group the plan uses) and `overlappingHolidays` (non-managed holidays whose
dates intersect the window — reported, never touched). If any time spec would
be suppressed, the call is refused with nothing written unless
`acknowledgeSideEffects=true`. `dryRun=true` returns the plan and the report
without writing anything, whether or not you acknowledged. The built-in
`Always` time spec ticks all eight groups and is never affected.

**Cancelling.** `cancel_unlock_window` first, **if** the managed portal group
exists, points it at the built-in `Never` time spec group (re-sending its
current portals); then, regardless of whether that portal group exists,
deletes the managed holidays and empties the managed time spec group and
deletes the managed time specs. The last two are best-effort: if the
controller refuses them, the tool still succeeds and lists what was left
under `leftBehind`, because once the portal group (if any) is on `Never` and
no managed holiday exists, nothing can unlock. The managed portal group and
time spec group are kept (pointing at `Never` / empty) and reused by the next
window. The tool reports there was nothing to cancel only when **no** managed
object of any kind — portal group, time spec group, holiday, or time spec —
exists.
`get_unlock_window` (always registered, read-only) shows the current managed
state — the portal group and whether it points at the managed time spec
group, that group's members (read from `GetTimeSpecGroups`, because
`GetTimeSpecGroup` returns `FAIL`/`NOT FOUND` on the verified 6.2.0
controller), the managed time specs and holidays — plus the window derived
from them and `activeNow` on the host clock.

**Limits and caveats.**

- A window must end in the future and be at most **31 days** long. Holidays
  are capped at 30 per partition, so a window whose segments would push past
  that is refused. `portalKeys` are keys only (use `get_portals` or
  `find_portals` to map names); an unknown key is refused before anything is
  written.
- End of day on the NBAPI is `23:59` (the built-in `Always` uses it), and
  `ENDTIME` is **inclusive through the end of that minute**, so there is no
  midnight gap between segments of a multi-day window. A window's door
  relocks up to **59 seconds after** the stated `end` minute (observed live:
  a window ending `08:27` relocked at `08:27:59` controller time). An `end`
  of `00:00` means "up to 23:59 of the previous day".
- Times are the **controller's local time**. The MCP host is assumed to share
  the controller's timezone; the host clock is used only to reject windows
  that have already elapsed and to compute `activeNow`.
- The physical unlock is **not observable through the NBAPI**: no read command
  exposes portal state, and `GetEventHistory` carries no Unlock/Relock
  activity. The tool verifies its work by reading the configuration objects
  back and comparing them to the plan; confirm the door itself on
  **Monitor → Portal Status** or in person.
- `set_portals_state` is the immediate alternative: its `UNLOCK` is an
  *Extended Unlock* that lasts until `LOCK`, with nothing scheduling the
  relock.

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

## Scheduled daily unlock windows

The companion to **Scheduled unlock windows** above: "unlock these doors from
*dailyStartTime* to *dailyEndTime*, every day from *startDate* through
*endDate*" — a single partial-day window that **recurs daily** across a date
range, which `schedule_unlock_window` cannot express (it models one
continuous span, so a multi-day request there keeps doors unlocked overnight
on the days strictly between the first and last). `schedule_daily_unlock_window`
relocks the doors every night outside the daily window.

**How it works (reusing the same mechanism).** This reuses the exact
holiday + time spec + portal group mechanism described above: a *Holiday*
spanning the **whole date range**, a *Time Spec* with **no weekdays** and
only the one reserved daily holiday group ticked, and a *Portal Group* whose
*Unlock Time Spec* is that time spec's group. Because a time spec with no
weekdays and holiday group *G* ticked is active during its
`STARTTIME`-`ENDTIME` on **every** date covered by a holiday in group *G*,
one holiday (covering every date in the range) paired with one partial-day
time spec already expresses "the same time-of-day window, every day in the
range" — **no first/middle/last segment-splitting is ever needed**, unlike
the continuous feature, whose planner has to split a multi-day span into up
to three segments precisely because a middle day needs a full `00:00`-`23:59`
grant. This feature's plan is always exactly **one** segment.

**Environment variables and collision safety.** `NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP`
(default `5`) is the single holiday group this feature reserves, and
`NETBOX_DAILY_UNLOCK_NAME_PREFIX` (default `MCP Daily Unlock Window`) names
its managed objects — see the environment variable table above for both.
`NETBOX_DAILY_UNLOCK_HOLIDAY_GROUP` is validated at startup to never be a
member of `NETBOX_UNLOCK_HOLIDAY_GROUPS`, so **this feature and the
continuous one always use disjoint holiday groups**, and — because each
feature's managed portal group and time spec group are named after its own
prefix — disjoint managed-object names as well. Consequently **the two
features can be active at the same time**: a daily window and a continuous
window may both be scheduled and unlocking doors concurrently, with no
shared NBAPI object between them. This also means `schedule_daily_unlock_window`'s
side-effect check does **not** special-case a currently-active continuous
window — if its dates happen to overlap the daily plan's dates, it is
reported like any other foreign time spec/holiday, which is the correct,
general behaviour rather than a special case.

**Managed objects and the single-daily-window model.** Everything this
tool creates is named with `NETBOX_DAILY_UNLOCK_NAME_PREFIX`: the portal
group is named exactly `<prefix>`, the time spec group `<prefix> time specs`
(never `<prefix>` — group names are unique across group types on this
controller, same as the continuous feature), and the one holiday and one
time spec `<prefix> schedule` (same name, different object tables — no
collision). Names are the identity. There is **one managed daily window at a
time**: scheduling a new one rewrites those same objects (modifying what
exists, adding what is missing), and calling it twice with the same
arguments is idempotent (only Modify/Get commands, same keys). The tools
never modify or delete any object whose name is not exactly one of those; a
user-created object that happens to carry one of those names is treated as
managed. The apply order is fixed — resolve portals, managed time spec
group, managed holiday, managed time spec, group membership, managed portal
group — and every step is read back and compared to the plan before the
tool reports `verified: true`; any mismatch is a tool error describing the
field. If any apply step fails, the tool rolls back by deleting the managed
holiday and time spec written so far (mirroring `cancel_daily_unlock_window`'s
cleanup) before returning the error, so no partial window is left active;
the error text names the failed step, the controller's message, and what
the rollback removed.

**The side-effect check and `acknowledgeSideEffects`.** Exactly as for the
continuous feature: a holiday in the reserved daily group suppresses, on its
dates, every time spec that does **not** tick that group. Before writing
anything, `schedule_daily_unlock_window` reads every time spec and holiday
and reports `suppressedTimeSpecs` (time specs other than `Never` and its own
that lack the reserved daily group) and `overlappingHolidays` (non-managed
holidays whose dates intersect the window — reported, never touched). If any
time spec would be suppressed, the call is refused with nothing written
unless `acknowledgeSideEffects=true`. `dryRun=true` returns the plan and the
report without writing anything, whether or not you acknowledged.

**Cancelling.** `cancel_daily_unlock_window` first, **if** the managed
portal group exists, points it at the built-in `Never` time spec group
(re-sending its current portals); then, regardless of whether that portal
group exists, deletes the managed holiday if it exists, and empties the
managed time spec group and deletes the managed time spec if either exists.
The last two are best-effort: if the controller refuses them, the tool still
succeeds and lists what was left under `leftBehind`, because once the portal
group (if any) is on `Never` and no managed holiday exists, nothing can
unlock. The managed portal group and time spec group are kept (pointing at
`Never` / empty) and reused by the next daily window. The tool reports there
was nothing to cancel only when **no** managed object of any kind — portal
group, time spec group, holiday, or time spec — exists.
`get_daily_unlock_window` (always registered, read-only) shows the current
managed state — the portal group and whether it points at the managed time
spec group, that group's members, the one managed time spec and holiday
(singular, not arrays — this feature never has more than one of each) —
plus the window derived from them and `activeNow` on the host clock.

**Limits and caveats.**

- A window must end in the future and span at most **31 days**
  (`endDate - startDate`). Holidays are capped at 30 per partition, so a
  window whose one holiday would push past that is refused. `portalKeys` are
  keys only (use `get_portals`/`find_portals` to map names); an unknown key
  is refused before anything is written.
- **An overnight-crossing daily window is not supported**: `dailyEndTime`
  must be strictly later than `dailyStartTime` (same-day time-of-day only).
  A request like "10 PM to 5 AM, every night" is rejected — a future
  extension could express this as two segments, but it is out of scope here.
- There is no per-weekday selectivity: the whole `[startDate, endDate]` range
  unlocks every day at the given time-of-day (no "weekdays only" filtering).
- Dates are `YYYY-MM-DD` and times are `HH:MM`, both **controller-local**;
  the same midnight-relock and host/controller-clock-assumption caveats as
  the continuous feature above apply here too.
- The physical unlock is **not observable through the NBAPI** — confirm the
  door on **Monitor → Portal Status** or in person, exactly as above.

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

This calls all read tools except `get_unlock_window`/`get_daily_unlock_window`
(35 of the 37 — see **Tools exposed** below) against a **real, configured** controller and
prints a PASS/FAIL line per tool plus a summary, exiting non-zero if
anything failed. It only runs if `NETBOX_BASE_URL`, `NETBOX_USERNAME`, and
`NETBOX_PASSWORD` are all set (loaded from `.env` if present); otherwise it
prints one line saying live testing was skipped and exits 0. It never prints
the value of `NETBOX_PASSWORD`, under any circumstance, and it never issues
a write/control command regardless of `NETBOX_ENABLE_WRITES`. `npm test`
never runs this script and never requires `.env` to exist.

### Live write smoke test (optional, opt-in twice)

```bash
npm run test:live:write                        # CRUD round-trips only
npm run test:live:write -- --go                # ... plus the real 2-minute unlock window
npm run test:live:write -- --go --start 14:30  # pin the unlock time (1-60 min ahead)
```

> **PowerShell:** on at least one PowerShell/npm combination this silently drops flags passed after
> `--` (npm prints `npm warn Unknown cli config "--go"` and the flag never reaches the script —
> observed live, 2026-09-15). If `--go` doesn't trigger phase (c), call the script directly instead:
> `npx tsx scripts/live-check-write.ts --go`.

This skips with one line and exit 0 — making no network call — unless
`NETBOX_BASE_URL`, `NETBOX_USERNAME`, `NETBOX_PASSWORD`,
`NETBOX_ENABLE_WRITES=true` **and** `NETBOX_LIVE_TEST_PORTALKEY` are all set.
Most of the round-trips below issue deletes/removes directly against the
controller (independent of the MCP server's own `NETBOX_ENABLE_DESTRUCTIVE`
gating, which this script bypasses by calling the NBAPI client directly), so
**set `NETBOX_ENABLE_DESTRUCTIVE=true` before running it**.

Otherwise it round-trips add → get → modify → get → delete for a time spec, a
time spec group, a holiday, a reader group, and a portal group under the
distinct prefix `MCP livecheck` (the portal group's unlock time spec group is
`Never` and the holiday is in 2099, so nothing can unlock), asserting each
read-back. It then round-trips a person (`AddPerson` → `GetPerson` →
`ModifyPerson` → `GetPerson`) plus a credential on that person (`AddCredential`
→ `GetPerson` with `WANTCREDENTIALID` → `ModifyCredential` with `DISABLED=1`
→ read-back → `RemoveCredential` → read-back) → `RemovePerson`, accepting
either `NOT FOUND` or `DELETED=TRUE` on the final `GetPerson` (never sends
`PERSONPURGE`); an access level (`AddAccessLevel` with `TIMESPECGROUPKEY`
`Never` → `GetAccessLevel` → `ModifyAccessLevel` → read-back →
`DeleteAccessLevel` → read-back gone) plus an access level group built from a
second temporary access level (`AddAccessLevelGroup` → `GetAccessLevelGroup`
→ `ModifyAccessLevelGroup` → read-back → `DeleteAccessLevelGroup`, tolerating
the same `FAIL`/`ERRMSG="NOT FOUND"` quirk documented for `GetTimeSpecGroup`
against an empty collection); a threat level plus a threat level group
(`AddThreatLevel` → `AddThreatLevelGroup` → `ModifyThreatLevel` →
`ModifyThreatLevelGroup` → `RemoveThreatLevelGroup` → `RemoveThreatLevel`,
proven gone by a second `RemoveThreatLevel` failing — `GetThreatLevels` is
not used for round-trip verification here, and `SetThreatLevel` is never
called); `InsertActivity`
with a timestamped `USERACTIVITY` record; a UDF list item round-trip via
`ModifyUDFListItems` (or a recorded `SKIPPED` pass if no UDF list is
configured); and `GetPartitions` → `SwitchPartition` back to the session's
own partition (`AddPartition` is never called). It cleans up any
`MCP livecheck` leftovers — including persons, access levels/groups, and
threat levels/groups — from an aborted run, both before and after the round
trips.

It then estimates the controller's clock from the newest `GetAccessHistory`
record and refuses to run the door phase — regardless of `--go` — when that
estimate disagrees with the host clock by more than 2 minutes; window times
passed to `schedule_unlock_window` are always controller-local, not host-local.

With `--go` — pass it **only after** notifying the user (push notification
plus a chat message giving the exact unlock and relock clock times) and
receiving a go-ahead, because they observe the door — it prints a
`HEADS-UP` line, schedules a real 2-minute unlock of the designated portal
through the real `schedule_unlock_window` executor (unlock at now + 2 min and
relock at now + 4 min, or at `--start HH:MM`), prints `OBSERVE: portal ...
should unlock at HH:MM and relock at HH:MM — confirm on Monitor → Portal
Status`, polls `get_unlock_window` every 30 s until one minute after relock,
then calls `cancel_unlock_window` and asserts the managed portal group is on
`Never` with no managed holiday, time spec, or time spec group member left
(leftBehind is tolerated but reported). It refuses that phase if a managed
window already exists (so it never replaces a real one); apart from the
supervised single actions below, it never touches outputs, `TriggerEvent`, or
portal lock/unlock actions, never prints the password, exits non-zero on any
failed assertion (still cancelling the window first), and `npm test` never
runs it.

#### Supervised single actions

```bash
npm run test:live:write -- --action unlock_portal
npm run test:live:write -- --action set_threat_level --value High
```

`--action <name> [--value <v>]` runs exactly **one** write against the
designated portal (or its strike output) instead of the full flow above —
skipping phases (b), (b2), and (c) entirely. It still requires
`NETBOX_ENABLE_WRITES=true` and the credential variables (same skip line as
above), but **not** `NETBOX_ENABLE_DESTRUCTIVE`, since no deletes happen. It
refuses to run — exit 2, no network call — if `--action` is combined with
`--go`, if the action name is unknown, or if `set_threat_level`'s required
`--value` is missing. It prints the exact command and params sent (never
credentials), the controller's `CODE`/`DETAILS` or `ERRMSG`, and an
`OBSERVE: ...` line describing what to check at the door or on Monitor; a
`FAIL` with `ERRMSG` `"Portal state not changed"` is reported as
PASS-with-note rather than a failure. Exits 0 on success or already-in-state,
1 otherwise, and unknown/invalid arguments exit 2.

Every action is reversible:

| Action | Effect | Reverse |
| --- | --- | --- |
| `unlock_portal` | `UnlockPortal` (Extended Unlock) | `lock_portal` |
| `lock_portal` | `LockPortal` | — |
| `momentary_unlock_portal` | `MomentaryUnlockPortal` (relocks itself) | — |
| `dog_on_next_exit_portal` | `DogOnNextExitPortal` | `lock_portal` |
| `activate_output` | `ActivateOutput` on the portal's strike output | `deactivate_output` |
| `deactivate_output` | `DeactivateOutput` on the portal's strike output | — |
| `set_portals_state_unlock` | the real `set_portals_state` (`setPortalsState`) tool, action `UNLOCK` | `set_portals_state_lock` |
| `set_portals_state_lock` | `set_portals_state`, action `LOCK` | — |
| `set_portals_state_momentary` | `set_portals_state`, action `MOMENTARY_UNLOCK` (relocks itself) | — |
| `set_threat_level` | `SetThreatLevel LEVELNAME=<--value>` | `set_threat_level --value Default` |
| `trigger_event_activate` | `TriggerEvent EVENTNAME=<--value> EVENTACTION=ACTIVATE PARTITIONID=1` | `trigger_event_deactivate` |
| `trigger_event_deactivate` | `TriggerEvent EVENTNAME=<--value> EVENTACTION=DEACTIVATE PARTITIONID=1` | — |

`activate_output`/`deactivate_output` resolve the strike output by finding
the `GetOutputs` entry whose `NAME` starts with the designated portal's
`NAME` (e.g. portal `"02OF01A"` → output `"02OF01A EL"`), failing clearly if
none is found. `AddPartition` is never reachable through `--action`, same as
the rest of this script.

`trigger_event_activate`/`trigger_event_deactivate` require `--value
<EVENTNAME>` — the name of a NetBox event that must already exist (events
cannot be created via the NBAPI; create it first in the NetBox UI). This is
the **only** live verification path for `trigger_event` — the full CRUD
flow above never calls `TriggerEvent`. Both actions go through the same
`NetboxClient.call` as every other command, so `NETBOX_EVENT_API_PATH`
routing still applies; the script prints which URL path it used.

### Live write smoke test — daily unlock window (optional, opt-in twice)

```bash
npm run test:live:write:daily         # CRUD round-trips only
npm run test:live:write:daily -- --go # ... plus the real 2-minute daily unlock window
```

> **PowerShell:** see the same-named caveat under "Live write smoke test" above — if `--go` is
> silently dropped, use `npx tsx scripts/live-check-write-daily.ts --go` instead (verified live,
> 2026-09-15, on portal `02OF01A`: unlock/relock confirmed in person, 16/16 steps PASS).

A sibling script to `npm run test:live:write` above, covering
`schedule_daily_unlock_window`/`cancel_daily_unlock_window`/
`get_daily_unlock_window` (kept as a separate `npm` script rather than
chained onto `test:live:write` so `-- --go` keeps reaching the script it is
meant for). It skips with one line and exit 0 — making no network call —
under the same gating as `npm run test:live:write`. Otherwise it round-trips
add → get → modify → get → delete for a time spec, a time spec group, a
holiday, and a portal group under the distinct prefix `MCP livecheck daily`
(the portal group's unlock time spec group is `Never` and the holiday is in
2099, so nothing can unlock), asserting each read-back, then runs the same
controller-clock-skew guard as `test:live:write` (refusing the door phase
above a 2-minute skew regardless of `--go`).

With `--go` — pass it **only after** notifying the user and receiving a
go-ahead, same as above — it prints a `HEADS-UP` line, schedules a real
2-minute **daily** unlock covering only today's date (`dailyStartTime` = now
+ 2 min, `dailyEndTime` = now + 4 min) on the designated portal through the
real `schedule_daily_unlock_window` executor, prints an `OBSERVE: ...` line,
polls `get_daily_unlock_window` every 30 s until one minute after relock,
then calls `cancel_daily_unlock_window` and asserts the managed portal group
is on `Never` with no managed holiday or time spec left (`leftBehind` is
tolerated but reported). It refuses that phase if a managed daily window
already exists, never touches persons, credentials, access levels, threat
levels, outputs, events, partitions, or UDF lists, never prints the
password, exits non-zero on any failed assertion (still cancelling the
window first), and `npm test` never runs it.

## Out of scope

- Photo **upload** — the multipart POST to `/nbws/goforms/upload`, which is
  not an NBAPI XML command at all. Reading a person's photo **is** supported:
  `get_picture` wraps `GetPicture` and returns the Base64 JPEG unmodified.
- Elevator and floor **writes** — not a choice: neither the v1 nor the v2
  guide documents any `Add`/`Modify`/`Delete` command for elevators or
  floors, so `get_elevators`/`get_floors` are read-only because the API is.
  See [the diff report](docs/reference/nbapi-command-diff.md).
- **Data Operations** (bulk person import/export) — the LenelS2 Data
  Operations guide describes a web-UI and NAS-polling feature with no API of
  its own, so there is nothing to wrap. No import-file builder, export parser
  or NAS automation is planned.
- Alarm-queue **workflow** commands (`AckAlarm`, `AckEvent`,
  `AlarmClearActions`, `AlarmSetOwner`, `EventClearActions`) — `get_alarms`
  reads alarms, but this server does not drive an operator alarm queue.
- `StreamEvents` / the persistent `/appdevent/nbapi/event` push feed
- MAC-based authentication (session-login only)
- The S2 Global API variant
- The deprecated NBAPI commands (`EditPerson`, `EditThreatLevel`,
  `EditThreatLevelGroup`, `GetAccessDataLog`, `GetAccessCardDetails`,
  `LoginUserName`, `LoginUserPassword`)
- Multiple concurrent managed unlock windows, per-window naming, or any
  persistence on the MCP host (there is one managed window; names are its
  identity)
- Resolving portals by **name** in the composite tools (keys only —
  `get_portals`/`find_portals` map names)
- Automatically deleting the managed portal group or time spec group on
  cancel (they stay, pointing at `Never` / empty, and are reused)
- Any scheduler on the host (Task Scheduler, in-process timers) — the
  controller is the only scheduler
- Confirmation prompts inside the server — the MCP host's permission model
  and the environment gates are the controls
- Any GUI/dashboard beyond the MCP tool surface

See `specs/archive/s2-netbox-mcp-write.md` for the full requirements the write-tool
surface was built against, and `specs/archive/s2-netbox-mcp.md` for the
original read-only v1 spec (archived — all its acceptance criteria passed,
including live verification).

## Contributing

Bug reports, feature requests, and PRs are welcome — see `CONTRIBUTING.md` for the
workflow (issue first, branch naming, PR conventions) and the physical-safety note that
applies to any change touching write/destructive tools.

## Security

Found a vulnerability? See `SECURITY.md` for how to report it privately and what the
physical-safety blast radius looks like at each configuration level.
