/**
 * pi-omniroute-ext — Pi Coding Agent extension for the OmniRoute AI gateway.
 *
 * Factory responsibilities (see the internal architecture document §4):
 *  1. Register commands and the status tool immediately (Pi stays usable
 *     before OmniRoute is reachable — PRD FR-9).
 *  2. Seed the provider from the cached catalog when one exists (offline
 *     startup), then refresh against the live gateway. The factory waits for
 *     discovery only up to a short bound so startup model selection
 *     (`--model omniroute/...`) usually sees the catalog, while a slow or
 *     down gateway never blocks Pi (NFR-1). The fetch keeps running past the
 *     bound; no timers, watchers or processes are owned by the factory.
 *  3. Wire lifecycle events: notification bridge, routing telemetry (status
 *     line), session tagging (FR-11/FR-12).
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOmniRouteCommands } from "./commands.ts";
import { createRuntime } from "./runtime.ts";
import {
  clearNotifier,
  getConfig,
  getSessionTag,
  sessionTagHeader,
  setNotifier,
  setSessionTag,
} from "./state.ts";
import { recordFromHeaders } from "./telemetry.ts";
import { registerStatusTool } from "./tool.ts";
import { formatStatusLine } from "./ui.ts";

/** How long startup may wait for the first discovery before continuing. */
const STARTUP_DISCOVERY_WAIT_MS = 3000;

export default async function omnirouteExtension(pi: ExtensionAPI): Promise<void> {
  const runtime = createRuntime(pi);

  registerOmniRouteCommands(pi, runtime);
  registerStatusTool(pi, runtime);

  // Notification bridge — commands and background discovery share one channel.
  // Session tag (FR-12): one id per Pi session; kept across /reload restarts.
  pi.on("session_start", (event, ctx) => {
    setNotifier((message, type) => ctx.ui.notify(message, type));
    if (event.reason !== "reload" || !getSessionTag()) {
      const sid = ctx.sessionManager.getSessionId?.();
      setSessionTag(sid ? `pi-${sid}` : randomUUID());
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearNotifier();
    if (ctx.mode === "tui") {
      try {
        ctx.ui.setStatus("omniroute", undefined);
      } catch {
        // UI already gone.
      }
    }
  });

  // Session tagging (FR-12): inject X-OmniRoute-Session-Id into OmniRoute
  // requests only, and only when the opt-in toggle is on. This is Pi's
  // documented header-injection point and runs after auth headers assemble.
  pi.on("before_provider_headers", (event, ctx) => {
    if (!getConfig().config.sessionTag) return;
    const injected = sessionTagHeader(ctx.model?.provider, true);
    for (const [key, value] of Object.entries(injected)) {
      event.headers[key] = value;
    }
  });

  // Routing telemetry (FR-7) + status line (FR-11): X-OmniRoute-* headers on
  // every gateway response feed the ring buffer and the TUI footer.
  pi.on("after_provider_response", (event, ctx) => {
    const decision = recordFromHeaders(event.status, event.headers);
    if (!decision) return;
    if (ctx.mode === "tui" && getConfig().config.showTelemetry) {
      try {
        ctx.ui.setStatus("omniroute", formatStatusLine(decision));
      } catch {
        // Non-interactive UI — status line is optional decoration.
      }
    }
  });

  // Seed from the cached catalog (registers immediately when available) …
  runtime.rebuild();

  // … then refresh against the live gateway (FR-9: a down gateway never
  // blocks startup; discovery success/failure notifies once).
  const discovery = runtime.discover({ notify: true });
  const bound = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STARTUP_DISCOVERY_WAIT_MS);
    if (typeof timer.unref === "function") timer.unref();
  });
  await Promise.race([discovery, bound]);
}
