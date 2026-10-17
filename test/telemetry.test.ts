/**
 * Routing telemetry tests: X-OmniRoute-* header capture (PRD FR-7).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearDecisions,
  formatDecision,
  lastDecision,
  parseDecisionHeader,
  recentDecisions,
  recordFromHeaders,
} from "../src/telemetry.ts";

test("parseDecisionHeader splits strategy/provider/latency", () => {
  const parsed = parseDecisionHeader("strategy=priority; provider=groq; latency_ms=412");
  assert.deepEqual(parsed, { strategy: "priority", provider: "groq", latencyMs: 412 });
});

test("parseDecisionHeader tolerates empty and malformed values", () => {
  assert.deepEqual(parseDecisionHeader("strategy=single; provider=; latency_ms=abc"), { strategy: "single" });
  assert.deepEqual(parseDecisionHeader(""), {});
  assert.deepEqual(parseDecisionHeader("no-equals-sign"), {});
});

test("recordFromHeaders captures a full decision", () => {
  clearDecisions();
  const record = recordFromHeaders(200, {
    "X-OmniRoute-Decision": "strategy=auto; provider=groq; latency_ms=842",
    "X-OmniRoute-Model": "groq/llama-3.3-70b-versatile",
    "X-OmniRoute-Provider": "groq",
    "X-OmniRoute-Response-Cost": "0.0001234567",
    "X-OmniRoute-Tokens-In": "1200",
    "X-OmniRoute-Tokens-Out": "350",
    "X-OmniRoute-Fallback-Attempts": "2",
    "X-OmniRoute-Version": "v3.8.52",
  });
  assert.ok(record);
  assert.equal(record.strategy, "auto");
  assert.equal(record.provider, "groq");
  assert.equal(record.latencyMs, 842);
  assert.equal(record.model, "groq/llama-3.3-70b-versatile");
  assert.equal(record.costUsd, "0.0001234567");
  assert.equal(record.tokensIn, 1200);
  assert.equal(record.tokensOut, 350);
  assert.equal(record.fallbackAttempts, 2);
  assert.equal(record.gatewayVersion, "v3.8.52");
  assert.equal(lastDecision(), record);
});

test("headers are matched case-insensitively", () => {
  clearDecisions();
  const record = recordFromHeaders(200, { "x-omniroute-decision": "strategy=lkgp; provider=glm; latency_ms=10" });
  assert.ok(record);
  assert.equal(record.strategy, "lkgp");
});

test("non-OmniRoute responses are ignored", () => {
  clearDecisions();
  assert.equal(recordFromHeaders(200, { "content-type": "application/json" }), null);
  assert.equal(lastDecision(), undefined);
});

test("buffer keeps only the most recent 10 decisions", () => {
  clearDecisions();
  for (let i = 0; i < 15; i += 1) {
    recordFromHeaders(200, { "X-OmniRoute-Decision": `strategy=s${i}; provider=p; latency_ms=${i}` });
  }
  assert.equal(recentDecisions(50).length, 10);
  assert.equal(lastDecision()?.strategy, "s14");
  assert.equal(recentDecisions(50).at(-1)?.strategy, "s5");
});

test("formatDecision renders a compact one-liner", () => {
  clearDecisions();
  recordFromHeaders(200, {
    "X-OmniRoute-Decision": "strategy=priority; provider=groq; latency_ms=412",
    "X-OmniRoute-Response-Cost": "0.00001",
  });
  const formatted = formatDecision(lastDecision()!);
  assert.match(formatted, /strategy=priority/);
  assert.match(formatted, /provider=groq/);
  assert.match(formatted, /latency=412ms/);
  assert.match(formatted, /\$0\.00001/);
});
