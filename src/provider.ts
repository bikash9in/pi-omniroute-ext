/**
 * Provider registration for OmniRoute (PRD FR-1, FR-9).
 *
 * Registers provider id "omniroute" with Pi's legacy configuration form and a
 * `refreshModels` implementation so Pi's own catalog refresh paths (startup
 * refresh, model-selector refresh) re-discover the gateway. Pi composes
 * models.json overrides above this registration; built-in providers are never
 * touched.
 */

import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { apiBaseUrl, loadConfig, providerApiKeyRef, rootUrl, type OmniRouteConfig } from "./config.ts";
import {
  normalizeCatalog,
  pullCatalog,
  readCatalogCache,
  readMetadataMap,
  restoreStateFromCache,
} from "./discovery.ts";
import { setConfig, setDiscoveryError, state } from "./state.ts";

export const PROVIDER_ID = "omniroute";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pi's own refresh path. Contract notes:
 * - `context.allowNetwork === false` (offline session init) → serve the cache.
 * - Network failure → serve the cache when present, otherwise retain the
 *   current list by returning undefined (the composer only replaces models
 *   when a list is returned — matching the native-provider "retain previous
 *   list on failure" contract).
 */
async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  const loaded = loadConfig();
  setConfig(loaded);
  const cfg = loaded.config;
  const cache = readCatalogCache(cfg);
  const metadata = readMetadataMap();

  if (!context.allowNetwork) {
    if (cache) {
      const normalized = normalizeCatalog(cache.entries, cfg, metadata.models);
      restoreStateFromCache(cfg, cache, normalized);
      return normalized.models;
    }
    return undefined as unknown as ProviderModelConfig[];
  }

  try {
    const pull = await pullCatalog(cfg, context.signal);
    return pull.models;
  } catch (err) {
    if (context.signal.aborted) return undefined as unknown as ProviderModelConfig[];
    setDiscoveryError(errorMessage(err));
    if (cache) {
      const normalized = normalizeCatalog(cache.entries, cfg, metadata.models);
      restoreStateFromCache(cfg, cache, normalized);
      return normalized.models;
    }
    return undefined as unknown as ProviderModelConfig[];
  }
}

export function buildProviderConfig(cfg: OmniRouteConfig, models: ProviderModelConfig[]): ProviderConfig {
  const config: ProviderConfig = {
    name: "OmniRoute",
    baseUrl: apiBaseUrl(cfg),
    apiKey: providerApiKeyRef(cfg),
    api: cfg.api,
    models,
    refreshModels: refreshModels as NonNullable<ProviderConfig["refreshModels"]>,
  };
  // Readable defaults for the status UI (never used for requests).
  state.discovery.baseUrl = rootUrl(cfg);
  return config;
}
