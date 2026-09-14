# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

This repo opts into the **team-maintainer** profile, per this user's global git-policies
(`~/.claude/skills/git-policies`), which take precedence over the defaults below:

- `bd dolt push` runs automatically after every `bd create` / `bd update` / `bd close` — no
  confirmation, not batched for session close. It syncs `refs/dolt/data`, which is not covered
  by the `main` branch ruleset, so it carries none of the review weight of a merge.
- Feature-branch `git push` also runs freely, without asking.
- **Merges to `main` stay human-gated via PR** — never auto-merge, regardless of how freely
  bead/branch state syncs. Issue-first workflow, signed commits, and PR conventions from
  git-policies apply to all code changes in this repo.
- Repo-scoped knowledge goes in `bd remember`, not `MEMORY.md` — this only overrides
  project-local memory files; the user's global cross-repo memory system is unaffected and
  still applies.

## Session Completion

1. **File issues for remaining work** — create beads for anything that needs follow-up.
2. **Run quality gates** (if code changed) — tests, linters, builds.
3. **Update issue status** — close finished work, update in-progress items, `bd dolt push`
   immediately (see above — no confirmation needed for this step).
4. **Git**: push the feature branch; open/update the PR referencing its issue (`Fixes #N`);
   stop at the merge gate for human approval — never auto-merge into `main`.
5. **Hand off** — summarize changes, validation, issue/PR status.

**Critical rule:** explicit user instruction in the moment always overrides this file.
<!-- END BEADS INTEGRATION -->


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
