/**
 * `omniroute_status` — read-only, LLM-callable gateway status (PRD FR-8).
 * Never exposes credentials: the API key is reported only as configured/not-set.
 */

import { Type, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.ts";
import { buildStatusSummary, formatStatus, type StatusSummary } from "./ui.ts";

const StatusSchema = Type.Object({
  phase: Type.String(),
  reachable: Type.Boolean(),
  baseUrl: Type.String(),
  api: Type.String(),
  keyConfigured: Type.Boolean(),
  keySource: Type.String(),
  registered: Type.Boolean(),
  modelCount: Type.Integer(),
  comboCount: Type.Integer(),
  fromCache: Type.Boolean(),
  reasoning: Type.Boolean(),
  gatewayVersion: Type.Optional(Type.String()),
  lastSuccessAt: Type.Optional(Type.Number()),
  lastError: Type.Optional(Type.String()),
  activeModel: Type.Optional(Type.String()),
  lastDecision: Type.Optional(Type.String()),
  sessionTag: Type.Optional(Type.String()),
});

export function registerStatusTool(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerTool(
    defineTool({
      name: "omniroute_status",
      label: "OmniRoute status",
      description:
        "Report the OmniRoute AI gateway state: reachability, configured base URL and wire API, discovered " +
        "model/combo counts, registration status and the last routing decision (strategy/provider/latency). " +
        "Read-only; never returns credentials.",
      promptSnippet: "Check OmniRoute gateway status and model catalog",
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: StatusSchema,
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const probeOk = await runtime.probe();
        const summary: StatusSummary = buildStatusSummary(runtime.config(), probeOk, ctx.model);
        // structuredContent must be JSON-safe: drop undefined optional fields.
        const structured: JsonObject = {};
        for (const [key, value] of Object.entries(summary)) {
          if (value !== undefined) structured[key] = value as JsonValue;
        }
        return {
          content: [{ type: "text", text: formatStatus(summary) }],
          details: summary,
          structuredContent: structured,
        };
      },
    }),
  );
}
