/**
 * Runtime orchestration: discovery, cache rebuilds, config persistence and
 * reachability probes. Created once per extension load in index.ts and handed
 * to the commands and the status tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyEnv,
  loadConfig,
  rootUrl,
  saveFileConfig,
  type LoadedConfig,
  type OmniRouteConfig,
} from "./config.ts";
import { normalizeCatalog, pullCatalog, readCatalogCache, readMetadataMap, restoreStateFromCache } from "./discovery.ts";
import { buildProviderConfig, PROVIDER_ID } from "./provider.ts";
import { getConfig, notify, setConfig, setDiscovering, setDiscoveryError, state } from "./state.ts";

export type DiscoverOutcome =
  | { ok: true; modelCount: number; comboCount: number; source: "live" }
  | { ok: false; error: string; registered: boolean };

export interface Runtime {
  /** Effective configuration (env > file > default). */
  config(): LoadedConfig;
  /** Persist edits to the config file and reload the effective config. */
  saveConfig(patch: Partial<OmniRouteConfig>): LoadedConfig;
  /** Fetch the live catalog and (re)register the provider. Deduplicates concurrent calls. */
  discover(opts?: { notify?: boolean }): Promise<DiscoverOutcome>;
  /** Re-register from the cached catalog with the current config. False when no cache. */
  rebuild(): boolean;
  /** Cheap liveness probe (HEAD /v1/models, no auth required). */
  probe(timeoutMs?: number): Promise<boolean>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createRuntime(pi: ExtensionAPI): Runtime {
  let inflight: Promise<DiscoverOutcome> | null = null;

  async function discover(opts?: { notify?: boolean }): Promise<DiscoverOutcome> {
    if (inflight) return inflight;
    const shouldNotify = opts?.notify ?? false;

    const loaded = loadConfig();
    setConfig(loaded);
    const cfg = loaded.config;
    setDiscovering(rootUrl(cfg));

    inflight = (async (): Promise<DiscoverOutcome> => {
      try {
        const pull = await pullCatalog(cfg);
        pi.registerProvider(PROVIDER_ID, buildProviderConfig(cfg, pull.models));
        state.discovery.registered = true;
        if (shouldNotify) {
          notify(`OmniRoute connected — ${pull.modelCount} models, ${pull.comboCount} combos`, "info");
        }
        return { ok: true, modelCount: pull.modelCount, comboCount: pull.comboCount, source: "live" };
      } catch (err) {
        const error = messageOf(err);
        setDiscoveryError(error);
        if (shouldNotify) {
          if (state.discovery.registered) {
            notify(
              `OmniRoute unreachable at ${cfg.baseUrl} — serving the cached catalog ` +
                `(${state.discovery.modelCount} models, ${state.discovery.comboCount} combos). ${error}`,
              "warning",
            );
          } else {
            notify(`OmniRoute not connected: ${error}`, "warning");
          }
        }
        return { ok: false, error, registered: state.discovery.registered };
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  function rebuild(): boolean {
    const loaded = loadConfig();
    setConfig(loaded);
    const cfg = loaded.config;
    const cache = readCatalogCache(cfg);
    if (!cache) return false;
    const normalized = normalizeCatalog(cache.entries, cfg, readMetadataMap().models);
    if (normalized.models.length === 0) return false;

    pi.registerProvider(PROVIDER_ID, buildProviderConfig(cfg, normalized.models));
    restoreStateFromCache(cfg, cache, normalized);
    state.discovery.registered = true;
    return true;
  }

  function saveConfig(patch: Partial<OmniRouteConfig>): LoadedConfig {
    const file = saveFileConfig(patch);
    const loaded = applyEnv(file);
    setConfig(loaded);
    return loaded;
  }

  async function probe(timeoutMs = 4000): Promise<boolean> {
    const cfg = getConfig().config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      const res = await fetch(`${rootUrl(cfg)}/v1/models`, { method: "HEAD", signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return { config: () => getConfig(), saveConfig, discover, rebuild, probe };
}
