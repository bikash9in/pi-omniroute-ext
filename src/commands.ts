/**
 * The six /omniroute-* commands (PRD FR-4).
 *
 * Every command works in JSON/print modes too: interactive dialogs are gated
 * on `ctx.hasUI` and fall back to plain text output.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { WIRE_APIS, normalizeBaseUrl, type OmniRouteConfig, type WireApi } from "./config.ts";
import { isCombo, type CatalogEntry } from "./discovery.ts";
import type { Runtime } from "./runtime.ts";
import { state } from "./state.ts";
import {
  buildModelOptions,
  buildStatusSummary,
  formatComboDetail,
  formatConfigView,
  formatModelList,
  formatStatus,
} from "./ui.ts";

const NO_UI_HINT = "Interactive menus need a terminal session — showing text instead.";

function splitEntries(): { combos: CatalogEntry[]; models: CatalogEntry[] } {
  const combos = state.discovery.entries.filter((entry) => isCombo(entry));
  const models = state.discovery.entries.filter((entry) => !isCombo(entry));
  return { combos, models };
}

export function registerOmniRouteCommands(pi: ExtensionAPI, runtime: Runtime): void {
  const selectModel = async (id: string, ctx: ExtensionCommandContext): Promise<void> => {
    const model = ctx.modelRegistry.find("omniroute", id);
    if (!model) {
      ctx.ui.notify(`Model "${id}" is not registered — run /omniroute-reload.`, "warning");
      return;
    }
    const ok = await pi.setModel(model);
    if (ok) ctx.ui.notify(`Model set → omniroute/${id}`, "info");
    else {
      ctx.ui.notify(
        `Selected omniroute/${id}, but authentication is not configured. Set OMNIROUTE_API_KEY or use /omniroute-config.`,
        "warning",
      );
    }
  };

  // -------------------------------------------------------------------------
  // /omniroute-status
  // -------------------------------------------------------------------------
  pi.registerCommand("omniroute-status", {
    description: "OmniRoute gateway status: connection, catalog counts, last routing decision",
    handler: async (_args, ctx) => {
      const probeOk = await runtime.probe();
      const summary = buildStatusSummary(runtime.config(), probeOk, ctx.model);
      ctx.ui.notify(formatStatus(summary), probeOk ? "info" : "warning");
    },
  });

  // -------------------------------------------------------------------------
  // /omniroute-models [id]
  // -------------------------------------------------------------------------
  pi.registerCommand("omniroute-models", {
    description: "Browse and select OmniRoute models and combos (pass an id to select directly)",
    getArgumentCompletions: (prefix) => {
      const matches = state.discovery.entries
        .filter((entry) => entry.id.startsWith(prefix))
        .slice(0, 200)
        .map((entry) => ({ value: entry.id, label: isCombo(entry) ? `${entry.id} (combo)` : entry.id }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      if (state.discovery.entries.length === 0) {
        const outcome = await runtime.discover();
        if (!outcome.ok && state.discovery.entries.length === 0) {
          ctx.ui.notify(`No OmniRoute models yet: ${outcome.error}`, "error");
          return;
        }
      }
      const entries = state.discovery.entries;

      const wanted = args.trim();
      if (wanted) {
        await selectModel(wanted, ctx);
        return;
      }

      const { options, ids } = buildModelOptions(entries);

      if (!ctx.hasUI) {
        ctx.ui.notify(`${NO_UI_HINT}\n${formatModelList(entries)}\n\nSelect with: /omniroute-models <id>`, "info");
        return;
      }

      const picked = await ctx.ui.select(
        `OmniRoute catalog — ${state.discovery.modelCount} models, ${state.discovery.comboCount} combos`,
        options,
      );
      if (!picked) return;
      const id = ids.get(picked) ?? picked;
      await selectModel(id, ctx);
    },
  });

  // -------------------------------------------------------------------------
  // /omniroute-combos
  // -------------------------------------------------------------------------
  pi.registerCommand("omniroute-combos", {
    description: "List OmniRoute combos and show their catalog detail",
    handler: async (_args, ctx) => {
      if (state.discovery.entries.length === 0) {
        const outcome = await runtime.discover();
        if (!outcome.ok && state.discovery.entries.length === 0) {
          ctx.ui.notify(`No combos discovered: ${outcome.error}`, "error");
          return;
        }
      }
      const { combos } = splitEntries();
      if (combos.length === 0) {
        ctx.ui.notify(
          "No combos discovered.\n" +
            "Create one in the OmniRoute dashboard; auto/* channels appear automatically when auto-routing is enabled.\n" +
            "Then run /omniroute-reload.",
          "warning",
        );
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          `OmniRoute combos (${combos.length}):\n` +
            combos.map((entry) => `  ${entry.id}`).join("\n") +
            "\nRun interactively for details.",
          "info",
        );
        return;
      }

      const { options, ids } = buildModelOptions(combos);
      const picked = await ctx.ui.select(`OmniRoute combos (${combos.length})`, options);
      if (!picked) return;
      const id = ids.get(picked) ?? picked;
      const entry = combos.find((candidate) => candidate.id === id);
      if (entry) ctx.ui.notify(formatComboDetail(entry), "info");
    },
  });

  // -------------------------------------------------------------------------
  // /omniroute-reasoning [on|off]
  // -------------------------------------------------------------------------
  pi.registerCommand("omniroute-reasoning", {
    description: "Enable or disable Pi thinking levels for OmniRoute models (sends reasoning_effort)",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off"].filter((value) => value.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim().toLowerCase();
      let enable: boolean | undefined;
      if (["on", "enable", "true"].includes(raw)) enable = true;
      else if (["off", "disable", "false"].includes(raw)) enable = false;
      else if (ctx.hasUI) {
        const picked = await ctx.ui.select("OmniRoute reasoning / thinking levels", [
          "Enable thinking levels",
          "Disable thinking levels",
        ]);
        if (!picked) return;
        enable = picked.startsWith("Enable");
      }

      if (enable === undefined) {
        ctx.ui.notify(
          `Reasoning is currently ${runtime.config().config.reasoning ? "on" : "off"}.\nUsage: /omniroute-reasoning on|off`,
          "info",
        );
        return;
      }

      runtime.saveConfig({ reasoning: enable });
      const rebuilt = runtime.rebuild();
      void runtime.discover();
      ctx.ui.notify(
        enable
          ? "Reasoning enabled — OmniRoute models accept Pi thinking levels (Shift+Tab, --thinking, or a :high suffix)." +
              (rebuilt ? "" : "\nNo cached catalog yet; models refresh after /omniroute-reload.")
          : "Reasoning disabled — thinking levels are clamped off for OmniRoute models.",
        "info",
      );
    },
  });

  // -------------------------------------------------------------------------
  // /omniroute-reload
  // -------------------------------------------------------------------------
  pi.registerCommand("omniroute-reload", {
    description: "Re-discover models and combos from a running OmniRoute",
    handler: async (_args, ctx) => {
      const outcome = await runtime.discover();
      if (outcome.ok) {
        ctx.ui.notify(
          `OmniRoute reloaded — ${outcome.modelCount} models, ${outcome.comboCount} combos (live catalog).`,
          "info",
        );
      } else {
        ctx.ui.notify(`OmniRoute reload failed: ${outcome.error}`, "error");
      }
    },
  });

  // -------------------------------------------------------------------------
  // /omniroute-config
  // -------------------------------------------------------------------------
  pi.registerCommand("omniroute-config", {
    description: "Configure the OmniRoute connection (base URL, API key, wire API, reasoning, telemetry)",
    handler: async (_args, ctx) => {
      const start = runtime.config();
      if (!ctx.hasUI) {
        ctx.ui.notify(`${NO_UI_HINT}\n${formatConfigView(start)}`, "info");
        return;
      }

      const draft: OmniRouteConfig = { ...start.config };
      let dirty = false;
      let editing = true;

      while (editing) {
        const o = runtime.config().overridden;
        const choice = await ctx.ui.select("OmniRoute configuration", [
          `Base URL: ${draft.baseUrl}${o.baseUrl ? "  [env]" : ""}`,
          `Wire API: ${draft.api}${o.api ? "  [env]" : ""}`,
          `API key: ${draft.apiKey ? "configured" : "not set (keyless)"}${o.apiKey ? "  [env]" : ""}`,
          `Reasoning: ${draft.reasoning ? "on" : "off"}   Telemetry: ${draft.showTelemetry ? "on" : "off"}`,
          `Session tagging: ${draft.sessionTag ? "on" : "off"}`,
          "Change base URL…",
          "Set API key…",
          "Clear API key",
          "Switch wire API…",
          "Toggle reasoning",
          "Toggle telemetry",
          "Toggle session tagging",
          "Reload catalog now",
          "Save & close",
          "Discard changes",
        ]);
        if (!choice) return;

        switch (choice) {
          case "Change base URL…": {
            const input = await ctx.ui.input("OmniRoute base URL", draft.baseUrl);
            if (input && input.trim()) {
              draft.baseUrl = normalizeBaseUrl(input);
              dirty = true;
            }
            break;
          }
          case "Set API key…": {
            const input = await ctx.ui.input("OmniRoute API key (stored in ~/.pi/agent/omniroute-config.json)");
            if (input && input.trim()) {
              draft.apiKey = input.trim();
              dirty = true;
            }
            break;
          }
          case "Clear API key": {
            draft.apiKey = null;
            dirty = true;
            break;
          }
          case "Switch wire API…": {
            draft.api = WIRE_APIS.find((api: WireApi) => api !== draft.api) ?? draft.api;
            dirty = true;
            break;
          }
          case "Toggle reasoning":
            draft.reasoning = !draft.reasoning;
            dirty = true;
            break;
          case "Toggle telemetry":
            draft.showTelemetry = !draft.showTelemetry;
            dirty = true;
            break;
          case "Toggle session tagging":
            draft.sessionTag = !draft.sessionTag;
            dirty = true;
            break;
          case "Reload catalog now": {
            const outcome = await runtime.discover();
            ctx.ui.notify(
              outcome.ok
                ? `Reloaded — ${outcome.modelCount} models, ${outcome.comboCount} combos.`
                : `Reload failed: ${outcome.error}`,
              outcome.ok ? "info" : "error",
            );
            break;
          }
          case "Save & close": {
            if (dirty) {
              runtime.saveConfig({
                baseUrl: draft.baseUrl,
                api: draft.api,
                apiKey: draft.apiKey,
                reasoning: draft.reasoning,
                showTelemetry: draft.showTelemetry,
                sessionTag: draft.sessionTag,
                dashboardUrl: draft.dashboardUrl,
              });
              runtime.rebuild();
              void runtime.discover();
              ctx.ui.notify("Configuration saved — catalog rebuilding in the background.", "info");
            }
            editing = false;
            break;
          }
          case "Discard changes":
            editing = false;
            break;
          default:
            // Informational row — no-op.
            break;
        }
      }
    },
  });
}
