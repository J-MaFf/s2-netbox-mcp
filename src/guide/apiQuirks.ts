import type { GuideTopic } from './types.js';

/**
 * R6 (api-quirks): STARTFROMKEY/NEXTKEY paging, the absence of a singular
 * get_portal, and checking write results for the literal SUCCESS. Generic
 * S2 NetBox domain knowledge only.
 */
export const apiQuirksTopic: GuideTopic = {
  title: 'API quirks',
  summary:
    'Paging list tools to completion via STARTFROMKEY/NEXTKEY, the missing singular get_portal, and checking for SUCCESS on writes.',
  content: `API quirks

List tools page results via STARTFROMKEY (the cursor you pass in) and NEXTKEY
(the cursor the controller hands back). A single call only returns one page
-- to get a complete result, keep calling with the previous response's
NEXTKEY as the next call's STARTFROMKEY until the controller returns no
further NEXTKEY. Stopping after one page silently truncates the result
rather than erroring.

There is no singular get_portal tool -- only the plural, paginated
get_portals exists, and it returns every portal with no name or location
filter. To find a specific door by name or location, use find_portals
instead, which searches portal names and reader names/descriptions for you.

Every successful write tool's result text contains the literal word SUCCESS.
A tool call that doesn't throw is not by itself proof the write applied --
check the result text for SUCCESS rather than assuming success from the mere
absence of a thrown error.`,
};
