import type { GuideTopic } from './types.js';
import { accessModelTopic } from './accessModel.js';
import { unlockWindowsTopic } from './unlockWindows.js';
import { groupAndNameGotchasTopic } from './groupAndNameGotchas.js';
import { credentialsAndCardFormatsTopic } from './credentialsAndCardFormats.js';
import { apiQuirksTopic } from './apiQuirks.js';
import { writeSafetyTopic } from './writeSafety.js';

/**
 * The full `get_guide` knowledge base (R5), keyed exactly as R1(d)/R8 name
 * them as arguments to the `get_guide` tool: access-model, unlock-windows,
 * group-and-name-gotchas, credentials-and-card-formats, api-quirks,
 * write-safety.
 */
export const GUIDE_TOPICS: Record<string, GuideTopic> = {
  'access-model': accessModelTopic,
  'unlock-windows': unlockWindowsTopic,
  'group-and-name-gotchas': groupAndNameGotchasTopic,
  'credentials-and-card-formats': credentialsAndCardFormatsTopic,
  'api-quirks': apiQuirksTopic,
  'write-safety': writeSafetyTopic,
};
