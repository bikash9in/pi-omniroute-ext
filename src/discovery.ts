/**
 * OmniRoute catalog discovery (PRD FR-2, FR-5).
 *
 * GET /v1/models?prefix=alias → OpenAI list format with combos marked
 * `owned_by: "combo"` (verified against OmniRoute v3.8.52
 * src/app/api/v1/models/catalog.ts). Entries may carry:
 *   context_length, max_output_tokens, input_modalities, output_modalities,
 *   capabilities {tool_calling, reasoning, vision, …}, display_name, description
 * Pricing is NOT advertised — model costs register as 0; real cost comes from
 * the X-OmniRoute-* telemetry headers instead.
 *
 * Normalization is a pure function so it can be tested and re-run from the
 * local cache without network access (config/reasoning changes rebuild fast).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  cacheDir,
  resolveRawApiKey,
  rootUrl,
  type OmniRouteConfig,
  type WireApi,
} from "./config.ts";
import { setConnected, setDiscovering, state } from "./state.ts";

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_OUTPUT_TOKENS = 4096;
export const DISCOVERY_TIMEOUT_MS = 15000;

/** One entry of OmniRoute's GET /v1/models catalog (OpenAI list format + extras). */
export interface CatalogEntry {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  name?: string;
  display_name?: string;
  description?: string;
  /** Omitted or "chat" for chat models; e.g. "audio", "image", "embedding". */
  type?: string;
  context_length?: number;
  max_output_tokens?: number;
  max_input_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_endpoints?: string[];
  capabilities?: Record<string, unknown>;
  free?: boolean;
}

export interface FetchResult {
  entries: CatalogEntry[];
  gatewayVersion?: string;
  fetchedAt: number;
}

/** Chat-only view of Pi's provider model config (this extension registers chat models exclusively). */
export type OmniChatModel = Extract<ProviderModelConfig, { reasoning: boolean }>;

export interface NormalizedCatalog {
  models: OmniChatModel[];
  modelCount: number;
  comboCount: number;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function causeMessage(err: unknown): string {
  if (err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    if (typeof cause === "string") return cause;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeFetchError(err: unknown, root: string): Error {
  const detail = causeMessage(err);
  if (/timed out/i.test(detail)) {
    return new Error(`OmniRoute request to ${root} timed out after ${DISCOVERY_TIMEOUT_MS}ms.`);
  }
  return new Error(
    `Cannot reach OmniRoute at ${root} (${detail}). Is it running? ` +
      `Start it with "npx omniroute" or set OMNIROUTE_BASE_URL.`,
  );
}

function describeHttpError(status: number, root: string): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `OmniRoute rejected the API key (HTTP ${status}). Set OMNIROUTE_API_KEY or save a key with /omniroute-config.`,
    );
  }
  if (status === 404) {
    return new Error(`OmniRoute returned 404 for ${root}/v1/models — check that OMNIROUTE_BASE_URL points at the gateway.`);
  }
  return new Error(`OmniRoute GET /v1/models failed with HTTP ${status} at ${root}.`);
}

