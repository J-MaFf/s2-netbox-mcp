import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import {
  runNbapiTool,
  mergeParams,
  formatAsJson,
  formatWriteSuccess,
  clientGuardError,
  destructiveFlagRequired,
  notFoundResult,
  toolErrorResult,
  wrapList,
  type ToolTextResult,
  type ToolGateFlags,
} from '../toolHelpers.js';
import { asRecord, asRecordList, text, type XmlRecord } from '../paging.js';
import { enrichWithReaderDescriptions } from '../readerDescriptions.js';
import { enrichWithPersonNames } from '../personEnrichment.js';

// SearchPersonData supports UDF1-UDF20 as search filters (per the Command
// reference). Generated rather than hand-typed twenty times over.
const udfSearchFields: Record<string, z.ZodOptional<z.ZodString>> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return [`UDF${n}`, z.string().optional().describe(`Optional. Search filter on user-defined field UDF${n}.`)];
  })
);

// AddPerson/ModifyPerson also carry UDF1-UDF20 as plain value fields (distinct
// schema instance from the search filters above, though shaped the same).
const udfValueFields: Record<string, z.ZodOptional<z.ZodString>> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return [`UDF${n}`, z.string().optional().describe(`Optional. Value for user-defined field UDF${n}.`)];
  })
);

// AD-sync caution (NBAPI doc, printed p. 1) — moved next to the person tools
// per R31. Repeated verbatim-ish on both add_person and modify_person so the
// caution is visible regardless of which tool a caller reads first.
const AD_SYNC_CAUTION =
  'CAUTION: if this NetBox instance syncs person/access-level data from Active Directory, any value this ' +
  'call writes to a synced field is silently overwritten on the next AD sync.';

// The ModifyPerson bare-name ACCESSLEVELS syntax replaces all of the
// person's access levels (R16 / the doc's Person Access Levels section).
const ACCESSLEVELS_REPLACES_WARNING =
  'WARNING: an ACCESSLEVELS value that is a plain list of access-level names (the bare-name syntax) replaces ' +
  "all of the person's access levels. Use the alternative { ACCESSLEVELNAME, DELETE?, ACTDATE?, EXPDATE?, " +
  'AUTOREMOVE? } block syntax to add/remove individual levels without replacing the rest.';

const accessLevelBlockSchema = z.object({
  ACCESSLEVELNAME: z.string(),
  DELETE: z.enum(['0', '1']).optional(),
  ACTDATE: z.string().optional(),
  EXPDATE: z.string().optional(),
  AUTOREMOVE: z.string().optional(),
});

const accessLevelsField = z
  .array(z.union([z.string(), accessLevelBlockSchema]))
  .optional()
  .describe(
    'Optional. Either syntax, not mixed in one call: a list of bare access-level name strings (replaces all ' +
      'access levels on ModifyPerson), or a list of { ACCESSLEVELNAME, DELETE?, ACTDATE?, EXPDATE?, AUTOREMOVE? } blocks (additive).'
  );

type AccessLevelsArg = Array<string | { ACCESSLEVELNAME: string }> | undefined;

/** R16 guard: mixing the two documented ACCESSLEVELS syntaxes in one call is a client-side error. */
function accessLevelsSyntaxMixed(items: AccessLevelsArg): boolean {
  if (!items || items.length === 0) return false;
  const hasBareName = items.some((item) => typeof item === 'string');
  const hasBlock = items.some((item) => typeof item === 'object');
  return hasBareName && hasBlock;
}

const vehicleAddFields = {
  VEHICLECOLOR: z.string().optional(),
  VEHICLEMAKE: z.string().optional(),
  VEHICLEMODEL: z.string().optional(),
  VEHICLESTATE: z.string().optional(),
  VEHICLELICNUM: z.string().optional(),
  VEHICLETAGNUM: z.string().optional(),
};

const vehiclesAddField = z
  .array(z.object(vehicleAddFields))
  .optional()
  .describe('Optional. Vehicles to record for this person.');

