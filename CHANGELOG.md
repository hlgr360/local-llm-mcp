# Changelog

## Version 3.6.0 - Embed-only mode for embedding-model backends

### Features
- **`LOCAL_LLM_EMBED_ONLY`**: set it (`1`/`true`/`yes`/`on`, case-insensitive) to front an
  embedding model instead of a generative one. An embedding backend serves `/v1/embeddings`
  and `/tokenize` but has no chat-completion endpoint and usually no chat template, so the
  fourteen chat-backed tools can only ever fail against it. In this mode `ListTools` is
  filtered to the three tools such a backend can serve (`semantic_similarity`, `tokenize`,
  `server_info`), the MCP `instructions` describe an embedding server rather than code
  offloading, and `server_info` reports `embed_only`. A chat tool called anyway — by a client
  holding a tool list from before the flag was set — fails with an error naming the mode and
  the available tools, instead of a 404 from `/v1/chat/completions` or a missing-template
  error from the backend. The motivating case is one agent with several of these servers
  configured at once, where an embeddings backend would otherwise contribute fourteen tools
  indistinguishable from the generative server's.

### Fixes
- **`semantic_similarity` now rejects non-numeric embeddings** instead of reporting every
  score as `null`. A backend can answer `200` with correctly-shaped vectors whose elements
  are all NaN — found immediately when smoke-testing embed-only mode against a real
  `llama-server` fronting `nomic-embed-text-v1.5` on a Vulkan build, where both
  `/v1/embeddings` and the legacy `/embedding` returned 768 nulls. `cosineSimilarity` over
  those returns NaN, which `JSON.stringify` renders as `null`, so the call *looked* like a
  success and returned a meaningless ranking. The mock backend never produced this, so no
  existing test caught it.

### Tests
- `test/embed-only.test.js` spawns the real entry point with `LOCAL_LLM_EMBED_ONLY=1` and
  asserts over MCP JSON-RPC: the exact three-tool `tools/list`, embedding-specific
  `instructions` (and the absence of the file-aware steering), `semantic_similarity` and
  `tokenize` still working, a filtered chat tool erroring *without* reaching
  `/v1/chat/completions`, and `embed_only: true` in `server_info`. Its own process, since
  the flag is read at module import time like `LOCAL_LLM_BASE_URL`.
- Added an all-NaN embedding case to `test/server.test.js`'s `semanticSimilarity` suite.

## Version 3.5.0 - Prompt hook that points Claude at the right tool

### Added
- **`UserPromptSubmit` hook** (`hooks/local-llm-prompt-nudge.sh`, Claude Code plugin): when a
  prompt asks to review git changes, look into test/build/CI output or logs, review or explain
  a file, or relate several files, it adds one line to Claude's context naming the matching
  `local_llm_*` tool and noting that it's a deferred MCP tool. Claude Code loads MCP tools as
  deferred names, and on a fresh install Claude rarely used them unprompted. Words are matched
  first, so most prompts cost no network call; a hint is only added when a local LLM server
  answers (~40 ms on a match against a real Ollama). Silent otherwise.
- `hooks/local-llm-common.sh`: the server check, now shared by both hooks.
- `test/hooks.test.js`: both hooks run as real processes (23 tests), including the Read gate,
  which had no tests before.

### Added (scripts)
- `scripts/ollama-patch-env.sh`: sets Ollama's server-side environment variables (e.g.
  `OLLAMA_CONTEXT_LENGTH`) in the Homebrew launchd plist and reloads the service; a no-op when
  they're already set. Described in the README's "Using Ollama" section.

### Fixed
- `ollama-patch-env.sh` took its `.bak` backup after editing the plist, so the backup held the
  patched file. It now saves the original before any change and keeps it as `.bak` only when
  something changed.

## Version 3.4.0 - Thinking decisions, review_diff, digest_file

### Features
- **Thinking decisions (Ollama).** A decision model such as Laya (`ollama pull laya`) chooses
  per request whether the chat model thinks: before each chat call the server asks it
  (`POST /v1/systemone`) for low or high reasoning and sends `think: false/true`. On
  automatically when a model with the `decision` capability is installed and the chat model
  has `thinking`; `LOCAL_LLM_DECISION_MODEL` pins one (pulled if missing) or `off` disables it.
  Only answers at probability >= 0.65 apply (shipped decision models are over-confident);
  anything else, or a failure, keeps the model's default. `TOOL_REASONING_OVERRIDES` still
  wins. The decision model sees the tool's one-line task, the agent's instruction and the
  code line count, never the code: without the task line, a review with no focus came back
  "low" (0.74); with it, "high" (0.79). `local_llm_session_stats` reports
  `thinkingDecisions`. Measured with Laya and gemma4:e4b on an M4: ~150 ms per decision,
  low for `is_even` (2.3s answer), high for a race-condition fix (26s).