/** Fetch the catalog. Throws with an actionable message on any failure. */
export async function fetchCatalog(opts: {
  root: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onOuterAbort = () => controller.abort((opts.signal as AbortSignal | undefined)?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const url = `${opts.root}/v1/models?prefix=alias`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw describeFetchError(err, opts.root);
    }
    if (!res.ok) throw describeHttpError(res.status, opts.root);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(
        `OmniRoute at ${opts.root} did not return JSON for /v1/models — check that OMNIROUTE_BASE_URL is the gateway, not the dashboard HTML.`,
      );
    }
    const data =
      body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data)
        : null;
    if (!data) {
      throw new Error(`Unexpected response shape from ${opts.root}/v1/models (missing data array).`);
    }

    const entries: CatalogEntry[] = [];
    for (const raw of data) {
      if (raw && typeof raw === "object" && typeof (raw as CatalogEntry).id === "string") {
        entries.push(raw as CatalogEntry);
      }
    }
    return {
      entries,
      gatewayVersion: res.headers.get("x-omniroute-version") ?? undefined,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// Normalization (pure)
// ---------------------------------------------------------------------------

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function isCombo(entry: CatalogEntry): boolean {
  return entry.owned_by === "combo";
}

/** Chat models and combos only — embeddings/images/audio/etc. are filtered out. */
export function isChatEligible(entry: CatalogEntry): boolean {
  if (isCombo(entry)) return true;
  if (entry.type && entry.type !== "chat") return false;
  if (Array.isArray(entry.supported_endpoints) && !entry.supported_endpoints.includes("chat")) return false;
  return true;
}

function displayName(entry: CatalogEntry, combo: boolean): string {
  const display = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
  if (display) return display;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (name) return name;
  return combo ? `${entry.id} (combo)` : entry.id;
}

/**
 * Turn catalog entries into Pi provider model configs.
 * Metadata merge order (FR-5): router fields → cached metadata → defaults.
 */
export function normalizeCatalog(
  entries: readonly CatalogEntry[],
  cfg: OmniRouteConfig,
  metadata: MetadataMap,
): NormalizedCatalog {
  const seen = new Set<string>();
  const models: OmniChatModel[] = [];
  let comboCount = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    if (!isChatEligible(entry)) continue;
    seen.add(id);

    const combo = isCombo(entry);
    if (combo) comboCount += 1;

    const cached = metadata[id];
    const contextWindow =
      positiveNumber(entry.context_length) ??
      positiveNumber(cached?.contextWindow) ??
      DEFAULT_CONTEXT_WINDOW;
    const maxTokens =
      positiveNumber(entry.max_output_tokens) ??
      positiveNumber(cached?.maxOutputTokens) ??
      DEFAULT_OUTPUT_TOKENS;

    const imageInput = Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image");
    const vision = imageInput || entry.capabilities?.vision === true;

    models.push({
      id,
      name: displayName(entry, combo),
      input: vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // FR-6: reasoning is opt-in via the manual toggle. When enabled, models
      // map Pi thinking levels to OpenAI-style reasoning_effort with off→none;
      // low/medium/high/xhigh pass through (see pi-ai openai-completions).
      reasoning: cfg.reasoning,
      contextWindow,
      maxTokens,
      ...(cfg.reasoning ? { thinkingLevelMap: { off: "none", minimal: "low", max: "xhigh" } } : {}),
    });
  }

  return { models, modelCount: models.length - comboCount, comboCount };
}

// ---------------------------------------------------------------------------
// Metadata cache (~/.cache/pi/omniroute-model-metadata.json)
// ---------------------------------------------------------------------------

export interface MetadataEntry {
  contextWindow: number;
  maxOutputTokens: number;
  updatedAt: number;
}

export interface MetadataFile {
  version: 1;
  models: MetadataMap;
}

export interface MetadataMap {
  [id: string]: MetadataEntry | undefined;
}

const MAX_METADATA_ENTRIES = 1000;

export function metadataPath(): string {
  return join(cacheDir(), "omniroute-model-metadata.json");
}

export function readMetadataMap(): MetadataFile {
  try {
    const path = metadataPath();
    if (!existsSync(path)) return { version: 1, models: {} };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MetadataFile> | null;
    if (raw && typeof raw === "object" && raw.models && typeof raw.models === "object") {
      return { version: 1, models: raw.models as MetadataMap };
    }
  } catch {
    // Corrupt cache → rebuild from live data.
  }
  return { version: 1, models: {} };
}

/** Merge router-provided limits into the metadata map. Returns true if changed. */
export function updateMetadata(entries: readonly CatalogEntry[], file: MetadataFile): boolean {
  let changed = false;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !isChatEligible(entry)) continue;
    const contextWindow = positiveNumber(entry.context_length);
    const maxOutputTokens = positiveNumber(entry.max_output_tokens);
    if (contextWindow === undefined && maxOutputTokens === undefined) continue;
    const existing = file.models[entry.id];
    if (
      existing &&
      (contextWindow === undefined || existing.contextWindow === contextWindow) &&
      (maxOutputTokens === undefined || existing.maxOutputTokens === maxOutputTokens)
    ) {
      continue;
    }
    file.models[entry.id] = {
      contextWindow: contextWindow ?? existing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: maxOutputTokens ?? existing?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
      updatedAt: Date.now(),
    };
    changed = true;
  }

  const ids = Object.keys(file.models);
  if (ids.length > MAX_METADATA_ENTRIES) {
    ids
      .sort((a, b) => (file.models[a]?.updatedAt ?? 0) - (file.models[b]?.updatedAt ?? 0))
      .slice(0, ids.length - MAX_METADATA_ENTRIES)
      .forEach((id) => {
        delete file.models[id];
        changed = true;
      });
  }
  return changed;
}