const vehiclesModifyField = z
  .array(z.object({ ...vehicleAddFields, DELETE: z.enum(['0', '1']).optional() }))
  .optional()
  .describe('Optional. Vehicles to add/update (or remove, with DELETE="1") for this person.');

const personCommonOptionalFields = {
  FIRSTNAME: z.string().optional().describe("Optional. The person's first name."),
  MIDDLENAME: z.string().optional().describe("Optional. The person's middle name."),
  NOTES: z.string().optional().describe('Optional. Free-text notes on the person record.'),
  EXPDATE: z.string().optional().describe('Optional. Date/time the person record expires.'),
  ACTDATE: z.string().optional().describe('Optional. Date/time the person record activates.'),
  ...udfValueFields,
  PIN: z.string().optional().describe('Optional. The PIN assigned to this person.'),
  BADGELAYOUT: z.string().optional().describe('Optional. Badge layout name to use for this person.'),
  CONTACTPHONE: z.string().optional().describe("Optional. The person's contact phone number."),
  CONTACTEMAIL: z.string().optional().describe("Optional. The person's contact email address."),
  CONTACTSMSEMAIL: z.string().optional().describe("Optional. The person's SMS gateway email address."),
  CONTACTLOCATION: z.string().optional().describe("Optional. The person's contact location."),
  OTHERCONTACTNAME: z.string().optional().describe('Optional. Name of an additional emergency/other contact.'),
  OTHERCONTACTPHONE1: z.string().optional().describe('Optional. First phone number of the other contact.'),
  OTHERCONTACTPHONE2: z.string().optional().describe('Optional. Second phone number of the other contact.'),
};

/**
 * Person/credential tools: the existing four read tools (GetPerson,
 * SearchPersonData, GetCardAccessDetails, GetCardFormats) plus the R16/R17
 * write tools (AddPerson, ModifyPerson, RemovePerson, AddCredential,
 * ModifyCredential, RemoveCredential). Field names are copied verbatim from
 * the spec's "Command reference" section. `PICTURE`/`PICTUREEXT`/
 * `PICTUREURL` and the S2-Global-only `PARTITIONKEY` are deliberately not
 * exposed (R16 / spec Out of scope).
 *
 * get_card_access_details's RESOLVEDESCRIPTIONS (specs/get-access-history-
 * resolve-descriptions.md, R3) enriches each returned ACCESS record's
 * READERKEY with a human-readable READERDESCRIPTION, reusing
 * src/readerDescriptions.ts's enrichWithReaderDescriptions -- the same
 * shared helper get_access_history uses. Defaults to true (opt-out, not
 * opt-in), since the underlying GetReaders fetch is a single small
 * full-table read whose cost doesn't scale with the number of ACCESS
 * records returned. Bypasses runNbapiTool for the same reason
 * get_access_history's RESOLVENAMES path does: the async enrichment can't
 * run inside runNbapiTool's synchronous formatSuccess callback.
 *
 * get_card_access_details's RESOLVENAMES (specs/get-card-access-details-
 * resolve-names.md) is an independent flag over the same response. Unlike
 * get_access_history's RESOLVENAMES (one GetPerson call per distinct
 * PERSONID across many records), GetCardAccessDetails' response carries
 * exactly one PERSONID at the *top level* -- a card belongs to one person --
 * so this is a single GetPerson lookup per call, reusing
 * src/personEnrichment.ts's enrichWithPersonNames as-is via a
 * single-element array (its simplest, already-handled "one distinct
 * PERSONID" path). The four resulting fields land on the top level of the
 * response object, alongside PERSONID/DISABLED/EXPDATE -- never duplicated
 * onto each ACCESS record, since every record shares that one PERSONID by
 * construction. Defaults to false/off, matching this codebase's usual
 * optional-boolean convention (unlike RESOLVEDESCRIPTIONS above).
 */
function withStringReaderKey(raw: XmlRecord): XmlRecord & { READERKEY: string } {
  return { ...raw, READERKEY: text(raw.READERKEY) };
}

