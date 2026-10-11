import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { startMockLlamaServer } from "./helpers/mockLlamaServer.js";
import { TOOL_MODEL_PREFERENCES, TOOL_REASONING_OVERRIDES } from "../prompts.js";

let mock;
let LocalLlmServer;
let tmpDir;
let originalCwd;

before(async () => {
  mock = await startMockLlamaServer();
  process.env.LOCAL_LLM_BASE_URL = mock.url;
  ({ LocalLlmServer } = await import("../index.js"));
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-llm-mcp-test-"));
  // getCodeGraphContext() defaults to process.cwd() -- chdir into a directory
  // guaranteed to have no .codegraph/, so these tests stay hermetic instead of
  // accidentally hitting this repo's own real CodeGraph index.
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

after(async () => {
  process.chdir(originalCwd);
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.modelId = "mock-org/mock-model-7b";
  mock.state.modelIds = null;
  mock.state.finishReason = "stop";
});

describe("resolveModel", () => {
  test("an explicit model argument skips the network call entirely", async () => {
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel("qwen-explicit");
    assert.equal(resolved.id, "qwen-explicit");
    assert.equal(resolved.family, "qwen");
    assert.equal(mock.state.requests.length, 0);
  });

  test("auto-detects the loaded model from /v1/models and resolves its family", async () => {
    mock.state.modelId = "gemma-3-12b-it";
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel(undefined);
    assert.equal(resolved.id, "gemma-3-12b-it");
    assert.equal(resolved.family, "gemma");
  });

  test("caches the auto-detected model instead of re-querying every call", async () => {
    const server = new LocalLlmServer();
    await server.resolveModel(undefined);
    await server.resolveModel(undefined);
    const modelRequests = mock.state.requests.filter((r) => r.url === "/v1/models");
    assert.equal(modelRequests.length, 1);
  });

});

describe("resolveModel with multiple models (router/multi-model support)", () => {
  afterEach(() => {
    delete TOOL_MODEL_PREFERENCES.write_tests;
  });

  test("single-model behavior is unaffected when no preferences are configured", async () => {
    mock.state.modelIds = ["mock-org/mock-model-7b"];
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel(undefined, "generate_code");
    assert.equal(resolved.id, "mock-org/mock-model-7b");
  });

  test("with multiple models and no preference for the tool, falls back to the first one", async () => {
    mock.state.modelIds = ["deepseek-coder-v2", "qwen2.5-coder"];
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel(undefined, "generate_code");
    assert.equal(resolved.id, "deepseek-coder-v2");
  });

  test("honors a configured preference, picking the first available matching family", async () => {
    mock.state.modelIds = ["deepseek-coder-v2", "qwen2.5-coder"];
    TOOL_MODEL_PREFERENCES.write_tests = ["qwen", "deepseek"];
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel(undefined, "write_tests");
    assert.equal(resolved.id, "qwen2.5-coder");
    assert.equal(resolved.family, "qwen");
  });

  test("falls back to the first model when none of the preferred families are available", async () => {
    mock.state.modelIds = ["llama-3-8b-instruct"];
    TOOL_MODEL_PREFERENCES.write_tests = ["qwen", "deepseek"];
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel(undefined, "write_tests");
    assert.equal(resolved.id, "llama-3-8b-instruct");
  });

  test("caches the shared model list once regardless of how many tools resolve against it", async () => {
    mock.state.modelIds = ["deepseek-coder-v2", "qwen2.5-coder"];
    const server = new LocalLlmServer();
    await server.resolveModel(undefined, "generate_code");
    await server.resolveModel(undefined, "write_tests");
    const modelRequests = mock.state.requests.filter((r) => r.url === "/v1/models");
    assert.equal(modelRequests.length, 1);
  });
});

describe("resolveModel with LOCAL_LLM_CHAT_MODEL / LOCAL_LLM_EMBEDDING_MODEL", () => {
  afterEach(() => {
    delete process.env.LOCAL_LLM_CHAT_MODEL;
    delete process.env.LOCAL_LLM_EMBEDDING_MODEL;
    delete TOOL_MODEL_PREFERENCES.write_tests;
  });

  test("LOCAL_LLM_CHAT_MODEL wins over the loaded model and preferences, without querying /v1/models", async () => {
    process.env.LOCAL_LLM_CHAT_MODEL = "gemma-3-4b-it";
    mock.state.modelIds = ["deepseek-coder-v2", "qwen2.5-coder"];
    TOOL_MODEL_PREFERENCES.write_tests = ["qwen"];
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel(undefined, "write_tests");
    assert.deepEqual(resolved, { id: "gemma-3-4b-it", family: "gemma" });
    assert.equal(mock.state.requests.filter((r) => r.url === "/v1/models").length, 0);
  });

  test("an explicit model argument still wins over LOCAL_LLM_CHAT_MODEL", async () => {
    process.env.LOCAL_LLM_CHAT_MODEL = "gemma-3-4b-it";
    const server = new LocalLlmServer();
    const resolved = await server.resolveModel("qwen-explicit", "generate_code");
    assert.equal(resolved.id, "qwen-explicit");
  });

  test("LOCAL_LLM_EMBEDDING_MODEL is used for semantic_similarity only", async () => {
    process.env.LOCAL_LLM_EMBEDDING_MODEL = "nomic-embed-text";
    const server = new LocalLlmServer();
    assert.equal((await server.resolveModel(undefined, "semantic_similarity")).id, "nomic-embed-text");
    assert.equal((await server.resolveModel(undefined, "generate_code")).id, "mock-org/mock-model-7b");
  });

  test("LOCAL_LLM_CHAT_MODEL isn't used for semantic_similarity", async () => {
    process.env.LOCAL_LLM_CHAT_MODEL = "gemma-3-4b-it";
    const server = new LocalLlmServer();
    assert.equal((await server.resolveModel(undefined, "semantic_similarity")).id, "mock-org/mock-model-7b");
  });

  test("the configured chat model is what's actually sent", async () => {
    process.env.LOCAL_LLM_CHAT_MODEL = "gemma-3-4b-it";
    const server = new LocalLlmServer();
    await server.generateCode({ prompt: "x", language: "python" });
    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.equal(chatRequest.body.model, "gemma-3-4b-it");
  });
});

describe("callLocalLlm / tool methods", () => {
  test("generateCode sends the built messages and returns the model's content", async () => {
    const server = new LocalLlmServer();
    const result = await server.generateCode({ prompt: "add two numbers", language: "javascript" });
    const text = result.content[0].text;
    assert.match(text, /add two numbers/);
    assert.match(text, /javascript/i);

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.ok(chatRequest, "expected a request to /v1/chat/completions");
    assert.equal(chatRequest.body.messages[0].role, "system");
    assert.equal(chatRequest.body.messages[1].role, "user");
  });

  test("every request includes a max_tokens ceiling", async () => {
    const server = new LocalLlmServer();
    await server.generateCode({ prompt: "x", language: "python" });
    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.ok(Number.isInteger(chatRequest.body.max_tokens));
    assert.ok(chatRequest.body.max_tokens > 0);
  });

  test("appends a truncation warning when the model hits the max_tokens limit", async () => {
    mock.state.finishReason = "length";
    const server = new LocalLlmServer();
    const result = await server.generateCode({ prompt: "x", language: "python" });
    assert.match(result.content[0].text, /WARNING.*truncated/i);
  });

  test("does not append a truncation warning on a normal completion", async () => {
    mock.state.finishReason = "stop";
    const server = new LocalLlmServer();
    const result = await server.generateCode({ prompt: "x", language: "python" });
    assert.doesNotMatch(result.content[0].text, /WARNING/);
  });

  test("does not send chat_template_kwargs when no reasoning override is configured", async () => {
    const server = new LocalLlmServer();
    await server.generateCode({ prompt: "x", language: "python" });
    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.equal(chatRequest.body.chat_template_kwargs, undefined);
  });

  test("sends chat_template_kwargs.enable_thinking when a reasoning override is configured for the tool", async () => {
    TOOL_REASONING_OVERRIDES.generate_code = false;
    try {
      const server = new LocalLlmServer();
      await server.generateCode({ prompt: "x", language: "python" });
      const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
      assert.deepEqual(chatRequest.body.chat_template_kwargs, { enable_thinking: false });
    } finally {
      delete TOOL_REASONING_OVERRIDES.generate_code;
    }
  });

  test("reviewFile reads the file server-side and includes its content and path in the prompt", async () => {
    const filePath = path.join(tmpDir, "sample.js");
    await fs.writeFile(filePath, "function add(a, b) { return a + b; }");

    const server = new LocalLlmServer();
    await server.reviewFile({ file_path: filePath, focus: "bugs" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /sample\.js/);
    assert.match(userMessage, /function add/);
    assert.match(userMessage, /bugs/);
  });

  test("reviewFile surfaces a clear error for a missing file", async () => {
    const server = new LocalLlmServer();
    await assert.rejects(
      () => server.reviewFile({ file_path: path.join(tmpDir, "does-not-exist.js"), focus: "bugs" }),
      /Failed to read file/
    );
  });

  test("reviewFile sends line-numbered code so findings can cite real locations", async () => {
    const filePath = path.join(tmpDir, "multiline.js");
    await fs.writeFile(filePath, "const a = 1;\nconst b = 2;\nconst c = 3;");

    const server = new LocalLlmServer();
    await server.reviewFile({ file_path: filePath, focus: "bugs" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /1\tconst a = 1;/);
    assert.match(userMessage, /2\tconst b = 2;/);
    assert.match(userMessage, /3\tconst c = 3;/);
  });

  test("explainFile sends line-numbered code the same way reviewFile does", async () => {
    const filePath = path.join(tmpDir, "explain-multiline.js");
    await fs.writeFile(filePath, "const x = 1;\nconst y = 2;");

    const server = new LocalLlmServer();
    await server.explainFile({ file_path: filePath });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /1\tconst x = 1;/);
    assert.match(userMessage, /2\tconst y = 2;/);
  });

  test("analyzeFiles concatenates all requested files into one prompt", async () => {
    const fileA = path.join(tmpDir, "a.js");
    const fileB = path.join(tmpDir, "b.js");
    await fs.writeFile(fileA, "const a = 1;");
    await fs.writeFile(fileB, "const b = 2;");

    const server = new LocalLlmServer();
    await server.analyzeFiles({ file_paths: [fileA, fileB], task: "find shared patterns" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /a\.js/);
    assert.match(userMessage, /b\.js/);
    assert.match(userMessage, /const a = 1/);
    assert.match(userMessage, /const b = 2/);
  });

  test("analyzeFiles sends each file's code with its own line numbering", async () => {
    const fileA = path.join(tmpDir, "numbered-a.js");
    await fs.writeFile(fileA, "line one\nline two\nline three");

    const server = new LocalLlmServer();
    await server.analyzeFiles({ file_paths: [fileA], task: "check" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /1\tline one/);
    assert.match(userMessage, /2\tline two/);
    assert.match(userMessage, /3\tline three/);
  });

  test("analyzeFiles expands a glob pattern into matching files", async () => {
    const fileA = path.join(tmpDir, "glob-a.js");
    const fileB = path.join(tmpDir, "glob-b.js");
    await fs.writeFile(fileA, "const a = 1;");
    await fs.writeFile(fileB, "const b = 2;");

    const server = new LocalLlmServer();
    await server.analyzeFiles({ file_paths: [path.join(tmpDir, "glob-*.js")], task: "find shared patterns" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /glob-a\.js/);
    assert.match(userMessage, /glob-b\.js/);
  });

  test("generateCodeWithContext expands a glob pattern in context_files", async () => {
    const fileA = path.join(tmpDir, "ctx-glob-a.js");
    await fs.writeFile(fileA, "const a = 1;");

    const server = new LocalLlmServer();
    await server.generateCodeWithContext({
      prompt: "x",
      language: "javascript",
      context_files: [path.join(tmpDir, "ctx-glob-*.js")],
    });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /ctx-glob-a\.js/);
  });

  test("generateCodeWithContext does NOT line-number reference files (unlike review/analyze)", async () => {
    const fileA = path.join(tmpDir, "ctx-plain.js");
    await fs.writeFile(fileA, "const a = 1;\nconst b = 2;");

    const server = new LocalLlmServer();
    await server.generateCodeWithContext({
      prompt: "x",
      language: "javascript",
      context_files: [fileA],
    });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    // Generation output shouldn't risk copying line-number artifacts, so reference files
    // stay unnumbered -- only the review/explain/analyze tools get line numbers.
    assert.doesNotMatch(userMessage, /1\tconst a = 1;/);
    assert.match(userMessage, /const a = 1;\nconst b = 2;/);
  });

  test("rejects a glob pattern that matches too many files", async () => {
    for (let i = 0; i < 51; i++) {
      await fs.writeFile(path.join(tmpDir, `many-${i}.js`), "// x");
    }

    const server = new LocalLlmServer();
    await assert.rejects(
      () => server.analyzeFiles({ file_paths: [path.join(tmpDir, "many-*.js")], task: "x" }),
      /exceeds the limit/
    );
  });

  test("a plain literal path with no glob metacharacters is unaffected", async () => {
    const filePath = path.join(tmpDir, "literal.js");
    await fs.writeFile(filePath, "const literal = true;");

    const server = new LocalLlmServer();
    await server.analyzeFiles({ file_paths: [filePath], task: "x" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.match(chatRequest.body.messages[1].content, /const literal = true/);
  });

  test("an explicit model argument overrides auto-detection for the actual request", async () => {
    const server = new LocalLlmServer();
    await server.generateCode({ prompt: "x", language: "python", model: "deepseek-explicit" });
    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.equal(chatRequest.body.model, "deepseek-explicit");
  });
});

describe("digestFile", () => {
  const lastPrompt = () =>
    mock.state.requests.filter((r) => r.url === "/v1/chat/completions").at(-1).body.messages[1].content;

  test("sends the whole log line-numbered, with the question and file details", async () => {
    const logPath = path.join(tmpDir, "test.log");
    await fs.writeFile(logPath, "running 3 tests\nok 1\nnot ok 2 - adds numbers\nok 3\n");
    const server = new LocalLlmServer();
    await server.digestFile({ file_path: logPath, question: "which test failed?" });
    const prompt = lastPrompt();
    assert.match(prompt, /^QUESTION: which test failed\?/);
    assert.match(prompt, /FILE: test\.log\nPATH: .*test\.log\nLINES: 5\n/);
    assert.match(prompt, /^3\tnot ok 2 - adds numbers$/m);
    assert.doesNotMatch(prompt, /omitted/);
  });

  test("strips terminal color codes", async () => {
    const logPath = path.join(tmpDir, "color.log");
    await fs.writeFile(logPath, "\x1b[31mFAIL\x1b[0m test/a.test.js\n\x1b[2K\x1b[1Gdone\n");
    const server = new LocalLlmServer();
    await server.digestFile({ file_path: logPath });
    const prompt = lastPrompt();
    assert.match(prompt, /^1\tFAIL test\/a\.test\.js$/m);
    assert.match(prompt, /^2\tdone$/m);
    assert.ok(!prompt.includes("\x1b"), "escape codes left in the prompt");
  });

  test("a log over the budget keeps its start and end, with original line numbers and a marker", async () => {
    const logPath = path.join(tmpDir, "huge.log");
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i + 1}: progress output that nobody needs to read`);
    lines[0] = "line 1: START of the run";
    lines[19999] = "line 20000: 1 test FAILED";
    await fs.writeFile(logPath, lines.join("\n"));
    const server = new LocalLlmServer();
    await server.digestFile({ file_path: logPath });
    const prompt = lastPrompt();
    assert.ok(prompt.length < 101_000, `prompt is ${prompt.length} chars`);
    assert.match(prompt, /^1\tline 1: START of the run$/m);
    assert.match(prompt, /^20000\tline 20000: 1 test FAILED$/m);
    const marker = /\[\.\.\. lines (\d+)-(\d+) omitted \((\d+) lines\) \.\.\.\]/.exec(prompt);
    assert.ok(marker, "expected an omitted-lines marker");
    const [, from, to, count] = marker.map(Number);
    assert.equal(count, to - from + 1);
    assert.match(prompt, new RegExp(`^${from - 1}\\t`, "m")); // last head line is right before the gap
    assert.match(prompt, new RegExp(`^${to + 1}\\t`, "m")); // first tail line is right after it
    assert.match(prompt, new RegExp(`LINES: 20000 \\(lines ${from}-${to} omitted to fit`));
    // Most of the budget goes to the end, where failures usually are.
    assert.ok(20000 - to > from * 3, `head ${from - 1} lines, tail ${20000 - to} lines`);
  });

  test("a missing file is a clear error", async () => {
    const server = new LocalLlmServer();
    await assert.rejects(() => server.digestFile({ file_path: path.join(tmpDir, "nope.log") }), /Failed to read file .*nope\.log/);
  });
});

describe("serverInfo", () => {
  test("merges /props and /v1/models into one report", async () => {
    mock.state.modelId = "qwen-2.5-coder-7b";
    mock.state.props = {
      default_generation_settings: { n_ctx: 32768 },
      total_slots: 2,
      chat_template: "{{ x }}",
    };

    const server = new LocalLlmServer();
    const result = await server.serverInfo();
    const info = JSON.parse(result.content[0].text);

    assert.equal(info.model_id, "qwen-2.5-coder-7b");
    assert.equal(info.model_family, "qwen");
    assert.equal(info.context_size, 32768);
    assert.equal(info.total_slots, 2);
    assert.equal(info.has_chat_template, true);
  });

  test("degrades gracefully when /props isn't implemented (e.g. vLLM, LM Studio)", async () => {
    mock.state.modelId = "some-org/some-model";
    mock.state.propsAvailable = false;
    try {
      const server = new LocalLlmServer();
      const result = await server.serverInfo();
      const info = JSON.parse(result.content[0].text);

      assert.equal(info.model_id, "some-org/some-model");
      assert.equal(info.context_size, null);
      assert.equal(info.total_slots, null);
      assert.equal(info.has_chat_template, null);
    } finally {
      mock.state.propsAvailable = true;
    }
  });
});

describe("sessionStats", () => {
  test("starts at zero before any calls", () => {
    const server = new LocalLlmServer();
    const stats = JSON.parse(server.sessionStats().content[0].text);
    assert.deepEqual(stats, {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      perTool: {},
      thinkingDecisions: { model: null, decided: 0, thinkOn: 0, thinkOff: 0, unsure: 0, failed: 0 },
    });
  });

  test("accumulates usage across calls, with a per-tool breakdown", async () => {
    mock.state.usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    const server = new LocalLlmServer();

    await server.generateCode({ prompt: "x", language: "python" });
    await server.generateCode({ prompt: "y", language: "python" });
    mock.state.usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
    await server.explainCode({ code: "z" });

    const stats = JSON.parse(server.sessionStats().content[0].text);
    assert.equal(stats.calls, 3);
    assert.equal(stats.promptTokens, 25);
    assert.equal(stats.completionTokens, 47);
    assert.equal(stats.totalTokens, 72);
    assert.deepEqual(stats.perTool.generate_code, { calls: 2, promptTokens: 20, completionTokens: 40, totalTokens: 60 });
    assert.deepEqual(stats.perTool.explain_code, { calls: 1, promptTokens: 5, completionTokens: 7, totalTokens: 12 });
  });

  test("tolerates a response with no usage field instead of crashing", async () => {
    const server = new LocalLlmServer();
    const originalUsage = mock.state.usage;
    mock.state.usage = undefined;
    try {
      await server.generateCode({ prompt: "x", language: "python" });
    } finally {
      mock.state.usage = originalUsage;
    }
    const stats = JSON.parse(server.sessionStats().content[0].text);
    assert.equal(stats.calls, 0);
  });
});

describe("tokenize", () => {
  test("returns a token count without the raw token array by default", async () => {
    const server = new LocalLlmServer();
    const result = await server.tokenize({ text: "hello world" });
    const info = JSON.parse(result.content[0].text);
    assert.ok(info.token_count > 0);
    assert.equal(info.tokens, undefined);
  });

  test("includes the raw token array when include_tokens is true", async () => {
    const server = new LocalLlmServer();
    const result = await server.tokenize({ text: "hello world", include_tokens: true });
    const info = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(info.tokens));
    assert.equal(info.tokens.length, info.token_count);
  });
});

describe("semanticSimilarity", () => {
  test("ranks candidates by similarity to the query, without ever including raw vectors", async () => {
    mock.state.embeddings = (inputs) => {
      const vectors = { "find the auth code": [1, 0, 0], "login handler": [0.9, 0.1, 0], "fruit salad recipe": [0, 0, 1] };
      return inputs.map((text) => vectors[text]);
    };

    const server = new LocalLlmServer();
    const result = await server.semanticSimilarity({
      query: "find the auth code",
      candidates: ["login handler", "fruit salad recipe"],
    });
    const { results } = JSON.parse(result.content[0].text);

    assert.equal(results.length, 2);
    assert.equal(results[0].candidate, 0);
    assert.ok(results[0].score > results[1].score);
    assert.doesNotMatch(result.content[0].text, /0\.9,\s*0\.1,\s*0/);
  });

  test("rejects all-NaN vectors instead of reporting every score as null", async () => {
    // Shape is right, contents aren't: what llama-server returns for nomic-embed-text on a
    // compute backend that can't actually run it. JSON-serializes as [null, null, null].
    mock.state.embeddings = (inputs) => inputs.map(() => [NaN, NaN, NaN]);

    const server = new LocalLlmServer();
    await assert.rejects(
      () => server.semanticSimilarity({ query: "a", candidates: ["b"] }),
      /non-numeric embedding/
    );
  });

  test("resolves the model before requesting embeddings, same as other tools", async () => {
    mock.state.embeddings = (inputs) => inputs.map(() => [1, 1, 1]);
    const server = new LocalLlmServer();
    await server.semanticSimilarity({ query: "a", candidates: ["b"], model: "explicit-embed-model" });

    const embeddingRequest = mock.state.requests.find((r) => r.url === "/v1/embeddings");
    assert.equal(embeddingRequest.body.model, "explicit-embed-model");
    assert.deepEqual(embeddingRequest.body.input, ["a", "b"]);
  });
});

describe("CodeGraph context enrichment (via reviewFile)", () => {
  afterEach(async () => {
    delete process.env.CODEGRAPH_BIN;
    await fs.rm(path.join(tmpDir, ".codegraph"), { recursive: true, force: true });
  });

  test("omits codegraph context when no .codegraph/ directory exists", async () => {
    const filePath = path.join(tmpDir, "no-codegraph.js");
    await fs.writeFile(filePath, "const x = 1;");

    const server = new LocalLlmServer();
    await server.reviewFile({ file_path: filePath, focus: "bugs" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.doesNotMatch(chatRequest.body.messages[1].content, /CODEGRAPH CONTEXT/);
  });

  test("includes codegraph output when .codegraph/ exists and the binary succeeds", async () => {
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const stubBinPath = path.join(tmpDir, "fake-codegraph.sh");
    await fs.writeFile(stubBinPath, "#!/bin/sh\necho 'FAKE_CODEGRAPH_OUTPUT_MARKER'\n");
    await fs.chmod(stubBinPath, 0o755);
    process.env.CODEGRAPH_BIN = stubBinPath;

    const filePath = path.join(tmpDir, "with-codegraph.js");
    await fs.writeFile(filePath, "const x = 1;");

    const server = new LocalLlmServer();
    await server.reviewFile({ file_path: filePath, focus: "bugs" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.match(chatRequest.body.messages[1].content, /FAKE_CODEGRAPH_OUTPUT_MARKER/);
  });

  test("falls back silently (tool still succeeds) when .codegraph/ exists but the binary is missing", async () => {
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    process.env.CODEGRAPH_BIN = "/definitely/not/a/real/binary";

    const filePath = path.join(tmpDir, "missing-binary.js");
    await fs.writeFile(filePath, "const x = 1;");

    const server = new LocalLlmServer();
    const result = await server.reviewFile({ file_path: filePath, focus: "bugs" });
    assert.ok(result.content[0].text);

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.doesNotMatch(chatRequest.body.messages[1].content, /CODEGRAPH CONTEXT/);
  });
});
