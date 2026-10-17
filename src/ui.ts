/**
 * Formatting helpers shared by the commands and the status tool.
 * Terminal-only dialogs are guarded by callers via `ctx.hasUI`.
 */

import type { CatalogEntry } from "./discovery.ts";
import { isCombo } from "./discovery.ts";
import { configPath, rootUrl, type KeySource, type LoadedConfig } from "./config.ts";
import { PROVIDER_ID } from "./provider.ts";
import { formatDecision, lastDecision, type RoutingDecision } from "./telemetry.ts";
import { state, getSessionTag } from "./state.ts";

export interface StatusSummary {
  phase: string;
  reachable: boolean;
  baseUrl: string;
  api: string;
  keyConfigured: boolean;
  keySource: KeySource;
  registered: boolean;
  modelCount: number;
  comboCount: number;
  fromCache: boolean;
  reasoning: boolean;
  gatewayVersion?: string;
  lastSuccessAt?: number;
  lastError?: string;
  activeModel?: string;
  lastDecision?: string;
  sessionTag?: string;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function modelLabel(model: { provider: string; id: string } | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

export function buildStatusSummary(
  loaded: LoadedConfig,
  probeOk: boolean,
  activeModel?: { provider: string; id: string },
): StatusSummary {
  const d = state.discovery;
  const keySource: KeySource = loaded.overridden.apiKey ? "env" : loaded.config.apiKey ? "file" : "none";
  const decision = lastDecision();
  return {
    phase: d.phase,
    reachable: probeOk,
    baseUrl: rootUrl(loaded.config),
    api: loaded.config.api,
    keyConfigured: keySource !== "none",
    keySource,
    registered: d.registered,
    modelCount: d.modelCount,
    comboCount: d.comboCount,
    fromCache: d.fromCache,
    reasoning: loaded.config.reasoning,
    gatewayVersion: d.gatewayVersion,
    lastSuccessAt: d.lastSuccessAt,
    lastError: d.lastError,
    activeModel: modelLabel(activeModel),
    lastDecision:
      decision && loaded.config.showTelemetry ? `${formatDecision(decision)} · ${formatRelativeTime(decision.at)}` : undefined,
    sessionTag: loaded.config.sessionTag ? getSessionTag() : undefined,
  };
}

/** Compact footer line for the status bar (FR-11). */
export function formatStatusLine(d: RoutingDecision): string {
  const parts: string[] = ["OmniRoute"];
  parts.push(d.provider ?? "?");
  if (d.strategy && d.strategy !== "single") parts.push(d.strategy);
  if (d.latencyMs !== undefined) parts.push(`${d.latencyMs}ms`);
  if (d.fallbackAttempts) parts.push(`fb×${d.fallbackAttempts}`);
  return parts.join(" · ");
}

function phaseLabel(s: StatusSummary): string {
  switch (s.phase) {
    case "connected":
      return "connected (live catalog)";
    case "cached":
      return "serving cached catalog";
    case "discovering":
      return "discovering…";
    case "error":
      return "error (not connected)";
    default:
      return "idle";
  }
}

export function formatStatus(s: StatusSummary): string {
  const lines: string[] = [];
  lines.push("OmniRoute status");
  lines.push(`  Gateway        ${s.reachable ? "reachable" : "unreachable"}${s.gatewayVersion ? ` (${s.gatewayVersion})` : ""}`);
  lines.push(`  Base URL       ${s.baseUrl}`);
  lines.push(`  Wire API       ${s.api}`);
  lines.push(`  API key        ${s.keyConfigured ? `configured (${s.keySource})` : "not set (keyless instance)"}`);
  lines.push(`  Provider       ${s.registered ? `registered as "${PROVIDER_ID}"` : "not registered"}`);
  const synced = s.lastSuccessAt ? ` · synced ${formatRelativeTime(s.lastSuccessAt)}` : "";
  lines.push(`  Catalog        ${s.modelCount} models · ${s.comboCount} combos${synced}`);
  lines.push(`  Phase          ${phaseLabel(s)}`);
  lines.push(`  Reasoning      ${s.reasoning ? "on" : "off"}`);
  lines.push(`  Session tag    ${s.sessionTag ? `on (${s.sessionTag})` : "off"}`);
  if (s.activeModel) lines.push(`  Active model   ${s.activeModel}`);
  if (s.lastError) lines.push(`  Last error     ${s.lastError}`);
  if (s.lastDecision) lines.push(`  Last routing   ${s.lastDecision}`);
  if (!s.reachable) {
    lines.push("  Hint           Start OmniRoute (npx omniroute) or set OMNIROUTE_BASE_URL, then /omniroute-reload.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Catalog browsing
// ---------------------------------------------------------------------------

export interface ModelOptions {
  options: string[];
  ids: Map<string, string>;
}

/** Picker rows: combos first (OmniRoute pins them first server-side too). */
export function buildModelOptions(entries: readonly CatalogEntry[]): ModelOptions {
  const combos = entries.filter((entry) => isCombo(entry));
  const models = entries.filter((entry) => !isCombo(entry));
  const options: string[] = [];
  const ids = new Map<string, string>();
  for (const entry of [...combos, ...models]) {
    const combo = isCombo(entry);
    const display = typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : "";
    const label = combo ? (display ? `${entry.id}  ·  ${display}` : `${entry.id}  (combo)`) : entry.id;
    if (ids.has(label)) continue;
    ids.set(label, entry.id);
    options.push(label);
  }
  return { options, ids };
}

export function formatModelList(entries: readonly CatalogEntry[], limit = 40): string {
  const combos = entries.filter((entry) => isCombo(entry));
  const models = entries.filter((entry) => !isCombo(entry));
  const lines: string[] = [];
  const slice = <T>(list: T[]): T[] => list.slice(0, limit);
  if (combos.length > 0) {
    lines.push("Combos:");
    slice(combos).forEach((entry) => lines.push(`  ${entry.id}`));
    if (combos.length > limit) lines.push(`  … and ${combos.length - limit} more`);
  }
  if (models.length > 0) {
    lines.push("Models:");
    slice(models).forEach((entry) => lines.push(`  ${entry.id}`));
    if (models.length > limit) lines.push(`  … and ${models.length - limit} more`);
  }
  return lines.join("\n");
}

export function formatComboDetail(entry: CatalogEntry): string {
  const lines: string[] = [];
  lines.push(`Combo: ${entry.id}`);
  const display = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
  if (display && display !== entry.id) lines.push(`  Display name  ${display}`);
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  if (description) lines.push(`  Description   ${description}`);
  if (typeof entry.context_length === "number") lines.push(`  Context       ${entry.context_length.toLocaleString("en-US")} tokens`);
  if (typeof entry.max_output_tokens === "number") lines.push(`  Max output    ${entry.max_output_tokens.toLocaleString("en-US")} tokens`);
  if (Array.isArray(entry.input_modalities) && entry.input_modalities.length > 0) {
    lines.push(`  Input         ${entry.input_modalities.join(", ")}`);
  }
  const caps = entry.capabilities;
  if (caps && typeof caps === "object") {
    const active = Object.entries(caps)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    if (active.length > 0) lines.push(`  Capabilities  ${active.join(", ")}`);
  }
  lines.push("  Select it with /omniroute-models or /model omniroute/<id>.");
  lines.push("  Routing strategy/steps live in the OmniRoute dashboard (management API).");
  return lines.join("\n");
}

export function formatConfigView(loaded: LoadedConfig): string {
  const c = loaded.config;
  const o = loaded.overridden;
  const lines: string[] = [];
  lines.push("OmniRoute configuration");
  lines.push(`  Base URL    ${c.baseUrl}${o.baseUrl ? "  [set by OMNIROUTE_BASE_URL]" : ""}`);
  lines.push(`  Wire API    ${c.api}${o.api ? "  [set by OMNIROUTE_API]" : ""}`);
  lines.push(
    `  API key     ${c.apiKey ? "configured" : "not set (keyless)"}${o.apiKey ? "  [set by OMNIROUTE_API_KEY]" : ""}`,
  );
  lines.push(`  Reasoning   ${c.reasoning ? "on" : "off"}${o.reasoning ? "  [set by env]" : ""}`);
  lines.push(`  Session tag ${c.sessionTag ? "on" : "off"}${o.sessionTag ? "  [set by env]" : ""}`);
  lines.push(`  Telemetry   ${c.showTelemetry ? "on" : "off"}`);
  lines.push(`  Dashboard   ${c.dashboardUrl ?? "default (base URL)"}`);
  lines.push(`  Config file ${configPath()}`);
  lines.push("Run /omniroute-config in an interactive session to change these.");
  return lines.join("\n");
}
