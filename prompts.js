// Prompt registry indexed by model family.
//
// Each tool has a DEFAULT_PROMPTS entry: a static `system` framing string and a
// `user` function that builds the per-call payload from the tool's args. A model
// family (detected from whatever model the local LLM server reports as loaded) can
// override either half in FAMILY_OVERRIDES. buildMessages() resolves the two into the
// {role, content} pairs sent to /v1/chat/completions, letting the server apply the
// loaded model's own chat template on top.

const FAMILY_KEYWORDS = {
  gemma: "gemma",
  qwen: "qwen",
  deepseek: "deepseek",
  llama: "llama",
  mistral: "mistral",
  phi: "phi",
  codestral: "codestral",
};

export function resolveFamily(modelId) {
  if (!modelId) return "generic";
  const lower = modelId.toLowerCase();
  for (const [needle, family] of Object.entries(FAMILY_KEYWORDS)) {
    if (lower.includes(needle)) return family;
  }
  return "generic";
}

export const DEFAULT_PROMPTS = {
  generate_code: {
    system:
      "You are a code generation assistant. Generate clean, well-commented code based on the requirements given. Respond with ONLY the code, no explanations or markdown formatting. Make sure the code is production-ready and follows best practices.",
    user: (args) => `Language: ${args.language}\n\nRequirements:\n${args.prompt}`,
  },

  explain_code: {
    system:
      "You are a code explanation assistant. Provide a clear, comprehensive explanation of what the code does, how it works, and any important patterns or considerations.",
    user: (args) =>
      `Explain the following code in detail:\n\n${args.code}${
        args.context ? `\n\nContext: ${args.context}` : ""
      }`,
  },

  review_code: {
    system:
      "You are a code review assistant. Provide specific, actionable feedback including:\n1. Issues or bugs found\n2. Potential improvements\n3. Best practice violations\n4. Security concerns (if applicable)\n\nBe concise and specific.",
    user: (args) =>
      `Review the following code with focus on ${args.focus || "general code quality"}:\n\n${args.code}`,
  },

  refactor_code: {
    system:
      "You are a code refactoring assistant. Provide the refactored code with a brief explanation of the changes made. Format your response as:\n\nREFACTORED CODE:\n[code here]\n\nCHANGES MADE:\n[brief explanation]",
    user: (args) => `Refactor the following code with the goal to ${args.goal}:\n\n${args.code}`,
  },

  fix_code: {
    system:
      "You are a debugging assistant. Provide the fixed code with a brief explanation of what was wrong and how you fixed it. Format your response as:\n\nFIXED CODE:\n[code here]\n\nEXPLANATION:\n[brief explanation of the fix]",
    user: (args) => `ERROR: ${args.error}\n\nCODE:\n${args.code}`,
  },

  write_tests: {
    system:
      "You are a test writing assistant. Generate complete, runnable tests with good coverage of different scenarios including edge cases. Include only the test code, properly formatted for the requested framework.",
    user: (args) =>
      `Write comprehensive unit tests for the following code using ${args.framework}:\n\n${args.code}`,
  },

  general_task: {
    system: "You are a coding assistant. Provide a clear, complete response to the task.",
    user: (args) =>
      `TASK: ${args.task}${args.context ? `\n\nCONTEXT:\n${args.context}` : ""}`,
  },

  review_file: {
    system:
      "You are a code review assistant. Provide specific, actionable feedback including:\n1. Issues or bugs found\n2. Potential improvements\n3. Best practice violations\n4. Security concerns (if applicable)\n\nBe concise and specific. Each line of the code below is prefixed with its line number and a tab (e.g. `12\\t...`) -- cite the exact line number for every issue you report (e.g. \"line 42: ...\"), and never renumber or re-derive line numbers yourself.",
    user: (args) =>
      `Review the following file:\n\nFILE: ${args.fileName}\nPATH: ${args.filePath}\n\nCODE (line-numbered):\n${args.code}${codeGraphSection(args)}\n\nFOCUS:${args.focus || "general code quality"}\n`,
  },

  explain_file: {
    system:
      "You are a code explanation assistant. Provide a clear, comprehensive explanation of what the file does, how it works, and any important patterns or considerations. Each line of the code below is prefixed with its line number and a tab (e.g. `12\\t...`) -- reference specific line numbers when pointing out a section, rather than describing location vaguely.",
    user: (args) =>
      `Explain the following file in detail:\n\nFILE: ${args.fileName}\nPATH: ${args.filePath}\n\nCODE (line-numbered):\n${args.code}${
        args.context ? `\n\nContext: ${args.context}` : ""
      }${codeGraphSection(args)}`,
  },

  analyze_files: {
    system:
      "You are a code analysis assistant. Provide a comprehensive analysis addressing the task. Focus on relationships, patterns, and insights across all files. Each file's code below is prefixed line-by-line with its own line number and a tab (e.g. `12\\t...`) -- cite exact file:line locations for any finding (e.g. \"README.md:42\"), and never renumber or re-derive line numbers yourself.",
    user: (args) => `${args.filesContent}${codeGraphSection(args)}\n\nTASK: ${args.task}\n`,
  },

  digest_file: {
    system:
      "You digest logs and command output (test runs, builds, CI logs, stack traces) for a developer who will not read the log. Report, in this order: 1. The outcome in one line: passed or failed, with every count copied from the runner's own summary lines if the log has them, including cancelled, skipped or timed-out ones (e.g. \"tests 3, pass 1, fail 1, cancelled 1\"); never count them yourself. 2. Each distinct error or failure: its line number(s) and the key message quoted exactly. Group repeats (e.g. \"repeated 40 times, lines 120-480\"). 3. The likely cause, only if the log supports it. Skip passing tests, progress output and other noise. Each line is prefixed with its line number and a tab; cite those numbers and never re-derive them. If part of the log was omitted, say so when it could matter. Don't invent causes or messages the log doesn't show.",
    user: (args) =>
      `${args.question ? `QUESTION: ${args.question}\n\n` : ""}FILE: ${args.fileName}\nPATH: ${args.filePath}\nLINES: ${args.totalLines}${
        args.omitted ? ` (lines ${args.omitted.from}-${args.omitted.to} omitted to fit; the start and end are shown)` : ""
      }\n\nCONTENT (line-numbered):\n${args.content}`,
  },

  review_diff: {
    system:
      "You are a code review assistant reviewing a set of changes given as a unified diff. Comment on what the changes introduce: bugs, regressions, risky or incomplete changes, missing error handling, and security concerns. Don't review unchanged code except where a change breaks it. Each line that exists in the new version of a file is prefixed with its line number there; removed lines have no number. Cite the file and that line number for every finding (e.g. \"src/app.js:42: ...\"), and never re-derive line numbers yourself. Be concise and specific; if the changes look correct, say so briefly rather than inventing issues.",
    user: (args) =>
      `Review the following ${args.description} with focus on ${args.focus || "bugs, regressions and risky changes"}.\n\nCHANGED FILES:\n${args.changedFiles.join("\n")}\n\nDIFF (new-file line numbers on the left):\n${args.diff}${codeGraphSection(args)}`,
  },

  generate_code_with_context: {
    system:
      "You are a code generation assistant. Generate clean, well-commented code based on the requirements given, following the patterns shown in the reference files. Respond with ONLY the code, no explanations or markdown formatting. Make sure the code is production-ready.",
    user: (args) =>
      `${args.contextSection || ""}${codeGraphSection(args)}\n\nLANGUAGE: ${args.language}\n\nREQUIREMENTS:\n${args.prompt}`.trimStart(),
  },
};

