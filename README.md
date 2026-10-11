# local-llm-mcp

This MCP (Model Context Protocol) server bridges a local LLM server — **Ollama** (through its
native API), or any **OpenAI-compatible** server such as llama.cpp's `llama-server`, vLLM, LM
Studio, or anything else that speaks the `/v1/chat/completions` API — to **any MCP-speaking coding agent** — Claude Code, Cursor,
Codex CLI, Cline, Windsurf, or your own MCP client — letting you delegate coding tasks to
your local models to minimize cloud API token usage. It speaks standard MCP over stdio, so
nothing here is Claude-specific; the setup instructions below use Claude Code as the
reference example since that's what's included (`claude-mcp-config.json`), but the same
`node index.js` command works as the MCP server entry for any client.

`llama-server` is used as the worked example throughout this README. See "Using Ollama"
below for Ollama, and "Using a Different Backend" for vLLM, LM Studio, or anything else
OpenAI-compatible. The test suite runs against mocked llama-server and Ollama backends.

## How It Works

Your coding agent acts as the **orchestrator**, calling tools provided by this MCP
server. The tools run on your local backend (`llama-server`, vLLM, LM Studio, etc.), and
the agent reviews/refines the results as needed. This approach:

- ✅ Minimizes cloud API token usage (up to 98.75% reduction with file-aware tools!)
- ✅ Leverages your local compute resources
- ✅ Works across any project/session, in any MCP-compatible client
- ✅ Lets the orchestrating agent provide oversight and corrections
- ✅ Auto-detects whichever model your backend currently has loaded — no hardcoded model name

## Available Tools

### String-Based Tools (Pass code as arguments)

These tools accept code as string parameters - useful when code is already in the conversation:

1. **local_llm_generate_code** - Generate new code from requirements
2. **local_llm_explain_code** - Explain how code works
3. **local_llm_review_code** - Review code for issues and improvements
4. **local_llm_refactor_code** - Refactor code to improve quality
5. **local_llm_fix_code** - Fix bugs or errors in code
6. **local_llm_write_tests** - Generate unit tests
7. **local_llm_general_task** - Execute any general coding task

### File-Aware Tools (Massive token savings!)

These tools read files directly on the MCP server, dramatically reducing conversation token usage:

8. **local_llm_review_file** - Review a file by path (saves ~98.75% tokens vs reading + reviewing)
9. **local_llm_explain_file** - Explain a file by path
10. **local_llm_analyze_files** - Analyze multiple files together to understand relationships.
    `file_paths` entries may be glob patterns (e.g. `src/**/*.js`), expanded server-side
    (capped at 50 matched files)
11. **local_llm_generate_code_with_context** - Generate code using existing files as reference
    patterns. `context_files` also supports glob patterns, same as above
12. **local_llm_review_diff** - Review git changes without the diff entering the agent's
    context: the server runs `git diff` itself (read-only). Reviews uncommitted changes by
    default, only staged ones with `staged: true`, or what a branch adds since `base` (like a
    pull request: `git diff <base>...HEAD`), optionally limited to `paths`. Each line is
    labelled with its line number in the new file, so findings cite real `file:line`
    locations. See "Reviewing git changes" below
13. **local_llm_digest_file** - Digest a long log or command output file (test run, build,
    CI log): the outcome with the runner's own counts, each distinct failure with its line
    numbers and exact message, and the likely cause. Redirect a command's output to a file
    first (`npm test > /tmp/test.log 2>&1`). Color codes are stripped; logs over about 100k
    characters keep their start and, mostly, their end, with a marker naming the skipped lines

### Introspection

14. **local_llm_server_info** - Reports which model your backend currently has loaded, its
    context size, slot count, and whether it has a chat template — useful for any agent to
    check what's actually running before assuming a model or capability. The context-size/
    slot/chat-template fields come from llama-server's `/props` extension and come back
    `null` on backends that don't implement it (see "Using a Different Backend" below). With
    Ollama it reports the model chat tools would use, whether it's loaded, the largest
    context window it supports (`max_context_size`, from `/api/show`), and the window it's
    actually running at (`context_size`, from `/api/ps`; `null` until the model is loaded).
    See "Using Ollama" below.
15. **local_llm_session_stats** - Reports cumulative prompt/completion/total token usage sent
    to and received from your backend so far in this session, with a per-tool breakdown —
    based on the `usage` field the backend returns per request. Answers "how many tokens
    have actually been offloaded to the local model instead of my own context?" Also
    reports `thinkingDecisions`: how often a decision model turned thinking on or off (see
    "Thinking decisions" below)

