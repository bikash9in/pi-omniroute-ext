/**
 * Routing telemetry from OmniRoute response headers (PRD FR-7).
 *
 * Captured via Pi's `after_provider_response` event. Only header values are
 * retained (strategy/provider/latency/cost) — never prompts or completions,
 * never credentials. The buffer holds the most recent decisions in memory;
 * it is ephemeral and excluded from model context.
 *
 * Headers consumed (see the internal OmniRoute-integration document §3):
 *   X-OmniRoute-Decision          strategy=…; provider=…; latency_ms=…
 *   X-OmniRoute-Model/-Provider   effective model/provider that served the turn
 *   X-OmniRoute-Response-Cost     USD cost of the turn
 *   X-OmniRoute-Tokens-In/-Out    token counts
 *   X-OmniRoute-Fallback-Attempts >0 means fallback fired
 *   X-OmniRoute-Version           gateway build
 */

export interface RoutingDecision {
  at: number;
  status: number;
  strategy?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  costUsd?: string;
  tokensIn?: number;
  tokensOut?: number;
  fallbackAttempts?: number;
  gatewayVersion?: string;
}

const MAX_DECISIONS = 10;
const buffer: RoutingDecision[] = [];

function toLowerMap(headers: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") map.set(key.toLowerCase(), value);
  }
  return map;
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Parse `strategy=a; provider=b; latency_ms=123` into an object. */
export function parseDecisionHeader(raw: string): { strategy?: string; provider?: string; latencyMs?: number } {
  const out: { strategy?: string; provider?: string; latencyMs?: number } = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "strategy") out.strategy = value;
    else if (key === "provider") out.provider = value;
    else if (key === "latency_ms") {
      const ms = parseNumber(value);
      if (ms !== undefined) out.latencyMs = ms;
    }
  }
  return out;
}

/**
 * Record telemetry from a response if OmniRoute headers are present.
 * Returns the recorded decision, or null when the response wasn't OmniRoute's.
 */
export function recordFromHeaders(status: number, headers: Record<string, string>): RoutingDecision | null {
  const h = toLowerMap(headers ?? {});
  const decision = h.get("x-omniroute-decision");
  const version = h.get("x-omniroute-version");
  const model = h.get("x-omniroute-model");
  if (!decision && !version && !model) return null;

  const record: RoutingDecision = {
    at: Date.now(),
    status,
    ...(decision ? parseDecisionHeader(decision) : {}),
    ...(model ? { model } : {}),
    ...(h.get("x-omniroute-provider") ? { provider: h.get("x-omniroute-provider") as string } : {}),
    ...(h.get("x-omniroute-response-cost") ? { costUsd: h.get("x-omniroute-response-cost") as string } : {}),
    ...(parseNumber(h.get("x-omniroute-tokens-in")) !== undefined
      ? { tokensIn: parseNumber(h.get("x-omniroute-tokens-in")) as number }
      : {}),
    ...(parseNumber(h.get("x-omniroute-tokens-out")) !== undefined
      ? { tokensOut: parseNumber(h.get("x-omniroute-tokens-out")) as number }
      : {}),
    ...(parseNumber(h.get("x-omniroute-fallback-attempts")) !== undefined
      ? { fallbackAttempts: parseNumber(h.get("x-omniroute-fallback-attempts")) as number }
      : {}),
    ...(version ? { gatewayVersion: version } : {}),
  };

  buffer.unshift(record);
  if (buffer.length > MAX_DECISIONS) buffer.length = MAX_DECISIONS;
  return record;
}

export function lastDecision(): RoutingDecision | undefined {
  return buffer[0];
}

export function recentDecisions(count = 3): RoutingDecision[] {
  return buffer.slice(0, Math.max(0, count));
}

export function clearDecisions(): void {
  buffer.length = 0;
}

/** One-line summary, e.g. `strategy=priority · provider=groq · latency=412ms · $0.0001230000`. */
export function formatDecision(d: RoutingDecision): string {
  const parts: string[] = [];
  if (d.strategy) parts.push(`strategy=${d.strategy}`);
  if (d.provider) parts.push(`provider=${d.provider}`);
  if (d.model) parts.push(`model=${d.model}`);
  if (d.latencyMs !== undefined) parts.push(`latency=${d.latencyMs}ms`);
  if (d.fallbackAttempts) parts.push(`fallbacks=${d.fallbackAttempts}`);
  if (d.costUsd !== undefined && d.costUsd !== "") parts.push(`$${d.costUsd}`);
  return parts.length > 0 ? parts.join(" · ") : `HTTP ${d.status}`;
}
