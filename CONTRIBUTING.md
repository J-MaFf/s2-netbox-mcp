# Contributing to s2-netbox-mcp

Thanks for considering a contribution. This is a small, solo-maintained project, so the
process is lightweight, but a few conventions keep it easy to review.

## Before you write code

**Open a GitHub issue first**, even for small changes. Describe the bug or the feature you
want to add before implementing it — this avoids duplicated or wasted work if the change
needs discussion first.

## Development setup

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in a NetBox controller's session-login credentials if
you want to run the live checks (`npm run test:live`, etc.) — the unit test suite
(`npm test`) doesn't need a real controller, since it runs against a mocked HTTP client.

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, mocked HTTP, no real controller needed
npm run build       # tsc, emits dist/
```

All three run in CI on every PR.

## Branch naming

Use a type prefix in kebab-case:

- Bug fixes: `fix/<short-description>`
- Features: `feat/<short-description>`
- Docs: `docs/<short-description>`

## Making the change

- Keep PRs scoped to one issue. If a change feels like it's doing two things, it's probably
  two issues.
- Update `CHANGELOG.md` under `[Unreleased]` in the same PR as the change, following
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format — one bullet per
  user-visible or operational change, linking the issue/PR.
- If you're adding a new NBAPI tool, match the existing pattern: read tools are always
  registered, write tools are gated behind `NETBOX_ENABLE_WRITES`, and anything that deletes
  or purges data is gated behind `NETBOX_ENABLE_DESTRUCTIVE` on top of that. See the
  "Write access" section of `README.md` for the full gating rules.

## Opening the PR

- Reference the issue in the PR body: `Fixes #N`
- Fill out the PR template's testing checklist
- A maintainer will squash-merge once it's reviewed — no need to keep history tidy on your
  branch, but please don't force-push over review comments without a heads-up

## Commit signing

The maintainer signs commits on this repo, but signing is **not required** from outside
contributors — don't let SSH/GPG signing setup be a barrier to contributing.

## Physical-safety note

This server can lock/unlock doors and delete access-control objects on a real physical
security controller when write/destructive tools are enabled. If your change touches a write
or destructive tool, call that out explicitly in the PR description.

Found an actual security vulnerability rather than a PR-worthy change? See `SECURITY.md` —
please report it privately rather than opening a public issue or PR.
