#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs/promises";
import { realpathSync } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildMessages, resolveFamily, TOOL_MODEL_PREFERENCES, TOOL_REASONING_OVERRIDES } from "./prompts.js";
import packageJson from "./package.json" with { type: "json" };

const execFileAsync = promisify(execFile);

// Optional unix-domain-socket transport. When set, every backend call goes over this
// socket instead of a TCP address -- for hosts that can see the filesystem but not the
// network the model server listens on (sandboxed MCP launchers, netns-isolated
// containers). Front a TCP backend with, e.g.:
//   socat UNIX-LISTEN:/path/to/llama.sock,fork,mode=600 TCP:127.0.0.1:8081
// Server discovery is skipped in this mode -- the socket *is* the address -- and the URL
// is display-only, since Node ignores a URL's host when socketPath is set.
const LOCAL_LLM_SOCKET_PATH = process.env.LOCAL_LLM_SOCKET_PATH || null;

// Every backend call goes through this instance rather than bare axios, so socket mode is
// configured in one place instead of at each of the ~20 call sites. Absolute URLs are
// still passed per call (axios ignores their host when socketPath is set).
const http = axios.create(LOCAL_LLM_SOCKET_PATH ? { socketPath: LOCAL_LLM_SOCKET_PATH } : {});

// Embed-only mode, for fronting a dedicated embedding server (nomic-embed-text, bge, e5,
// ...) rather than a generative one. Such a backend serves /v1/embeddings and /tokenize
// but has no chat-completion endpoint and usually no chat template, so the chat-backed
// tools can only ever fail against it. Declaring it up front keeps them out of the tool
// list entirely, instead of offering the calling agent fourteen tools that error on use.
// Distinct from resolveModel's capability filtering, which picks between several models on
// one Ollama server; this is for a server that serves exactly one purpose, and is the only
// mechanism available on backends that don't report capabilities at all (llama-server).
const EMBED_ONLY = /^(1|true|yes|on)$/i.test(process.env.LOCAL_LLM_EMBED_ONLY ?? "");
const EMBED_ONLY_TOOLS = new Set([
  "local_llm_semantic_similarity",
  "local_llm_tokenize",
  "local_llm_server_info",
]);

