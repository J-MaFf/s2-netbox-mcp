/**
 * The complete, closed set of NBAPI commands this server is capable of issuing.
 *
 * Per spec requirement R10, this is the ONLY place in the source tree where
 * NBAPI `COMMAND name="..."` string literals are defined. Every call site
 * elsewhere in the codebase references these constants (e.g.
 * `NBAPI_COMMANDS.GET_PERSON`) rather than inlining a new string literal, so a
 * grep of the source tree for command-name literals stays exhaustive here.
 *
 * This set intentionally contains only read/query commands plus the two
 * session-lifecycle commands (Login, Logout). No write/control command
 * (Add/Modify/Delete/Remove/Lock/Unlock/Activate/Deactivate/Set/Trigger/etc.)
 * may ever be added to this map — doing so would violate R10 and the
 * "Read-only enforcement" requirement of the spec.
 */
export const NBAPI_COMMANDS = {
  LOGIN: 'Login',
  LOGOUT: 'Logout',
  GET_API_VERSION: 'GetAPIVersion',
  GET_PERSON: 'GetPerson',
  SEARCH_PERSON_DATA: 'SearchPersonData',
  GET_CARD_ACCESS_DETAILS: 'GetCardAccessDetails',
  GET_CARD_FORMATS: 'GetCardFormats',
  GET_ACCESS_LEVEL: 'GetAccessLevel',
  GET_ACCESS_LEVELS: 'GetAccessLevels',
  GET_ACCESS_LEVEL_GROUP: 'GetAccessLevelGroup',
  GET_ACCESS_LEVEL_GROUPS: 'GetAccessLevelGroups',
  GET_PORTAL: 'GetPortal',
  GET_PORTALS: 'GetPortals',
  GET_READER: 'GetReader',
  GET_READERS: 'GetReaders',
  GET_EVENT_HISTORY: 'GetEventHistory',
  LIST_EVENTS: 'ListEvents',
  GET_ACCESS_HISTORY: 'GetAccessHistory',
} as const;

export type NbapiCommandName = (typeof NBAPI_COMMANDS)[keyof typeof NBAPI_COMMANDS];
