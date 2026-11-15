import type { LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config } from "./config";

export type Provider = "groq" | "google" | "local";

export interface ParsedSpec {
  provider: Provider;
  modelId: string;
}

export function parseSpec(spec: string): ParsedSpec {
  const i = spec.indexOf(":");
  const provider = spec.slice(0, i);
  const modelId = spec.slice(i + 1);
  if (i < 1 || !modelId || !["groq", "google", "local"].includes(provider)) {
    throw new Error(
      `Bad model spec "${spec}". Expected "groq:<id>", "google:<id>" or "local:<id>".`,
    );
  }
  return { provider: provider as Provider, modelId };
}

/** Which providers have credentials available (never returns the keys). */
export function providerAvailability(
  env: NodeJS.ProcessEnv = process.env,
): Record<Provider, boolean> {
  return {
    groq: Boolean(env.GROQ_API_KEY?.trim()),
    google: Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()),
    // A local server needs no key; assume reachable and let the call fail loudly.
    local: true,
  };
}

/**
 * The LLM port. A model is a "provider:id" string; swapping models is a
 * config change, never a code change.
 */
export function resolveModel(spec: string, cfg: Config): LanguageModel {
  const { provider, modelId } = parseSpec(spec);
  switch (provider) {
    case "groq":
      return createGroq({ apiKey: process.env.GROQ_API_KEY })(modelId);
    case "google":
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      })(modelId);
    case "local":
      return createOpenAICompatible({
        name: "local",
        baseURL: cfg.local.baseUrl,
        apiKey: cfg.local.apiKey,
      })(modelId);
  }
}