// Where to look for a local LLM server when LOCAL_LLM_BASE_URL isn't set, in this order. Only
// a running server can be found; `binary` and `start` explain an installed-but-stopped one.
const DEFAULT_SERVERS = [
  {
    name: "Ollama",
    url: "http://localhost:11434",
    backend: "ollama",
    binary: "ollama",
    start: "`ollama serve` (or `brew services start ollama`)",
  },
  {
    name: "llama-server",
    url: "http://localhost:8080",
    backend: "openai",
    binary: "llama-server",
    start: "`llama-server -m <model.gguf> --port 8080`",
  },
];
// Defensive ceiling on generated tokens per call. With a reasoning model and no cap, a
// single tool call can spend an unbounded number of hidden <think> tokens before ever
// producing a visible answer -- this bounds worst-case latency without being tight enough
// to routinely truncate legitimate output. Override via LOCAL_LLM_MAX_TOKENS if needed.
const MAX_TOKENS = Number(process.env.LOCAL_LLM_MAX_TOKENS) || 16384;
// Minimum context window for Ollama calls (num_ctx). Ollama silently drops whatever prompt
// doesn't fit the window -- exactly the large file contents the file-aware tools send -- and
// its stock default window is small. A model already running with at least this much (e.g.
// from OLLAMA_CONTEXT_LENGTH) keeps its window; see ollamaContextWindow. Capped at the
// model's maximum. LOCAL_LLM_MIN_CTX=0 never sends num_ctx, leaving it entirely to Ollama.
// Only used with the Ollama backend; other servers fix the context size at server start.
const MIN_CTX = process.env.LOCAL_LLM_MIN_CTX === undefined ? 32768 : Number(process.env.LOCAL_LLM_MIN_CTX);
// Ordinary text tokenizes at roughly 3-5 characters per token. A prompt that comes back with
// far more characters per evaluated token than that was cut down to fit num_ctx.
const TRUNCATED_CHARS_PER_TOKEN = 8;
const MODEL_CACHE_TTL_MS = 30_000;
// Pulling a configured model can mean a multi-GB download; allow far longer than a chat call.
const PULL_TIMEOUT_MS = 60 * 60_000;
// Thinking decisions (Ollama): a decision model (e.g. Laya) answers "low or high reasoning?"
// per request, and its answer only replaces the chat model's own default when it's at least
// this sure -- shipped decision models are known to be over-confident, so this stays strict.
const DECISION_MIN_PROBABILITY = 0.65;
const DECISION_TIMEOUT_MS = 15_000; // the first call loads the decision model (~3s for Laya)
const DECISION_REQUEST_CHAR_LIMIT = 1500; // Laya reads 512-1024 tokens; keep the state well inside
const DECISION_QUESTIONS = {
  effort: {
    type: "choice",
    instructions: "How much reasoning does this coding request need before answering?",
    criteria: {
      low: "mechanical or boilerplate: one obvious step, no analysis needed",
      high: "needs analysis: debugging, security, concurrency, or multi-step design",
    },
  },
};
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 50 * 1024 * 1024;
// What review_diff accepts as a ref (branch, tag, HEAD~2, origin/main, a SHA). It can never
// start with "-", so it can't be read as an option: `git diff --output=<file>` writes files.
const SAFE_GIT_REF = /^[A-Za-z0-9_./@{}~^][A-Za-z0-9_./@{}~^-]*$/;
// Always passed to git for review_diff, so a repository's own config can't make it run
// programs: fsmonitor hooks are switched off, external diff drivers and textconv filters are
// skipped by the diff flags.
const GIT_SAFE_CONFIG = ["-c", "core.fsmonitor=false"];
const GIT_DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv"];
// How much of a log digest_file sends: about 30k tokens of typical log text, which fits the
// 32k minimum window with room for the answer. Longer logs keep their start and, mostly, their
// end, where test runners and builds print failures and summaries.
const DIGEST_CHAR_BUDGET = 100_000;
const DIGEST_HEAD_SHARE = 0.2;
// Terminal color and cursor codes, which logs captured from a TTY are full of.
// eslint-disable-next-line no-control-regex -- matching the ESC character is the point
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;
const GLOB_METACHARACTERS = /[*?[{]/;
const MAX_GLOB_MATCHES = 50;
const CODEGRAPH_CONTEXT_CHAR_LIMIT = 4000;
const CODEGRAPH_TIMEOUT_MS = 5000;

const SERVER_INSTRUCTIONS = `Offloads code-shaped work (generation, review, refactoring, explanation, test-writing) to a local LLM, saving your own context budget.

For anything already on disk, prefer the file-aware tools (local_llm_review_file, local_llm_explain_file, local_llm_analyze_files, local_llm_generate_code_with_context, local_llm_digest_file, local_llm_review_diff) over reading the file yourself and pasting it into the string-based tools -- the file-aware tools read server-side, at roughly 50 tokens of your context versus thousands for a full read. local_llm_analyze_files also works well for cross-file consistency checks (e.g. "do these docs agree with each other"), not just dependency/relationship analysis.

For commands with long output (test suites, builds, CI logs), redirect the output to a file (e.g. \`npm test > /tmp/test.log 2>&1\`) and call local_llm_digest_file on it instead of reading the output yourself; it reports the failures with line numbers, so you can then read just those lines. To review git changes you didn't write or no longer have in view (a branch against main, a checked-out PR, a long session's uncommitted work), use local_llm_review_diff; it runs git diff itself.

This server has no internet access and no knowledge of anything outside the files you point it at. Don't use it for questions needing current external knowledge (library APIs, changelogs, GitHub issues, current docs) -- it will confabulate specifics rather than refuse. Verify its output before trusting it, the same way you would a fast but occasionally-wrong reviewer.`;

const EMBED_ONLY_INSTRUCTIONS = `Fronts an embedding model, not a generative one. Two useful tools: local_llm_semantic_similarity ranks candidate texts by meaning against a query (cheap triage of a long candidate list before you read any of them), and local_llm_tokenize counts tokens with this model's tokenizer.

There is deliberately no code generation, review, or explanation here -- an embedding backend has no chat-completion endpoint, so those tools are not registered. If this session also lists a differently-named local_llm server, that one fronts a generative model; send code-shaped work there.`;

const MODEL_ARG_SCHEMA = {
  type: "string",
  description:
    "Optional model override. If omitted, the model currently loaded by the local LLM server is auto-detected.",
};

// A request that couldn't reach the server: refused outright, or reset because the server went
// away while a kept-alive connection to it was still open.
// A missing socket file is the socket-mode equivalent of a refused connection: both mean
// "nothing is listening", and both should produce the actionable message rather than a raw
// errno.
function isUnreachable(error) {
  return (
    error.code === "ECONNREFUSED" ||
    error.code === "ECONNRESET" ||
    (LOCAL_LLM_SOCKET_PATH !== null && error.code === "ENOENT")
  );
}

// The part of a log that digest_file sends, line-numbered with the original line numbers. Fits
// DIGEST_CHAR_BUDGET by keeping whole lines from the start (DIGEST_HEAD_SHARE of the budget) and
// the end (the rest), with a marker naming the lines left out in between.
function digestContent(raw) {
  const content = raw.replace(ANSI_ESCAPES, "");
  const lines = content.split("\n");
  const numbered = (from, to) => lines.slice(from, to).map((line, i) => `${from + i + 1}\t${line}`);
  if (content.length <= DIGEST_CHAR_BUDGET) {
    return { text: numbered(0, lines.length).join("\n"), totalLines: lines.length, omitted: null };
  }

  // Counts each line as sent: its line-number prefix, the line and its newline.
  const take = (budget, indices) => {
    let used = 0;
    let count = 0;
    for (const index of indices) {
      used += String(index + 1).length + 1 + lines[index].length + 1;
      if (used > budget) break;
      count += 1;
    }
    return count;
  };
  const headCount = take(DIGEST_CHAR_BUDGET * DIGEST_HEAD_SHARE, lines.keys());
  const tailIndices = Array.from({ length: lines.length - headCount }, (_, i) => lines.length - 1 - i);
  const tailCount = take(DIGEST_CHAR_BUDGET * (1 - DIGEST_HEAD_SHARE), tailIndices);
  const omitted = { from: headCount + 1, to: lines.length - tailCount };
  const marker = `[... lines ${omitted.from}-${omitted.to} omitted (${omitted.to - omitted.from + 1} lines) ...]`;
  return {
    text: [...numbered(0, headCount), marker, ...numbered(lines.length - tailCount, lines.length)].join("\n"),
    totalLines: lines.length,
    omitted,
  };
}

// Prefixes every line of a unified diff that exists in the new version of a file (context and
// added lines) with that line number, read from the hunk headers, and leaves the number blank
// for removed lines. A small model can then cite real file:line locations without having to
// work them out from "@@ -a,b +c,d @@" itself, which it does unreliably.
function annotateDiff(diff) {
  let newLine = null;
  return diff
    .split("\n")
    .map((line) => {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        return line;
      }
      if (newLine === null || line.startsWith("diff --git ")) {
        newLine = null;
        return line;
      }
      if (line.startsWith("-")) return `${"".padStart(6)} ${line}`;
      if (line.startsWith("+") || line.startsWith(" ")) return `${String(newLine++).padStart(6)} ${line}`;
      return line; // "\ No newline at end of file" and the like
    })
    .join("\n");
}

// One line saying what each tool does, sent to the decision model ahead of the agent's own
// instruction. Without it, a review called with no focus reaches Laya as an empty request and
// comes back "low" (measured: review_diff went from low 0.74 to high 0.79 with this line).
const DECISION_TASKS = {
  generate_code: "Write new code to these requirements.",
  generate_code_with_context: "Write new code to these requirements, following the reference files.",
  explain_code: "Explain what this code does and how it works.",
  explain_file: "Explain what this code does and how it works.",
  review_code: "Review this code for bugs, security issues and code quality problems.",
  review_file: "Review this code for bugs, security issues and code quality problems.",
  review_diff: "Review these code changes for bugs, regressions and risky changes.",
  refactor_code: "Refactor this code.",
  fix_code: "Fix the bug in this code.",
  write_tests: "Write unit tests for this code.",
  analyze_files: "Analyze these files together.",
  digest_file: "Summarize this log or output: find the errors and failures and their likely cause.",
};

// What a decision model sees of a request: the tool, what it does, the calling agent's own
// instruction text (whichever of these fields the tool has), and how much code comes with it --
// never the code itself, which wouldn't fit a decision model's 512-1024-token input anyway.
function decisionState(toolName, args) {
  const instruction = [DECISION_TASKS[toolName], args.prompt, args.task, args.goal, args.error, args.focus, args.context, args.question]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n")
    .slice(0, DECISION_REQUEST_CHAR_LIMIT);
  const code = [args.code, args.filesContent, args.contextSection, args.diff, args.content]
    .filter((part) => typeof part === "string")
    .join("\n");
  return {
    tool: toolName,
    request: instruction || "(no instructions beyond the tool itself)",
    code_lines: code ? code.split("\n").length : 0,
  };
}

// Whether an executable of this name is on PATH, for the "installed but not running" hint.
async function isOnPath(binary) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      await fs.access(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Prefixes each line with its 1-based line number and a tab, matching the format the
// orchestrating agent's own Read tool returns. Without this, the local model has no way to
// know real line numbers and will confabulate them when a review/analysis response cites a
// location -- used only for review_file/explain_file/analyze_files, not
// generate_code_with_context, since generation output shouldn't risk copying the numbering.
function numberLines(content) {
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

// Expands any glob patterns (entries containing *, ?, [, or {) into absolute file paths;
// plain literal paths pass through unchanged. Relative patterns resolve against
// process.cwd(). Throws if the total expansion exceeds MAX_GLOB_MATCHES, so a broad
// pattern like "**/*.js" can't silently balloon a request into hundreds of files.
async function expandFilePaths(patterns) {
  const expanded = [];
  for (const pattern of patterns) {
    if (!GLOB_METACHARACTERS.test(pattern)) {
      expanded.push(pattern);
      continue;
    }
    for await (const match of fs.glob(pattern)) {
      expanded.push(path.resolve(match));
    }
  }

  if (expanded.length > MAX_GLOB_MATCHES) {
    throw new Error(
      `Glob pattern(s) matched ${expanded.length} files, which exceeds the limit of ${MAX_GLOB_MATCHES}. Narrow your pattern(s).`
    );
  }

  return expanded;
}

// Best-effort CodeGraph enrichment: if the target project has a .codegraph/ index, runs
// `codegraph explore <query>` and folds its output (call paths, blast radius) into the
// prompt sent to the local model. Returns null on any failure -- no .codegraph/ directory,
// the `codegraph` binary missing from PATH, a timeout, or a non-zero exit -- since this is
// strictly additive and must never block a tool response or require CodeGraph to be
// installed. The binary name is overridable via CODEGRAPH_BIN for testing.
async function getCodeGraphContext(query, cwd = process.cwd()) {
  try {
    await fs.access(path.join(cwd, ".codegraph"));
  } catch {
    return null;
  }

  try {
    const bin = process.env.CODEGRAPH_BIN || "codegraph";
    const { stdout } = await execFileAsync(bin, ["explore", query], {
      cwd,
      timeout: CODEGRAPH_TIMEOUT_MS,
    });
    return stdout.slice(0, CODEGRAPH_CONTEXT_CHAR_LIMIT);
  } catch {
    return null;
  }
}

class LocalLlmServer {
  constructor() {
    this.server = new Server(
      {
        name: "local-llm-mcp",
        version: packageJson.version,
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: EMBED_ONLY ? EMBED_ONLY_INSTRUCTIONS : SERVER_INSTRUCTIONS,
      }
    );

    this.modelsCache = null;
    this.modelsCacheAt = 0;
    this.maxContextCache = new Map();
    this.confirmedModels = new Set();
    this.defaultServers = DEFAULT_SERVERS;
    this.target = null;
    this.pulls = new Map();
    this.tokenStats = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, perTool: {} };
    this.thinkingDecisions = { model: null, decided: 0, thinkOn: 0, thinkOff: 0, unsure: 0, failed: 0 };

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "local_llm_generate_code",
          description: "Generate code using your local LLM server. Use this for writing new functions, classes, or code snippets. Provide detailed requirements and context. If you have reference files to base the generated code on, use local_llm_generate_code_with_context instead so they're read server-side.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Detailed description of the code to generate, including requirements, language, and context",
              },
              language: {
                type: "string",
                description: "Programming language (e.g., javascript, python, rust)",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["prompt", "language"],
          },
        },
        {
          name: "local_llm_explain_code",
          description: "Explain how code works using your local LLM server. Use this to understand complex code sections, algorithms, or patterns already in the conversation. If the code is in a file instead, use local_llm_explain_file so it's read server-side.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to explain",
              },
              context: {
                type: "string",
                description: "Additional context about what you want to understand",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code"],
          },
        },
        {
          name: "local_llm_review_code",
          description: "Review code for issues, bugs, or improvements using your local LLM server. Use this for code already in the conversation. If the code is in a file instead, use local_llm_review_file so it's read server-side.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to review",
              },
              focus: {
                type: "string",
                description: "What to focus on (e.g., 'performance', 'security', 'best practices', 'bugs')",
                default: "general code quality",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code"],
          },
        },
        {
          name: "local_llm_refactor_code",
          description: "Refactor code to improve quality, readability, or structure using your local LLM server.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to refactor",
              },
              goal: {
                type: "string",
                description: "Refactoring goal (e.g., 'improve readability', 'reduce complexity', 'modernize syntax')",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code", "goal"],
          },
        },
        {
          name: "local_llm_fix_code",
          description: "Fix bugs or errors in code using your local LLM server. Provide the broken code and error details.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code with issues",
              },
              error: {
                type: "string",
                description: "Error message or description of the problem",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code", "error"],
          },
        },
        {
          name: "local_llm_write_tests",
          description: "Generate unit tests for code using your local LLM server.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to write tests for",
              },
              framework: {
                type: "string",
                description: "Testing framework to use (e.g., 'jest', 'pytest', 'mocha')",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code", "framework"],
          },
        },
        {
          name: "local_llm_general_task",
          description: "Execute any general coding task grounded in code/text you provide, using your local LLM server. Use this for tasks that don't fit other categories. This server has no internet access -- don't use it for questions needing current external knowledge (library APIs, docs, GitHub issues), since it will confabulate rather than refuse.",
          inputSchema: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "Detailed description of the task to perform",
              },
              context: {
                type: "string",
                description: "Any relevant context, code, or background information",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["task"],
          },
        },
        {
          name: "local_llm_review_file",
          description: "Review a file by path using your local LLM server. Prefer this over reading the file yourself and passing it to local_llm_review_code -- the MCP server reads the file directly, at a fraction of the token cost of a full read. Findings cite real line numbers (the file is sent to the model pre-numbered), so file:line locations in the response can be trusted without re-deriving them yourself -- though the findings themselves still warrant the usual verification.",
          inputSchema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Absolute path to the file to review",
              },
              focus: {
                type: "string",
                description: "What to focus on (e.g., 'performance', 'security', 'best practices', 'bugs')",
                default: "general code quality",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["file_path"],
          },
        },
        {
          name: "local_llm_explain_file",
          description: "Explain a file by path using your local LLM server. Prefer this over reading the file yourself and passing it to local_llm_explain_code -- the MCP server reads the file directly, at a fraction of the token cost of a full read. The file is sent to the model pre-numbered, so it can reference real line numbers in its explanation.",
          inputSchema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Absolute path to the file to explain",
              },
              context: {
                type: "string",
                description: "Additional context about what you want to understand",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["file_path"],
          },
        },
        {
          name: "local_llm_analyze_files",
          description: "Analyze multiple files together using your local LLM server, reading them server-side instead of you reading each one. Useful for understanding relationships/dependencies between files, or for cross-file consistency checks (e.g. do these docs agree with each other, does this doc match the current code) -- prefer this over reading each file yourself first. Each file is sent to the model pre-numbered, so findings can cite real file:line locations -- verify a citation before acting on it if precision matters, the same way you'd verify any of its other output.",
          inputSchema: {
            type: "object",
            properties: {
              file_paths: {
                type: "array",
                items: { type: "string" },
                description: "Array of absolute paths to files to analyze together",
              },
              task: {
                type: "string",
                description: "What analysis to perform (e.g., 'find dependencies', 'check consistency', 'summarize architecture')",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["file_paths", "task"],
          },
        },
        {
          name: "local_llm_generate_code_with_context",
          description: "Generate code using your local LLM server with context from existing files. Reads reference files server-side to understand patterns -- prefer this over reading the reference files yourself and pasting them into local_llm_generate_code.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Detailed description of the code to generate",
              },
              language: {
                type: "string",
                description: "Programming language (e.g., javascript, python, rust)",
              },
              context_files: {
                type: "array",
                items: { type: "string" },
                description: "Array of file paths to use as context/examples",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["prompt", "language"],
          },
        },
        {
          name: "local_llm_digest_file",
          description: "Digest a long log or command output file (test run, build, CI log, stack traces) with your local LLM server: it reports the outcome, each distinct error or failure with its line numbers and exact message, and the likely cause, instead of you reading thousands of lines. Redirect a command's output to a file first (e.g. `npm test > /tmp/test.log 2>&1`). Very long files are cut to their start and end, where failures and summaries usually are.",
          inputSchema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Absolute path to the log or output file",
              },
              question: {
                type: "string",
                description: "What to look for, if more specific than errors and failures (e.g. \"why did the integration tests time out?\")",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["file_path"],
          },
        },
        {
          name: "local_llm_review_diff",
          description: "Review git changes with your local LLM server. The server runs `git diff` itself (read-only) and reviews the result, so the diff never enters your context. Use it for changes you didn't write or no longer have in view: a branch against main, a checked-out PR, or a long session's uncommitted work before committing. Findings cite file:line in the new version. Untracked files aren't included.",
          inputSchema: {
            type: "object",
            properties: {
              repo_path: {
                type: "string",
                description: "Absolute path to the git repository (or any directory inside it)",
              },
              base: {
                type: "string",
                description: "Review what the current branch adds since it left this ref, like a pull request (git diff <base>...HEAD), e.g. \"main\" or \"origin/main\". Omit to review uncommitted changes (staged and unstaged) instead.",
              },
              staged: {
                type: "boolean",
                description: "Review only staged changes (git diff --cached). Can't be combined with base.",
                default: false,
              },
              paths: {
                type: "array",
                items: { type: "string" },
                description: "Limit the review to these files or directories (relative to the repository)",
              },
              focus: {
                type: "string",
                description: "What to focus on (e.g., \"security\", \"error handling\"); defaults to bugs, regressions and risky changes",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["repo_path"],
          },
        },
        {
          name: "local_llm_server_info",
          description: "Report which model the local LLM server currently has loaded, its context size, and its capabilities. Use this to check what's actually running before assuming a model or capability.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "local_llm_session_stats",
          description: "Report cumulative token usage sent to/received from the local LLM server so far in this session, with a per-tool breakdown. Use this to see how many tokens have been offloaded from the orchestrating agent's own context.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "local_llm_tokenize",
          description: "Count how many tokens a piece of text would consume according to the local LLM server's currently loaded tokenizer. Useful for checking context-window fit before sending large content. Needs llama-server; not available with Ollama.",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The text to tokenize",
              },
              include_tokens: {
                type: "boolean",
                description: "If true, also return the raw token ID array (omitted by default to keep output small)",
                default: false,
              },
            },
            required: ["text"],
          },
        },
        {
          name: "local_llm_semantic_similarity",
          description: "Rank a list of candidate texts by semantic similarity to a query, using the local LLM server's embedding model. Returns similarity scores only, never raw embedding vectors, to keep output small.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The text to compare candidates against",
              },
              candidates: {
                type: "array",
                items: { type: "string" },
                description: "Texts to rank by similarity to the query",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["query", "candidates"],
          },
        },
      ].filter((tool) => !EMBED_ONLY || EMBED_ONLY_TOOLS.has(tool.name)),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // A client holding a tool list from before the mode was set can still call a
        // filtered-out tool. Say why it's gone, rather than letting it fail further in as
        // a 404 on /v1/chat/completions or a missing-chat-template error.
        if (EMBED_ONLY && !EMBED_ONLY_TOOLS.has(name)) {
          throw new Error(
            `${name} is unavailable: this server runs in embed-only mode (LOCAL_LLM_EMBED_ONLY), fronting an embedding model with no chat-completion endpoint. Available here: ${[...EMBED_ONLY_TOOLS].join(", ")}.`
          );
        }

        switch (name) {
          case "local_llm_generate_code":
            return await this.generateCode(args);
          case "local_llm_explain_code":
            return await this.explainCode(args);
          case "local_llm_review_code":
            return await this.reviewCode(args);
          case "local_llm_refactor_code":
            return await this.refactorCode(args);
          case "local_llm_fix_code":
            return await this.fixCode(args);
          case "local_llm_write_tests":
            return await this.writeTests(args);
          case "local_llm_general_task":
            return await this.generalTask(args);
          case "local_llm_review_file":
            return await this.reviewFile(args);
          case "local_llm_explain_file":
            return await this.explainFile(args);
          case "local_llm_analyze_files":
            return await this.analyzeFiles(args);
          case "local_llm_generate_code_with_context":
            return await this.generateCodeWithContext(args);
          case "local_llm_review_diff":
            return await this.reviewDiff(args);
          case "local_llm_digest_file":
            return await this.digestFile(args);
          case "local_llm_server_info":
            return await this.serverInfo();
          case "local_llm_session_stats":
            return this.sessionStats();
          case "local_llm_tokenize":
            return await this.tokenize(args);
          case "local_llm_semantic_similarity":
            return await this.semanticSimilarity(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  // Builds the error for a refused connection, and forgets the server it was talking to, so the
  // next call looks for one again -- e.g. after switching from llama-server to Ollama.
  connectionError(error) {
    if (error.noServerFound) return error; // already says what was tried
    const url = this.target?.url ?? process.env.LOCAL_LLM_BASE_URL;
    this.target = null;
    this.modelsCache = null;
    if (LOCAL_LLM_SOCKET_PATH) {
      return new Error(
        `Cannot connect to local LLM server. Make sure it's listening on unix socket ${LOCAL_LLM_SOCKET_PATH} and is either Ollama or OpenAI-compatible (llama-server, vLLM, LM Studio, etc.).`,
        { cause: error }
      );
    }
    return new Error(
      `Cannot connect to local LLM server. Make sure it's running at ${url} and is either Ollama or OpenAI-compatible (llama-server, vLLM, LM Studio, etc.).`,
      { cause: error }
    );
  }

  // The server to talk to, as { url, backend, source }. LOCAL_LLM_BASE_URL wins when set;
  // otherwise the first of DEFAULT_SERVERS that answers. Cached until a connection error.
  async locateServer() {
    if (this.target) return this.target;

    // In socket mode there is nothing to discover: the socket is the address, and probing
    // default TCP ports would find an unrelated server. The URL is a placeholder axios
    // needs for path resolution and never dials. LOCAL_LLM_BACKEND still selects Ollama's
    // native request path for a socket-fronted Ollama.
    if (LOCAL_LLM_SOCKET_PATH) {
      this.target = {
        url: "http://localhost",
        backend: process.env.LOCAL_LLM_BACKEND === "ollama" ? "ollama" : "openai",
        source: `unix socket ${LOCAL_LLM_SOCKET_PATH}`,
      };
      return this.target;
    }

    const configured = process.env.LOCAL_LLM_BASE_URL;
    if (configured) {
      const backend = await this.probeBackend(configured);
      // Unreachable: don't cache a guess -- the request that follows surfaces the real
      // connection error, and the next call probes again.
      if (!backend) return { url: configured, backend: "openai", source: "LOCAL_LLM_BASE_URL" };
      this.target = { url: configured, backend, source: "LOCAL_LLM_BASE_URL" };
      return this.target;
    }

    for (const candidate of this.defaultServers) {
      if (await this.isServerAt(candidate)) {
        this.target = { url: candidate.url, backend: candidate.backend, source: `auto-detected ${candidate.name}` };
        return this.target;
      }
    }
    // Marked as a refused connection, so the request paths' existing ECONNREFUSED handling
    // passes it through connectionError unchanged instead of wrapping it.
    const error = new Error(await this.noServerFoundMessage());
    error.code = "ECONNREFUSED";
    error.noServerFound = true;
    throw error;
  }

  // "ollama" or "openai" for a configured URL, or null if nothing answers. Ollama also speaks
  // the OpenAI-compatible /v1 API, but only its native /api/chat can set a per-request context
  // window (see MIN_CTX), so it gets its own request path. Detected by probing Ollama's
  // /api/version, which OpenAI-compatible servers 404 on; LOCAL_LLM_BACKEND=ollama|openai skips
  // the probe.
  async probeBackend(url) {
    const override = process.env.LOCAL_LLM_BACKEND;
    if (override === "ollama" || override === "openai") return override;
    try {
      const response = await http.get(`${url}/api/version`, { timeout: 5000 });
      return typeof response.data?.version === "string" ? "ollama" : "openai";
    } catch (error) {
      return error.response ? "openai" : null;
    }
  }

  // Stricter than probeBackend, since nobody chose these addresses: a default port only counts
  // when the expected server answers on it (Ollama's version, or an OpenAI-style model list),
  // not just anything listening there, like an unrelated dev server on 8080.
  async isServerAt(candidate) {
    try {
      if (candidate.backend === "ollama") {
        const response = await http.get(`${candidate.url}/api/version`, { timeout: 2000 });
        return typeof response.data?.version === "string";
      }
      const response = await http.get(`${candidate.url}/v1/models`, { timeout: 2000 });
      return Array.isArray(response.data?.data);
    } catch {
      return false;
    }
  }

  async noServerFoundMessage() {
    const tried = this.defaultServers.map((candidate) => `${candidate.name} at ${candidate.url}`).join(", ");
    const installed = [];
    for (const candidate of this.defaultServers) {
      if (await isOnPath(candidate.binary)) installed.push(`${candidate.name} is installed but not running; start it with ${candidate.start}.`);
    }
    const hint = installed.length
      ? installed.join(" ")
      : "Install Ollama or llama.cpp, or set LOCAL_LLM_BASE_URL for another OpenAI-compatible server (vLLM, LM Studio, etc.).";
    return `Cannot connect to local LLM server: LOCAL_LLM_BASE_URL isn't set and none answered at the default addresses (${tried}). ${hint}`;
  }

  async detectBackend() {
    return (await this.locateServer()).backend;
  }

  async serverUrl() {
    return (await this.locateServer()).url;
  }

  // Ollama's /v1/models lists every *installed* model rather than what's loaded, so taking
  // the first entry would be arbitrary. Loaded models (/api/ps) go first, then the rest of
  // /api/tags (Ollama loads those on demand), each carrying its capabilities so resolveModel
  // can keep chat tools off embedding-only models and vice versa.
  async fetchOllamaModels() {
    const [ps, tags] = await Promise.all([
      http.get(`${await this.serverUrl()}/api/ps`, { timeout: 5000 }),
      http.get(`${await this.serverUrl()}/api/tags`, { timeout: 5000 }),
    ]);
    const loaded = ps.data?.models ?? [];
    const installed = tags.data?.models ?? [];
    const capabilitiesByName = new Map(installed.map((model) => [model.name, model.capabilities]));
    const names = [...new Set([...loaded, ...installed].map((model) => model.name))];
    return names.map((id) => ({ id, capabilities: capabilitiesByName.get(id) ?? null }));
  }

  async fetchAvailableModels() {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCacheAt < MODEL_CACHE_TTL_MS) {
      return this.modelsCache;
    }

    try {
      let models;
      if ((await this.detectBackend()) === "ollama") {
        models = await this.fetchOllamaModels();
      } else {
        const response = await http.get(`${await this.serverUrl()}/v1/models`, {
          timeout: 5000,
        });
        models = response.data?.data ?? [];
      }
      if (models.length === 0) {
        throw new Error("local LLM server reported no loaded model");
      }

      this.modelsCache = models;
      this.modelsCacheAt = now;
      return models;
    } catch (error) {
      this.modelsCache = null;
      if (isUnreachable(error)) {
        throw this.connectionError(error);
      }
      throw new Error(`Failed to discover model from local LLM server: ${error.message}`, { cause: error });
    }
  }

  // Picks a model when the caller didn't specify one. LOCAL_LLM_CHAT_MODEL /
  // LOCAL_LLM_EMBEDDING_MODEL, when set, always win -- they're the user's own choice, not a
  // model hardcoded here, and they keep the pick stable when other models get loaded or
  // pulled. Otherwise, with a single model loaded (the common case), always resolves to it. Behind a multi-model router (e.g. llama-swap),
  // consults TOOL_MODEL_PREFERENCES for the given tool before falling back to whichever
  // model /v1/models lists first. Models that report capabilities (Ollama) are first narrowed
  // to the ones that can serve this tool -- embeddings for semantic_similarity, chat otherwise.
  async resolveModel(explicitModel, toolName) {
    if (explicitModel) {
      return { id: explicitModel, family: resolveFamily(explicitModel) };
    }

    const required = toolName === "semantic_similarity" ? "embedding" : "completion";
    const configured =
      required === "embedding" ? process.env.LOCAL_LLM_EMBEDDING_MODEL : process.env.LOCAL_LLM_CHAT_MODEL;
    if (configured) {
      if ((await this.detectBackend()) === "ollama") await this.ensureOllamaModel(configured);
      return { id: configured, family: resolveFamily(configured) };
    }

    const models = (await this.fetchAvailableModels()).filter(
      (model) => !model.capabilities || model.capabilities.includes(required)
    );
    if (models.length === 0) {
      const hint = required === "embedding" ? " Install one, e.g. `ollama pull nomic-embed-text`." : "";
      throw new Error(`No available model supports ${required}, which ${toolName} needs.${hint}`);
    }

    const preferredFamilies = TOOL_MODEL_PREFERENCES[toolName];
    if (preferredFamilies) {
      for (const family of preferredFamilies) {
        const match = models.find((model) => resolveFamily(model.id) === family);
        if (match) return { id: match.id, family };
      }
    }

    const [first] = models;
    return { id: first.id, family: resolveFamily(first.id) };
  }

  // Pulls a configured model (LOCAL_LLM_CHAT_MODEL / LOCAL_LLM_EMBEDDING_MODEL) that isn't
  // installed yet, so first use just works. Only ever for those user-configured names -- never
  // for a per-call `model` argument, which would let the calling agent start arbitrary
  // downloads. LOCAL_LLM_AUTO_PULL=0 turns it off. Once a name is known to be installed it isn't
  // checked again, and concurrent calls share a single pull.
  async ensureOllamaModel(name) {
    if (process.env.LOCAL_LLM_AUTO_PULL === "0" || this.confirmedModels.has(name)) return;

    // Ollama lists untagged names with an explicit ":latest".
    const tagged = name.includes(":") ? name : `${name}:latest`;
    try {
      const tags = await http.get(`${await this.serverUrl()}/api/tags`, { timeout: 5000 });
      const installed = (tags.data?.models ?? []).map((model) => model.name);
      if (!installed.includes(tagged)) {
        if (!this.pulls.has(tagged)) {
          this.pulls.set(tagged, this.pullOllamaModel(name).finally(() => this.pulls.delete(tagged)));
        }
        await this.pulls.get(tagged);
      }
    } catch (error) {
      if (isUnreachable(error)) {
        throw this.connectionError(error);
      }
      throw error;
    }
    this.confirmedModels.add(name);
  }

  async pullOllamaModel(name) {
    console.error(`[local-llm-mcp] ${name} is configured but not installed; pulling it from Ollama...`);
    try {
      await http.post(`${await this.serverUrl()}/api/pull`, { model: name, stream: false }, { timeout: PULL_TIMEOUT_MS });
    } catch (error) {
      if (isUnreachable(error)) throw error;
      const reason = error.response?.data?.error ?? error.message;
      throw new Error(`${name} is configured but not installed, and pulling it failed: ${reason}`, { cause: error });
    }
    this.modelsCache = null; // the installed list just changed
    console.error(`[local-llm-mcp] pulled ${name}.`);
  }

  async callLocalLlm(toolName, args) {
    const { model: explicitModel, ...promptArgs } = args;
    const resolved = await this.resolveModel(explicitModel, toolName);
    const messages = buildMessages(toolName, promptArgs, resolved.family);
    const backend = await this.detectBackend();
    // A fixed per-tool setting wins; otherwise a decision model may choose per request.
    let enableThinking = TOOL_REASONING_OVERRIDES[toolName];
    if (enableThinking === undefined && backend === "ollama") {
      enableThinking = await this.decideThinking(toolName, promptArgs, resolved.id);
    }

    let completion;
    try {
      completion =
        backend === "ollama"
          ? await this.ollamaChat(resolved.id, messages, enableThinking)
          : await this.openAiChat(resolved.id, messages, enableThinking);
    } catch (error) {
      if (isUnreachable(error)) {
        throw this.connectionError(error);
      }
      // Ollama and llama-server explain failures (e.g. "model 'x' not found") in the body's
      // `error` field, which axios's own message ("status code 404") leaves out.
      const detail = error.response?.data?.error;
      const reason = typeof detail === "string" ? detail : detail?.message;
      throw new Error(`local LLM error: ${error.message}${reason ? ` (${reason})` : ""}`, { cause: error });
    }

    this.recordTokenUsage(toolName, completion.usage);
    let text = completion.content;
    if (completion.promptTruncated) {
      const { contextWindow, atMaxContext } = completion;
      const window = contextWindow ? `${contextWindow}-token` : "default";
      const advice = atMaxContext
        ? "That's the largest window this model supports, so send less content per call."
        : `Send less content per call, or raise LOCAL_LLM_MIN_CTX${contextWindow ? ` above ${contextWindow}` : ""}.`;
      text += `\n\n[WARNING: the input didn't fit the model's ${window} context window and was cut down to ${completion.usage.prompt_tokens} tokens before the model saw it, so this answer is based on partial input. ${advice}]`;
    }
    if (completion.finishReason === "length") {
      text += `\n\n[WARNING: response was truncated at the ${MAX_TOKENS}-token generation limit (LOCAL_LLM_MAX_TOKENS) before finishing. Consider a narrower request, or raise the limit.]`;
    }
    return text;
  }

  // Asks a decision model (Ollama's POST /v1/systemone, e.g. Laya) whether this request needs
  // the chat model to think, and returns true/false -- or undefined to leave the chat model's
  // own default, which is also what happens when there's no decision model, the chat model
  // can't think, the answer isn't sure enough, or anything fails. Never fails the call.
  async decideThinking(toolName, promptArgs, chatModel) {
    let decisionModel;
    try {
      decisionModel = await this.resolveDecisionModel();
      if (!decisionModel) return undefined;
      const chat = (await this.fetchAvailableModels()).find((model) => model.id === chatModel);
      if (!chat?.capabilities?.includes("thinking")) return undefined;
    } catch {
      return undefined;
    }

    this.thinkingDecisions.model = decisionModel;
    try {
      const response = await http.post(
        `${await this.serverUrl()}/v1/systemone`,
        { model: decisionModel, state: decisionState(toolName, promptArgs), questions: DECISION_QUESTIONS },
        { timeout: DECISION_TIMEOUT_MS }
      );
      const { choice, probabilities } = response.data?.answers?.effort ?? {};
      if (choice !== "low" && choice !== "high") throw new Error("no effort answer");
      this.thinkingDecisions.decided += 1;
      if ((probabilities?.[choice] ?? 0) < DECISION_MIN_PROBABILITY) {
        this.thinkingDecisions.unsure += 1;
        return undefined;
      }
      this.thinkingDecisions[choice === "high" ? "thinkOn" : "thinkOff"] += 1;
      return choice === "high";
    } catch {
      this.thinkingDecisions.failed += 1;
      return undefined;
    }
  }

  // LOCAL_LLM_DECISION_MODEL picks the decision model ("off" disables thinking decisions) and is
  // pulled if missing, like the other configured models. Unset, the first installed model with
  // Ollama's "decision" capability is used -- never pulled, so nobody gets a surprise download.
  async resolveDecisionModel() {
    const configured = process.env.LOCAL_LLM_DECISION_MODEL;
    if (configured === "off") return null;
    if (configured) {
      await this.ensureOllamaModel(configured);
      return configured;
    }
    const models = await this.fetchAvailableModels();
    return models.find((model) => model.capabilities?.includes("decision"))?.id ?? null;
  }

  async openAiChat(model, messages, enableThinking) {
    const body = {
      model,
      messages,
      stream: false,
      max_tokens: MAX_TOKENS,
    };
    if (enableThinking !== undefined) {
      body.chat_template_kwargs = { enable_thinking: enableThinking };
    }

    const response = await http.post(`${await this.serverUrl()}/v1/chat/completions`, body, {
      timeout: 900000, // 15 minute timeout (overly long, to account for slow local models)
    });
    const choice = response.data.choices[0];
    return { content: choice.message.content, finishReason: choice.finish_reason, usage: response.data.usage };
  }

  // Ollama's native chat API: num_ctx and num_predict go in `options`, and thinking is toggled
  // with its own top-level `think` flag rather than a chat-template kwarg. Like the OpenAI path,
  // only message.content is returned -- Ollama keeps reasoning separate in message.thinking.
  async ollamaChat(model, messages, enableThinking) {
    const options = { num_predict: MAX_TOKENS };
    if (MIN_CTX > 0) options.num_ctx = await this.ollamaContextWindow(model);
    const body = { model, messages, stream: false, options };
    if (enableThinking !== undefined) body.think = enableThinking;

    const response = await http.post(`${await this.serverUrl()}/api/chat`, body, {
      timeout: 900000, // 15 minute timeout (overly long, to account for slow local models)
    });
    const data = response.data;
    const promptTokens = data.prompt_eval_count ?? 0;
    const completionTokens = data.eval_count ?? 0;
    const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    // Ollama drops prompt tokens that don't fit num_ctx without reporting an error.
    const promptTruncated = promptTokens > 0 && promptChars / promptTokens > TRUNCATED_CHARS_PER_TOKEN;
    const completion = {
      content: data.message?.content ?? "",
      finishReason: data.done_reason,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      promptTruncated,
    };
    if (promptTruncated) {
      // For the warning: the window the model ran at (looked up when num_ctx was left to
      // Ollama), and whether it's already the most this model supports.
      completion.contextWindow = options.num_ctx ?? (await this.ollamaRunningContext(model));
      const maxContext = await this.ollamaMaxContext(model);
      completion.atMaxContext = Boolean(maxContext && completion.contextWindow >= maxContext);
    }
    return completion;
  }

  // The num_ctx to send. Ollama reloads a model whenever a request's num_ctx differs from the
  // window it's running at, and a request *without* num_ctx means "Ollama's default", which
  // reloads it just the same if it was loaded with another window. So the current window is
  // always sent back explicitly, keeping a larger configured window (OLLAMA_CONTEXT_LENGTH)
  // and avoiding reloads, unless it's below MIN_CTX. An unloaded model is first loaded with an
  // empty chat request, which loads it at Ollama's default window without generating anything.
  async ollamaContextWindow(model) {
    const maxContext = await this.ollamaMaxContext(model);
    // A model whose maximum is at or below MIN_CTX always runs at its maximum.
    if (maxContext && maxContext <= MIN_CTX) return maxContext;

    let running = await this.ollamaRunningContext(model);
    if (running === null) {
      await http.post(`${await this.serverUrl()}/api/chat`, { model, messages: [] }, { timeout: 900000 });
      running = await this.ollamaRunningContext(model);
    }
    return running !== null && running >= MIN_CTX ? running : MIN_CTX;
  }

  // The context window a loaded model is running at, from /api/ps. Best-effort: null if the
  // model isn't loaded or the lookup fails.
  async ollamaRunningContext(model) {
    try {
      const ps = await http.get(`${await this.serverUrl()}/api/ps`, { timeout: 5000 });
      return ps.data?.models?.find((entry) => entry.name === model)?.context_length ?? null;
    } catch {
      return null;
    }
  }

  // The largest context window a model supports, from /api/show's model_info, where the key is
  // prefixed with the model architecture (e.g. "llama.context_length"). Known without loading
  // the model, and cached since it never changes. Best-effort: null if the model doesn't report
  // it or the lookup fails.
  async ollamaMaxContext(model) {
    if (this.maxContextCache.has(model)) return this.maxContextCache.get(model);
    try {
      const show = await http.post(`${await this.serverUrl()}/api/show`, { model }, { timeout: 5000 });
      const modelInfo = show.data?.model_info ?? {};
      const key = Object.keys(modelInfo).find((name) => name.endsWith(".context_length"));
      const maxContext = key ? modelInfo[key] : null;
      if (maxContext) this.maxContextCache.set(model, maxContext);
      return maxContext;
    } catch {
      return null;
    }
  }

  recordTokenUsage(toolName, usage) {
    if (!usage) return;
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

    this.tokenStats.calls += 1;
    this.tokenStats.promptTokens += promptTokens;
    this.tokenStats.completionTokens += completionTokens;
    this.tokenStats.totalTokens += totalTokens;

    const perTool = this.tokenStats.perTool[toolName] ?? {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    perTool.calls += 1;
    perTool.promptTokens += promptTokens;
    perTool.completionTokens += completionTokens;
    perTool.totalTokens += totalTokens;
    this.tokenStats.perTool[toolName] = perTool;
  }

  sessionStats() {
    const stats = { ...this.tokenStats, thinkingDecisions: this.thinkingDecisions };
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  }

  async tokenize(args) {
    const { text, include_tokens } = args;
    if ((await this.detectBackend()) === "ollama") {
      throw new Error("Tokenizing isn't supported with Ollama, which has no tokenize endpoint. It needs llama-server's /tokenize.");
    }
    try {
      const response = await http.post(
        `${await this.serverUrl()}/tokenize`,
        { content: text },
        { timeout: 10000 }
      );
      const tokens = response.data?.tokens ?? [];
      const info = { token_count: tokens.length };
      if (include_tokens) info.tokens = tokens;
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    } catch (error) {
      if (isUnreachable(error)) {
        throw this.connectionError(error);
      }
      throw new Error(`Failed to tokenize text: ${error.message}`, { cause: error });
    }
  }

  async semanticSimilarity(args) {
    const { query, candidates, model: explicitModel } = args;
    const resolved = await this.resolveModel(explicitModel, "semantic_similarity");

    try {
      const response = await http.post(
        `${await this.serverUrl()}/v1/embeddings`,
        { model: resolved.id, input: [query, ...candidates] },
        { timeout: 60000 }
      );

      const vectors = response.data?.data?.map((entry) => entry.embedding) ?? [];

      // A backend can answer 200 with correctly-shaped vectors whose elements are all NaN,
      // which JSON-serializes as null -- observed from llama-server fronting
      // nomic-embed-text on a Vulkan build. cosineSimilarity over those returns NaN, and
      // JSON.stringify would then report every score as `null`: a silently meaningless
      // ranking that looks like a successful call. Fail loudly instead.
      const badIndex = vectors.findIndex(
        (vector) => !Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)
      );
      if (badIndex !== -1) {
        throw new Error(
          `backend returned a non-numeric embedding for input ${badIndex} of ${vectors.length} (all-null/NaN vectors usually mean the model loaded but can't be run for embeddings on the server's current compute backend -- re-running that backend with -ngl 0 will confirm)`
        );
      }

      const [queryVector, ...candidateVectors] = vectors;

      const results = candidateVectors
        .map((vector, index) => ({
          candidate: index,
          score: Math.round(cosineSimilarity(queryVector, vector) * 10000) / 10000,
        }))
        .sort((a, b) => b.score - a.score);

      return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
    } catch (error) {
      if (isUnreachable(error)) {
        throw this.connectionError(error);
      }
      throw new Error(`Failed to compute semantic similarity: ${error.message}`, { cause: error });
    }
  }

  async generateCode(args) {
    const response = await this.callLocalLlm("generate_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async explainCode(args) {
    const response = await this.callLocalLlm("explain_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async reviewCode(args) {
    const response = await this.callLocalLlm("review_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async refactorCode(args) {
    const response = await this.callLocalLlm("refactor_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async fixCode(args) {
    const response = await this.callLocalLlm("fix_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async writeTests(args) {
    const response = await this.callLocalLlm("write_tests", args);
    return { content: [{ type: "text", text: response }] };
  }

  async generalTask(args) {
    const response = await this.callLocalLlm("general_task", args);
    return { content: [{ type: "text", text: response }] };
  }

  async readFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return content;
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error.message}`, { cause: error });
    }
  }

  async reviewFile(args) {
    const { file_path, focus, model } = args;
    const code = await this.readFile(file_path);
    const fileName = path.basename(file_path);
    const codeGraphContext = await getCodeGraphContext(fileName);

    const response = await this.callLocalLlm("review_file", {
      code: numberLines(code),
      focus,
      fileName,
      filePath: file_path,
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async explainFile(args) {
    const { file_path, context, model } = args;
    const code = await this.readFile(file_path);
    const fileName = path.basename(file_path);
    const codeGraphContext = await getCodeGraphContext(fileName);

    const response = await this.callLocalLlm("explain_file", {
      code: numberLines(code),
      context,
      fileName,
      filePath: file_path,
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async analyzeFiles(args) {
    const { file_paths, task, model } = args;
    const expandedPaths = await expandFilePaths(file_paths);

    const filesContent = await Promise.all(
      expandedPaths.map(async (filePath) => {
        const content = await this.readFile(filePath);
        const fileName = path.basename(filePath);
        return `FILE: ${fileName}\nPATH: ${filePath}\n\nCODE:\n${numberLines(content)}\n\n${"=".repeat(80)}\n`;
      })
    );
    const codeGraphContext = await getCodeGraphContext(expandedPaths.map((p) => path.basename(p)).join(" "));

    const response = await this.callLocalLlm("analyze_files", {
      task,
      filesContent: filesContent.join("\n"),
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async generateCodeWithContext(args) {
    const { prompt, language, context_files, model } = args;

    let contextSection = "";
    let codeGraphContext = null;
    if (context_files && context_files.length > 0) {
      const expandedContextFiles = await expandFilePaths(context_files);
      const contextContent = await Promise.all(
        expandedContextFiles.map(async (filePath) => {
          const content = await this.readFile(filePath);
          const fileName = path.basename(filePath);
          return `EXAMPLE FILE: ${fileName}\n${content}\n\n${"=".repeat(80)}\n`;
        })
      );
      contextSection = `\n\nREFERENCE FILES (for context and patterns):\n${contextContent.join("\n")}`;
      codeGraphContext = await getCodeGraphContext(expandedContextFiles.map((p) => path.basename(p)).join(" "));
    }

    const response = await this.callLocalLlm("generate_code_with_context", {
      prompt,
      language,
      contextSection,
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async digestFile(args) {
    const { file_path, question, model } = args;
    const raw = await this.readFile(file_path);
    const { text, totalLines, omitted } = digestContent(raw);
    const response = await this.callLocalLlm("digest_file", {
      content: text,
      question,
      fileName: path.basename(file_path),
      filePath: file_path,
      totalLines,
      omitted,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async reviewDiff(args) {
    const { repo_path, base, staged, paths = [], focus, model } = args;
    if (!repo_path || !path.isAbsolute(repo_path)) {
      throw new Error("repo_path must be an absolute path to a git repository.");
    }
    if (base !== undefined && staged) {
      throw new Error("Use either base or staged, not both.");
    }
    if (base !== undefined && !SAFE_GIT_REF.test(base)) {
      throw new Error(`Not a valid git ref: ${JSON.stringify(base)}. Use a branch, tag or commit such as "main" or "origin/main".`);
    }
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string")) {
      throw new Error("paths must be an array of strings.");
    }

    const range = staged ? ["--cached"] : base !== undefined ? [`${base}...HEAD`] : ["HEAD"];
    const description = staged
      ? "staged changes"
      : base !== undefined
        ? `changes on the current branch since ${base}`
        : "uncommitted changes (staged and unstaged)";
    // Paths go after "--", where git treats everything as a path, never as an option.
    const git = async (extra) => {
      try {
        const { stdout } = await execFileAsync(
          "git",
          [...GIT_SAFE_CONFIG, "diff", ...GIT_DIFF_FLAGS, ...extra, ...range, "--", ...paths],
          { cwd: repo_path, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }
        );
        return stdout;
      } catch (error) {
        const reason = error.stderr?.trim() || error.message;
        throw new Error(`git diff failed in ${repo_path}: ${reason}`, { cause: error });
      }
    };

    const changedFiles = (await git(["--name-only"])).split("\n").filter(Boolean);
    if (changedFiles.length === 0) {
      return { content: [{ type: "text", text: `No changes to review: ${description} are empty.` }] };
    }
    const diff = await git([]);
    const codeGraphContext = await getCodeGraphContext(changedFiles.map((file) => path.basename(file)).join(" "), repo_path);

    const response = await this.callLocalLlm("review_diff", {
      diff: annotateDiff(diff),
      changedFiles,
      description,
      focus,
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async serverInfo() {
    if ((await this.detectBackend()) === "ollama") {
      return this.ollamaServerInfo();
    }

    let modelsResponse;
    try {
      modelsResponse = await http.get(`${await this.serverUrl()}/v1/models`, { timeout: 5000 });
    } catch (error) {
      if (isUnreachable(error)) {
        throw this.connectionError(error);
      }
      throw new Error(`Failed to fetch local LLM server info: ${error.message}`, { cause: error });
    }

    // /props is a llama.cpp-specific extension, not part of the OpenAI-compatible surface
    // every backend implements -- best-effort only, so this tool still works against
    // vLLM, LM Studio, etc. that don't have it.
    let props = null;
    try {
      props = (await http.get(`${await this.serverUrl()}/props`, { timeout: 5000 })).data;
    } catch {
      // no-op: props stays null, matching a backend that doesn't implement /props
    }

    const model = modelsResponse.data?.data?.[0];
    const info = {
      backend: "openai",
      base_url: await this.serverUrl(),
      base_url_source: (await this.locateServer()).source,
      socket_path: LOCAL_LLM_SOCKET_PATH,
      embed_only: EMBED_ONLY,
      model_id: model?.id ?? null,
      model_family: model?.id ? resolveFamily(model.id) : null,
      context_size: props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null,
      total_slots: props?.total_slots ?? null,
      has_chat_template: props ? Boolean(props.chat_template) : null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
  }

  // Reports the model chat tools would use right now. max_context_size (/api/show) is always
  // known; context_size is the window it's actually running at (/api/ps), so it's null until
  // the model is loaded.
  async ollamaServerInfo() {
    let version;
    let ps;
    let model;
    try {
      [version, ps] = await Promise.all([
        http.get(`${await this.serverUrl()}/api/version`, { timeout: 5000 }),
        http.get(`${await this.serverUrl()}/api/ps`, { timeout: 5000 }),
      ]);
      model = await this.resolveModel(undefined, "server_info");
    } catch (error) {
      if (isUnreachable(error)) {
        throw this.connectionError(error);
      }
      throw new Error(`Failed to fetch local LLM server info: ${error.message}`, { cause: error });
    }

    const running = ps.data?.models?.find((entry) => entry.name === model.id);
    const maxContext = await this.ollamaMaxContext(model.id);
    const info = {
      backend: "ollama",
      base_url: await this.serverUrl(),
      base_url_source: (await this.locateServer()).source,
      socket_path: LOCAL_LLM_SOCKET_PATH,
      embed_only: EMBED_ONLY,
      ollama_version: version.data?.version ?? null,
      model_id: model.id,
      model_family: model.family,
      model_loaded: Boolean(running),
      context_size: running?.context_length ?? null,
      max_context_size: maxContext,
      min_context_size: MIN_CTX > 0 ? MIN_CTX : null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
    const target =
      LOCAL_LLM_SOCKET_PATH ??
      process.env.LOCAL_LLM_BASE_URL ??
      DEFAULT_SERVERS.map((candidate) => candidate.url).join(", then ");
    console.error(
      `local LLM MCP server running on stdio (target: ${target}${EMBED_ONLY ? ", embed-only" : ""})`
    );
  }
}

export { LocalLlmServer };

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const server = new LocalLlmServer();
  server.run();
}
