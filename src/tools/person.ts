import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetboxClient } from '../netboxClient.js';
import { NBAPI_COMMANDS } from '../commands.js';
import { runNbapiTool, mergeParams } from '../toolHelpers.js';

/**
 * Person/credential tools: GetPerson, SearchPersonData, GetCardAccessDetails,
 * GetCardFormats. Each is a thin pass-through of that NBAPI command's
 * documented PARAMS and response fields — the tool returns the full response
 * payload as JSON, without reshaping it.
 */
export function registerPersonTools(server: McpServer, client: NetboxClient): void {
  server.tool(
    'get_person',
    'Returns the full person record for a given PERSONID (wraps NBAPI GetPerson).',
    {
      PERSONID: z.string().describe('Required. The unique PERSONID of the person record to retrieve.'),
    },
    async ({ PERSONID }) => runNbapiTool(client, NBAPI_COMMANDS.GET_PERSON, { PERSONID })
  );

  server.tool(
    'search_person_data',
    'Searches for person records matching the given criteria (wraps NBAPI SearchPersonData). ' +
      'Common fields (FIRSTNAME, LASTNAME) are modeled explicitly; any other documented ' +
      'SearchPersonData search field can be supplied via extraParams.',
    {
      FIRSTNAME: z.string().optional().describe('Optional. Match on the person\'s first name.'),
      LASTNAME: z.string().optional().describe('Optional. Match on the person\'s last name.'),
      PERSONID: z.string().optional().describe('Optional. Match on a specific PERSONID.'),
      extraParams: z
        .record(z.string())
        .optional()
        .describe(
          'Optional. Additional NBAPI SearchPersonData PARAMS fields (per the Command Reference) not ' +
            'covered above, as {"FIELDNAME": "value"} pairs passed through verbatim.'
        ),
    },
    async ({ FIRSTNAME, LASTNAME, PERSONID, extraParams }) =>
      runNbapiTool(
        client,
        NBAPI_COMMANDS.SEARCH_PERSON_DATA,
        mergeParams({ FIRSTNAME, LASTNAME, PERSONID }, extraParams)
      )
  );

  server.tool(
    'get_card_access_details',
    'Returns credential/card details and assigned access for a given PERSONID (wraps NBAPI GetCardAccessDetails).',
    {
      PERSONID: z.string().describe('Required. The PERSONID whose card/credential details should be retrieved.'),
    },
    async ({ PERSONID }) => runNbapiTool(client, NBAPI_COMMANDS.GET_CARD_ACCESS_DETAILS, { PERSONID })
  );

  server.tool(
    'get_card_formats',
    'Returns the card formats configured on the NetBox system (wraps NBAPI GetCardFormats). No parameters required.',
    {},
    async () => runNbapiTool(client, NBAPI_COMMANDS.GET_CARD_FORMATS, {})
  );
}
