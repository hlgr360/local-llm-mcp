import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { startMockLlamaServer } from "./helpers/mockLlamaServer.js";

// Embed-only mode is decided from LOCAL_LLM_EMBED_ONLY at module import time, so it needs
// its own process rather than a toggle inside a shared suite -- same reasoning as
// server-unreachable.test.js. Driving the real `node index.js` over MCP JSON-RPC (as
// integration.test.js does) is also the only way to assert on the filtered tools/list,
// since the filter lives in the request handler, not in a class method.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "index.js");

let mock;
let proc;
let buffer = "";
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

function waitForResponse(id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === id) {
          clearInterval(iv);
          resolve(parsed);
          return;
        }
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for response id ${id}`));
      }
    }, 20);
  });
}

let initializeResponse;

before(async () => {
  mock = await startMockLlamaServer();
  // An embedding backend: no chat template, and /v1/models reports the embedding model.
  mock.state.modelId = "nomic-ai/nomic-embed-text-v1.5-GGUF";
  mock.state.props = { default_generation_settings: { n_ctx: 2048 }, total_slots: 1 };

  proc = spawn("node", [INDEX_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LOCAL_LLM_BASE_URL: mock.url, LOCAL_LLM_EMBED_ONLY: "1" },
  });
  proc.stdout.on("data", (d) => (buffer += d.toString()));

  send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.1" },
  });
  initializeResponse = await waitForResponse(1);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

after(async () => {
  proc.kill();
  await mock.close();
});

test("tools/list exposes only the three tools an embedding backend can serve", async () => {
  const id = send("tools/list", {});
  const response = await waitForResponse(id);
  const names = response.result.tools.map((t) => t.name).sort();

  assert.deepEqual(names, [
    "local_llm_semantic_similarity",
    "local_llm_server_info",
    "local_llm_tokenize",
  ]);
});

test("initialize instructions describe the embedding server, not code offloading", () => {
  const { instructions } = initializeResponse.result;
  assert.match(instructions, /embedding model/);
  assert.match(instructions, /local_llm_semantic_similarity/);
  // The generative instructions steer toward the file-aware tools; those tools aren't
  // registered here, so advertising them would send the agent after tools it can't call.
  assert.doesNotMatch(instructions, /local_llm_review_file/);
});

test("semantic_similarity still works, ranking candidates against the query", async () => {
  mock.state.embeddings = (inputs) =>
    inputs.map((text) => (text === "needle" ? [1, 0, 0] : text === "close" ? [0.9, 0.1, 0] : [0, 1, 0]));

  const id = send("tools/call", {
    name: "local_llm_semantic_similarity",
    arguments: { query: "needle", candidates: ["far", "close"] },
  });
  const response = await waitForResponse(id);
  const { results } = JSON.parse(response.result.content[0].text);

  assert.equal(results[0].candidate, 1);
  assert.ok(results[0].score > results[1].score);
});

test("tokenize still works, since /tokenize is independent of chat support", async () => {
  const id = send("tools/call", {
    name: "local_llm_tokenize",
    arguments: { text: "embed me" },
  });
  const response = await waitForResponse(id);
  assert.equal(JSON.parse(response.result.content[0].text).token_count, 2);
});

test("a filtered-out chat tool explains the mode instead of failing at the backend", async () => {
  const id = send("tools/call", {
    name: "local_llm_generate_code",
    arguments: { prompt: "reverse a string", language: "python" },
  });
  const response = await waitForResponse(id);
  const text = response.result.content[0].text;

  assert.match(text, /embed-only mode/);
  assert.match(text, /LOCAL_LLM_EMBED_ONLY/);
  assert.match(text, /local_llm_semantic_similarity/);
  // Specifically must not have reached the backend's chat endpoint.
  assert.ok(!mock.state.requests.some((r) => r.url === "/v1/chat/completions"));
});

test("server_info reports the mode, so a caller can tell why tools are missing", async () => {
  const id = send("tools/call", { name: "local_llm_server_info", arguments: {} });
  const response = await waitForResponse(id);
  const info = JSON.parse(response.result.content[0].text);

  assert.equal(info.embed_only, true);
  assert.equal(info.model_id, "nomic-ai/nomic-embed-text-v1.5-GGUF");
  assert.equal(info.has_chat_template, false);
});
