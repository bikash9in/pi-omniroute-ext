/**
 * Config precedence tests: environment > file > defaults (PRD FR-3).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  DEFAULT_CONFIG,
  KEYLESS_PLACEHOLDER,
  apiBaseUrl,
  applyEnv,
  configPath,
  isWireApi,
  loadConfig,
  loadFileConfig,
  normalizeBaseUrl,
  providerApiKeyRef,
  resolveRawApiKey,
  rootUrl,
  saveFileConfig,
} from "../src/config.ts";

const ENV_KEYS = [
  "OMNIROUTE_BASE_URL",
  "OMNIROUTE_API_KEY",
  "OMNIROUTE_API",
  "OMNIROUTE_ENABLE_REASONING",
  "OMNIROUTE_DASHBOARD_URL",
  "PI_CODING_AGENT_DIR",
  "XDG_CACHE_HOME",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(): string {
  for (const key of ENV_KEYS) delete process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "omniroute-ext-cfg-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("defaults when no config file and no environment", () => {
  const dir = setup();
  try {
    const { config, overridden } = loadConfig();
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.deepEqual(overridden, {
      baseUrl: false,
      api: false,
      apiKey: false,
      reasoning: false,
      sessionTag: false,
      dashboardUrl: false,
    });
  } finally {
    cleanup(dir);
  }
});

test("file values override defaults and survive a round-trip", () => {
  const dir = setup();
  try {
    saveFileConfig({
      baseUrl: "https://omni.example.com:8443/",
      api: "anthropic-messages",
      apiKey: "omni-secret",
      reasoning: true,
      showTelemetry: false,
    });
    const loaded = loadConfig();
    assert.equal(loaded.config.baseUrl, "https://omni.example.com:8443");
    assert.equal(loaded.config.api, "anthropic-messages");
    assert.equal(loaded.config.apiKey, "omni-secret");
    assert.equal(loaded.config.reasoning, true);
    assert.equal(loaded.config.showTelemetry, false);

    const onDisk = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.apiKey, "omni-secret");
    // The file must never capture environment values.
    assert.equal(onDisk.baseUrl, "https://omni.example.com:8443");
  } finally {
    cleanup(dir);
  }
});

test("environment overrides the file and is reported as an override", () => {
  const dir = setup();
  try {
    saveFileConfig({ baseUrl: "http://file:1234", apiKey: "file-key", reasoning: false });
    process.env.OMNIROUTE_BASE_URL = "http://env-host:9999/";
    process.env.OMNIROUTE_API_KEY = "env-key";
    process.env.OMNIROUTE_ENABLE_REASONING = "on";
    process.env.OMNIROUTE_API = "openai-completions";

    const { config, overridden } = loadConfig();
    assert.equal(config.baseUrl, "http://env-host:9999");
    assert.equal(config.apiKey, "env-key");
    assert.equal(config.reasoning, true);
    assert.equal(config.api, "openai-completions");
    assert.deepEqual(overridden, {
      baseUrl: true,
      apiKey: true,
      reasoning: true,
      api: true,
      sessionTag: false,
      dashboardUrl: false,
    });
  } finally {
    cleanup(dir);
  }
});

test("corrupt config file falls back to defaults", () => {
  const dir = setup();
  try {
    writeFileSync(configPath(), "{ not json !!");
    assert.deepEqual(loadFileConfig(), DEFAULT_CONFIG);
  } finally {
    cleanup(dir);
  }
});

test("normalizeBaseUrl strips trailing slashes and adds a missing scheme", () => {
  assert.equal(normalizeBaseUrl("  http://localhost:20128///  "), "http://localhost:20128");
  assert.equal(normalizeBaseUrl("localhost:20128"), "http://localhost:20128");
  assert.equal(normalizeBaseUrl(""), DEFAULT_CONFIG.baseUrl);
});

test("apiBaseUrl depends on the wire API", () => {
  const openai = { ...DEFAULT_CONFIG, api: "openai-completions" as const, baseUrl: "http://localhost:20128" };
  const anthropic = { ...DEFAULT_CONFIG, api: "anthropic-messages" as const, baseUrl: "http://localhost:20128" };
  assert.equal(rootUrl(openai), "http://localhost:20128");
  assert.equal(apiBaseUrl(openai), "http://localhost:20128/v1");
  assert.equal(apiBaseUrl(anthropic), "http://localhost:20128");
});

test("API key resolution: env > file > keyless placeholder", () => {
  const cfg = { ...DEFAULT_CONFIG, apiKey: "file-key" };
  assert.equal(resolveRawApiKey(cfg), "file-key");
  process.env.OMNIROUTE_API_KEY = "env-key";
  assert.equal(resolveRawApiKey(cfg), "env-key");
  delete process.env.OMNIROUTE_API_KEY;
  assert.equal(resolveRawApiKey({ ...cfg, apiKey: null }), KEYLESS_PLACEHOLDER);
});

test("providerApiKeyRef keeps env as a live interpolation and escapes literal $ keys", () => {
  process.env.OMNIROUTE_API_KEY = "env-key";
  assert.equal(providerApiKeyRef({ ...DEFAULT_CONFIG, apiKey: "file-key" }), "$OMNIROUTE_API_KEY");
  delete process.env.OMNIROUTE_API_KEY;
  assert.equal(providerApiKeyRef({ ...DEFAULT_CONFIG, apiKey: "omni-abc" }), "omni-abc");
  assert.equal(providerApiKeyRef({ ...DEFAULT_CONFIG, apiKey: "$literal" }), "$$$literal");
  assert.equal(providerApiKeyRef({ ...DEFAULT_CONFIG, apiKey: null }), KEYLESS_PLACEHOLDER);
});

test("boolean parsing for OMNIROUTE_ENABLE_REASONING", () => {
  for (const truthy of ["true", "1", "on", "YES"]) {
    process.env.OMNIROUTE_ENABLE_REASONING = truthy;
    assert.equal(applyEnv({ ...DEFAULT_CONFIG }).config.reasoning, true, truthy);
  }
  for (const falsy of ["false", "0", "off", "No"]) {
    process.env.OMNIROUTE_ENABLE_REASONING = falsy;
    assert.equal(applyEnv({ ...DEFAULT_CONFIG }).config.reasoning, false, falsy);
  }
  delete process.env.OMNIROUTE_ENABLE_REASONING;
});

test("isWireApi accepts only known APIs", () => {
  assert.equal(isWireApi("openai-completions"), true);
  assert.equal(isWireApi("anthropic-messages"), true);
  assert.equal(isWireApi("responses"), false);
  assert.equal(isWireApi(undefined), false);
});