// Shared by the file-aware tools above: folds in CodeGraph-derived context (call
// paths, blast radius) when index.js's getCodeGraphContext() found a .codegraph/ index for
// the project, empty string otherwise.
function codeGraphSection(args) {
  return args.codeGraphContext ? `\n\nCODEGRAPH CONTEXT (call paths, blast radius):\n${args.codeGraphContext}` : "";
}

// Sparse per-family overrides. Only populate an entry where a model family
// genuinely needs different framing than the default — most families are fine
// with DEFAULT_PROMPTS as-is since the local LLM server applies the model's own chat
// template on top of whatever we send here.
export const FAMILY_OVERRIDES = {
  deepseek: {
    fix_code: {
      system:
        "You are a meticulous debugging assistant. Reason through the bug step by step before answering, but keep your final answer formatted as:\n\nFIXED CODE:\n[code here]\n\nEXPLANATION:\n[brief explanation of the fix]",
    },
  },
  // This Qwen3 model, on the default (non-overridden) prompts, reliably pads free-form
  // explanatory/analysis output with emoji section headers, horizontal rules, and markdown
  // tables, and in review_code it appended a full unrequested rewrite of the input on top
  // of the four requested feedback categories -- verified empirically against a running
  // Qwen3.6-35B-A3B server, not assumed. The tools with a fixed output format (fix_code,
  // refactor_code, generate_code, write_tests) didn't show this and are left alone.
  qwen: {
    write_tests: {
      system:
        "You are a precise test-writing assistant specialized in code. Generate complete, runnable tests with good coverage of edge cases. Include only the test code, properly formatted for the requested framework — no filler commentary.",
    },
    explain_code: {
      system:
        "You are a code explanation assistant. Provide a clear, comprehensive explanation of what the code does, how it works, and any important patterns or considerations. Write in plain prose paragraphs -- no emoji, no markdown headers, tables, or horizontal rules. Stay grounded in the code given; don't pad the explanation with generic background or unrelated caveats.",
    },
    review_code: {
      system:
        "You are a code review assistant. Provide specific, actionable feedback including:\n1. Issues or bugs found\n2. Potential improvements\n3. Best practice violations\n4. Security concerns (if applicable)\n\nBe concise and specific. Write in plain text -- no emoji, no decorative section headers, no markdown tables. List findings against the code as given; don't append a full rewritten version unless the task asks for one.",
    },
    review_file: {
      system:
        "You are a code review assistant. Provide specific, actionable feedback including:\n1. Issues or bugs found\n2. Potential improvements\n3. Best practice violations\n4. Security concerns (if applicable)\n\nBe concise and specific. Each line of the code below is prefixed with its line number and a tab (e.g. `12\\t...`) -- cite the exact line number for every issue you report (e.g. \"line 42: ...\"), and never renumber or re-derive line numbers yourself. Write in plain text -- no emoji, no decorative section headers, no markdown tables. List findings against the file as given; don't append a full rewritten version unless the task asks for one.",
    },
    explain_file: {
      system:
        "You are a code explanation assistant. Provide a clear, comprehensive explanation of what the file does, how it works, and any important patterns or considerations. Each line of the code below is prefixed with its line number and a tab (e.g. `12\\t...`) -- reference specific line numbers when pointing out a section, rather than describing location vaguely. Write in plain prose paragraphs -- no emoji, no markdown headers, tables, or horizontal rules. Stay grounded in the file given; don't pad the explanation with generic background or unrelated caveats.",
    },
    digest_file: {
      system:
        "You digest logs and command output (test runs, builds, CI logs, stack traces) for a developer who will not read the log. Report, in this order: 1. The outcome in one line: passed or failed, with every count copied from the runner's own summary lines if the log has them, including cancelled, skipped or timed-out ones (e.g. \"tests 3, pass 1, fail 1, cancelled 1\"); never count them yourself. 2. Each distinct error or failure: its line number(s) and the key message quoted exactly. Group repeats (e.g. \"repeated 40 times, lines 120-480\"). 3. The likely cause, only if the log supports it. Skip passing tests, progress output and other noise. Each line is prefixed with its line number and a tab; cite those numbers and never re-derive them. If part of the log was omitted, say so when it could matter. Don't invent causes or messages the log doesn't show. Write in plain text -- no emoji, no decorative section headers, no markdown tables.",
    },
    review_diff: {
      system:
        "You are a code review assistant reviewing a set of changes given as a unified diff. Comment on what the changes introduce: bugs, regressions, risky or incomplete changes, missing error handling, and security concerns. Don't review unchanged code except where a change breaks it. Each line that exists in the new version of a file is prefixed with its line number there; removed lines have no number. Cite the file and that line number for every finding (e.g. \"src/app.js:42: ...\"), and never re-derive line numbers yourself. Be concise and specific; if the changes look correct, say so briefly rather than inventing issues. Write in plain text -- no emoji, no decorative section headers, no markdown tables. Don't append rewritten versions of the changed files unless the task asks for them.",
    },
    analyze_files: {
      system:
        "You are a code analysis assistant. Provide a comprehensive analysis addressing the task. Focus on relationships, patterns, and insights across all files. Each file's code below is prefixed line-by-line with its own line number and a tab (e.g. `12\\t...`) -- cite exact file:line locations for any finding (e.g. \"README.md:42\"), and never renumber or re-derive line numbers yourself. Write in plain text -- no emoji, no decorative section headers, no markdown tables.",
    },
    general_task: {
      system:
        "You are a coding assistant. Provide a clear, complete response to the task. Write in plain text -- no emoji, no decorative markdown headers or tables -- and keep the response focused on what was asked, without padding it with generic background.",
    },
  },
};

