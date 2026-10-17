/**
 * Discovery tests: normalization (pure), caches, and fetch/pull against a
 * local mock OmniRoute (PRD FR-2, FR-5, FR-9).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_CONFIG, type OmniRouteConfig } from "../src/config.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_TOKENS,
  catalogCachePath,
  fetchCatalog,
  isChatEligible,
  normalizeCatalog,
  pullCatalog,
  readCatalogCache,
  readMetadataMap,
  updateMetadata,
  writeCatalogCache,
  writeMetadataFile,
  type CatalogEntry,
} from "../src/discovery.ts";
import { state } from "../src/state.ts";
import { EXPECTED_CHAT_IDS, EXPECTED_COMBO_IDS, EXPECTED_MODEL_IDS, SAMPLE_CATALOG } from "./fixtures/sample-catalog.ts";

const ENV_KEYS = ["OMNIROUTE_BASE_URL", "OMNIROUTE_API_KEY", "OMNIROUTE_API", "OMNIROUTE_ENABLE_REASONING", "PI_CODING_AGENT_DIR", "XDG_CACHE_HOME"] as const;
const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(): { dir: string; cfg: OmniRouteConfig } {
  for (const key of ENV_KEYS) delete process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "omniroute-ext-test-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  return { dir, cfg: { ...DEFAULT_CONFIG } };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Normalization (pure)
// ---------------------------------------------------------------------------

test("normalize keeps chat models and combos, filters non-chat, dedupes", () => {
  const normalized = normalizeCatalog(SAMPLE_CATALOG, DEFAULT_CONFIG, {});
  assert.deepEqual(
    normalized.models.map((model) => model.id),
    EXPECTED_CHAT_IDS,
    "combos first, non-chat filtered, duplicates removed",
  );
  assert.equal(normalized.comboCount, EXPECTED_COMBO_IDS.length);
  assert.equal(normalized.modelCount, EXPECTED_MODEL_IDS.length);
  assert.equal(normalized.models.length, EXPECTED_CHAT_IDS.length);
});

test("combo display names: display_name wins, otherwise '<id> (combo)'", () => {
  const normalized = normalizeCatalog(SAMPLE_CATALOG, DEFAULT_CONFIG, {});
  const byId = new Map(normalized.models.map((model) => [model.id, model]));
  assert.equal(byId.get("CheapFix")?.name, "Cheap");
  assert.equal(byId.get("auto")?.name, "auto (combo)");
  assert.equal(byId.get("glm/glm-5.2")?.name, "glm/glm-5.2");
});

test("metadata merge: router fields > cached metadata > defaults (FR-5)", () => {
  const metadata = { "cc/claude-sonnet-4-6": { contextWindow: 200000, maxOutputTokens: 32000, updatedAt: 1 } };
  const normalized = normalizeCatalog(SAMPLE_CATALOG, DEFAULT_CONFIG, metadata);
  const byId = new Map(normalized.models.map((model) => [model.id, model]));

  // Router fields win.
  assert.equal(byId.get("glm/glm-5.2")?.contextWindow, 131072);
  assert.equal(byId.get("glm/glm-5.2")?.maxTokens, 65536);
  // Cached metadata fills gaps.
  assert.equal(byId.get("cc/claude-sonnet-4-6")?.contextWindow, 200000);
  assert.equal(byId.get("cc/claude-sonnet-4-6")?.maxTokens, 32000);
  // Defaults apply when nothing knows better.
  const noMeta = normalizeCatalog([{ id: "mystery-model" }], DEFAULT_CONFIG, {});
  assert.equal(noMeta.models[0]?.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(noMeta.models[0]?.maxTokens, DEFAULT_OUTPUT_TOKENS);
});

test("vision detection: input_modalities or capabilities.vision", () => {
  const normalized = normalizeCatalog(SAMPLE_CATALOG, DEFAULT_CONFIG, {});
  const byId = new Map(normalized.models.map((model) => [model.id, model]));
  assert.deepEqual(byId.get("gemini/gemini-2.5-flash")?.input, ["text", "image"]);
  assert.deepEqual(byId.get("auto")?.input, ["text", "image"]);
  assert.deepEqual(byId.get("glm/glm-5.2")?.input, ["text"]);
});

test("reasoning toggle: off by default, on maps thinking levels incl. off→none (FR-6)", () => {
  const off = normalizeCatalog(SAMPLE_CATALOG, DEFAULT_CONFIG, {});
  assert.ok(off.models.every((model) => model.reasoning === false));
  assert.ok(off.models.every((model) => model.thinkingLevelMap === undefined));

  const on = normalizeCatalog(SAMPLE_CATALOG, { ...DEFAULT_CONFIG, reasoning: true }, {});
  assert.ok(on.models.every((model) => model.reasoning === true));
  const map = on.models[0]?.thinkingLevelMap;
  assert.equal(map?.off, "none");
  assert.equal(map?.minimal, "low");
  assert.equal(map?.max, "xhigh");
});

test("costs register as zero — OmniRoute pricing is telemetry-header based", () => {
  const normalized = normalizeCatalog(SAMPLE_CATALOG, DEFAULT_CONFIG, {});
  assert.deepEqual(normalized.models[0]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("isChatEligible rules", () => {
  assert.equal(isChatEligible({ id: "a", owned_by: "combo" }), true, "combos always chat");
  assert.equal(isChatEligible({ id: "b", type: "audio" }), false);
  assert.equal(isChatEligible({ id: "c", type: "chat" }), true);
  assert.equal(isChatEligible({ id: "d" }), true);
  assert.equal(isChatEligible({ id: "e", supported_endpoints: ["chat", "responses"] }), true);
  assert.equal(isChatEligible({ id: "f", supported_endpoints: ["rerank"] }), false);
});

test("empty catalog normalizes to zero counts", () => {
  const normalized = normalizeCatalog([], DEFAULT_CONFIG, {});
  assert.deepEqual(normalized, { models: [], modelCount: 0, comboCount: 0 });
});

// ---------------------------------------------------------------------------
// Metadata + catalog caches
// ---------------------------------------------------------------------------

test("metadata cache merges router limits and is readable", () => {
  const { dir } = setup();
  try {
    const file = readMetadataMap();
    const changed = updateMetadata([{ id: "glm/glm-5.2", context_length: 131072, max_output_tokens: 65536 }], file);
    assert.equal(changed, true);
    const again = updateMetadata([{ id: "glm/glm-5.2", context_length: 131072, max_output_tokens: 65536 }], file);
    assert.equal(again, false, "unchanged limits do not rewrite");
    writeMetadataFile(file);
    const reread = readMetadataMap();
    assert.equal(reread.models["glm/glm-5.2"]?.contextWindow, 131072);
  } finally {
    cleanup(dir);
  }
});

test("catalog cache round-trips and rejects a different baseUrl/api", () => {
  const { dir, cfg } = setup();
  try {
    writeCatalogCache(cfg, { entries: SAMPLE_CATALOG, fetchedAt: 123, gatewayVersion: "v3.8.52" });
    assert.ok(existsSync(catalogCachePath()));

    const cache = readCatalogCache(cfg);
    assert.ok(cache);
    assert.equal(cache.entries.length, SAMPLE_CATALOG.length);
    assert.equal(cache.gatewayVersion, "v3.8.52");
    assert.equal(cache.fetchedAt, 123);

    assert.equal(readCatalogCache({ ...cfg, baseUrl: "http://other:1" }), null, "baseUrl mismatch");
    assert.equal(readCatalogCache({ ...cfg, api: "anthropic-messages" }), null, "api mismatch");

    writeFileSync(catalogCachePath(), "corrupt{");
    assert.equal(readCatalogCache(cfg), null, "corrupt cache tolerated");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// fetchCatalog / pullCatalog against a mock gateway
// ---------------------------------------------------------------------------

interface MockRoute {
  status?: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

async function withMockGateway(
  route: MockRoute | ((url: string) => MockRoute),
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const resolved = typeof route === "function" ? route(req.url ?? "") : route;
    const headers = { "content-type": "application/json", ...(resolved.headers ?? {}) };
    const body = resolved.rawBody ?? JSON.stringify(resolved.body ?? {});
    res.writeHead(resolved.status ?? 200, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("fetchCatalog parses entries and the gateway version header", async () => {
  const { dir } = setup();
  try {
    await withMockGateway(
      { body: { object: "list", data: SAMPLE_CATALOG }, headers: { "x-omniroute-version": "v3.8.52" } },
      async (baseUrl) => {
        const result = await fetchCatalog({ root: baseUrl, apiKey: "test-key" });
        assert.equal(result.entries.length, SAMPLE_CATALOG.length);
        assert.equal(result.gatewayVersion, "v3.8.52");
        assert.ok(result.fetchedAt > 0);
      },
    );
  } finally {
    cleanup(dir);
  }
});

test("fetchCatalog requests the alias prefix", async () => {
  const { dir } = setup();
  try {
    let requestedUrl = "";
    await withMockGateway(
      (url) => {
        requestedUrl = url;
        return { body: { object: "list", data: [] } };
      },
      async (baseUrl) => {
        await fetchCatalog({ root: baseUrl, apiKey: "k" });
        assert.equal(requestedUrl, "/v1/models?prefix=alias");
      },
    );
  } finally {
    cleanup(dir);
  }
});

test("fetchCatalog maps 401 to actionable API-key guidance (FR-9)", async () => {
  const { dir } = setup();
  try {
    await withMockGateway({ status: 401, body: { error: "unauthorized" } }, async (baseUrl) => {
      await assert.rejects(
        () => fetchCatalog({ root: baseUrl, apiKey: "wrong" }),
        (err: Error) => err.message.includes("API key") && err.message.includes("/omniroute-config"),
      );
    });
  } finally {
    cleanup(dir);
  }
});

test("fetchCatalog reports non-JSON responses (wrong base URL)", async () => {
  const { dir } = setup();
  try {
    await withMockGateway({ rawBody: "<html>dashboard</html>" }, async (baseUrl) => {
      await assert.rejects(
        () => fetchCatalog({ root: baseUrl, apiKey: "k" }),
        (err: Error) => err.message.includes("did not return JSON"),
      );
    });
  } finally {
    cleanup(dir);
  }
});

test("fetchCatalog reports an unreachable gateway", async () => {
  const { dir } = setup();
  try {
    await assert.rejects(
      () => fetchCatalog({ root: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 3000 }),
      (err: Error) => err.message.includes("Cannot reach OmniRoute") && err.message.includes("npx omniroute"),
    );
  } finally {
    cleanup(dir);
  }
});

test("pullCatalog: registers state, writes cache, counts models and combos", async () => {
  const { dir } = setup();
  try {
    await withMockGateway(
      { body: { object: "list", data: SAMPLE_CATALOG }, headers: { "x-omniroute-version": "v3.8.52" } },
      async (baseUrl) => {
        const cfg: OmniRouteConfig = { ...DEFAULT_CONFIG, baseUrl };
        const pull = await pullCatalog(cfg);
        assert.equal(pull.modelCount, EXPECTED_MODEL_IDS.length);
        assert.equal(pull.comboCount, EXPECTED_COMBO_IDS.length);

        assert.equal(state.discovery.phase, "connected");
        assert.equal(state.discovery.fromCache, false);
        assert.equal(state.discovery.modelCount, EXPECTED_MODEL_IDS.length);
        assert.equal(state.discovery.comboCount, EXPECTED_COMBO_IDS.length);
        assert.equal(state.discovery.gatewayVersion, "v3.8.52");
        assert.equal(state.discovery.entries.length, SAMPLE_CATALOG.length);
        assert.equal(state.discovery.lastError, undefined);

        const cache = readCatalogCache(cfg);
        assert.ok(cache);
        assert.equal(cache.entries.length, SAMPLE_CATALOG.length);
      },
    );
  } finally {
    cleanup(dir);
  }
});

test("pullCatalog fails on an empty catalog with dashboard guidance", async () => {
  const { dir } = setup();
  try {
    await withMockGateway({ body: { object: "list", data: [] } }, async (baseUrl) => {
      const cfg: OmniRouteConfig = { ...DEFAULT_CONFIG, baseUrl };
      await assert.rejects(
        () => pullCatalog(cfg),
        (err: Error) => err.message.includes("Connect at least one provider"),
      );
    });
  } finally {
    cleanup(dir);
  }
});
