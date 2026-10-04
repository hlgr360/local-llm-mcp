# Changelog

## Unreleased - Attribution

### Documentation
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