- **`local_llm_review_diff`**: reviews git changes (uncommitted, staged, or a branch since
  `base`) by running `git diff` server-side, so the diff never enters the agent's context.
  Lines carry their new-file line numbers, so findings cite real `file:line` locations.
  Safety: no shell, only `git diff`, refs validated (never starting with `-`, since
  `git diff --output=` writes files), paths after `--`, and `--no-ext-diff`, `--no-textconv`
  and `core.fsmonitor=false` so a repository's config can't run programs.
- **`local_llm_digest_file`**: digests a long log or command output file into the outcome
  (counts copied from the runner's summary, including cancelled/skipped), each failure with
  its line numbers and exact message, and the likely cause. Color codes stripped; logs over
  ~100k characters keep 20% start / 80% end with an omitted-lines marker. The server
  instructions suggest redirecting long command output to a file and digesting it.

### Tests
- Thinking decisions in `test/ollama.test.js` (mock `/v1/systemone`); `test/review-diff.test.js`
  against real temporary git repositories, including option injection and a hostile repo
  config; `digestFile` in `test/server.test.js`. 169 passing.

## Version 3.3.0 - Find the local server automatically

### Features
- **No `LOCAL_LLM_BASE_URL` needed for the common setups.** Without it, the server looks for
  a running Ollama at `localhost:11434`, then llama-server at `localhost:8080`, and uses the
  first that answers. The checks are strict (Ollama's version reply, or an OpenAI-style model
  list), so an unrelated app on 8080 isn't mistaken for a model server. `LOCAL_LLM_BASE_URL`
  still wins when set. Previously the default was `localhost:8080` only.
- The server found is remembered until it stops answering; the next call then searches
  again, so switching servers doesn't need a restart. A connection reset (a server stopped
  while a kept-alive connection was open) now counts as unreachable, like a refused one.
- When nothing answers, the error lists the addresses tried and says which of Ollama and
  llama-server is installed (on `PATH`) but not running, with the command to start it.
- `local_llm_server_info` reports `base_url_source` (`LOCAL_LLM_BASE_URL` or e.g.
  `auto-detected Ollama`).
- The Read-gate hook checks the same addresses when `LOCAL_LLM_BASE_URL` isn't set, so it
  works with Ollama without configuration. Its path in `hooks.json` is now quoted (flagged by
  `claude plugin validate`).

### Tests
- `test/discovery.test.js`: preference order, fallback, an unrelated server on a default
  port, `LOCAL_LLM_BASE_URL` precedence, re-detection after the server goes away, the
  "none found" message with and without an installed binary, and no caching of a failed
  search. Verified live against Ollama 0.40.2 with no configuration.

## Version 3.2.0 - Ollama backend

### Features
- **Ollama support through its native API.** The server probes `GET /api/version` once
  (cached) and, if Ollama answers, sends chat through `POST /api/chat` instead of
  `/v1/chat/completions`. `LOCAL_LLM_BACKEND=ollama|openai` skips the probe. The native API is
  the only way to set a per-request context window: verified against Ollama 0.40.2, a prompt
  larger than the window is cut down without any error (a 1024-token window kept 514 tokens of
  a ~5k-token prompt). `MAX_TOKENS` is sent as `num_predict`.
- **`LOCAL_LLM_MIN_CTX`** (default `32768`, `0` = never send `num_ctx`) is a minimum context
  window, capped at the model's maximum: a larger window configured on the Ollama side (e.g.
  `OLLAMA_CONTEXT_LENGTH=131072`) is kept rather than shrunk. Every call sends the model's
  current window back as `num_ctx`, because Ollama reloads a model on any `num_ctx` change,
  and also when `num_ctx` is omitted and the model was loaded with a non-default window (both
  verified on 0.40.2). An unloaded model is first loaded with an empty `messages: []`
  request, which loads it at the server default without generating, so its window can be read.