### Primitives

16. **local_llm_tokenize** - Counts how many tokens a piece of text would consume according to
    the currently loaded tokenizer, via `/tokenize` — a llama.cpp/llama-server extension, not
    a standard OpenAI endpoint. Useful for checking context-window fit before sending large
    content. Not available with Ollama, which has no tokenize endpoint.
17. **local_llm_semantic_similarity** - Ranks candidate texts by semantic similarity to a query
    using the backend's `/v1/embeddings` endpoint (standard OpenAI surface, but requires an
    embeddings-capable model to be loaded — for llama-server, start it with `--embeddings`).
    Returns similarity scores only, never raw embedding vectors, since a 768-4096 float vector
    serialized as tool output would dump thousands of tokens back into the calling agent's
    context — the opposite of this project's point.

## Setup Instructions

You don't need to clone this repo to use it — see "Configure Your MCP Client" below for
running it via `npx`. Cloning is only needed if you want to develop on it (run the test
suite, edit `prompts.js`, etc.).

### 1. Install Dependencies (only if you cloned the repo)

```bash
npm install
```

### 2. Run `llama-server`

Start `llama-server` with a model, with **`--jinja` enabled** so it applies the model's own
chat template when this server calls `/v1/chat/completions` (recent `llama-server` builds
enable this by default — pass `--jinja` explicitly anyway if you're not sure which build
you're on, or use `--no-jinja` to opt out):

```bash
llama-server -m /path/to/model.gguf --jinja --port 8080
```

Optionally give it a friendly name with `--alias` (otherwise the model `id` reported by the
server defaults to the gguf file path, or the HuggingFace repo:tag if loaded via `-hf`).
For example, loading a model straight from HuggingFace with GPU offload and a larger
context window:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_M -ngl 999 -fa on -c 65536 --port 8080
```

For reasoning models (like the Qwen3.6 example above, or DeepSeek-R1/-V3.x), also add
`--reasoning-format deepseek` so the model's `<think>...</think>` output is split into
`message.reasoning_content` instead of leaking into `message.content` — the only field
this server reads (see "Prompt Templates" below for why that matters):

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_M -ngl 999 -fa on -c 65536 --port 8080 --reasoning-format deepseek
```

`scripts/start-llama.sh` wraps a command like this in a background `tmux` session, with a
small model-name → HuggingFace-repo lookup table you can edit for your own models:

```bash
./scripts/start-llama.sh qwen3.6   # edit the case block in the script to add your own
```

Verify it's up and see what it reports as loaded:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/v1/models
```

### Finding the server

With no configuration, the server looks for a running local LLM server itself, in this order:

1. **Ollama** at `http://localhost:11434` (it must answer `GET /api/version`)
2. **llama-server** at `http://localhost:8080` (it must answer `GET /v1/models` with a model
   list, so an unrelated app listening on 8080 isn't mistaken for it)

The first one that answers is used, and remembered until it stops answering. The next call
then searches again, so switching from one server to the other doesn't need a restart. If
neither answers, the error names what was tried and which of the two is installed but not
running, with the command that starts it. `local_llm_server_info` reports which server was
used and how it was found (`base_url_source`).

Set `LOCAL_LLM_BASE_URL` to skip the search, e.g. for a server on another host or port, or
for vLLM and LM Studio:

```bash
export LOCAL_LLM_BASE_URL=http://localhost:8081
```

### Using Ollama

Start Ollama (`ollama serve`, or `brew services start ollama`); the server finds it on its
default port without any configuration (see "Finding the server" above). With
`LOCAL_LLM_BASE_URL` set to an Ollama address instead, the server recognizes Ollama by
probing `GET /api/version`, which OpenAI-compatible servers don't have. Set `LOCAL_LLM_BACKEND=ollama` or
`LOCAL_LLM_BACKEND=openai` to skip the probe and force either path. With Ollama:

- **Chat goes through the native `POST /api/chat`**, not Ollama's `/v1` compatibility layer,
  because only the native API lets each request set its context window. Ollama otherwise
  runs a model at its own default window and **silently drops whatever part of the prompt
  doesn't fit**, which is exactly the file contents the file-aware tools send.
- **`LOCAL_LLM_MIN_CTX`** (default `32768`) is the *minimum* window. If your Ollama already
  runs models with a larger window, for example via `OLLAMA_CONTEXT_LENGTH=131072`, that
  window is kept. Only a smaller window (Ollama's stock default, or one another client
  loaded the model with) is raised to the minimum, capped at the model's own maximum. To
  avoid reloads, every call sends the model's current window back as `num_ctx`: Ollama
  reloads a model whenever a request's `num_ctx` differs from its running window, and a
  request *without* `num_ctx` means "the default", which reloads it too. A model that isn't
  loaded yet is first loaded with an empty request, at your Ollama default, so its window
  can be read from `/api/ps`. Set `LOCAL_LLM_MIN_CTX=0` to never send `num_ctx` at all.
- **If a prompt still didn't fit**, the tool's answer gets an appended
  `[WARNING: the input didn't fit the model's N-token context window ...]` note. Ollama
  doesn't report truncation itself, so this is inferred from how few prompt tokens it
  evaluated compared to the size of the input. N is the window the model actually ran at,
  read back from `/api/ps`. If that's already the model's maximum, the warning says to send
  less rather than to raise `LOCAL_LLM_MIN_CTX`.
  `local_llm_server_info` shows both numbers for the current model.
- **Model auto-detection** prefers the model Ollama currently has loaded (`/api/ps`), then
  falls back to installed models (`/api/tags`), which Ollama loads on demand. Ollama's
  `/v1/models` isn't used for this because it lists every installed model, loaded or not.
  Chat tools only pick models with the `completion` capability, and
  `local_llm_semantic_similarity` only picks ones with `embedding` (e.g.
  `ollama pull nomic-embed-text`).
- **`TOOL_REASONING_OVERRIDES`** maps to Ollama's own `think` flag instead of
  `chat_template_kwargs`, so it works for every Ollama thinking model, not just Qwen3.
  Ollama returns reasoning separately from the answer, so no extra server flag is needed.
- **`local_llm_tokenize`** isn't available, since Ollama has no tokenize endpoint; it returns
  an error that says so.

**Server-side settings with Homebrew (macOS).** Ollama's own settings, such as its default
context window (`OLLAMA_CONTEXT_LENGTH`), are environment variables of the Ollama service,
not of this MCP server. With `brew services`, they live in the service's launchd plist
(`~/Library/LaunchAgents/sh.brew.ollama.plist`), and Homebrew regenerates that file on some
service operations and upgrades. `scripts/ollama-patch-env.sh` writes the variables listed at
its top into the plist and reloads the service, and does nothing when they're already set,
so it's safe to re-run after an upgrade. Edit its `VARS` list first; it ships with
`OLLAMA_KEEP_ALIVE=15m`, `OLLAMA_CONTEXT_LENGTH=131072`, `OLLAMA_FLASH_ATTENTION=1` and
`OLLAMA_KV_CACHE_TYPE=q8_0`.

### Using a Different Backend (vLLM, LM Studio, etc.)

This server has no llama.cpp-specific dependency in its request path — every tool talks to
the backend purely through the OpenAI-compatible surface (`/v1/models`,
`/v1/chat/completions`, `/v1/embeddings`, plus llama.cpp's own `/tokenize`). To point it at
a different backend, just start that backend and set `LOCAL_LLM_BASE_URL` to wherever it's
listening, e.g.:

```bash
# vLLM, serving an OpenAI-compatible API on port 8000
export LOCAL_LLM_BASE_URL=http://localhost:8000

# LM Studio, local server mode (default port 1234)
export LOCAL_LLM_BASE_URL=http://localhost:1234
```

A few endpoints are best-effort and degrade gracefully on backends that don't implement
them:
- **`local_llm_server_info`** calls llama-server's `/props` extension for
  `context_size`/`total_slots`/`has_chat_template`; on a backend without `/props` (vLLM, LM
  Studio) those fields come back `null` instead of failing the call.
- **`local_llm_tokenize`** uses llama-server's `/tokenize` endpoint, which isn't part of the
  OpenAI standard — check whether your backend exposes an equivalent.
- **`local_llm_semantic_similarity`** needs `/v1/embeddings`, which requires an
  embeddings-capable model to be loaded (for llama-server, start it with `--embeddings`).

Everything else — code generation, review, refactoring, the file-aware tools — works
against any backend that implements standard OpenAI chat completions.

### Embed-Only Mode (pointing at an embedding model)

An embedding model (`nomic-embed-text`, `bge-*`, `e5-*`, …) serves `/v1/embeddings` and
`/tokenize` but has no chat-completion endpoint and usually no chat template, so the fourteen
chat-backed tools can only ever fail against it. Set `LOCAL_LLM_EMBED_ONLY` to register just
the three tools such a backend can actually serve:

```bash
export LOCAL_LLM_EMBED_ONLY=1   # also accepts true/yes/on, case-insensitive
```

With it set:
- `tools/list` returns only `local_llm_semantic_similarity`, `local_llm_tokenize`, and
  `local_llm_server_info`.
- The server's MCP instructions describe an embedding backend instead of code offloading, so
  the calling agent isn't steered toward file-aware tools that aren't registered.
- A chat tool called anyway (by a client holding a stale tool list) returns an error naming
  the mode, without a doomed round trip to the backend.
- `local_llm_server_info` reports `embed_only: true`.

This matters most when one agent has several of these servers configured at once: without
the flag, an embeddings backend contributes fourteen tools that look identical to the
generative server's and fail on use. Run two entries, each with its own `LOCAL_LLM_BASE_URL`:

```json
{
  "mcpServers": {
    "codegen": {
      "command": "npx",
      "args": ["-y", "github:hlgr360/local-llm-mcp"],
      "env": { "LOCAL_LLM_BASE_URL": "http://localhost:8081" }
    },
    "embed": {
      "command": "npx",
      "args": ["-y", "github:hlgr360/local-llm-mcp"],
      "env": {
        "LOCAL_LLM_BASE_URL": "http://localhost:8080",
        "LOCAL_LLM_EMBED_ONLY": "1"
      }
    }
  }
}
```

### 3. Configure Your MCP Client

Every MCP client reads roughly the same shape of config — a command to launch the server
plus its arguments — just from a different file. This repo ships `claude-mcp-config.json`
for Claude Code/Desktop as the reference example:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

**Option A — no clone, run via `npx` straight from GitHub (recommended):**

```json
{
  "mcpServers": {
    "local_llm": {
      "command": "npx",
      "args": ["-y", "github:hlgr360/local-llm-mcp"]
    }
  }
}
```

This tracks whatever is on `main` rather than a released version — pin to a tag or commit
instead if you want stability, e.g. `github:hlgr360/local-llm-mcp#v3.1.0`. This project isn't
published to the npm registry — `npx` installing straight from the git repo is the only
"no clone" option.

**Option B — clone locally** (needed if you're developing on the server itself):

```json
{
  "mcpServers": {
    "local_llm": {
      "command": "node",
      "args": ["/Users/holger/repos/github/local-llm-mcp/index.js"]
    }
  }
}
```

**Note**: Update the path in `args` to match your actual installation location.

For any other MCP client (Cursor, Codex CLI, Cline, Windsurf, a custom client, etc.),
consult that client's docs for where its MCP config lives — the `mcpServers` entry itself
is the same for any option above, since this server only relies on standard MCP-over-stdio
and doesn't do anything Claude-specific.

### 3b. Claude Code Plugin (optional, Claude Code only)

If you use Claude Code specifically, you can install this repo as a plugin instead of
hand-editing your MCP config:

```
/plugin marketplace add hlgr360/local-llm-mcp
/plugin install local-llm-mcp@local-llm-mcp-marketplace
```

This registers the `local_llm` MCP server the same way Option A above does (via `npx` straight
from GitHub — the plugin cache itself has no build step and doesn't run `npm install`, so the
server can't run from the plugin's own bundled source), and additionally installs a
`PreToolUse` hook on `Read` that nudges Claude Code toward the file-aware tools
(`local_llm_review_file`, `local_llm_explain_file`, `local_llm_analyze_files`) instead of
reading whole files by hand. The hook only activates when a local LLM server is actually
reachable (it fails open otherwise), and only blocks the *first* `Read` of a given file per
session — a second `Read` on the same path goes through, so it doesn't fight the `Edit` tool's
own read-before-edit requirement.

It also installs a **`UserPromptSubmit` hook** that points Claude at the right tool when a
prompt asks for what the local model is good at. Claude Code loads MCP tools as deferred
names, which Claude rarely reaches for unprompted; the hook adds one line to its context
instead, e.g. *"local-llm: for long command output, redirect it to a file … and call
local_llm_digest_file on it"*. It recognizes requests to review git changes
(`local_llm_review_diff`), test, build or CI output and logs (`local_llm_digest_file`), file
reviews (`local_llm_review_file`), explanations (`local_llm_explain_file`) and cross-file
questions (`local_llm_analyze_files`). It matches the prompt's words first, so most prompts
cost no network call, and only adds the line when a local LLM server answers (about 40 ms on
a match). Both hooks share their server check (`hooks/local-llm-common.sh`) and need `jq` and
`curl`.

This is Claude-Code-specific plumbing on top of the provider-agnostic core above; every other
MCP client should keep using Option A or B. For a stronger steer in Claude Code without the
plugin, or on top of it, add a few lines to your `CLAUDE.md` saying when to offload, e.g.
reviews and explanations of larger files, test or build logs (via `local_llm_digest_file`) and
diffs you didn't write (via `local_llm_review_diff`), but not small files or files you're about
to edit.

### 4. Restart Your MCP Client

After updating the configuration, restart your client (Claude Code, or whichever agent
you configured) for the changes to take effect.

## Usage

Once configured, your agent will automatically have access to the local LLM tools. You can:

### Direct Usage
Ask the agent to use specific tools:
- "Use local_llm_generate_code to create a function that..."
- "Use local_llm_review_code to check this code for issues"
- "Use local_llm_server_info to check what model is loaded"
- "Use local_llm_session_stats to see how many tokens have been offloaded to the local model so far"

### Automatic Orchestration
Simply ask the agent to do tasks, and it will decide when to delegate to the local model:
- "Write a function to parse JSON" → the agent may delegate to the local model
- "Review this code" → the agent may use the local model for initial review, then add insights
- "Fix this bug" → the local model attempts a fix, the agent verifies and corrects if needed

## Customization

### Model Selection

There's no hardcoded model anymore. Every tool call auto-detects whichever model your
backend currently has loaded (via `GET /v1/models`, standard across OpenAI-compatible
servers, or `/api/ps` and `/api/tags` with Ollama; cached for ~30 seconds), so switching models is just a matter of restarting the
backend with a different model loaded (e.g. `llama-server`'s `-m` flag). You can still
force a specific model per call by passing an explicit `model` argument to any tool.

**Pinning a model.** Set `LOCAL_LLM_CHAT_MODEL` to the model the 14 chat tools should use,
and `LOCAL_LLM_EMBEDDING_MODEL` to the one for `local_llm_semantic_similarity`. Either one
replaces auto-detection entirely for its tools, so the choice no longer depends on what
happens to be loaded or most recently pulled. This matters most with Ollama, where several
models are typically installed. A per-call `model` argument still wins. An unknown name
fails with the backend's own message, e.g. `(model 'gemma4:e4b-typo' not found)`.

With Ollama, a configured model that isn't installed yet is **pulled automatically** on
first use (`POST /api/pull`), so the first call may take as long as the download.
Concurrent calls share one pull, and a name that can't be pulled fails with Ollama's reason
(e.g. `pull model manifest: file does not exist`). This only applies to these two settings,
never to a `model` argument passed by the calling agent, so an agent can't start downloads
on its own. `LOCAL_LLM_AUTO_PULL=0` turns it off. Set them in the `env` of your MCP client
config:

```json
{
  "mcpServers": {
    "local_llm": {
      "command": "npx",
      "args": ["-y", "github:hlgr360/local-llm-mcp"],
      "env": {
        "LOCAL_LLM_CHAT_MODEL": "gemma4:e4b-mlx",
        "LOCAL_LLM_EMBEDDING_MODEL": "nomic-embed-text"
      }
    }
  }
}
```

Order of precedence: per-call `model` argument, then `LOCAL_LLM_CHAT_MODEL` /
`LOCAL_LLM_EMBEDDING_MODEL`, then `TOOL_MODEL_PREFERENCES` (below), then auto-detection.

**Router/multi-model setups** (e.g. `llama-swap` fronting several models): when
`/v1/models` reports more than one entry, auto-detection consults `TOOL_MODEL_PREFERENCES`
in `prompts.js` — a sparse map of tool name to an ordered list of preferred model families —
before falling back to whichever model is listed first. It's empty by default, so a
single-model setup (the common case) is completely unaffected. To use it, add your own
entries:

```js
export const TOOL_MODEL_PREFERENCES = {
  write_tests: ["qwen"],
  fix_code: ["deepseek"],
};
```

### Prompt Templates (indexed by model family)

`prompts.js` holds the system/user prompt template for each tool, plus a sparse
`FAMILY_OVERRIDES` map keyed by model family (`gemma`, `qwen`, `deepseek`, `llama`,
`mistral`, `phi`, `codestral`, or `generic` as the fallback). The family is derived
automatically from whatever model id `llama-server` reports. To tune wording or framing
for a specific model family, add or edit an entry in `FAMILY_OVERRIDES`:

```js
export const FAMILY_OVERRIDES = {
  qwen: {
    write_tests: {
      system: "...", // overrides DEFAULT_PROMPTS.write_tests.system only for qwen models
    },
  },
};
```

Since requests go through `/v1/chat/completions` with `--jinja` enabled, `llama-server`
applies the loaded model's *own* chat template on top of whatever system/user messages we
send — so most models work well with the defaults, and overrides are only needed for
genuine framing differences (e.g. reasoning-style models).

For reasoning models (Qwen3.x, DeepSeek-R1/-V3.x, etc.), also start `llama-server` with
`--reasoning-format deepseek`. This server only ever reads `message.content` from the
response (see `callLocalLlm` in `index.js`) — with `--reasoning-format deepseek`,
`llama-server` splits the model's `<think>...</think>` output into a separate
`message.reasoning_content` field and leaves `content` as just the final answer. Without
it, raw thinking text leaks into every tool's returned output.

### Latency Controls (reasoning models)

A reasoning model with no output limit can spend an *unbounded* number of hidden
`<think>` tokens before ever producing a visible answer — at 50 t/s, a call that "feels"
slow despite fast raw throughput is very likely this, not a slow model or a slow network.
Confirmed on this project's own dev machine: a `review_code` call generated 3971 tokens
(most of it invisible reasoning) and took 89 seconds at a perfectly normal 44.6 t/s.

Two controls address this:

- **`LOCAL_LLM_MAX_TOKENS`** (default `16384`): every request now includes a `max_tokens`
  ceiling, bounding worst-case latency regardless of model or task. If a response is cut
  off by this limit, the tool's returned text gets an appended
  `[WARNING: response was truncated...]` note rather than silently returning a cut-off
  answer — check `llama-server`'s `finish_reason: "length"` semantics if you see this often
  and consider raising the limit for that workload.
- **`TOOL_REASONING_OVERRIDES`** in `prompts.js` (empty/no-op by default): set
  `{ tool_name: false }` to send `chat_template_kwargs: { enable_thinking: false }` for that
  tool, skipping reasoning entirely. In testing, this took a trivial `generate_code` call
  from **28 seconds down to 541ms** — roughly 50x faster for a task that didn't need
  reasoning to get right. This is a Qwen3-family chat-template convention, not a standard
  OpenAI field — `llama-server` silently ignores it for model families that don't recognize
  it, so it's harmless to leave configured even if you switch models. Reasoning generally
  *helps* on hard tasks (debugging, tricky refactors), so this is opt-in per tool, not a
  global default — you decide the speed/quality tradeoff per tool, e.g.:

```js
export const TOOL_REASONING_OVERRIDES = {
  generate_code: false,  // usually mechanical, skip thinking
  fix_code: true,        // debugging benefits from it
};
```

With Ollama the override is sent as Ollama's own `think` flag instead, which works for any
Ollama thinking model.

### Thinking decisions (Ollama, with a decision model)

A fixed setting per tool can't tell an easy request from a hard one: `fix_code` for a typo
and for a race condition get the same treatment. With Ollama, a small **decision model**
such as [Laya](https://ollama.com/library/laya) can choose per request instead. Before each
chat call, the server asks it whether the request needs low or high reasoning and sends
`think: false` or `think: true` to the chat model.

- **On automatically** when a model with Ollama's `decision` capability is installed and the
  chat model has the `thinking` capability: `ollama pull laya`, nothing else to configure.
  Without a decision model, or with a chat model that can't think, nothing changes.
- **`LOCAL_LLM_DECISION_MODEL`** picks a specific one (pulled automatically if missing, like
  the other configured models), e.g. `laya:421m-typed-decisions-mlx-fp16`; `off` disables
  thinking decisions. Without the setting, an installed decision model is used but never
  pulled.
- **Only confident answers count**: below 0.65 probability, or if the decision model fails
  for any reason, the chat model keeps its own default. A `TOOL_REASONING_OVERRIDES` entry
  always wins.
- **What the decision model sees**: the tool's one-line task (e.g. "Review these code changes
  for bugs, regressions and risky changes."), the agent's own instruction text and the
  number of code lines. Never the code itself, which wouldn't fit its 512-1024-token input
  anyway.
- `local_llm_session_stats` reports the decisions under `thinkingDecisions`.

Measured with Laya and `gemma4:e4b-mlx` on an M4: about 150 ms per decision. It chose low
for writing `is_even` (answered in 2.3s without thinking) and high for fixing a race
condition (26s with thinking). On 8 clear-cut test requests it picked the expected level 8
times out of 8; borderline requests are where it will be wrong, which is why low-confidence
answers are ignored.

### Reviewing git changes

`local_llm_review_diff` is for changes the agent didn't write or no longer has in view: a
branch against `main`, a checked-out pull request, or a long session's uncommitted work.
For edits the agent just made, it already knows the changes. The local model's review is a
cheap first pass, not a final verdict: expect some false alarms.

It only ever runs `git diff` (and its `--name-only` form), without a shell. Because `git
diff` has options that write files (`--output=<file>`), a `base` must look like a git ref
and can't start with `-`, and `paths` are passed after `--`, where git treats them as paths.
A repository's own configuration can't make it run programs either: external diff drivers
and textconv filters are skipped (`--no-ext-diff`, `--no-textconv`) and fsmonitor is
switched off. Untracked files aren't part of `git diff`; `git add -N <file>` includes them.

### CodeGraph Context Enrichment (optional)

If the project being reviewed has a CodeGraph index (`.codegraph/` directory present, from
the separately-installed `codegraph` CLI), the file-aware tools (`review_file`,
`explain_file`, `analyze_files`, `generate_code_with_context`) automatically fold in
`codegraph explore`'s output — call paths and blast radius, not just raw file content —
before sending the prompt to the local model. A code review that also sees "here's what
calls this function, here's what depends on it" is a materially better review than one
that only sees the file in isolation.

This is strictly best-effort: no `.codegraph/` directory, no `codegraph` binary on `PATH`,
a slow response (5s timeout), or any other failure all silently fall back to no enrichment
— CodeGraph is never a hard dependency for these tools to work. Override the binary used
via the `CODEGRAPH_BIN` environment variable (mainly useful for testing).

### Add New Tools

Add new tools by:
1. Adding a tool definition in the `ListToolsRequestSchema` handler in `index.js`
2. Adding a `DEFAULT_PROMPTS` entry for it in `prompts.js`
3. Creating a new method (like `generateCode`, `reviewCode`, etc.) that calls
   `this.callLocalLlm("your_tool_key", args)`
4. Adding a case in the `CallToolRequestSchema` handler

## Troubleshooting

### "Cannot connect to local LLM server" Error
- Ensure your backend is running, e.g. `llama-server -m <model.gguf> --jinja --port 8080`
  or `ollama serve`
- Without `LOCAL_LLM_BASE_URL`, only the default addresses are searched: Ollama on 11434 and
  llama-server on 8080 (see "Finding the server"). The error says which of them is installed
  but not running. Check with `curl http://localhost:11434/api/version` or
  `curl http://localhost:8080/v1/models`
- If `LOCAL_LLM_BASE_URL` is set, confirm it matches where your backend is actually listening

### Tools Not Appearing in Your MCP Client
- Verify the config path is correct
- Restart your client completely
- Check your client's logs for MCP connection errors

### Slow Responses / Timeouts
- **Expected behavior**: local model calls typically take 60-180 seconds depending on model size and hardware
- Consider using a smaller/faster model for simple tasks
- Adjust the timeout in `index.js` (currently 900000ms = 15 minutes, in `callLocalLlm`)
- Ensure your machine has adequate resources for the model
- For large files, consider using smaller models or breaking the analysis into chunks

## Example Workflows

### Basic Workflow
1. **User asks**: "Create a function to validate email addresses"
2. **Agent decides**: "This is a code generation task, I'll use local_llm_generate_code"
3. **Local model generates**: Initial code implementation
4. **Agent reviews**: Checks the code, may suggest improvements or fixes
5. **Result**: User gets locally-generated code with the agent's oversight

### File-Aware Workflow (Token Saver!)
1. **User asks**: "Review the code in index.js for security issues"
2. **Agent calls**: `local_llm_review_file` with the file path and focus="security"
3. **MCP server**: Reads index.js directly (no tokens used in conversation!)
4. **Local model analyzes**: Reviews the file
5. **Agent refines**: Adds context or additional insights
6. **Token savings**: ~98.75% compared to reading the file into conversation first

### Test Failure Workflow
1. **Agent runs**: `npm test > /tmp/test.log 2>&1` instead of reading the output directly
2. **Agent calls**: `local_llm_digest_file` with `/tmp/test.log`
3. **Local model**: reports e.g. "tests 3, pass 1, fail 1, cancelled 1" and each failure
   with its line numbers
4. **Agent reads**: only those lines of the log, if it needs more

### Multi-File Analysis Workflow
1. **User asks**: "How do index.js and package.json relate?"
2. **Agent calls**: `local_llm_analyze_files` with both file paths
3. **MCP server**: Reads both files server-side
4. **Local model analyzes**: Identifies dependencies, patterns, relationships
5. **Result**: Cross-file insights without sending files through the agent's conversation

This hybrid approach gives you the speed and cost savings of local models with the intelligence and quality assurance of your orchestrating agent.

## Performance Expectations

### Response Times
- **Small tasks** (simple code snippets): 20-60 seconds
- **Medium tasks** (function reviews, file analysis): 60-120 seconds
- **Large tasks** (multiple files, complex analysis): 120-180 seconds

Response time depends on:
- Your GPU/CPU capabilities
- Model size and quantization
- Task complexity
- File size for file-aware tools

### Token Usage
- **Traditional approach**: Read 700-line file (2000 tokens) + Review (2000 tokens) = **4000 tokens**
- **File-aware approach**: Call `local_llm_review_file` with path = **~50 tokens**
- **Savings**: ~98.75% reduction in the orchestrating agent's API token usage!

## Benefits Over Pure Local or Pure Cloud

- **vs Pure Local Model**: Your cloud agent provides architectural guidance, catches errors, and ensures quality
- **vs Pure Cloud Agent**: Significant token savings on routine coding tasks (up to 98.75%!)
- **Best of Both**: Local compute for heavy lifting, your cloud agent for orchestration and refinement

## Project Structure

```
local-llm-mcp/
├── index.js              # Main MCP server implementation
├── prompts.js            # Prompt registry, indexed by model family
├── test/                 # Automated test suite (npm test) — mocked llama-server and Ollama backends
│   ├── helpers/mockLlamaServer.js
│   ├── helpers/mockOllamaServer.js
│   ├── prompts.test.js
│   ├── server.test.js
│   ├── ollama.test.js
│   ├── discovery.test.js
│   ├── review-diff.test.js
│   ├── hooks.test.js
│   ├── server-unreachable.test.js
│   └── integration.test.js
├── scripts/
│   ├── start-llama.sh    # Optional convenience launcher for llama-server (tmux + HF model lookup)
│   └── ollama-patch-env.sh  # Sets Ollama's server env vars in its Homebrew launchd plist and reloads it
├── eslint.config.js      # ESLint flat config (recommended rules only, no style/formatting)
├── package.json          # Node.js dependencies
├── README.md             # This file
├── NOTICE                # Attribution to the original project and the modification notice
├── AGENTS.md             # Priming notes for coding agents working in this repo
├── TEST.md               # Manual test cases and validation guide
└── .gitignore             # Git ignore patterns
```

## Origin and licence

This project began as a fork of [Jadael/OllamaClaude](https://github.com/Jadael/OllamaClaude),
an MCP server that lets Claude Code use a local Ollama server, and has been substantially
modified since 2026-08-18 (among other things it now targets any OpenAI-compatible server
and any MCP-speaking coding agent). Like the original it is licensed under the
[GNU Affero General Public License v3.0](LICENSE). See [NOTICE](NOTICE) for the attribution and
the modification notice, and [CHANGELOG.md](CHANGELOG.md) for what changed.

## Contributing & Future Improvements

Potential enhancements to consider:
- **Streaming responses**: Stream local model output for faster perceived performance
- **Tool-calling passthrough**: Hand the model real tool definitions via llama-server's
  `--jinja` function-calling support instead of only returning prose
- **Caching**: Cache file contents for repeated operations
- **File writing**: Allow the model to write generated code directly to files

See `TEST.md` for detailed test cases and validation procedures.