export function registerPersonTools(server: McpServer, client: NetboxClient, gate: ToolGateFlags): void {
  server.tool(
    'get_person',
    'Returns the full person record for a given PERSONID (wraps NBAPI GetPerson).',
    {
      PERSONID: z.string().describe('Required. The unique PERSONID of the person record to retrieve.'),
      ALLPARTITIONS: z.string().optional().describe('Optional. Per NBAPI GetPerson.'),
      ACCESSLEVELDETAILS: z.string().optional().describe('Optional. Include full access level details in the response.'),
      WANTCREDENTIALID: z.string().optional().describe('Optional. Include CREDENTIALID values on returned access cards.'),
    },
    async ({ PERSONID, ALLPARTITIONS, ACCESSLEVELDETAILS, WANTCREDENTIALID }) =>
      runNbapiTool(
        client,
        NBAPI_COMMANDS.GET_PERSON,
        mergeParams({ PERSONID, ALLPARTITIONS, ACCESSLEVELDETAILS, WANTCREDENTIALID })
      )
  );

  server.tool(
    'search_person_data',
    'Searches for person records matching the given criteria (wraps NBAPI SearchPersonData). ' +
      'Every documented SearchPersonData filter field is modeled explicitly; omit all filters to return every record.',
    {
      PERSONID: z.string().optional().describe('Optional. Match on a specific PERSONID.'),
      LASTNAME: z.string().optional().describe("Optional. Match on the person's last name."),
      FIRSTNAME: z.string().optional().describe("Optional. Match on the person's first name."),
      MIDDLENAME: z.string().optional().describe("Optional. Match on the person's middle name."),
      CONTACTEMAIL: z.string().optional().describe("Optional. Match on the person's office email address."),
      MOBILEPHONE: z.string().optional().describe("Optional. Match on the person's mobile phone number."),
      CARDFORMAT: z.string().optional().describe('Optional. Match persons holding a card in this card format.'),
      CARDSTATUS: z.string().optional().describe('Optional. Match persons holding a card with this card status name.'),
      MSUENABLED: z.string().optional().describe('Optional. Match on whether MSU mobile credentials are enabled ("TRUE"/"FALSE").'),
      BLUEDIAMONDENABLED: z
        .string()
        .optional()
        .describe('Optional. Match on whether BlueDiamond mobile credentials are enabled ("TRUE"/"FALSE").'),
      NOTES: z.string().optional().describe("Optional. Match on the person record's notes text."),
      VEHICLELICNUM: z.string().optional().describe('Optional. Match on a vehicle license plate number.'),
      VEHICLETAGNUM: z.string().optional().describe('Optional. Match on a vehicle tag number.'),
      ...udfSearchFields,
      HOTSTAMP: z.string().optional().describe('Optional. Match on a card hot-stamp number.'),
      WANTCREDENTIALID: z.string().optional().describe('Optional. Include CREDENTIALID values on returned access cards.'),
      ACCESSLEVEL: z.string().optional().describe('Optional. Match persons assigned this access level.'),
      OLDESTLASTMOD: z.string().optional().describe('Optional. Only include records last modified on/after this date/time.'),
      NEWESTLASTMOD: z.string().optional().describe('Optional. Only include records last modified on/before this date/time.'),
      DELETED: z.enum(['ALL', 'TRUE', 'FALSE']).optional().describe('Optional. Include/exclude deleted person records.'),
      ALLPARTITIONS: z.string().optional().describe('Optional. Search across all partitions.'),
      CASEINSENSITIVE: z.string().optional().describe('Optional. Perform a case-insensitive match.'),
      WILDCARDSEARCH: z.string().optional().describe('Optional. Treat text filters as wildcard patterns.'),
      ACCESSLEVELDETAILS: z.string().optional().describe('Optional. Include full access level details in the response.'),
      RAWCARDNUMBER: z.string().optional().describe('Optional. Match on a raw (unformatted) card number.'),
    },
    async (args) => runNbapiTool(client, NBAPI_COMMANDS.SEARCH_PERSON_DATA, mergeParams(args))
  );

  server.tool(
    'get_card_access_details',
    'Returns card/credential access details for a given card (wraps NBAPI GetCardAccessDetails). ' +
      'Identifies the card by ENCODEDNUM + CARDFORMAT, not PERSONID — GetCardAccessDetails has no PERSONID ' +
      'parameter. RESOLVEDESCRIPTIONS defaults to true — an inverted, opt-*out* default (unlike most optional ' +
      "booleans in this codebase): each returned ACCESS record is enriched with the reader's human-readable " +
      'READERDESCRIPTION via one GetReaders full-table fetch per call (not per record); set ' +
      'RESOLVEDESCRIPTIONS: false to skip it. Set RESOLVENAMES: true to enrich the response with the card ' +
      "owner's FIRSTNAME/LASTNAME/FULLNAME/NOTES (default false — off) via a single GetPerson lookup for the " +
      "card's one PERSONID — cheaper than get_access_history's RESOLVENAMES, which pays one GetPerson call per " +
      'distinct person across many records, since a card has exactly one owner. The four fields land on the ' +
      'top level of the response, alongside PERSONID/DISABLED/EXPDATE, not on each ACCESS record.',
    {
      ENCODEDNUM: z.string().describe('Required. The encoded card number whose access details should be retrieved.'),
      CARDFORMAT: z.string().describe('Required. The card format of ENCODEDNUM.'),
      MAXRECORDS: z.string().optional().describe('Optional. Maximum number of access records to return.'),
      OLDESTDTTM: z.string().optional().describe('Optional. Oldest date/time to include in the returned access records.'),
      RESOLVENAMES: z
        .boolean()
        .optional()
        .describe(
          "Optional (default false). Enrich the top level of the response with the card owner's " +
            'FIRSTNAME/LASTNAME/FULLNAME/NOTES via a single GetPerson lookup for the response\'s top-level ' +
            'PERSONID (one lookup per call, not one per ACCESS record — a card has exactly one owner).'
        ),
      RESOLVEDESCRIPTIONS: z
        .boolean()
        .optional()
        .describe(
          'Optional (default true — on by default; the inverse of this codebase\'s usual optional-boolean ' +
            "default). Enrich each returned ACCESS record with the reader's human-readable READERDESCRIPTION " +
            'via one GetReaders full-table fetch per call (not per record). Set to false to skip it.'
        ),
    },
    async ({ ENCODEDNUM, CARDFORMAT, MAXRECORDS, OLDESTDTTM, RESOLVENAMES, RESOLVEDESCRIPTIONS }): Promise<ToolTextResult> => {
      const resolveDescriptions = RESOLVEDESCRIPTIONS !== false;
      if (!RESOLVENAMES && !resolveDescriptions) {
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS,
          mergeParams({ ENCODEDNUM, CARDFORMAT, MAXRECORDS, OLDESTDTTM })
        );
      }
      try {
        const result = await client.call(
          NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS,
          mergeParams({ ENCODEDNUM, CARDFORMAT, MAXRECORDS, OLDESTDTTM })
        );
        if (result.notFound) {
          return notFoundResult();
        }
        let details = asRecord(result.data);
        const accesses = asRecord(details.ACCESSES);
        let records: XmlRecord[] = asRecordList(accesses.ACCESS);
        if (resolveDescriptions) {
          records = await enrichWithReaderDescriptions(client, records.map(withStringReaderKey));
        }
        if (RESOLVENAMES) {
          // Exactly one PERSONID for the whole response (R3/R4 of
          // specs/archive/get-card-access-details-resolve-names.md) -- a
          // single-element array is the correct way to exercise the shared
          // helper here, since it already treats "one distinct PERSONID" as
          // its simplest case (including an empty-string PERSONID, which
          // skips the GetPerson call and yields empty-string fields with no
          // special-casing needed here).
          const [enrichedTop] = await enrichWithPersonNames(client, [{ PERSONID: text(details.PERSONID) }]);
          details = {
            ...details,
            FIRSTNAME: enrichedTop.FIRSTNAME,
            LASTNAME: enrichedTop.LASTNAME,
            FULLNAME: enrichedTop.FULLNAME,
            NOTES: enrichedTop.NOTES,
          };
        }
        const responseData = { ...details, ACCESSES: { ...accesses, ACCESS: records } };
        return { content: [{ type: 'text', text: formatAsJson(responseData) }] };
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );

  server.tool(
    'get_card_formats',
    'Returns the card formats configured on the NetBox system (wraps NBAPI GetCardFormats). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_CARD_FORMATS, {})
  );

  if (gate.writesEnabled) {
    server.tool(
      'add_person',
      `WRITE: Creates a new person record (wraps NBAPI AddPerson). ${AD_SYNC_CAUTION} ${ACCESSLEVELS_REPLACES_WARNING}`,
      {
        PERSONID: z.string().optional().describe('Optional. Desired PERSONID; the controller assigns one if omitted.'),
        LASTNAME: z.string().describe("Required. The person's last name."),
        ...personCommonOptionalFields,
        ACCESSLEVELS: accessLevelsField,
        VEHICLES: vehiclesAddField,
      },
      async ({ ACCESSLEVELS, VEHICLES, ...rest }) => {
        if (accessLevelsSyntaxMixed(ACCESSLEVELS)) {
          return clientGuardError(
            'ACCESSLEVELS must use one syntax per call: either a list of bare names, or a list of ' +
              '{ ACCESSLEVELNAME, ... } blocks — not both.'
          );
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.ADD_PERSON,
          mergeParams({
            ...rest,
            ...wrapList('ACCESSLEVELS', 'ACCESSLEVEL', ACCESSLEVELS),
            ...wrapList('VEHICLES', 'VEHICLE', VEHICLES),
          }),
          formatWriteSuccess
        );
      }
    );

    server.tool(
      'modify_person',
      `WRITE: Modifies an existing person record (wraps NBAPI ModifyPerson). ${AD_SYNC_CAUTION} ${ACCESSLEVELS_REPLACES_WARNING}`,
      {
        PERSONID: z.string().describe('Required. The PERSONID of the person record to modify.'),
        LASTNAME: z.string().optional().describe("Optional. The person's last name."),
        ...personCommonOptionalFields,
        ACCESSLEVELS: accessLevelsField,
        VEHICLES: vehiclesModifyField,
        PERSONPURGE: z.enum(['TRUE']).optional().describe('Optional. Permanently purges the person record.'),
        DELETED: z.enum(['TRUE', 'FALSE']).optional().describe('Optional. Marks the person record deleted/undeleted.'),
        ALLPARTITIONS: z.enum(['TRUE']).optional().describe('Optional. Applies the modification across all partitions.'),
      },
      async ({ ACCESSLEVELS, VEHICLES, PERSONPURGE, DELETED, ...rest }) => {
        if (accessLevelsSyntaxMixed(ACCESSLEVELS)) {
          return clientGuardError(
            'ACCESSLEVELS must use one syntax per call: either a list of bare names, or a list of ' +
              '{ ACCESSLEVELNAME, ... } blocks — not both.'
          );
        }
        if ((DELETED === 'TRUE' || PERSONPURGE === 'TRUE') && !gate.destructiveEnabled) {
          return destructiveFlagRequired('modify_person with DELETED="TRUE" or PERSONPURGE="TRUE"');
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_PERSON,
          mergeParams({
            ...rest,
            PERSONPURGE,
            DELETED,
            ...wrapList('ACCESSLEVELS', 'ACCESSLEVEL', ACCESSLEVELS),
            ...wrapList('VEHICLES', 'VEHICLE', VEHICLES),
          }),
          formatWriteSuccess
        );
      }
    );

    server.tool(
      'add_credential',
      'WRITE: Adds a credential (card) to a person (wraps NBAPI AddCredential).',
      {
        PERSONID: z.string().describe('Required. The PERSONID to add the credential to.'),
        CARDFORMAT: z.string().describe('Required. The card format of the credential.'),
        ENCODEDNUM: z.string().optional().describe('Optional. The encoded card number (one of ENCODEDNUM/HOTSTAMP required).'),
        HOTSTAMP: z.string().optional().describe('Optional. The hot-stamp number (one of ENCODEDNUM/HOTSTAMP required).'),
        WANTCREDENTIALID: z.string().optional().describe('Optional. Request a CREDENTIALID back in the response.'),
        CARDSTATUS: z.string().optional().describe('Optional. Initial card status.'),
        CARDEXPDATE: z.string().optional().describe('Optional. Card expiration date/time.'),
      },
      async ({ ENCODEDNUM, HOTSTAMP, ...rest }) => {
        if (!ENCODEDNUM && !HOTSTAMP) {
          return clientGuardError('add_credential requires at least one of ENCODEDNUM or HOTSTAMP.');
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.ADD_CREDENTIAL,
          mergeParams({ ...rest, ENCODEDNUM, HOTSTAMP }),
          formatWriteSuccess
        );
      }
    );

    server.tool(
      'modify_credential',
      'WRITE: Modifies a person’s existing credential (wraps NBAPI ModifyCredential).',
      {
        PERSONID: z.string().describe('Required. The PERSONID owning the credential.'),
        CARDFORMAT: z.string().optional().describe('Optional. The card format of the credential.'),
        ENCODEDNUM: z.string().optional().describe('Optional. The encoded card number identifying the credential.'),
        HOTSTAMP: z.string().optional().describe('Optional. The hot-stamp number identifying the credential.'),
        CREDENTIALID: z.string().optional().describe('Optional. Alternative credential identifier.'),
        DISABLED: z.enum(['0', '1']).optional().describe('Optional. Disable ("1") or enable ("0") the credential. Mutually exclusive with CARDSTATUS.'),
        CARDSTATUS: z.string().optional().describe('Optional. New card status. Mutually exclusive with DISABLED.'),
        CARDEXPDATE: z.string().optional().describe('Optional. New card expiration date/time.'),
      },
      async ({ DISABLED, CARDSTATUS, ...rest }) => {
        if (DISABLED !== undefined && CARDSTATUS !== undefined) {
          return clientGuardError('modify_credential accepts DISABLED or CARDSTATUS, not both, in the same call.');
        }
        return runNbapiTool(
          client,
          NBAPI_COMMANDS.MODIFY_CREDENTIAL,
          mergeParams({ ...rest, DISABLED, CARDSTATUS }),
          formatWriteSuccess
        );
      }
    );

    if (gate.destructiveEnabled) {
      server.tool(
        'remove_credential',
        'DESTRUCTIVE: Removes a credential from a person (wraps NBAPI RemoveCredential). Requires NETBOX_ENABLE_DESTRUCTIVE.',
        {
          PERSONID: z.string().describe('Required. The PERSONID owning the credential.'),
          CARDFORMAT: z.string().optional().describe('Optional. The card format of the credential to remove.'),
          ENCODEDNUM: z.string().optional().describe('Optional. The encoded card number identifying the credential.'),
          HOTSTAMP: z.string().optional().describe('Optional. The hot-stamp number identifying the credential.'),
          CREDENTIALID: z.string().optional().describe('Optional. Alternative credential identifier.'),
        },
        async ({ CREDENTIALID, ENCODEDNUM, HOTSTAMP, ...rest }) => {
          if (!CREDENTIALID && !ENCODEDNUM && !HOTSTAMP) {
            return clientGuardError('remove_credential requires CREDENTIALID, or at least one of ENCODEDNUM/HOTSTAMP.');
          }
          return runNbapiTool(
            client,
            NBAPI_COMMANDS.REMOVE_CREDENTIAL,
            mergeParams({ ...rest, CREDENTIALID, ENCODEDNUM, HOTSTAMP }),
            formatWriteSuccess
          );
        }
      );

      server.tool(
        'remove_person',
        'DESTRUCTIVE: Removes a person record (wraps NBAPI RemovePerson). Requires NETBOX_ENABLE_DESTRUCTIVE.',
        {
          PERSONID: z.string().describe('Required. The PERSONID of the person record to remove.'),
        },
        async ({ PERSONID }) =>
          runNbapiTool(client, NBAPI_COMMANDS.REMOVE_PERSON, { PERSONID }, formatWriteSuccess)
      );
    }
  }
}
