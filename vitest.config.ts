import { defineConfig, configDefaults } from "vitest/config";

// Scope the suite to this repository's own tests. Without this, vitest's
// default include glob (`**/*.test.ts`) sweeps up any nested checkout under
// `.claude/worktrees/` (used by other tooling for isolated worktrees), which
// silently inflates `npm test`'s file/test counts with tests that aren't
// part of this artifact.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
