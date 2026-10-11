import http from "http";

// Minimal stand-in for llama-server's OpenAI-compatible endpoints, so tests
// don't depend on a real model being loaded. `state.modelId`/`state.props`
// can be mutated between requests to change what the mock reports; requests
// are recorded in `state.requests` so tests can assert on what was sent.
// Set `state.modelIds` (an array) instead of `state.modelId` to simulate a
// multi-model router reporting more than one loaded model.
export function startMockLlamaServer({ socketPath } = {}) {
  const state = {
    modelId: "mock-org/mock-model-7b",
    modelIds: null,
    props: {
      default_generation_settings: { n_ctx: 4096 },
      total_slots: 1,
      chat_template: "{{ messages }}",
    },
    requests: [],
    chatResponse: (body) => `echo:${JSON.stringify(body.messages)}`,
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    finishReason: "stop",
    tokenize: (content) => Array.from({ length: Math.max(1, Math.ceil(content.length / 4)) }, (_, i) => i),
    // Default: a crude per-string vector (char-code based) so identical text
    // always embeds identically and different text embeds differently.
    // Tests that need exact similarity control override this directly.
    embeddings: (inputs) =>
      inputs.map((text) => {
        const vector = [0, 0, 0];
        for (let i = 0; i < text.length; i++) vector[i % 3] += text.charCodeAt(i);
        return vector;
      }),
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method, url: req.url, body });

      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const ids = state.modelIds ?? (state.modelId ? [state.modelId] : []);
        res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
        return;
      }

      if (req.method === "GET" && req.url === "/props") {
        if (state.propsAvailable === false) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.props));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: state.chatResponse(body) }, finish_reason: state.finishReason }],
            usage: state.usage,
          })
        );
        return;
      }

      if (req.method === "POST" && req.url === "/tokenize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tokens: state.tokenize(body.content) }));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/embeddings") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const vectors = state.embeddings(body.input);
        res.end(JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })) }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve) => {
    // A unix-socket mock exercises the LOCAL_LLM_SOCKET_PATH transport; the TCP
    // path stays the default so existing callers are unaffected.
    const ready = () =>
      resolve({
        url: socketPath ? "http://localhost" : `http://127.0.0.1:${server.address().port}`,
        socketPath: socketPath ?? null,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    if (socketPath) server.listen(socketPath, ready);
    else server.listen(0, "127.0.0.1", ready);
  });
}
