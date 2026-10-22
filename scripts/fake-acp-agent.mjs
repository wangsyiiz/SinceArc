#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 5000;
const SESSION_ID = "fake-session-1";
const REPORT_FILE = "fake-agent-report.json";

const pending = new Map();
let promptInFlight = false;

function log(...args) {
  console.error("[fake-acp-agent]", ...args);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function adoptSessionCwd(params) {
  const cwd = params?.cwd;
  if (typeof cwd !== "string" || !cwd) {
    return;
  }
  try {
    // 本地启动不会替 agent 设置 current_dir；切到 session/new 的 cwd 后，
    // 报告文件与客户端 fs 沙箱的根目录才是同一个。
    process.chdir(cwd);
    log(`cwd -> ${process.cwd()}`);
  } catch (error) {
    log(`cannot chdir to ${cwd}: ${error.message}`);
  }
}

function requestClient(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      log(`request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      resolve({ timeout: true });
    }, REQUEST_TIMEOUT_MS);
    pending.set(String(id), { resolve, timer });
  });
}

function checkFromResponse(id, requestedPath, response) {
  if (response.timeout) {
    return {
      id,
      path: requestedPath,
      ok: false,
      code: "timeout",
      message: `客户端 ${REQUEST_TIMEOUT_MS}ms 内没有响应`,
    };
  }
  if (response.error) {
    return {
      id,
      path: requestedPath,
      ok: false,
      code: response.error.code,
      message: response.error.message ?? "",
    };
  }

  const content = response.result?.content;
  if (typeof content !== "string") {
    return {
      id,
      path: requestedPath,
      ok: false,
      code: "bad-result",
      message: "响应成功但没有字符串 result.content",
    };
  }
  return {
    id,
    path: requestedPath,
    ok: true,
    bytes: Buffer.byteLength(content, "utf8"),
    preview: content.slice(0, 120),
  };
}

async function runPrompt(promptId) {
  const requests = [
    { id: 100, path: "inside.txt" },
    { id: 101, path: "C:\\Windows\\win.ini" },
    { id: 102, path: "../escape.txt" },
  ];

  log("session/prompt received; probing fs/read_text_file");
  const checks = await Promise.all(
    requests.map(async (request) => {
      send({
        jsonrpc: "2.0",
        id: request.id,
        method: "fs/read_text_file",
        params: { sessionId: SESSION_ID, path: request.path },
      });
      const response = await requestClient(request.id);
      const check = checkFromResponse(request.id, request.path, response);
      log(
        `request ${request.id} (${request.path}): ${check.ok ? "ok" : `rejected (${check.code})`}`,
      );
      return check;
    }),
  );

  const report = { cwd: process.cwd(), checks };
  fs.writeFileSync(
    path.join(process.cwd(), REPORT_FILE),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  log(`report written to ${path.join(process.cwd(), REPORT_FILE)}`);

  // 必须等三条 client 请求都有结果后再结束 prompt，否则界面会提前离开生成态。
  reply(promptId, { stopReason: "end_turn" });
  log("session/prompt completed");
}

async function handleLine(line) {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log(`ignoring malformed JSON: ${error.message}`);
    return;
  }

  // 无 method 的带 id 消息是客户端对我们请求的响应。
  if (message.method === undefined && message.id !== undefined) {
    const entry = pending.get(String(message.id));
    if (!entry) {
      log(`response for unknown id ${message.id}`);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(String(message.id));
    entry.resolve(message);
    return;
  }

  switch (message.method) {
    case "initialize":
      log("initialize");
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      });
      return;
    case "session/new":
      log("session/new");
      adoptSessionCwd(message.params);
      reply(message.id, { sessionId: SESSION_ID });
      return;
    case "session/prompt":
      if (promptInFlight) {
        replyError(message.id, -32600, "prompt already in flight");
        return;
      }
      promptInFlight = true;
      try {
        await runPrompt(message.id);
      } catch (error) {
        log(`prompt failed: ${error.stack ?? error}`);
        replyError(message.id, -32603, `fake agent failed: ${error.message}`);
      } finally {
        promptInFlight = false;
      }
      return;
    case "session/cancel":
      log("session/cancel received; exiting");
      process.exit(0);
      return;
    default:
      if (message.id !== undefined) {
        replyError(message.id, -32601, `method not found: ${message.method}`);
      }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  void handleLine(line).catch((error) => {
    log(`unhandled line failure: ${error.stack ?? error}`);
  });
});

rl.on("close", () => {
  log("stdin closed");
  process.exit(0);
});
