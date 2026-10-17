/**
 * Shared runtime state: effective configuration, discovery/connection state
 * and the session notification bridge.
 *
 * The notifier is set from the `session_start` event so notifications work
 * whether discovery finishes before or after the session starts (Pi has no
 * global notify API — see ARCHITECTURE.md §5).
 */

import { loadConfig, type LoadedConfig } from "./config.ts";
import type { CatalogEntry } from "./discovery.ts";

export type Phase = "idle" | "discovering" | "connected" | "cached" | "error";

export interface DiscoveryState {
  phase: Phase;
  /** Whether provider id "omniroute" is currently registered. */
  registered: boolean;
  /** True when the serving catalog came from the local cache file. */
  fromCache: boolean;
  baseUrl: string;
  modelCount: number;
  comboCount: number;
  gatewayVersion?: string;
  /** Timestamp of the last successful catalog sync (live or cached restore). */
  lastSuccessAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  /** Raw catalog entries from the last successful sync (combos included). */
  entries: CatalogEntry[];
}

export interface AppState {
  config: LoadedConfig | null;
  discovery: DiscoveryState;
}

function freshDiscoveryState(): DiscoveryState {
  return {
    phase: "idle",
    registered: false,
    fromCache: false,
    baseUrl: "",
    modelCount: 0,
    comboCount: 0,
    entries: [],
  };
}

export const state: AppState = {
  config: null,
  discovery: freshDiscoveryState(),
};

export function getConfig(): LoadedConfig {
  if (!state.config) state.config = loadConfig();
  return state.config;
}

export function setConfig(loaded: LoadedConfig): void {
  state.config = loaded;
}

export interface ConnectedOptions {
  baseUrl: string;
  modelCount: number;
  comboCount: number;
  fromCache: boolean;
  gatewayVersion?: string;
  lastSuccessAt: number;
}

export function setConnected(opts: ConnectedOptions): void {
  const d = state.discovery;
  d.phase = opts.fromCache ? "cached" : "connected";
  d.registered = true;
  d.fromCache = opts.fromCache;
  d.baseUrl = opts.baseUrl;
  d.modelCount = opts.modelCount;
  d.comboCount = opts.comboCount;
  d.lastSuccessAt = opts.lastSuccessAt;
  if (opts.gatewayVersion) d.gatewayVersion = opts.gatewayVersion;
  d.lastError = undefined;
  d.lastErrorAt = undefined;
}

/** Record a discovery failure; a registered provider keeps serving its catalog. */
export function setDiscoveryError(message: string): void {
  const d = state.discovery;
  d.lastError = message;
  d.lastErrorAt = Date.now();
  d.phase = d.registered ? "cached" : "error";
}

export function setDiscovering(baseUrl: string): void {
  const d = state.discovery;
  d.phase = "discovering";
  d.baseUrl = baseUrl;
}

// ---------------------------------------------------------------------------
// Notification bridge
// ---------------------------------------------------------------------------

export type NotifyType = "info" | "warning" | "error";
export type NotifyFn = (message: string, type?: NotifyType) => void;

let notifier: NotifyFn | null = null;
let pending: { message: string; type: NotifyType } | null = null;
let sessionActive = false;

export function setNotifier(fn: NotifyFn): void {
  notifier = fn;
  sessionActive = true;
  if (pending) {
    const queued = pending;
    pending = null;
    try {
      fn(queued.message, queued.type);
    } catch {
      // UI gone — drop the queued notification.
    }
  }
}

export function clearNotifier(): void {
  notifier = null;
  sessionActive = false;
  pending = null;
}

/**
 * Notify the user if a session is active; otherwise queue for the next
 * `session_start` (startup discovery usually completes before it).
 */
export function notify(message: string, type: NotifyType = "info"): void {
  if (notifier) {
    try {
      notifier(message, type);
      return;
    } catch {
      notifier = null;
    }
  }
  if (sessionActive) return;
  pending = { message, type };
}

// ---------------------------------------------------------------------------
// Session tag (PRD FR-12): X-OmniRoute-Session-Id per Pi session
// ---------------------------------------------------------------------------

let sessionTag: string | undefined;

export function setSessionTag(tag: string): void {
  sessionTag = tag;
}

export function getSessionTag(): string | undefined {
  return sessionTag;
}

export function clearSessionTag(): void {
  sessionTag = undefined;
}

/**
 * Header injection for `before_provider_headers`: only OmniRoute requests get
 * the tag, and only when the opt-in toggle is on. Empty object otherwise so
 * callers can spread unconditionally.
 */
export function sessionTagHeader(provider: string | undefined, enabled: boolean): Record<string, string> {
  if (!enabled || provider !== "omniroute" || !sessionTag) return {};
  return { "X-OmniRoute-Session-Id": sessionTag };
}
