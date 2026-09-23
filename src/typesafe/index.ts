/**
 * TypeSafe AI integration module
 * 
 * Minimal skeleton for TypeSafe AI structured output via OpenRouter.
 * 
 * Usage:
 *   import { createTypeSafeClient, runTypeSafeQuery, noul, score } from "./typesafe";
 *   
 *   const client = createTypeSafeClient();
 *   const result = await runTypeSafeQuery(
 *     "Analyze this text",
 *     { relevant: noul("Is this relevant?") }
 *   );
 *   console.log(result.answers.relevant.noul);
 */

export {
  createTypeSafeClient,
  runTypeSafeQuery,
  noul,
  score,
  choice,
} from "./client.js";

export type {
  SystemOneRequest,
  Questions,
  SystemOneResult,
  EntryType,
  NoulQuestion,
  ScoreQuestion,
  ChoiceQuestion,
} from "./client.js";