export function writeMetadataFile(file: MetadataFile): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(metadataPath(), JSON.stringify(file, null, 2), { mode: 0o600 });
  } catch {
    // Cache is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Catalog cache (~/.cache/pi/omniroute-models.json)
// ---------------------------------------------------------------------------

export interface CatalogCacheFile {
  version: 1;
  baseUrl: string;
  api: WireApi;
  fetchedAt: number;
  gatewayVersion?: string;
  entries: CatalogEntry[];
}

export function catalogCachePath(): string {
  return join(cacheDir(), "omniroute-models.json");
}

/** Read the cached catalog; null when missing or written for another instance/api. */
export function readCatalogCache(cfg: OmniRouteConfig): CatalogCacheFile | null {
  try {
    const path = catalogCachePath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CatalogCacheFile> | null;
    if (!raw || typeof raw !== "object") return null;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) return null;
    if (raw.baseUrl !== rootUrl(cfg) || raw.api !== cfg.api) return null;
    const entries = raw.entries.filter(
      (entry): entry is CatalogEntry => Boolean(entry) && typeof (entry as CatalogEntry).id === "string",
    );
    return {
      version: 1,
      baseUrl: raw.baseUrl,
      api: raw.api,
      fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : 0,
      gatewayVersion: typeof raw.gatewayVersion === "string" ? raw.gatewayVersion : undefined,
      entries,
    };
  } catch {
    return null;
  }
}

export function writeCatalogCache(cfg: OmniRouteConfig, result: FetchResult): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const payload: CatalogCacheFile = {
      version: 1,
      baseUrl: rootUrl(cfg),
      api: cfg.api,
      fetchedAt: result.fetchedAt,
      gatewayVersion: result.gatewayVersion,
      entries: result.entries,
    };
    writeFileSync(catalogCachePath(), JSON.stringify(payload), { mode: 0o600 });
  } catch {
    // Cache is best-effort.
  }
}

// ---------------------------------------------------------------------------
// pullCatalog — fetch + normalize + persist + update state (one call)
// ---------------------------------------------------------------------------

export interface PullResult extends NormalizedCatalog {
  entries: CatalogEntry[];
  gatewayVersion?: string;
  fetchedAt: number;
}

export async function pullCatalog(cfg: OmniRouteConfig, signal?: AbortSignal): Promise<PullResult> {
  setDiscovering(rootUrl(cfg));
  const result = await fetchCatalog({ root: rootUrl(cfg), apiKey: resolveRawApiKey(cfg), signal });
  const normalized = normalizeCatalog(result.entries, cfg, readMetadataMap().models);
  if (normalized.models.length === 0) {
    throw new Error(
      "OmniRoute returned no chat models or combos. Connect at least one provider in the dashboard, then run /omniroute-reload.",
    );
  }

  const metadata = readMetadataMap();
  if (updateMetadata(result.entries, metadata)) writeMetadataFile(metadata);
  writeCatalogCache(cfg, result);

  setConnected({
    baseUrl: rootUrl(cfg),
    modelCount: normalized.modelCount,
    comboCount: normalized.comboCount,
    fromCache: false,
    gatewayVersion: result.gatewayVersion,
    lastSuccessAt: result.fetchedAt,
  });
  state.discovery.entries = result.entries;

  return {
    ...normalized,
    entries: result.entries,
    gatewayVersion: result.gatewayVersion,
    fetchedAt: result.fetchedAt,
  };
}

/** Restore connection state from a cache entry (offline rebuilds). */
export function restoreStateFromCache(cfg: OmniRouteConfig, cache: CatalogCacheFile, normalized: NormalizedCatalog): void {
  setConnected({
    baseUrl: rootUrl(cfg),
    modelCount: normalized.modelCount,
    comboCount: normalized.comboCount,
    fromCache: true,
    gatewayVersion: cache.gatewayVersion,
    lastSuccessAt: cache.fetchedAt,
  });
  state.discovery.entries = cache.entries;
}