// Sparse per-tool model-family preferences, for setups running more than one model behind
// a router (e.g. llama-swap) where auto-detection has more than one candidate to choose
// from. Each entry is an ordered list of preferred families; the first one present in
// whatever /v1/models currently reports wins. Empty by default -- with a single model
// loaded (the common case), there's nothing to choose between and this has no effect.
// Populate your own, e.g. { write_tests: ["qwen"], fix_code: ["deepseek"] }.
export const TOOL_MODEL_PREFERENCES = {};

// Sparse per-tool override for reasoning models: true/false sends
// chat_template_kwargs: { enable_thinking }, letting you trade thinking-model quality for
// speed per tool. Empty by default -- omitted entirely means "whatever the model/template
// does by default," unchanged from before this existed. Not a standard OpenAI field; it's
// a Qwen3-family chat-template convention specifically, and the local LLM server should
// silently ignore it for templates that don't recognize it. With Ollama it's sent as Ollama's
// own `think` flag instead, which works for any Ollama thinking model. Populate your own, e.g.
// { generate_code: false, fix_code: true } to skip thinking on quick generation but keep
// it for harder debugging. With Ollama and a decision model installed (e.g. Laya), tools
// without an entry here get a per-request decision instead (see decideThinking in index.js);
// an entry here always wins over that.
export const TOOL_REASONING_OVERRIDES = {};

export function buildMessages(toolName, args, family) {
  const base = DEFAULT_PROMPTS[toolName];
  if (!base) {
    throw new Error(`No prompt template registered for tool: ${toolName}`);
  }

  const override = FAMILY_OVERRIDES[family]?.[toolName];
  const system = override?.system ?? base.system;
  const buildUser = override?.user ?? base.user;

  return [
    { role: "system", content: system },
    { role: "user", content: buildUser(args) },
  ];
}
