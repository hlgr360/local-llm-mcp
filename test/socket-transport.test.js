import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { startMockLlamaServer } from "./helpers/mockLlamaServer.js";

// Some sandboxes deny AF_UNIX outright (seccomp EPERM), and sun_path is capped at
// ~107 bytes so a long TMPDIR is also fatal. Probe once and skip rather than fail:
// the transport is still worth testing wherever it can actually be exercised.
const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-llm-mcp-sock-"));
const socketPath = path.join(probeDir, "s.sock");
const unixSocketsUsable = await (async () => {
  const probe = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(socketPath, resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
    return true;
  } catch {
    return false;
  }
})();

// Isolated in its own file/process: index.js reads LOCAL_LLM_SOCKET_PATH once at
// import time, so the socket transport can't share a process with the TCP tests.
let LocalLlmServer;
let mock;

describe("unix socket transport", { skip: unixSocketsUsable ? false : "AF_UNIX unavailable" }, () => {
  before(async () => {
    mock = await startMockLlamaServer({ socketPath });
    process.env.LOCAL_LLM_SOCKET_PATH = socketPath;
    // Deliberately unroutable: if anything dialled the base URL instead of the
    // socket, these tests would fail rather than silently pass over TCP.
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:1";
    ({ LocalLlmServer } = await import("../index.js"));
  });

  after(async () => {
    delete process.env.LOCAL_LLM_SOCKET_PATH;
    await mock.close();
    await fs.rm(probeDir, { recursive: true, force: true });
  });

  test("resolveModel reaches the backend over the socket, not the base URL", async () => {
    const resolved = await new LocalLlmServer().resolveModel(undefined);
    assert.equal(resolved.id, "mock-org/mock-model-7b");
  });

  test("a chat completion round-trips over the socket", async () => {
    const text = await new LocalLlmServer().callLocalLlm("general_task", { prompt: "ping" });
    assert.match(text, /echo:/);
  });

  test("server_info reports the socket path alongside the base url", async () => {
    const info = JSON.parse((await new LocalLlmServer().serverInfo()).content[0].text);
    assert.equal(info.socket_path, socketPath);
    assert.equal(info.model_id, "mock-org/mock-model-7b");
  });

  test("a missing socket file yields the connection error, not a raw ENOENT", async () => {
    await mock.close();
    await fs.rm(socketPath, { force: true });
    await assert.rejects(
      () => new LocalLlmServer().resolveModel(undefined),
      (error) =>
        /Cannot connect to local LLM server/.test(error.message) && error.message.includes(socketPath)
    );
  });
});
