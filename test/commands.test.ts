/**
 * Command tests with a stubbed ExtensionAPI/ExtensionCommandContext — no TUI
 * required. Covers PRD FR-4 (all six commands) including the non-interactive
 * text fallbacks (NFR: JSON/print modes keep commands functional).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type OmniRouteConfig } from "../src/config.ts";
import { registerOmniRouteCommands } from "../src/commands.ts";
import type { Runtime } from "../src/runtime.ts";
import { state } from "../src/state.ts";
import { clearDecisions, recordFromHeaders } from "../src/telemetry.ts";
import { SAMPLE_CATALOG } from "./fixtures/sample-catalog.ts";

const ENV_KEYS = ["OMNIROUTE_BASE_URL", "OMNIROUTE_API_KEY", "OMNIROUTE_API", "OMNIROUTE_ENABLE_REASONING", "PI_CODING_AGENT_DIR", "XDG_CACHE_HOME"] as const;
const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

let tempDir = "";

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = mkdtempSync(join(tmpdir(), "omniroute-ext-cmd-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  state.config = null;
  state.discovery = {
    phase: "idle",
    registered: false,
    fromCache: false,
    baseUrl: "",
    modelCount: 0,
    comboCount: 0,
    entries: [],
  };
  clearDecisions();
});

interface StubCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
}

function makePiStub(): { api: ExtensionAPI; commands: Map<string, StubCommand>; setModelCalls: string[] } {
  const commands = new Map<string, StubCommand>();
  const setModelCalls: string[] = [];
  const api = {
    registerCommand: (name: string, options: StubCommand) => {
      commands.set(name, options);
    },
    setModel: async (model: { provider: string; id: string }) => {
      setModelCalls.push(`${model.provider}/${model.id}`);
      return true;
    },
  } as unknown as ExtensionAPI;
  return { api, commands, setModelCalls };
}

interface RuntimeOverrides {
  config?: () => ReturnType<Runtime["config"]>;
  saveConfig?: Runtime["saveConfig"];
  discover?: Runtime["discover"];
  rebuild?: Runtime["rebuild"];
  probe?: Runtime["probe"];
}

function makeRuntime(overrides: RuntimeOverrides = {}): { runtime: Runtime; savedPatches: Partial<OmniRouteConfig>[]; discoverCalls: number; rebuildCalls: number } {
  const savedPatches: Partial<OmniRouteConfig>[] = [];
  let discoverCalls = 0;
  let rebuildCalls = 0;
  const runtime: Runtime = {
    config:
      overrides.config ??
      (() => ({
        config: { ...DEFAULT_CONFIG, baseUrl: "http://localhost:20128" },
        overridden: { baseUrl: false, api: false, apiKey: false, reasoning: false, sessionTag: false, dashboardUrl: false },
      })),
    saveConfig:
      overrides.saveConfig ??
      ((patch) => {
        savedPatches.push(patch);
        const loaded = {
          config: { ...DEFAULT_CONFIG, ...patch },
          overridden: { baseUrl: false, api: false, apiKey: false, reasoning: false, sessionTag: false, dashboardUrl: false },
        };
        return loaded;
      }),
    discover:
      overrides.discover ??
      (async () => {
        discoverCalls += 1;
        return { ok: true, modelCount: 3, comboCount: 2, source: "live" as const };
      }),
    rebuild:
      overrides.rebuild ??
      (() => {
        rebuildCalls += 1;
        return true;
      }),
    probe: overrides.probe ?? (async () => true),
  };
  return {
    runtime,
    savedPatches,
    get discoverCalls() {
      return discoverCalls;
    },
    get rebuildCalls() {
      return rebuildCalls;
    },
  };
}

interface Notification {
  message: string;
  type?: string;
}

function makeCtx(opts: { hasUI?: boolean; selects?: string[]; inputs?: string[]; model?: { provider: string; id: string } } = {}): {
  ctx: ExtensionCommandContext;
  notifications: Notification[];
} {
  const notifications: Notification[] = [];
  const selects = [...(opts.selects ?? [])];
  const inputs = [...(opts.inputs ?? [])];
  const ctx = {
    hasUI: opts.hasUI ?? false,
    mode: opts.hasUI ? "tui" : "json",
    model: opts.model,
    modelRegistry: {
      find: (provider: string, id: string) => {
        const known = SAMPLE_CATALOG.some((entry) => entry.id === id);
        return known ? { provider, id } : undefined;
      },
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      select: async () => selects.shift(),
      input: async () => inputs.shift(),
      confirm: async () => true,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

function seedEntries(): void {
  state.discovery.entries = SAMPLE_CATALOG;
  state.discovery.modelCount = 3;
  state.discovery.comboCount = 2;
  state.discovery.registered = true;
  state.discovery.phase = "connected";
  state.discovery.baseUrl = "http://localhost:20128";
  state.discovery.lastSuccessAt = Date.now();
}

// ---------------------------------------------------------------------------

test("/omniroute-status prints a report with probe result and active model", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  const { ctx, notifications } = makeCtx({ model: { provider: "omniroute", id: "auto" } });
  await commands.get("omniroute-status")!.handler("", ctx);

  assert.equal(notifications.length, 1);
  const text = notifications[0]!.message;
  assert.match(text, /OmniRoute status/);
  assert.match(text, /reachable/);
  assert.match(text, /http:\/\/localhost:20128/);
  assert.match(text, /registered as "omniroute"/);
  assert.match(text, /3 models · 2 combos/);
  assert.match(text, /Active model {3}omniroute\/auto/);
  assert.equal(notifications[0]!.type, "info");
});

test("/omniroute-status warns when the gateway is unreachable and includes a hint", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime({ probe: async () => false });
  registerOmniRouteCommands(api, runtime);

  const { ctx, notifications } = makeCtx();
  await commands.get("omniroute-status")!.handler("", ctx);

  assert.match(notifications[0]!.message, /unreachable/);
  assert.match(notifications[0]!.message, /Hint/);
  assert.equal(notifications[0]!.type, "warning");
});

test("/omniroute-status surfaces the last routing decision when telemetry is present", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  recordFromHeaders(200, {
    "X-OmniRoute-Decision": "strategy=priority; provider=groq; latency_ms=412",
    "X-OmniRoute-Version": "v3.8.52",
  });

  const { ctx, notifications } = makeCtx();
  await commands.get("omniroute-status")!.handler("", ctx);

  assert.match(notifications[0]!.message, /Last routing {3}strategy=priority · provider=groq · latency=412ms/);
});

test("/omniroute-models without a UI lists the catalog as text", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-models")!.handler("", ctx);

  const text = notifications[0]!.message;
  assert.match(text, /Combos:/);
  assert.match(text, /CheapFix/);
  assert.match(text, /Models:/);
  assert.match(text, /glm\/glm-5\.2/);
  assert.match(text, /\/omniroute-models <id>/);
});

test("/omniroute-models <id> selects the model through the registry", async () => {
  const { api, commands, setModelCalls } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-models")!.handler("glm/glm-5.2", ctx);

  assert.deepEqual(setModelCalls, ["omniroute/glm/glm-5.2"]);
  assert.match(notifications[0]!.message, /Model set → omniroute\/glm\/glm-5\.2/);
});

test("/omniroute-models with an unknown id reports actionable guidance", async () => {
  const { api, commands, setModelCalls } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-models")!.handler("does/not-exist", ctx);

  assert.deepEqual(setModelCalls, []);
  assert.match(notifications[0]!.message, /not registered — run \/omniroute-reload/);
  assert.equal(notifications[0]!.type, "warning");
});

test("/omniroute-models in a UI opens a selector and applies the pick", async () => {
  const { api, commands, setModelCalls } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  // First option is the first combo ("auto"), scripted selection.
  const { ctx, notifications } = makeCtx({ hasUI: true, selects: ["auto  (combo)"] });
  await commands.get("omniroute-models")!.handler("", ctx);

  assert.deepEqual(setModelCalls, ["omniroute/auto"]);
  assert.match(notifications[0]!.message, /Model set → omniroute\/auto/);
});

test("/omniroute-models argument completions expose catalog ids", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  const completions = commands.get("omniroute-models")!.getArgumentCompletions!("glm");
  assert.ok(completions);
  assert.ok(completions!.some((item) => item.value === "glm/glm-5.2"));
  const combos = commands.get("omniroute-models")!.getArgumentCompletions!("Cheap");
  assert.ok(combos!.some((item) => item.label.includes("(combo)")));
});

test("/omniroute-combos lists combos as text without a UI", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-combos")!.handler("", ctx);

  assert.match(notifications[0]!.message, /OmniRoute combos \(2\):/);
  assert.match(notifications[0]!.message, /CheapFix/);
});

test("/omniroute-combos shows catalog detail for a picked combo", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);
  seedEntries();

  const { ctx, notifications } = makeCtx({ hasUI: true, selects: ["CheapFix  ·  Cheap"] });
  await commands.get("omniroute-combos")!.handler("", ctx);

  const text = notifications[0]!.message;
  assert.match(text, /Combo: CheapFix/);
  assert.match(text, /Free-first priority fallback/);
  assert.match(text, /Context\s+131,072 tokens/);
});

test("/omniroute-combos warns when no combos are discovered", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime({
    discover: async () => ({ ok: true, modelCount: 0, comboCount: 0, source: "live" }),
  });
  registerOmniRouteCommands(api, runtime);
  state.discovery.entries = [];

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-combos")!.handler("", ctx);

  assert.equal(notifications[0]!.type, "warning");
  assert.match(notifications[0]!.message, /No combos discovered/);
});

test("/omniroute-reasoning on persists, rebuilds and notifies", async () => {
  const { api, commands } = makePiStub();
  const harness = makeRuntime();
  registerOmniRouteCommands(api, harness.runtime);
  seedEntries();

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-reasoning")!.handler("on", ctx);

  assert.deepEqual(harness.savedPatches, [{ reasoning: true }]);
  assert.equal(harness.rebuildCalls, 1);
  assert.equal(harness.discoverCalls, 1);
  assert.match(notifications[0]!.message, /Reasoning enabled/);
});

test("/omniroute-reasoning off persists disabled state", async () => {
  const { api, commands } = makePiStub();
  const harness = makeRuntime();
  registerOmniRouteCommands(api, harness.runtime);

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-reasoning")!.handler("off", ctx);

  assert.deepEqual(harness.savedPatches, [{ reasoning: false }]);
  assert.match(notifications[0]!.message, /Reasoning disabled/);
});

test("/omniroute-reasoning without args reports usage in non-UI mode", async () => {
  const { api, commands } = makePiStub();
  const harness = makeRuntime();
  registerOmniRouteCommands(api, harness.runtime);

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-reasoning")!.handler("", ctx);

  assert.equal(harness.savedPatches.length, 0);
  assert.match(notifications[0]!.message, /currently off/);
  assert.match(notifications[0]!.message, /on\|off/);
});

test("/omniroute-reload reports live counts", async () => {
  const { api, commands } = makePiStub();
  const harness = makeRuntime();
  registerOmniRouteCommands(api, harness.runtime);

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-reload")!.handler("", ctx);

  assert.equal(harness.discoverCalls, 1);
  assert.match(notifications[0]!.message, /reloaded — 3 models, 2 combos/);
});

test("/omniroute-reload reports the failure error", async () => {
  const { api, commands } = makePiStub();
  const harness = makeRuntime({
    discover: async () => ({ ok: false, error: "Cannot reach OmniRoute", registered: false }),
  });
  registerOmniRouteCommands(api, harness.runtime);

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-reload")!.handler("", ctx);

  assert.equal(notifications[0]!.type, "error");
  assert.match(notifications[0]!.message, /reload failed: Cannot reach OmniRoute/);
});

test("/omniroute-config prints the effective config without a UI", async () => {
  const { api, commands } = makePiStub();
  const { runtime } = makeRuntime();
  registerOmniRouteCommands(api, runtime);

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await commands.get("omniroute-config")!.handler("", ctx);

  const text = notifications[0]!.message;
  assert.match(text, /OmniRoute configuration/);
  assert.match(text, /Base URL {4}http:\/\/localhost:20128/);
  assert.match(text, /Wire API {4}openai-completions/);
  assert.match(text, /interactive session/);
});

test("/omniroute-config UI flow edits, saves and rebuilds", async () => {
  const { api, commands } = makePiStub();
  const harness = makeRuntime();
  registerOmniRouteCommands(api, harness.runtime);

  const { ctx, notifications } = makeCtx({
    hasUI: true,
    selects: ["Change base URL…", "Save & close"],
    inputs: ["http://omni.local:20128"],
  });
  await commands.get("omniroute-config")!.handler("", ctx);

  assert.equal(harness.savedPatches.length, 1);
  assert.equal(harness.savedPatches[0]!.baseUrl, "http://omni.local:20128");
  assert.equal(harness.rebuildCalls, 1);
  assert.ok(notifications.some((entry) => /Configuration saved/.test(entry.message)));
});
