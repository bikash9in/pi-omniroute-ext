/**
 * Configuration for pi-omniroute-ext.
 *
 * Precedence: environment > ~/.pi/agent/omniroute-config.json > defaults.
 * The file only ever stores user-edited values; environment overrides are
 * applied on top at load time and never written back implicitly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WireApi = "openai-completions" | "anthropic-messages";

export const WIRE_APIS: readonly WireApi[] = ["openai-completions", "anthropic-messages"];

/**
 * Pi's OpenAI-compatible client throws when no API key resolves, even for
 * keyless local gateways. This placeholder satisfies the client; a keyless
 * OmniRoute ignores it, and an instance with REQUIRE_API_KEY=true answers 401
 * which we surface with actionable guidance.
 */
export const KEYLESS_PLACEHOLDER = "omni-local";

export interface OmniRouteConfig {
  version: 1;
  /** Gateway root, without the /v1 suffix. */
  baseUrl: string;
  api: WireApi;
  /** OmniRoute inference API key, or null for keyless instances. */
  apiKey: string | null;
  /** Manual reasoning/thinking-level toggle (PRD FR-6). */
  reasoning: boolean;
  /** Send X-OmniRoute-Session-Id per Pi session for cost attribution (PRD FR-12, opt-in). */
  sessionTag: boolean;
  dashboardUrl: string | null;
  showTelemetry: boolean;
}

export const DEFAULT_CONFIG: OmniRouteConfig = {
  version: 1,
  baseUrl: "http://localhost:20128",
  api: "openai-completions",
  apiKey: null,
  reasoning: false,
  sessionTag: false,
  dashboardUrl: null,
  showTelemetry: true,
};

/** Which fields an environment variable currently overrides. */
export interface EnvOverrides {
  baseUrl: boolean;
  api: boolean;
  apiKey: boolean;
  reasoning: boolean;
  sessionTag: boolean;
  dashboardUrl: boolean;
}

export interface LoadedConfig {
  config: OmniRouteConfig;
  overridden: EnvOverrides;
}

export type KeySource = "env" | "file" | "none";

export function agentDir(): string {
  const custom = process.env.PI_CODING_AGENT_DIR?.trim();
  return custom ? custom : join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return join(agentDir(), "omniroute-config.json");
}

export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return xdg ? join(xdg, "pi") : join(homedir(), ".cache", "pi");
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return undefined;
}

export function normalizeBaseUrl(raw: string): string {
  let url = (raw ?? "").trim();
  if (!url) return DEFAULT_CONFIG.baseUrl;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "");
}

export function isWireApi(value: unknown): value is WireApi {
  return typeof value === "string" && (WIRE_APIS as readonly string[]).includes(value);
}

/** Read the on-disk config file (tolerant of missing/corrupt files). */
export function loadFileConfig(): OmniRouteConfig {
  const base: OmniRouteConfig = { ...DEFAULT_CONFIG };
  try {
    const path = configPath();
    if (!existsSync(path)) return base;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<OmniRouteConfig> | null;
    if (!raw || typeof raw !== "object") return base;
    if (typeof raw.baseUrl === "string" && raw.baseUrl.trim()) base.baseUrl = normalizeBaseUrl(raw.baseUrl);
    if (isWireApi(raw.api)) base.api = raw.api;
    if (typeof raw.apiKey === "string" && raw.apiKey.trim()) base.apiKey = raw.apiKey.trim();
    if (typeof raw.reasoning === "boolean") base.reasoning = raw.reasoning;
    if (typeof raw.sessionTag === "boolean") base.sessionTag = raw.sessionTag;
    if (typeof raw.dashboardUrl === "string" && raw.dashboardUrl.trim()) {
      base.dashboardUrl = normalizeBaseUrl(raw.dashboardUrl);
    }
    if (typeof raw.showTelemetry === "boolean") base.showTelemetry = raw.showTelemetry;
  } catch {
    // Corrupt file → fall back to defaults; /omniroute-config can rewrite it.
  }
  return base;
}

