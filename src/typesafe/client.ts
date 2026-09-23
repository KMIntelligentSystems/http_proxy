/**
 * TypeSafe AI client wrapper for OpenRouter integration
 * 
 * This module provides a minimal TypeSafe AI SDK setup that connects
 * to OpenRouter for model access. The typesafe/jev-1.13 model (or ~typesafe/jev-latest)
 * is used for structured output generation.
 */

import { TypeSafeClient, noul, score, choice } from "@typesafe-ai/sdk";
import type { 
  SystemOneRequest, 
  Questions, 
  SystemOneResult,
  EntryType 
} from "@typesafe-ai/sdk";

// OpenRouter configuration
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = "typesafe/jev-1.13";  // or "~typesafe/jev-latest"

/**
 * Create a TypeSafe client configured for OpenRouter
 * 
 * Requires TYPESAFE_API_KEY in environment (your OpenRouter API key)
 * or pass apiKey explicitly.
 */
export function createTypeSafeClient(apiKey?: string): TypeSafeClient {
  const key = apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!key) {
    throw new Error(
      "TypeSafe API key required. Set TYPESAFE_API_KEY env var or pass apiKey."
    );
  }

  return new TypeSafeClient({
    apiKey: key,
    baseURL: process.env.TYPESAFE_BASE_URL ?? OPENROUTER_BASE_URL,
    defaultModel: process.env.TYPESAFE_DEFAULT_MODEL ?? OPENROUTER_MODEL,
    logLevel: (process.env.TYPESAFE_LOG_LEVEL as any) ?? "warn",
  });
}

/**
 * Run a structured TypeSafe AI query
 * 
 * @param state - Input text/state to evaluate
 * @param questions - Structured questions to answer
 * @param options - Optional client and request options
 */
export async function runTypeSafeQuery<const Q extends Questions>(
  state: EntryType,
  questions: Q,
  options?: {
    client?: TypeSafeClient;
    model?: string;
    signal?: AbortSignal;
  }
): Promise<SystemOneResult<Q>> {
  const client = options?.client ?? createTypeSafeClient();
  
  const request: SystemOneRequest<Q> = {
    state,
    questions,
    model: options?.model,
  };

  const result = await client.systemOne(request, {
    signal: options?.signal,
  });

  return result;
}

// Export question builders for convenience
export { noul, score, choice };

// Export types
export type {
  SystemOneRequest,
  Questions,
  SystemOneResult,
  EntryType,
  NoulQuestion,
  ScoreQuestion,
  ChoiceQuestion,
};
