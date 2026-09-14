import type { NetboxClient } from './netboxClient.js';

export interface ShutdownDeps {
  exit: (code: number) => void;
}

const defaultDeps: ShutdownDeps = { exit: (code) => process.exit(code) };

/**
 * Registers SIGINT/SIGTERM handlers that send NBAPI Logout for any active
 * session before the process exits (R6/C6), guarding against re-entrancy
 * from a second signal arriving mid-shutdown. Returns the shutdown function
 * itself so callers (and tests) can also invoke it directly without going
 * through `process.emit`.
 */
export function registerShutdownHandlers(client: NetboxClient, deps: ShutdownDeps = defaultDeps): () => Promise<void> {
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await client.logout();
    } catch {
      // Defense in depth: NetboxClient.logout() is documented as best-effort
      // and never throws, but shutdown must never hang or reject even if
      // that contract is violated (e.g. by a test double or future change).
    } finally {
      deps.exit(0);
    }
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  return shutdown;
}