/** Layer environment variables over a file config. */
export function applyEnv(file: OmniRouteConfig): LoadedConfig {
  const config: OmniRouteConfig = { ...file };
  const overridden: EnvOverrides = {
    baseUrl: false,
    api: false,
    apiKey: false,
    reasoning: false,
    sessionTag: false,
    dashboardUrl: false,
  };

  const envBase = process.env.OMNIROUTE_BASE_URL?.trim();
  if (envBase) {
    config.baseUrl = normalizeBaseUrl(envBase);
    overridden.baseUrl = true;
  }
  const envApi = process.env.OMNIROUTE_API?.trim();
  if (isWireApi(envApi)) {
    config.api = envApi;
    overridden.api = true;
  }
  const envKey = process.env.OMNIROUTE_API_KEY?.trim();
  if (envKey) {
    config.apiKey = envKey;
    overridden.apiKey = true;
  }
  const envReasoning = parseBool(process.env.OMNIROUTE_ENABLE_REASONING);
  if (envReasoning !== undefined) {
    config.reasoning = envReasoning;
    overridden.reasoning = true;
  }
  const envSessionTag = parseBool(process.env.OMNIROUTE_SESSION_TAG);
  if (envSessionTag !== undefined) {
    config.sessionTag = envSessionTag;
    overridden.sessionTag = true;
  }
  const envDash = process.env.OMNIROUTE_DASHBOARD_URL?.trim();
  if (envDash) {
    config.dashboardUrl = normalizeBaseUrl(envDash);
    overridden.dashboardUrl = true;
  }
  return { config, overridden };
}

export function loadConfig(): LoadedConfig {
  return applyEnv(loadFileConfig());
}

/** Merge a patch into the on-disk config (environment is NOT captured here). */
export function saveFileConfig(patch: Partial<OmniRouteConfig>): OmniRouteConfig {
  const next: OmniRouteConfig = { ...loadFileConfig(), ...patch, version: 1 };
  next.baseUrl = normalizeBaseUrl(next.baseUrl);
  if (next.dashboardUrl) next.dashboardUrl = normalizeBaseUrl(next.dashboardUrl);
  if (typeof next.apiKey === "string" && !next.apiKey.trim()) next.apiKey = null;
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** Normalized gateway root (no trailing slash). */
export function rootUrl(cfg: OmniRouteConfig): string {
  return normalizeBaseUrl(cfg.baseUrl);
}

/**
 * Base URL handed to Pi's API implementations:
 * - openai-completions: the OpenAI SDK appends /chat/completions → <root>/v1
 * - anthropic-messages: the Anthropic SDK appends /v1/messages → <root>
 */
export function apiBaseUrl(cfg: OmniRouteConfig): string {
  const root = rootUrl(cfg);
  return cfg.api === "anthropic-messages" ? root : `${root}/v1`;
}

export function apiKeySource(): KeySource {
  if (process.env.OMNIROUTE_API_KEY?.trim()) return "env";
  if (loadFileConfig().apiKey) return "file";
  return "none";
}

/** Key for our own fetches (discovery/probes) — resolved for real. */
export function resolveRawApiKey(cfg: OmniRouteConfig): string {
  const env = process.env.OMNIROUTE_API_KEY?.trim();
  if (env) return env;
  if (cfg.apiKey) return cfg.apiKey;
  return KEYLESS_PLACEHOLDER;
}

/**
 * Key reference for provider registration — env stays a live $OMNIROUTE_API_KEY
 * interpolation so changes apply without re-registration. Literal values that
 * start with "$" are escaped with "$$" per models.json syntax.
 */
export function providerApiKeyRef(cfg: OmniRouteConfig): string {
  if (process.env.OMNIROUTE_API_KEY?.trim()) return "$OMNIROUTE_API_KEY";
  if (cfg.apiKey) return cfg.apiKey.startsWith("$") ? `$$${cfg.apiKey}` : cfg.apiKey;
  return KEYLESS_PLACEHOLDER;
}

export function dashboardUrl(cfg: OmniRouteConfig): string {
  return cfg.dashboardUrl ?? rootUrl(cfg);
}
