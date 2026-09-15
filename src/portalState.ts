import type { NetboxClient } from './netboxClient.js';
import { NBAPI_COMMANDS, type NbapiCommandName } from './commands.js';
import { NbapiFailError } from './errors.js';
import { fetchAllPages, text } from './paging.js';

/**
 * Bulk portal control behind `set_portals_state` (R10): one LockPortal /
 * UnlockPortal / MomentaryUnlockPortal per portal, issued sequentially and
 * never aborting on a single failure, with the outcomes partitioned so the
 * caller can see exactly which doors changed, which were already in the
 * requested state, and which failed.
 */

export const PORTAL_STATE_ACTIONS = ['LOCK', 'UNLOCK', 'MOMENTARY_UNLOCK'] as const;
export type PortalStateAction = (typeof PORTAL_STATE_ACTIONS)[number];

const COMMAND_FOR_ACTION: Record<PortalStateAction, NbapiCommandName> = {
  LOCK: NBAPI_COMMANDS.LOCK_PORTAL,
  UNLOCK: NBAPI_COMMANDS.UNLOCK_PORTAL,
  MOMENTARY_UNLOCK: NBAPI_COMMANDS.MOMENTARY_UNLOCK_PORTAL,
};

export interface PortalStateEntry {
  PORTALKEY: string;
  NAME: string;
}

export interface PortalStateFailure extends PortalStateEntry {
  error: string;
}

export interface PortalStateResult {
  action: PortalStateAction;
  /** How many portals the command was issued to. */
  requested: number;
  succeeded: PortalStateEntry[];
  /** FAIL with ERRMSG containing "Portal state not changed" — the door was already there. */
  alreadyInState: PortalStateEntry[];
  /** Any other FAIL/APIERROR (or transport error) for that portal. */
  failed: PortalStateFailure[];
}

/** The controller's ERRMSG when a lock/unlock is a no-op. */
const ALREADY_IN_STATE = /Portal state not changed/i;

/**
 * Issues `action` to `portalKeys` (or to every portal from a fully
 * paginated GetPortals when omitted), sequentially. Explicit keys are sent
 * as given — the controller answers an unknown key with FAIL "Invalid portal
 * key", which lands in `failed` — and their NAMEs are filled in from
 * GetPortals where known.
 */
export async function setPortalsState(
  client: NetboxClient,
  action: PortalStateAction,
  portalKeys?: string[]
): Promise<PortalStateResult> {
  const command = COMMAND_FOR_ACTION[action];
  const portals = await fetchAllPages(client, NBAPI_COMMANDS.GET_PORTALS, 'PORTALS', 'PORTAL');
  const nameByKey = new Map(portals.map((portal) => [text(portal.PORTALKEY), text(portal.NAME)]));

  const targets: PortalStateEntry[] =
    portalKeys === undefined
      ? portals.map((portal) => ({ PORTALKEY: text(portal.PORTALKEY), NAME: text(portal.NAME) }))
      : [...new Set(portalKeys)].map((key) => ({ PORTALKEY: key, NAME: nameByKey.get(key) ?? '' }));

  const result: PortalStateResult = { action, requested: targets.length, succeeded: [], alreadyInState: [], failed: [] };
  for (const target of targets) {
    try {
      await client.call(command, { PORTALKEY: target.PORTALKEY });
      result.succeeded.push(target);
    } catch (err) {
      if (err instanceof NbapiFailError && ALREADY_IN_STATE.test(err.errmsg ?? '')) {
        result.alreadyInState.push(target);
      } else {
        result.failed.push({ ...target, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return result;
}
