import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setPortalsState } from '../src/portalState.js';
import { registerPortalTools } from '../src/tools/portal.js';
import { NBAPI_COMMANDS } from '../src/commands.js';
import { FakeNetbox } from './fakeNetbox.js';
import { FakeServer, byName } from './testUtils.js';

function threePortals(): FakeNetbox {
  const fake = new FakeNetbox();
  fake.portals.push({ PORTALKEY: '1', NAME: '01OF01A' }, { PORTALKEY: '2', NAME: '02OF01A' }, { PORTALKEY: '3', NAME: '03OF01A' });
  return fake;
}

describe('setPortalsState (R10)', () => {
  it('partitions one success, one "Portal state not changed", and one other FAIL — sequentially, never aborting', async () => {
    const fake = threePortals();
    fake.portalActionOutcomes.set('2', 'unchanged');
    fake.portalActionOutcomes.set('3', 'offline');

    const result = await setPortalsState(fake.client, 'LOCK', ['1', '2', '3']);

    expect(result).toEqual({
      action: 'LOCK',
      requested: 3,
      succeeded: [{ PORTALKEY: '1', NAME: '01OF01A' }],
      alreadyInState: [{ PORTALKEY: '2', NAME: '02OF01A' }],
      failed: [{ PORTALKEY: '3', NAME: '03OF01A', error: 'NetBox NBAPI command failed: Portal not online or reachable' }],
    });
    expect(fake.calls).toEqual([
      { command: NBAPI_COMMANDS.GET_PORTALS, params: {} },
      { command: NBAPI_COMMANDS.LOCK_PORTAL, params: { PORTALKEY: '1' } },
      { command: NBAPI_COMMANDS.LOCK_PORTAL, params: { PORTALKEY: '2' } },
      { command: NBAPI_COMMANDS.LOCK_PORTAL, params: { PORTALKEY: '3' } },
    ]);
  });

  it('with portalKeys omitted, acts on every portal from a fully paginated GetPortals', async () => {
    const fake = new FakeNetbox();
    for (let i = 1; i <= 5; i++) fake.portals.push({ PORTALKEY: String(i), NAME: `0${i}OF01A` });
    fake.portalsPageSize = 2;

    const result = await setPortalsState(fake.client, 'UNLOCK');

    expect(fake.calls.slice(0, 3)).toEqual([
      { command: NBAPI_COMMANDS.GET_PORTALS, params: {} },
      { command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: '2' } },
      { command: NBAPI_COMMANDS.GET_PORTALS, params: { STARTFROMKEY: '4' } },
    ]);
    expect(fake.calls.slice(3).map((call) => call.command)).toEqual(Array(5).fill(NBAPI_COMMANDS.UNLOCK_PORTAL));
    expect(result.requested).toBe(5);
    expect(result.succeeded.map((portal) => portal.PORTALKEY)).toEqual(['1', '2', '3', '4', '5']);
    expect(result.alreadyInState).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('MOMENTARY_UNLOCK issues MomentaryUnlockPortal; an unknown explicit key is sent, fails at the controller, and lands in failed', async () => {
    const fake = threePortals();
    const result = await setPortalsState(fake.client, 'MOMENTARY_UNLOCK', ['1', '99']);
    expect(fake.calls.slice(1)).toEqual([
      { command: NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL, params: { PORTALKEY: '1' } },
      { command: NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL, params: { PORTALKEY: '99' } },
    ]);
    expect(result.succeeded).toEqual([{ PORTALKEY: '1', NAME: '01OF01A' }]);
    expect(result.failed).toEqual([{ PORTALKEY: '99', NAME: '', error: 'NetBox NBAPI command failed: Invalid portal key' }]);
  });

  it('de-duplicates explicit keys so a door is only commanded once', async () => {
    const fake = threePortals();
    const result = await setPortalsState(fake.client, 'LOCK', ['2', '2', '1']);
    expect(fake.calls.slice(1).map((call) => call.params)).toEqual([{ PORTALKEY: '2' }, { PORTALKEY: '1' }]);
    expect(result.requested).toBe(2);
  });
});

describe('set_portals_state tool', () => {
  function register(fake: FakeNetbox, writesEnabled: boolean): FakeServer {
    const server = new FakeServer();
    registerPortalTools(server as unknown as McpServer, fake.client, { writesEnabled, destructiveEnabled: false });
    return server;
  }

  it('is registered only when writes are enabled, is WRITE:-prefixed, and declares exactly action + portalKeys', () => {
    expect(register(threePortals(), false).registrations.map((r) => r.name)).not.toContain('set_portals_state');
    const reg = byName(register(threePortals(), true), 'set_portals_state');
    expect(reg.description.startsWith('WRITE:')).toBe(true);
    expect(Object.keys(reg.schema).sort()).toEqual(['action', 'portalKeys']);
  });

  it('returns SUCCESS + the JSON when nothing failed (alreadyInState is not a failure)', async () => {
    const fake = threePortals();
    fake.portalActionOutcomes.set('2', 'unchanged');
    const result = await byName(register(fake, true), 'set_portals_state').handler({ action: 'LOCK', portalKeys: ['1', '2'] });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.startsWith('SUCCESS\n')).toBe(true);
    expect(JSON.parse(result.content[0].text.slice('SUCCESS\n'.length))).toMatchObject({
      action: 'LOCK',
      requested: 2,
      succeeded: [{ PORTALKEY: '1', NAME: '01OF01A' }],
      alreadyInState: [{ PORTALKEY: '2', NAME: '02OF01A' }],
      failed: [],
    });
  });

  it('is isError iff failed is non-empty, still carrying the full JSON', async () => {
    const fake = threePortals();
    fake.portalActionOutcomes.set('3', 'offline');
    const result = await byName(register(fake, true), 'set_portals_state').handler({ action: 'UNLOCK' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1 of 3 portal(s) failed');
    const json = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('\n') + 1));
    expect(json.failed).toEqual([{ PORTALKEY: '3', NAME: '03OF01A', error: 'NetBox NBAPI command failed: Portal not online or reachable' }]);
    expect(json.succeeded.map((portal: { PORTALKEY: string }) => portal.PORTALKEY)).toEqual(['1', '2']);
  });
});
