#!/usr/bin/env node
/**
 * Mock OmniRoute gateway for local development and manual QA of
 * pi-omniroute-ext. Serves:
 *
 *   GET  /v1/models?prefix=alias   → sample catalog (combos pinned first)
 *   HEAD /v1/models                → 200 (extension probe)
 *   POST /v1/chat/completions      → minimal non-streaming SSE-compat reply
 *
 * Set MOCK_HEADERS_LOG=/path/to/file.jsonl to append received request headers
 * per call (used by the session-tagging smoke test).
 *
 * Usage:  node scripts/mock-gateway.mjs [port]   (default 20128)
 * Then:   OMNIROUTE_BASE_URL=http://127.0.0.1:<port> pi -e .
 */

import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 20128);

const catalog = [
  { id: "auto", object: "model", owned_by: "combo", context_length: 200000, max_output_tokens: 8192 },
  { id: "MockCombo", object: "model", owned_by: "combo", display_name: "Mock combo", description: "priority over mock models" },
  { id: "mock/mock-large", object: "model", owned_by: "mock", context_length: 128000, max_output_tokens: 8192, capabilities: { reasoning: true, tool_calling: true } },
  { id: "mock/mock-fast", object: "model", owned_by: "mock", context_length: 64000, max_output_tokens: 4096 },
  { id: "mock/mock-vision", object: "model", owned_by: "mock", context_length: 128000, capabilities: { vision: true } },
];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  res.setHeader("X-OmniRoute-Version", "mock-v1");

  if (req.method === "HEAD" && url.pathname === "/v1/models") {
    res.writeHead(200).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: catalog }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (process.env.MOCK_HEADERS_LOG) {
        appendFileSync(process.env.MOCK_HEADERS_LOG, `${JSON.stringify(req.headers)}\n`);
      }
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* keep default */
      }
      const id = "chatcmpl-mock";
      const created = Math.floor(Date.now() / 1000);
      const model = typeof body.model === "string" ? body.model : "mock";
      const wantStream = body.stream === true;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-omniroute-decision": "strategy=single; provider=mock; latency_ms=7",
        "x-omniroute-model": model,
      });
      if (!wantStream) {
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "OK (mock gateway)" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
        );
        return;
      }
      const chunk = (data) => `data: ${JSON.stringify(data)}\n\n`;
      res.write(
        chunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
      );
      res.write(chunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: "OK (mock gateway)" }, finish_reason: null }] }));
      res.write(chunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock OmniRoute listening on http://127.0.0.1:${port}`);
  console.log(`  catalog: ${catalog.length} entries (combos + models)`);
  console.log(`  try: OMNIROUTE_BASE_URL=http://127.0.0.1:${port} pi -e .`);
});
