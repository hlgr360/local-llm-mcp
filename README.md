# local-llm-mcp

This MCP (Model Context Protocol) server bridges a local **OpenAI-compatible LLM
server** — llama.cpp's `llama-server`, vLLM, LM Studio, or anything else that speaks the
`/v1/chat/completions` API — to **any MCP-speaking coding agent** — Claude Code, Cursor,
Codex CLI, Cline, Windsurf, or your own MCP client — letting you delegate coding tasks to
your local models to minimize cloud API token usage. It speaks standard MCP over stdio, so
nothing here is Claude-specific; the setup instructions below use Claude Code as the
reference example since that's what's included (`claude-mcp-config.json`), but the same
`node index.js` command works as the MCP server entry for any client.

`llama-server` is used as the worked example throughout this README since it's the only
backend this project's test suite runs against — see "Using a Different Backend" below for
pointing this server at vLLM, LM Studio, or anything else OpenAI-compatible instead.

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

### Introspection

12. **local_llm_server_info** - Reports which model your backend currently has loaded, its
    context size, slot count, and whether it has a chat template — useful for any agent to
    check what's actually running before assuming a model or capability. The context-size/
    slot/chat-template fields come from llama-server's `/props` extension and come back
    `null` on backends that don't implement it (see "Using a Different Backend" below).
13. **local_llm_session_stats** - Reports cumulative prompt/completion/total token usage sent
    to and received from your backend so far in this session, with a per-tool breakdown —
    based on the `usage` field the backend returns per request. Answers "how many tokens
    have actually been offloaded to the local model instead of my own context?"

### Primitives

14. **local_llm_tokenize** - Counts how many tokens a piece of text would consume according to
    the currently loaded tokenizer, via `/tokenize` — a llama.cpp/llama-server extension, not
    a standard OpenAI endpoint. Useful for checking context-window fit before sending large
    content.
15. **local_llm_semantic_similarity** - Ranks candidate texts by semantic similarity to a query
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

By default this MCP server talks to `http://localhost:8080`. Override with the
`LOCAL_LLM_BASE_URL` environment variable if you run `llama-server` on a different host/port:

```bash
export LOCAL_LLM_BASE_URL=http://localhost:8081
```

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
own read-before-edit requirement. This is Claude-Code-specific plumbing on top of the
provider-agnostic core above; every other MCP client should keep using Option A or B.

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
servers, cached for ~30 seconds), so switching models is just a matter of restarting the
backend with a different model loaded (e.g. `llama-server`'s `-m` flag). You can still
force a specific model per call by passing an explicit `model` argument to any tool.

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
- Check it's on the expected port: `curl http://localhost:8080/health` (or your backend's
  equivalent health/models endpoint)
- Confirm `LOCAL_LLM_BASE_URL` (if set) matches where your backend is actually listening

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
├── test/                 # Automated test suite (npm test) — mocked llama-server backend
│   ├── helpers/mockLlamaServer.js
│   ├── prompts.test.js
│   ├── server.test.js
│   ├── server-unreachable.test.js
│   └── integration.test.js
├── scripts/
│   └── start-llama.sh    # Optional convenience launcher for llama-server (tmux + HF model lookup)
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
