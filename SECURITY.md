# Security Policy

## This isn't a typical "leaks data" security model

This server bridges an AI agent to a real physical security controller. A
vulnerability here isn't just a data leak — depending on configuration, it
could mean an attacker locking/unlocking doors, adding or deleting
credentials, or otherwise reaching into a system that controls physical
access to a building. Treat reports accordingly: err on the side of
reporting privately, even if you're not sure it rises to "vulnerability."

The blast radius depends entirely on how the server is configured:

- **Default (no write-related env vars set):** the server is read-only —
  incapable of adding, modifying, deleting, locking/unlocking, or triggering
  anything on the controller. A vulnerability here is an information
  disclosure risk (cardholder/access data), not a physical-access risk.
- **`NETBOX_ENABLE_WRITES=true`:** the server can lock/unlock doors, and
  add/modify persons, credentials, and access configuration.
- **`NETBOX_ENABLE_WRITES=true` + `NETBOX_ENABLE_DESTRUCTIVE=true`:** the
  server can additionally delete/remove access-control objects.

See the "Write access" section of `README.md` for the full gating rules.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/J-MaFf/s2-netbox-mcp/security/advisories/new)
for this repository rather than opening a public issue. This applies to:

- Anything that could let a client bypass the read-only default or the
  write/destructive gates
- Credential handling issues (e.g. `NETBOX_PASSWORD` ending up somewhere it
  shouldn't — logs, error messages, tool output)
- Injection or parameter-smuggling issues in the NBAPI request building
- Any other issue where the "physical-safety blast radius" above applies

I'll acknowledge reports as soon as I can and aim to have a fix or mitigation
out promptly given the physical-safety stakes involved.

## Supported versions

This is a single-maintainer project without long-term support branches —
security fixes land on the latest release. Please upgrade to the latest
version before reporting, if practical.