- **Truncated-input warning (Ollama).** Since Ollama doesn't report dropped prompt tokens, a
  response whose input came out at more than 8 characters per evaluated prompt token gets an
  appended `[WARNING: the input didn't fit the model's N-token context window ...]` note. N is
  the window the model ran at; when that's already the model's maximum, the advice is to send
  less rather than to raise `LOCAL_LLM_MIN_CTX`.
- **Ollama model detection.** Prefers the loaded model (`/api/ps`), then installed models
  (`/api/tags`), rather than Ollama's `/v1/models`, which lists every installed model.
  `resolveModel` now filters by reported capabilities: chat tools only pick `completion`
  models, `local_llm_semantic_similarity` only `embedding` models, with an install hint when
  there is none. Backends that don't report capabilities are unaffected.
- **`LOCAL_LLM_CHAT_MODEL` / `LOCAL_LLM_EMBEDDING_MODEL`** pin the model for chat tools and
  for `local_llm_semantic_similarity`, on any backend. They replace auto-detection for their
  tools; a per-call `model` argument still wins. With several Ollama models installed,
  auto-detection otherwise depends on what's loaded or most recently pulled.
- **Auto-pull of configured models (Ollama).** A `LOCAL_LLM_CHAT_MODEL` /
  `LOCAL_LLM_EMBEDDING_MODEL` that isn't installed is pulled via `/api/pull` on first use
  (1-hour timeout, concurrent calls share one pull, untagged names match `:latest`). Never for
  a per-call `model` argument, so the calling agent can't trigger downloads.
  `LOCAL_LLM_AUTO_PULL=0` disables it.
- Chat request errors now include the backend's own explanation from the response body, e.g.
  `Request failed with status code 404 (model 'x' not found)`.
