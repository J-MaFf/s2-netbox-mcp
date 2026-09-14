import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerShutdownHandlers } from '../src/shutdown.js';
import type { NetboxClient } from '../src/netboxClient.js';

afterEach(() => {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

function fakeClient(): { client: NetboxClient; logout: ReturnType<typeof vi.fn> } {
  const logout = vi.fn().mockResolvedValue(undefined);
  const client = { logout } as unknown as NetboxClient;
  return { client, logout };
}

describe('registerShutdownHandlers (R6)', () => {
  it('sends Logout before exiting when SIGINT is received', async () => {
    const { client, logout } = fakeClient();
    const exit = vi.fn();
    registerShutdownHandlers(client, { exit });

    process.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(logout).toHaveBeenCalledTimes(1);
    const logoutOrder = logout.mock.invocationCallOrder[0];
    const exitOrder = exit.mock.invocationCallOrder[0];
    expect(logoutOrder).toBeLessThan(exitOrder);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('sends Logout before exiting when SIGTERM is received', async () => {
    const { client, logout } = fakeClient();
    const exit = vi.fn();
    registerShutdownHandlers(client, { exit });

    process.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(logout).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is re-entrant safe: a second signal during shutdown does not send a second Logout', async () => {
    const { client, logout } = fakeClient();
    const exit = vi.fn();
    registerShutdownHandlers(client, { exit });

    process.emit('SIGINT');
    process.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('still exits even if logout() rejects', async () => {
    const logout = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { logout } as unknown as NetboxClient;
    const exit = vi.fn();
    registerShutdownHandlers(client, { exit });

    process.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledWith(0);
  });
});
