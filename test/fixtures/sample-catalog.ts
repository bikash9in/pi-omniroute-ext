/**
 * Sample GET /v1/models catalog entries mirroring OmniRoute v3.8.52 output:
 * combos pinned first with `owned_by: "combo"`, provider-prefixed model ids,
 * capability metadata, and non-chat entries that must be filtered out.
 */

import type { CatalogEntry } from "../../src/discovery.ts";

export const SAMPLE_CATALOG: CatalogEntry[] = [
  // Built-in auto combo (advertised by OmniRoute with owned_by: "combo")
  {
    id: "auto",
    object: "model",
    owned_by: "combo",
    context_length: 200000,
    max_output_tokens: 8192,
    capabilities: { tool_calling: true, reasoning: true, vision: true },
    input_modalities: ["text", "image"],
  },
  // User combo with display name + description
  {
    id: "CheapFix",
    object: "model",
    owned_by: "combo",
    display_name: "Cheap",
    description: "Free-first priority fallback",
    context_length: 131072,
    max_output_tokens: 16384,
  },
  // Regular provider-prefixed model with full metadata
  {
    id: "glm/glm-5.2",
    object: "model",
    owned_by: "glm",
    context_length: 131072,
    max_output_tokens: 65536,
    capabilities: { reasoning: true, tool_calling: true },
    input_modalities: ["text"],
  },
  // Vision model flagged only through capabilities
  {
    id: "gemini/gemini-2.5-flash",
    object: "model",
    owned_by: "gemini",
    context_length: 1048576,
    max_output_tokens: 65536,
    capabilities: { vision: true },
  },
  // Model without any metadata → defaults (128000 / 4096)
  { id: "cc/claude-sonnet-4-6", object: "model", owned_by: "cc" },
  // Dual-catalog duplicate of glm — must be deduplicated
  { id: "glm/glm-5.2", object: "model", owned_by: "glm" },
  // Non-chat entries — must be filtered out
  { id: "whisper-1", object: "model", owned_by: "openai", type: "audio" },
  { id: "text-embedding-3-small", object: "model", owned_by: "openai", type: "embedding" },
  { id: "jina-reranker-v3", object: "model", owned_by: "jina", supported_endpoints: ["rerank"] },
];

/** Chat-eligible ids expected after normalization. */
export const EXPECTED_CHAT_IDS = ["auto", "CheapFix", "glm/glm-5.2", "gemini/gemini-2.5-flash", "cc/claude-sonnet-4-6"];
export const EXPECTED_COMBO_IDS = ["auto", "CheapFix"];
export const EXPECTED_MODEL_IDS = ["glm/glm-5.2", "gemini/gemini-2.5-flash", "cc/claude-sonnet-4-6"];
