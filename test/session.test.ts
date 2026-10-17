/**
 * Phase 2 tests: session tagging (FR-12) and status line (FR-11).
 */

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { DEFAULT_CONFIG, applyEnv } from "../src/config.ts";
import { clearSessionTag, getSessionTag, sessionTagHeader, setSessionTag } from "../src/state.ts";
import { formatStatusLine } from "../src/ui.ts";

const ENV_KEYS = ["OMNIROUTE_SESSION_TAG", "OMNIROUTE_BASE_URL", "OMNIROUTE_API_KEY", "OMNIROUTE_API", "OMNIROUTE_ENABLE_REASONING"] as const;
const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  clearSessionTag();
});

// ---------------------------------------------------------------------------
// Session tag lifecycle + header injection (FR-12)
// ---------------------------------------------------------------------------

test("session tag set/get/clear", () => {
  assert.equal(getSessionTag(), undefined);
  setSessionTag("pi-abc-123");
  assert.equal(getSessionTag(), "pi-abc-123");
  clearSessionTag();
  assert.equal(getSessionTag(), undefined);
});

test("sessionTagHeader injects only for omniroute when enabled", () => {
  setSessionTag("pi-abc-123");
  assert.deepEqual(sessionTagHeader("omniroute", true), { "X-OmniRoute-Session-Id": "pi-abc-123" });
  assert.deepEqual(sessionTagHeader("omniroute", false), {}, "toggle off");
  assert.deepEqual(sessionTagHeader("openrouter", true), {}, "other providers untouched");
  assert.deepEqual(sessionTagHeader(undefined, true), {}, "no active model");
});

test("sessionTagHeader is empty when no session tag exists", () => {
  assert.deepEqual(sessionTagHeader("omniroute", true), {});
});

test("session tagging config defaults to off (opt-in) and env can enable it", () => {
  assert.equal(DEFAULT_CONFIG.sessionTag, false);

  const off = applyEnv({ ...DEFAULT_CONFIG, sessionTag: true });
  assert.equal(off.config.sessionTag, true);
  assert.equal(off.overridden.sessionTag, false);

  process.env.OMNIROUTE_SESSION_TAG = "on";
  const on = applyEnv({ ...DEFAULT_CONFIG, sessionTag: false });
  assert.equal(on.config.sessionTag, true);
  assert.equal(on.overridden.sessionTag, true);
});

test("boolean parsing for OMNIROUTE_SESSION_TAG", () => {
  for (const truthy of ["true", "1", "ON"]) {
    process.env.OMNIROUTE_SESSION_TAG = truthy;
    assert.equal(applyEnv({ ...DEFAULT_CONFIG }).config.sessionTag, true, truthy);
  }
  for (const falsy of ["false", "0", "off"]) {
    process.env.OMNIROUTE_SESSION_TAG = falsy;
    assert.equal(applyEnv({ ...DEFAULT_CONFIG }).config.sessionTag, false, falsy);
  }
});

// ---------------------------------------------------------------------------
// Status line (FR-11)
// ---------------------------------------------------------------------------

test("formatStatusLine renders provider · strategy · latency", () => {
  const text = formatStatusLine({ at: Date.now(), status: 200, provider: "groq", strategy: "priority", latencyMs: 412 });
  assert.equal(text, "OmniRoute · groq · priority · 412ms");
});

test("formatStatusLine omits the 'single' strategy and adds fallback count", () => {
  const text = formatStatusLine({ at: Date.now(), status: 200, provider: "glm", strategy: "single", latencyMs: 80, fallbackAttempts: 2 });
  assert.equal(text, "OmniRoute · glm · 80ms · fb×2");
});

test("formatStatusLine tolerates sparse decisions", () => {
  assert.equal(formatStatusLine({ at: Date.now(), status: 200 }), "OmniRoute · ?");
  assert.equal(formatStatusLine({ at: Date.now(), status: 200, provider: "mock" }), "OmniRoute · mock");
});
