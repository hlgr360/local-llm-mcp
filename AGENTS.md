# AGENTS.md

Priming notes for any coding agent (Claude Code, Codex, Cursor, etc.) working in this
repo. For user-facing docs see `README.md`; for manual validation see `TEST.md`.

## What this is

A Node.js MCP server (`index.js`) that bridges a local LLM server — Ollama (native API), or
an OpenAI-compatible one such as `llama-server` (llama.cpp), vLLM, LM Studio — to
MCP-speaking coding agents, exposing 17 `local_llm_*` tools. `llama-server` is the primary
worked example; the test suite mocks both llama-server and Ollama (see README's "Using
Ollama" and "Using a Different Backend" sections). `prompts.js` holds the system/user prompt
templates, indexed by tool and by detected model family.

## Commands

```bash
npm install     # install deps (@modelcontextprotocol/sdk, axios) + devDeps (eslint)
npm test        # run the automated suite (node --test) — mocked backends, ~1.5s, no real server needed
npm run lint    # ESLint (flat config, recommended rules only — no style/formatting rules)
npm start        # run the MCP server on stdio (needs a real Ollama or llama-server, found automatically)
node --check index.js && node --check prompts.js   # quick syntax check
```

Running against a **real** server requires it to already be up: Ollama on 11434 or
llama-server on 8080 are found automatically, anything else via `LOCAL_LLM_BASE_URL`. `npm test` does not need this —
`test/helpers/mockLlamaServer.js` stands in for it (and `test/helpers/mockOllamaServer.js`
for Ollama).

## Architecture, in one pass

- `index.js` — `LocalLlmServer` class: registers tools (`ListToolsRequestSchema`), routes
  calls (`CallToolRequestSchema`), resolves/caches the currently-loaded model
  (`resolveModel`, 30s TTL), and sends chat requests (`callLocalLlm` →
  `POST /v1/chat/completions`). File-aware tools (`review_file`, `explain_file`,
  `analyze_files`, `generate_code_with_context`, `digest_file`, and `review_diff`, which runs
  `git diff` itself) read their input server-side before calling
  `callLocalLlm`, which is the whole point of this project — it saves the orchestrating
  agent from having to paste file contents into its own context.
  Exports `LocalLlmServer` and only auto-starts (`server.run()`) when run directly (guarded
  by `import.meta.url`), so tests can import the class without booting a stdio server.
  `callLocalLlm` also records each response's `usage` field on `this.tokenStats`
  (`recordTokenUsage`), which `local_llm_session_stats` reports back — an in-memory,
  per-process counter, so it naturally scopes to one client session and resets on restart.
  Every request includes a `max_tokens: MAX_TOKENS` ceiling (default 16384, override via
  `LOCAL_LLM_MAX_TOKENS`) — reasoning models have no natural output limit otherwise, and a
  single call can spend an unbounded number of hidden `<think>` tokens before answering.
  `finish_reason === "length"` appends a truncation warning rather than silently returning
  a cut-off answer. `TOOL_REASONING_OVERRIDES[toolName]` (in `prompts.js`, empty by default)
  optionally sets `chat_template_kwargs: { enable_thinking }` (Ollama: `think`) per tool — confirmed ~50x
  faster (28s → 541ms) for a trivial `generate_code` call with thinking disabled. Not a
  standard OpenAI field; it's Qwen3-specific and silently ignored by templates that don't
  recognize it.
  **Finding the server.** `locateServer()` returns `{ url, backend, source }`, cached per
  instance: `LOCAL_LLM_BASE_URL` if set (backend via `probeBackend`: `GET /api/version`,
  Ollama answers, OpenAI-compatible servers 404; `LOCAL_LLM_BACKEND=ollama|openai` skips
  it), otherwise the first of `DEFAULT_SERVERS` (Ollama :11434, then llama-server :8080)
  that `isServerAt` confirms. Every request builds its URL from `await this.serverUrl()`.
  `connectionError()` (for `isUnreachable`: ECONNREFUSED or ECONNRESET) forgets the cached
  server so the next call searches again; the "none found" error is marked ECONNREFUSED
  plus `noServerFound` so those catch blocks pass it through unwrapped. Tests replace
  `server.defaultServers` with mock URLs (`test/discovery.test.js`) and never touch the real
  default ports.
  **Two backends.** With Ollama, `callLocalLlm` goes through `ollamaChat` (native `POST /api/chat`) instead
  of `openAiChat` (`/v1/chat/completions`), because only the native API takes a per-request
  `num_ctx` — without it Ollama silently drops prompt that doesn't fit its default window.
  `ollamaContextWindow` picks it: the model's current window, raised to `LOCAL_LLM_MIN_CTX`
  (default 32768, capped at the model's max) if smaller. Always send it explicitly — Ollama
  reloads on any `num_ctx` change, and *omitting* it means "default", which also reloads a
  model loaded with another window. Unloaded models get an empty `messages: []` request
  first (loads at the server default without generating) so `/api/ps` can report it. Ollama never reports that truncation, so `ollamaChat`
  infers it (characters per evaluated prompt token > 8) and `callLocalLlm` appends a warning.
  Models come from `/api/ps` (loaded first) + `/api/tags`, carrying `capabilities`;
  `resolveModel` keeps chat tools on `completion` models and `semantic_similarity` on
  `embedding` ones. `tokenize` errors out on Ollama (no endpoint); `serverInfo` has its own
  `ollamaServerInfo`. Context windows: `ollamaMaxContext` (`/api/show`, the model's maximum,
  known unloaded) and `ollamaRunningContext` (`/api/ps`, the actual window — Ollama caps
  `num_ctx` at the maximum), both best-effort/null on failure.
  **Thinking decisions.** With Ollama and no `TOOL_REASONING_OVERRIDES` entry, `callLocalLlm`
  asks `decideThinking()` first: `resolveDecisionModel()` (`LOCAL_LLM_DECISION_MODEL`, "off",
  or the first installed model with the `decision` capability, never auto-pulled) is sent
  `decisionState()` (tool, `DECISION_TASKS[tool]` + the agent's instruction fields, code line
  count; never the code) via `POST /v1/systemone`. Only a chat model with the `thinking`
  capability is asked; only answers at probability >= `DECISION_MIN_PROBABILITY` (0.65) set
  `think`; any failure returns undefined (model default). Counted in `this.thinkingDecisions`.
  **`review_diff`** runs `git` via `execFileAsync` (no shell), only `diff`, with
  `GIT_SAFE_CONFIG` + `GIT_DIFF_FLAGS` (no ext diff, no textconv, no fsmonitor), a `base`
  checked against `SAFE_GIT_REF` (never starts with `-`; `git diff --output=` writes files) and
  paths after `--`. `annotateDiff` labels lines with new-file line numbers from the hunk
  headers. **`digest_file`**: `digestContent` strips ANSI codes, keeps the original line
  numbers, and over `DIGEST_CHAR_BUDGET` (100k chars, prefixes counted) keeps 20% head / 80%
  tail with an omitted-lines marker.
  **Plugin hooks** (`hooks/`, Claude Code only): `local-llm-read-gate.sh` (PreToolUse on Read)
  and `local-llm-prompt-nudge.sh` (UserPromptSubmit: matches the prompt's words against tool
  use cases, most specific first, and adds one `additionalContext` line naming the tool).
  Both source `local-llm-common.sh` for `local_llm_reachable` and must stay silent (`{}`)
  when nothing matches or no server answers. `test/hooks.test.js` runs them as real
  processes; it must spawn asynchronously, or the in-process mock can't answer their curl.
  `getCodeGraphContext(query, cwd)` is a best-effort helper the file-aware tools call:
  if `cwd` (default `process.cwd()`) has a `.codegraph/` directory, it shells out to
  `codegraph explore <query>` (binary overridable via `CODEGRAPH_BIN`, mainly for tests) and
  folds the output into the prompt; any failure (no `.codegraph/`, missing binary, timeout)
  returns `null` silently — never a hard dependency.
- `prompts.js` — `DEFAULT_PROMPTS[toolName]` gives `{system, user(args)}`; sparse
  `FAMILY_OVERRIDES[family][toolName]` overrides either half for models that need
  different framing. `resolveFamily(modelId)` does simple substring matching (gemma, qwen,
  deepseek, llama, mistral, phi, codestral → else `generic`). `llama-server` still applies
  the model's *own* Jinja chat template on top of whatever these produce — this file only
  controls the system/user framing text, not template syntax.

## Conventions to follow

- **Adding a tool**: (1) tool definition in `ListToolsRequestSchema` handler, (2) a
  `DEFAULT_PROMPTS` entry in `prompts.js`, (3) a method on `LocalLlmServer` calling
  `this.callLocalLlm("your_tool_key", args)`, (4) a case in the `CallToolRequestSchema`
  switch. Keep the tool name prefixed `local_llm_`.
- **No hardcoded models.** Model is auto-detected via `resolveModel`, unless the user names
  one: per-call `model` arg, then `LOCAL_LLM_CHAT_MODEL` / `LOCAL_LLM_EMBEDDING_MODEL` (user
  configuration, read per call). Don't reintroduce a default/fallback model constant in code.
  With Ollama, `ensureOllamaModel` auto-pulls a configured model that isn't installed —
  keep that limited to the env-configured names (chat, embedding, decision); a per-call
  `model` arg comes from the
  calling agent and must never trigger a download.
- **File-aware tools take absolute paths** and read files inside the MCP server process —
  don't ask the orchestrating agent to paste file contents when a `*_file`/`*_files` tool
  variant exists for that purpose.
- **`callLocalLlm` only reads `message.content`** from the chat-completion response, never
  `message.reasoning_content` (or Ollama's `message.thinking`). If you add handling for reasoning output, keep in mind the
  server needs `--reasoning-format deepseek` for those to even be split apart — see
  README's "Prompt Templates" section.
- After changing `index.js`/`prompts.js`: run `npm test` and `npm run lint`, and if you
  touched request/response shapes, re-verify against a real `llama-server` (`npm start`, or
  the MCP JSON-RPC smoke test pattern in `test/integration.test.js`) since the mocked
  backend won't catch a real model producing a genuinely different response shape.
- Re-thrown errors in a `catch` block should pass `{ cause: error }` to `new Error(...)` (ESLint's
  `preserve-caught-error` rule enforces this) so the original stack isn't lost.

## Known constraints

- Single 15-minute request timeout (`callLocalLlm`), intentionally generous for slow local
  hardware — don't "fix" this down without checking `TEST.md`'s timing notes.
- `LOCAL_LLM_MIN_CTX` is read once at module import time as a top-level constant.
  `LOCAL_LLM_BASE_URL` is read per lookup, but the result is cached per instance; the test
  files that each need their own mock still run in their own file/process.
  `LOCAL_LLM_SOCKET_PATH` and `LOCAL_LLM_EMBED_ONLY` are both import-time constants, hence
  `test/socket-transport.test.js` and `test/embed-only.test.js` each being their own
  spawned process.
- `LOCAL_LLM_EMBED_ONLY` filters `ListTools` down to `EMBED_ONLY_TOOLS` (the three tools an
  embedding backend can serve: `semantic_similarity`, `tokenize`, `server_info`) and swaps
  `SERVER_INSTRUCTIONS` for `EMBED_ONLY_INSTRUCTIONS`. **Adding a tool that doesn't need
  `/v1/chat/completions` means adding it to `EMBED_ONLY_TOOLS` too** — the set is an
  allowlist, so a new primitive silently stays hidden in embed-only mode otherwise. It's
  unrelated to `resolveModel`'s capability filtering: that picks among several models on one
  Ollama server, while this is for a server dedicated to embeddings, and is the only
  mechanism available on a backend that reports no capabilities at all (llama-server).
- `LOCAL_LLM_SOCKET_PATH` makes every backend call go over a unix socket. All ~20 call sites
  go through the module-level `http` axios instance rather than bare `axios` so the socket is
  configured once — **use `http.get`/`http.post` for any new backend call**, or it will
  bypass socket mode. `locateServer` short-circuits in socket mode (nothing to discover; the
  socket is the address) and returns a placeholder `http://localhost` URL that axios needs
  for path resolution and never dials.
- `index.js`'s shebang line, its `bin` entry in `package.json`, and the
  `import.meta.url === file://${realpathSync(process.argv[1])}` auto-start guard are all
  load-bearing for `npx github:hlgr360/local-llm-mcp` to work (the npm registry package
  was unpublished; that's the only `npx` install path now). **Don't simplify that guard
  back to comparing `process.argv[1]` directly** —
  npm's `node_modules/.bin/<name>` mechanism always invokes a package's bin through a
  symlink, and `import.meta.url` resolves through it while a non-realpath'd `argv[1]`
  doesn't, so they'd silently never match. This exact regression shipped in 2.0.0 (fixed
  in 2.0.1) — see `test/bin-symlink.test.js`, which is the only test that can catch it,
  since a direct `node index.js` invocation (no symlink) can't reproduce the bug.
- `test/server.test.js` `chdir`s into its temp directory for the whole file, specifically
  so `getCodeGraphContext`'s default `process.cwd()` doesn't accidentally find *this
  repo's own* real `.codegraph/` index during test runs (which happened once — tests got
  10x slower and non-hermetic before this fix). Keep that `chdir` if you add more tests
  here; don't assume `process.cwd()` is a safe default to rely on in tests.
