import { createRequire } from 'node:module';

/**
 * The package version, read from package.json at runtime so the version the
 * server reports in its MCP initialize response can't drift from the
 * published package (#129). The path resolves to the repo root from both
 * src/version.ts (tests via vitest) and dist/version.js (the built server);
 * npm always ships package.json, so the published package can read it too.
 */
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const SERVER_VERSION: string = pkg.version;
