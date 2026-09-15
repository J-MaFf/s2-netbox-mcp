/**
 * The complete, closed set of NBAPI commands this server is capable of issuing.
 *
 * Per spec requirement R4, this is the ONLY place in the source tree where
 * NBAPI `COMMAND name="..."` string literals are defined. Every call site
 * elsewhere in the codebase references these constants (e.g.
 * `NBAPI_COMMANDS.GET_PERSON`) rather than inlining a new string literal, so a
 * grep of the source tree for command-name literals stays exhaustive here.
 * `test/commandAllowlist.test.ts` enforces both the exact 80-command set and
 * the confinement rule.
 *
 * This is a closed set: no command may be added here that isn't one of the
 * 80 explicitly enumerated by the spec (session lifecycle, reads, portal/
 * output actions, adds, deletes, modifies, removes, person/credential
 * writes, event/activity writes, and partition/UDF-list commands). Whether a
 * given tool built on top of one of these commands is actually *reachable*
 * at runtime is controlled separately by `NETBOX_ENABLE_WRITES` /
 * `NETBOX_ENABLE_DESTRUCTIVE` gating in `src/index.ts` and `src/tools/*.ts`.
 */
export const NBAPI_COMMANDS = {
  // Session lifecycle (2) + v0.2.0 read commands (15) = 17
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
  GET_PORTALS: 'GetPortals',
  GET_READER: 'GetReader',
  GET_READERS: 'GetReaders',
  GET_EVENT_HISTORY: 'GetEventHistory',
  LIST_EVENTS: 'ListEvents',
  GET_ACCESS_HISTORY: 'GetAccessHistory',

  // Additional read commands (18, R8/R29)
  GET_TIME_SPEC: 'GetTimeSpec',
  GET_TIME_SPECS: 'GetTimeSpecs',
  GET_TIME_SPEC_GROUP: 'GetTimeSpecGroup',
  GET_TIME_SPEC_GROUPS: 'GetTimeSpecGroups',
  GET_HOLIDAY: 'GetHoliday',
  GET_HOLIDAYS: 'GetHolidays',
  GET_PORTAL_GROUP: 'GetPortalGroup',
  GET_PORTAL_GROUPS: 'GetPortalGroups',
  GET_READER_GROUP: 'GetReaderGroup',
  GET_READER_GROUPS: 'GetReaderGroups',
  GET_OUTPUTS: 'GetOutputs',
  GET_ACCESS_LEVEL_NAMES: 'GetAccessLevelNames',
  GET_PARTITIONS: 'GetPartitions',
  GET_UDF_LISTS: 'GetUDFLists',
  GET_UDF_LIST_ITEMS: 'GetUDFListItems',
  GET_ELEVATORS: 'GetElevators',
  GET_FLOORS: 'GetFloors',
  PING_APP: 'PingApp',

  // Portal/output actions (7, R9)
  ACTIVATE_OUTPUT: 'ActivateOutput',
  DEACTIVATE_OUTPUT: 'DeactivateOutput',
  DOG_ON_NEXT_EXIT_PORTAL: 'DogOnNextExitPortal',
  LOCK_PORTAL: 'LockPortal',
  MOMENTARY_UNLOCK_PORTAL: 'MomentaryUnlockPortal',
  UNLOCK_PORTAL: 'UnlockPortal',
  SET_THREAT_LEVEL: 'SetThreatLevel',

  // Add commands (10)
  ADD_ACCESS_LEVEL: 'AddAccessLevel',
  ADD_ACCESS_LEVEL_GROUP: 'AddAccessLevelGroup',
  ADD_HOLIDAY: 'AddHoliday',
  ADD_PARTITION: 'AddPartition',
  ADD_PORTAL_GROUP: 'AddPortalGroup',
  ADD_READER_GROUP: 'AddReaderGroup',
  ADD_TIME_SPEC: 'AddTimeSpec',
  ADD_TIME_SPEC_GROUP: 'AddTimeSpecGroup',
  ADD_THREAT_LEVEL: 'AddThreatLevel',
  ADD_THREAT_LEVEL_GROUP: 'AddThreatLevelGroup',

  // Delete commands (7) — all destructive (R2)
  DELETE_ACCESS_LEVEL: 'DeleteAccessLevel',
  DELETE_ACCESS_LEVEL_GROUP: 'DeleteAccessLevelGroup',
  DELETE_HOLIDAY: 'DeleteHoliday',
  DELETE_PORTAL_GROUP: 'DeletePortalGroup',
  DELETE_READER_GROUP: 'DeleteReaderGroup',
  DELETE_TIME_SPEC: 'DeleteTimeSpec',
  DELETE_TIME_SPEC_GROUP: 'DeleteTimeSpecGroup',

  // Modify commands (10)
  MODIFY_ACCESS_LEVEL: 'ModifyAccessLevel',
  MODIFY_ACCESS_LEVEL_GROUP: 'ModifyAccessLevelGroup',
  MODIFY_HOLIDAY: 'ModifyHoliday',
  MODIFY_PORTAL_GROUP: 'ModifyPortalGroup',
  MODIFY_READER_GROUP: 'ModifyReaderGroup',
  MODIFY_THREAT_LEVEL: 'ModifyThreatLevel',
  MODIFY_THREAT_LEVEL_GROUP: 'ModifyThreatLevelGroup',
  MODIFY_TIME_SPEC: 'ModifyTimeSpec',
  MODIFY_TIME_SPEC_GROUP: 'ModifyTimeSpecGroup',
  MODIFY_UDF_LIST_ITEMS: 'ModifyUDFListItems',

  // Remove commands (2) — destructive (R2)
  REMOVE_THREAT_LEVEL: 'RemoveThreatLevel',
  REMOVE_THREAT_LEVEL_GROUP: 'RemoveThreatLevelGroup',

  // Person/credential writes (6)
  ADD_CREDENTIAL: 'AddCredential',
  ADD_PERSON: 'AddPerson',
  MODIFY_CREDENTIAL: 'ModifyCredential',
  MODIFY_PERSON: 'ModifyPerson',
  REMOVE_CREDENTIAL: 'RemoveCredential', // destructive (R2)
  REMOVE_PERSON: 'RemovePerson', // destructive (R2)

  // Events/activity (2)
  TRIGGER_EVENT: 'TriggerEvent',
  INSERT_ACTIVITY: 'InsertActivity',

  // Partitions (1)
  SWITCH_PARTITION: 'SwitchPartition',
} as const;

export type NbapiCommandName = (typeof NBAPI_COMMANDS)[keyof typeof NBAPI_COMMANDS];
