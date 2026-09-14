import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

// SearchPersonData supports UDF1-UDF20 as search filters (per the Command
// reference). Generated rather than hand-typed twenty times over.
const udfSearchFields: Record<string, z.ZodOptional<z.ZodString>> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return [`UDF${n}`, z.string().optional().describe(`Optional. Search filter on user-defined field UDF${n}.`)];
  })
);

/**
 * Person/credential tools: GetPerson, SearchPersonData, GetCardAccessDetails,
 * GetCardFormats. Each is a thin pass-through of that NBAPI command's
 * documented PARAMS and response fields — the tool returns the full response
 * payload as JSON, without reshaping it. Field names below are copied
 * verbatim from the spec's "Command reference (verified against the primary
 * source)" section.
 */
export function registerPersonTools(server: McpServer, client: NetboxClient): void {
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
      'Identifies the card by ENCODEDNUM + CARDFORMAT, not PERSONID — GetCardAccessDetails has no PERSONID parameter.',
    {
      ENCODEDNUM: z.string().describe('Required. The encoded card number whose access details should be retrieved.'),
      CARDFORMAT: z.string().describe('Required. The card format of ENCODEDNUM.'),
      MAXRECORDS: z.string().optional().describe('Optional. Maximum number of access records to return.'),
      OLDESTDTTM: z.string().optional().describe('Optional. Oldest date/time to include in the returned access records.'),
    },
    async ({ ENCODEDNUM, CARDFORMAT, MAXRECORDS, OLDESTDTTM }) =>
      runNbapiTool(
        client,
        NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS,
        mergeParams({ ENCODEDNUM, CARDFORMAT, MAXRECORDS, OLDESTDTTM })
      )
  );

  server.tool(
    'get_card_formats',
    'Returns the card formats configured on the NetBox system (wraps NBAPI GetCardFormats). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_CARD_FORMATS, {})
  );
}