- `TOOL_REASONING_OVERRIDES` is sent as Ollama's `think` flag with Ollama.
- `local_llm_server_info` with Ollama reports `ollama_version`, the model chat tools would use,
  `model_loaded`, the running `context_size` (`/api/ps`), the model's `max_context_size`
  (`/api/show`, known even before it's loaded), and `min_context_size`. Both backends now
  include a `backend` field.
- `local_llm_tokenize` with Ollama returns an explicit "not supported" error instead of a 404.

### Tests
- `test/ollama.test.js` with `test/helpers/mockOllamaServer.js` (shaped after real Ollama
  0.40.2 responses): detection and override, model selection by load state and capability,
  native request shape (`num_ctx`, `num_predict`, `think`), context-window selection (keeping
  a larger default, raising a smaller one, no reloads, capped at the model's maximum), both
  truncation warnings, token
  usage mapping, server info, tokenize, embeddings. Also verified by hand against a real
  Ollama 0.40.2 with `llama3.2`.

### Documentation
- New "Using Ollama" README section; AGENTS.md architecture notes updated.
- Credit the original project: this repository is a fork of
  [Jadael/OllamaClaude](https://github.com/Jadael/OllamaClaude) (AGPL-3.0). Added a `NOTICE` file
  with the attribution and the modification notice (what and since when), an "Origin and licence"
  section in the README, and the original author in `package.json`.

## Version 3.1.4 - Qwen3 prompt overrides for plain-text output, plus test coverage

### Features
- **Qwen family system-prompt overrides for `explain_code`, `review_code`, `review_file`,
  `explain_file`, `analyze_files`, and `general_task`**: verified empirically against a
  running Qwen3.6-35B-A3B server, the default prompts led this model to reliably pad
  free-form explanatory/analysis output with emoji section headers, horizontal rules, and
  markdown tables, and in `review_code` it appended a full unrequested rewrite of the input
  on top of the four requested feedback categories. Each override now explicitly instructs
  plain-text/prose output and, for `review_code`, that findings shouldn't be followed by a
  full rewrite unless asked for. Tools with an already-fixed output format (`fix_code`,
  `refactor_code`, `generate_code`, `write_tests`) didn't show this behavior and are left on
  the default prompts.

### Tests
- Added coverage for `FAMILY_OVERRIDES.qwen` in `test/prompts.test.js`: each overridden tool
  is checked for using its qwen-specific system prompt (not the default), for leaving the
  user-message builder untouched, and (for the six new overrides) for banning emoji in the
  system prompt. Previously the suite only checked that qwen falls back to defaults for a
  tool with no override, never that the actual override entries take effect.

## Version 3.1.3 - Line-numbered file content for real file:line citations

### Features
- **`review_file`/`explain_file`/`analyze_files` now send line-numbered code**: a new
  `numberLines()` helper prefixes each line with its 1-based number and a tab (matching the
  format the orchestrating agent's own file-reading tool returns) before the content reaches
  the local model. Previously the model had no way to know real line numbers and would
  confabulate one whenever a review/analysis response cited a location -- e.g. a doc
  consistency check during development cited a finding at the wrong line entirely, because
  the correct line number was simply never available to the model. The system prompts for
  these three tools now explicitly instruct the model to cite the given numbering and never
  re-derive it. `generate_code_with_context`'s reference files are deliberately left
  unnumbered, since generation output shouldn't risk copying line-number artifacts into new
  code.
- Tool descriptions for `review_file`/`explain_file`/`analyze_files` updated to tell the
  calling agent that findings now cite real line numbers.

### Fixes
- **Stale hardcoded server version**: the MCP `initialize` response's `version` field was
  hardcoded to `"3.1.0"` and had drifted from `package.json` (already at `3.1.2`). Now reads
  `packageJson.version` directly via a `package.json` import, so this can't drift again.

## Version 3.1.2 - Fix plugin manifest so it actually loads

### Fixes
- **Plugin failed to load**: `claude plugin install` reported "Duplicate hooks file detected"
  because `plugin.json` explicitly pointed `hooks` at `./hooks/hooks.json`, which is already
  auto-loaded from that default path — `manifest.hooks` should only reference *additional*
  hook files. Removed the redundant field.
- **MCP server silently not registered**: the inline `mcpServers` field in `plugin.json` isn't
  a real manifest key and was ignored (`claude plugin details` showed "MCP servers (0)").
  Moved the `local_llm` server definition to a top-level `.mcp.json`, the auto-discovered
  location, confirmed against a scaffolded reference plugin
  (`claude plugin init --with mcp --with hooks`).

## Version 3.1.1 - Drop npm registry distribution; add optional Claude Code plugin

### Breaking Changes
- **npm registry install removed**: `npx -y local-llm-mcp` (and any `npm install`/`npm publish`
  of this package) no longer works — the npm package was unpublished and won't be
  republished. `package.json` now carries `"private": true` to prevent an accidental future
  publish. Use `npx -y github:hlgr360/local-llm-mcp` (pin a release with `#v3.1.0`, etc.) or
  clone the repo locally instead — both were already documented options and are unaffected.

### Features
- **Optional Claude Code plugin**: `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`
  let Claude Code users run `/plugin marketplace add hlgr360/local-llm-mcp` to install the
  `local_llm` MCP server (via `npx` from GitHub, same as the README's Option A) plus a bundled
  `PreToolUse`/`Read` hook (`hooks/local-llm-read-gate.sh`) that nudges Claude Code toward the
  file-aware tools instead of reading whole files by hand. The hook fails open when no local
  LLM server is reachable and allows a retried `Read` on the same file, so it doesn't fight
  the `Edit` tool's read-before-edit requirement. This is Claude-Code-specific and additive —
  every other MCP client keeps using the plain config options above.

## Version 3.1.0 - Server instructions steering the orchestrating agent toward offload

### Features
- The MCP `initialize` response now includes a top-level `instructions` string (the same
  mechanism tools like CodeGraph use to steer a calling agent before it acts) telling the
  orchestrating agent to prefer the file-aware tools over reading a file itself, that
  `local_llm_analyze_files` is also good for cross-file consistency checks, and that this
  server has no internet access and can confabulate — verify its output before trusting it.
- Tightened several tool descriptions in the same direction: `review_file`/`explain_file`/
  `generate_code_with_context` now explicitly say to prefer them over reading the file
  yourself; the corresponding string-based tools (`generate_code`, `explain_code`,
  `review_code`) now point back at their file-aware sibling when a file path is available;
  `analyze_files` calls out consistency-checking, not just dependency analysis; and
  `general_task` now warns against using it for questions needing current external
  knowledge, which the model will confabulate rather than refuse.

## Version 3.0.0 - Provider-agnostic core, renamed to local-llm-mcp

### Breaking Changes
- **Package/repo renamed**: `llamacpp-mcp-server` → `local-llm-mcp`
  (`github.com/hlgr360/local-llm-mcp`, `npx local-llm-mcp`), since "llamacpp" branding
  stopped being accurate once other OpenAI-compatible backends are supported.
- **All 15 tools renamed** `llamacpp_*` → `local_llm_*` (e.g. `llamacpp_generate_code` →
  `local_llm_generate_code`). MCP has no tool-alias mechanism, so this breaks any existing
  client config referencing the old names by name — there's no smooth migration path.
- **Env vars renamed**: `LLAMACPP_BASE_URL` → `LOCAL_LLM_BASE_URL`,
  `LLAMACPP_MAX_TOKENS` → `LOCAL_LLM_MAX_TOKENS`. No dual-read fallback.
- `LlamaCppServer` class and `callLlamaCpp` method renamed to `LocalLlmServer` /
  `callLocalLlm` (affects anyone importing the class directly, e.g. in tests).

### Features
- **Provider-agnostic `serverInfo`**: the `/props` call (a llama.cpp-specific extension,
  not part of the OpenAI-compatible surface) is now best-effort. If it fails while
  `/v1/models` succeeds — e.g. against vLLM or LM Studio, which don't implement `/props` —
  `context_size`/`total_slots`/`has_chat_template` come back `null` instead of failing the
  whole call. Every other endpoint this server uses (`/v1/models`, `/v1/chat/completions`,
  `/v1/embeddings`, `/tokenize`) was already either OpenAI-standard or already
  best-effort/optional, so this was the one remaining hard llama.cpp-specific dependency.
- Generic wording throughout (tool descriptions, error messages, README) — "local LLM
  server" instead of "llama.cpp server" — since these tools now genuinely work against any
  OpenAI-compatible backend, not just llama.cpp. The `llama-server` setup walkthrough in
  the README remains the primary worked example, since it's still the only backend this
  project actually tests against.

## Version 2.5.0 - Latency controls for reasoning models

### Features
- Every request to `/v1/chat/completions` now includes a `max_tokens` ceiling (default
  `16384`, override via `LLAMACPP_MAX_TOKENS`). Diagnosed on this project's own dev
  machine: a reasoning model with no output limit can spend an unbounded number of hidden
  `<think>` tokens before answering — one `review_code` call generated 3971 tokens (most
  of it invisible reasoning) and took 89 seconds at a perfectly normal 44.6 t/s. There was
  previously no cap anywhere on generation length.
- If a response is cut short by that limit (`finish_reason: "length"`), the returned text
  now gets an appended `[WARNING: response was truncated...]` note instead of silently
  returning a cut-off answer.
- New `TOOL_REASONING_OVERRIDES` sparse map in `prompts.js` (empty/no-op by default): set
  `{ tool_name: false }` to send `chat_template_kwargs: { enable_thinking: false }` for
  that tool, skipping reasoning entirely. Measured **28s → 541ms (~50x)** for a trivial
  `generate_code` call. Not a standard OpenAI field — a Qwen3-family chat-template
  convention that `llama-server` silently ignores for model families that don't recognize
  it. Left opt-in per tool since reasoning genuinely helps on harder tasks.

## Version 2.4.0 - CodeGraph context enrichment

### Features
- The file-aware tools (`llamacpp_review_file`, `llamacpp_explain_file`,
  `llamacpp_analyze_files`, `llamacpp_generate_code_with_context`) now automatically fold
  in `codegraph explore`'s output (call paths, blast radius) when the target project has a
  CodeGraph index (`.codegraph/` directory present) — a materially better review than one
  that only sees a file in isolation. Strictly best-effort: no `.codegraph/`, no `codegraph`
  binary on `PATH`, a slow response (5s timeout), or any other failure all silently fall
  back to no enrichment. The binary is overridable via `CODEGRAPH_BIN` (mainly for tests).

## Version 2.3.0 - Glob support for multi-file tools

### Features
- `llamacpp_analyze_files` (`file_paths`) and `llamacpp_generate_code_with_context`
  (`context_files`) now accept glob patterns (e.g. `src/**/*.js`) alongside plain literal
  paths, expanded server-side via Node's built-in `fs.glob`. Expansion is capped at 50
  matched files with a clear error if exceeded, so a broad pattern can't silently balloon a
  request into hundreds of files and enormous token usage sent to the local model.
  `llamacpp_review_file`/`llamacpp_explain_file` are unchanged (still single-file tools).

### Breaking Changes
- **`engines.node` raised from `>=18.0.0` to `>=22.0.0`** — required for the built-in
  `fs.glob`/`fs.promises.glob` API used above. No new runtime dependency was added; this
  project has consistently preferred Node built-ins over dependencies (`node:test` over a
  test framework, a hand-rolled mock server over `nock`/`msw`) and this follows the same
  reasoning.

## Version 2.2.0 - Router/multi-model support

### Features
- `resolveModel` now accepts a `toolName` and, when `/v1/models` reports more than one
  loaded model (e.g. behind a `llama-swap`-style router), consults a new
  `TOOL_MODEL_PREFERENCES` map in `prompts.js` — a sparse, empty-by-default list of
  preferred model families per tool — before falling back to whichever model is listed
  first. A single-model setup (the common case) is completely unaffected: no preferences
  configured means identical behavior to before.
- The model-list cache (`fetchAvailableModels`, replacing the old single-model
  `resolveModel` cache) is now shared across tools rather than tracking one resolved model,
  so multiple tools resolving against the same model list still only cost one `/v1/models`
  request within the 30s TTL.

## Version 2.1.0 - Tokenize and semantic similarity tools

### Features
- New `llamacpp_tokenize` tool: reports how many tokens a piece of text would consume
  according to the currently loaded tokenizer, via `llama-server`'s native `/tokenize`
  endpoint. Returns just `{ token_count }` by default; pass `include_tokens: true` to also
  get the raw token ID array.
- New `llamacpp_semantic_similarity` tool: ranks candidate texts by semantic similarity to
  a query via `llama-server`'s OpenAI-compatible `/v1/embeddings` endpoint (requires
  `llama-server` to be started with `--embeddings`). Deliberately returns similarity scores
  only, never raw embedding vectors — a 768-4096 float vector serialized as tool output
  would dump thousands of tokens back into the calling agent's context, undermining this
  project's entire token-savings premise.

## Version 2.0.1 - Fix npx/global-install startup bug

### Fixes
- **Critical**: `llamacpp-mcp-server@2.0.0` silently failed to start whenever invoked
  through a symlink — which is exactly how npm's `node_modules/.bin/<name>` mechanism (and
  therefore every `npx` or global install) always invokes a package's bin. The "only
  auto-start when run directly" guard added in 2.0.0 compared `import.meta.url` against
  the raw `process.argv[1]`; that matches for `node index.js` but never matches through a
  symlink, since `import.meta.url` resolves through it while `argv[1]` doesn't. The result
  was a clean, silent exit with zero output — no error, just nothing happening. Fixed by
  realpath-resolving `process.argv[1]` before comparing.
- Added `test/bin-symlink.test.js`: a regression test that invokes `index.js` through a
  real symlink and verifies the server actually starts, since the existing integration
  test (`node index.js` directly) can't exercise this failure mode at all.
- **Correction**: 2.0.0's changelog claimed `npx github:hlgr360/llamacpp-mcp-server`
  doesn't work because "npm's git-dependency install path closes piped stdin immediately."
  That diagnosis was wrong — it was this same symlink bug the whole time, reproducible with
  a plain `node` invocation through a symlink and no npm/npx involved at all. Both
  `npx github:hlgr360/llamacpp-mcp-server` and `npx llamacpp-mcp-server` (from the npm
  registry, once this version is published) work correctly.

## Version 2.0.0 - llama.cpp backend

### Breaking Changes
- Switched backend from Ollama (`/api/generate`, `localhost:11434`) to llama.cpp's
  `llama-server` (`/v1/chat/completions`, `localhost:8080` by default, overridable via
  `LLAMACPP_BASE_URL`)
- All 11 tools renamed from `ollama_*` to `llamacpp_*`
- Server name changed to `llamacpp-mcp-server`

### Features
- **No hardcoded model**: `DEFAULT_MODEL`/`FALLBACK_MODEL` constants removed. The server
  auto-detects whichever model `llama-server` currently has loaded via `GET /v1/models`
  (cached ~30s), with an optional per-call `model` argument to override
- **Prompts indexed by model family**: new `prompts.js` holds a `DEFAULT_PROMPTS` registry
  per tool plus a sparse `FAMILY_OVERRIDES` map keyed by detected model family (`gemma`,
  `qwen`, `deepseek`, `llama`, `mistral`, `phi`, `codestral`, `generic`)
- **Structured chat requests**: tool calls now send `{system, user}` messages through
  `/v1/chat/completions` instead of hand-built raw prompt strings, letting `llama-server`
  (with `--jinja`) apply the loaded model's own chat template
- New `llamacpp_server_info` tool: reports loaded model id/family, context size, slot
  count, and chat-template presence
- **Automated test suite**: `npm test` (`node --test`) covers model resolution/caching,
  prompt building, file-aware tools, and the real MCP `tools/list`/`tools/call` routing
  against a mocked `llama-server`, no real model or network needed. `index.js` now exports
  `LlamaCppServer` and only auto-starts when run directly, so it's importable by tests
- **`AGENTS.md`**: priming notes for coding agents working in this repo
- New `llamacpp_session_stats` tool: reports cumulative prompt/completion/total token usage
  sent to/from `llama-server` so far in this session, with a per-tool breakdown, based on
  the `usage` field `llama-server` returns per request
- **`scripts/start-llama.sh`**: optional convenience launcher for `llama-server` in a
  background `tmux` session, with a small model-name → HuggingFace-repo lookup table
- **ESLint**: flat config with `@eslint/js`'s recommended ruleset only (no style/formatting
  rules), run via `npm run lint`. Fixed everything it flagged, including 7 re-thrown errors
  that now pass `{ cause: error }` so the original stack isn't lost
- Added a `bin` entry (`llamacpp-mcp-server` → `index.js`) enabling `npx`-based installs,
  both directly from GitHub (`npx github:hlgr360/llamacpp-mcp-server`) and from the npm
  registry. See 2.0.1 for a startup bug this introduced and its fix.
- Repo transferred from `klopotek-rein` to `hlgr360` on GitHub, ahead of publishing to npm
  under the same personal account

### Notes
- `--jinja` is enabled by default on recent `llama-server` builds (no longer needs passing
  explicitly, though it's harmless to)
- Reasoning models (Qwen3.x, DeepSeek-R1/-V3.x) need `--reasoning-format deepseek` on
  `llama-server`, otherwise `<think>` output leaks into `message.content` — the only field
  `callLlamaCpp` reads

## Version 1.0.0 - Initial Release

### Features

#### Core MCP Server
- Implemented MCP server using `@modelcontextprotocol/sdk`
- Ollama integration via HTTP API (localhost:11434)
- Default model: `gemma3:27b` with `gemma3:4b` fallback
- 120-second timeout for Ollama requests
- Proper error handling for connection issues

#### String-Based Tools (7 tools)
Tools that accept code as string parameters:
1. `ollama_generate_code` - Generate new code from requirements
2. `ollama_explain_code` - Explain how code works
3. `ollama_review_code` - Review code for issues and improvements
4. `ollama_refactor_code` - Refactor code to improve quality
5. `ollama_fix_code` - Fix bugs or errors in code
6. `ollama_write_tests` - Generate unit tests
7. `ollama_general_task` - Execute any general coding task

#### File-Aware Tools (4 tools) - Major Innovation!
Tools that read files directly on the MCP server, providing massive token savings:
8. `ollama_review_file` - Review a file by path
9. `ollama_explain_file` - Explain a file by path
10. `ollama_analyze_files` - Analyze multiple files together
11. `ollama_generate_code_with_context` - Generate code using reference files

**Token Savings**: File-aware tools reduce conversation token usage by ~98.75% compared to traditional read-then-analyze workflows.

### Documentation
- Comprehensive README.md with setup instructions
- Detailed test.md with test cases and validation procedures
- .gitignore for clean repository
- CHANGELOG.md (this file)

### Technical Details
- Node.js 18+ required
- ES modules (`"type": "module"`)
- Dependencies: `@modelcontextprotocol/sdk`, `axios`
- Cross-platform support (Windows, macOS, Linux)
- Absolute file paths required for file-aware tools

### Performance Characteristics
- Small tasks: 30-90 seconds
- Medium tasks: 90-180 seconds
- Large tasks: 180-300 seconds
- Token savings: Up to 98.75% with file-aware tools

### Known Limitations
- Timeouts can occur with large models on slower hardware (expected)
- No streaming responses (synchronous only)
- No caching of file contents (reads on every call)
- Requires Ollama to be running locally

### Future Enhancement Ideas
- File content caching for repeated operations
- Glob pattern support for multi-file operations
- Streaming responses for better UX
- Auto-context: automatically find related files
- File writing capabilities
- Configurable timeout per tool
- Model selection hints based on task complexity
