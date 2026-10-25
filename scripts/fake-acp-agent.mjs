#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 5000;
/**
 * 权限自测开关，两种给法（文件优先，改完不用重启客户端）：
 *   - 环境变量 FAKE_PERMISSION_KIND / FAKE_PERMISSION_OPTIONS；
 *   - 会话 cwd 下的 `fake-permission.json`：{"kind":"edit","options":"allow_reject"}。
 * kind 设成 edit / delete / move / execute / unknown 就发一条权限请求；不设则不发（兼容原来的 fs 验证）。
 * options=reject_only 时只给拒绝项，用来看「这条没法自动同意」的兜底。
 */
function permissionConfig() {
  let kind = process.env.FAKE_PERMISSION_KIND ?? "";
  let options = process.env.FAKE_PERMISSION_OPTIONS ?? "allow_reject";
  // 等人点「允许/拒绝」时把等待放长，免得还没看清就超时
  let timeoutMs = Number(process.env.FAKE_PERMISSION_TIMEOUT_MS ?? REQUEST_TIMEOUT_MS);
  try {
    const file = path.join(process.cwd(), "fake-permission.json");
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof parsed.kind === "string") kind = parsed.kind;
      if (typeof parsed.options === "string") options = parsed.options;
      if (typeof parsed.timeoutMs === "number") timeoutMs = parsed.timeoutMs;
      log(`permission config from ${file}: kind=${kind} options=${options}`);
    }
  } catch (error) {
    log(`ignore bad fake-permission.json: ${error.message}`);
  }
  return { kind, options, timeoutMs };
}


/**
 * 能力开关，与 fake-permission.json 同一套路：会话 cwd 下放 `fake-caps.json`，
 * 例如 `{"fork":true,"load":true}` —— 改完不用重启客户端（下一次 spawn 生效）。
 * 默认全关：既有用例依赖「不声明 fork / 不支持 load」的旧行为。
 */
function capsConfig() {
  // initialize 早于 session/new，此时还拿不到会话 cwd：按「环境变量 → 进程 cwd → 家目录」找。
  const candidates = [
    process.env.FAKE_ACP_CAPS,
    path.join(process.cwd(), "fake-caps.json"),
    path.join(os.homedir(), ".fake-acp-caps.json"),
  ].filter(Boolean);
  let fork = false;
  let load = false;
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      fork = parsed?.fork === true;
      load = parsed?.load === true;
      log(`caps from ${file}: fork=${fork} load=${load}`);
      break;
    } catch {
      // 换下一个候选
    }
  }
  return { fork, load };
}

const SESSION_ID = "fake-session-1";
/**
 * 每个 session/new 给一个自己的 id：真 agent 都这么干，而这个假 agent 原来恒定返回
 * `fake-session-1`，于是「父会话」和「派活的子会话」是同一个 id —— 归属、正文缓冲、
 * 事件路由全部撞在一起，测出来的现象没法归因。
 */
let sessionCounter = 0;
let activeSessionId = SESSION_ID;
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

function requestClient(id, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      log(`request ${id} timed out after ${timeoutMs}ms`);
      resolve({ timeout: true });
    }, timeoutMs);
    pending.set(String(id), { resolve, timer });
  });
}

/**
 * 合同测试用：把 session/new / load / fork 收到的 mcpServers 原样落到文件里。
 * 回显成正文那条会被客户端的「迟到文本」规则在无待答轮次时丢掉，所以要看真实报文
 * （尤其是 sse 这种界面看不出来的形态）就落盘。默认写到会话 cwd 下，
 * `FAKE_ACP_DUMP` 可改路径。
 */
function dumpLifecycle(method, params) {
  const target = process.env.FAKE_ACP_DUMP ?? path.join(process.cwd(), "fake-acp-requests.jsonl");
  try {
    fs.appendFileSync(
      target,
      `${JSON.stringify({ method, mcpServers: params?.mcpServers ?? null })}\n`,
    );
  } catch (error) {
    log(`dump lifecycle failed: ${error.message}`);
  }
}

/** 合同测试用：任意请求原样落盘（谁收到了什么，界面看不出来的都靠它）。 */
function dumpRecord(payload) {
  const target = process.env.FAKE_ACP_DUMP ?? path.join(process.cwd(), "fake-acp-requests.jsonl");
  try {
    fs.appendFileSync(target, `${JSON.stringify(payload)}\n`);
  } catch (error) {
    log(`dump record failed: ${error.message}`);
  }
}

/** 合同测试用：把生命周期请求里收到的 mcpServers 原样回显成一条正文。 */
function echoMcpServers(params, sessionId) {
  const servers = params?.mcpServers;
  if (!Array.isArray(servers) || servers.length === 0) {
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `MCP-SERVERS: ${JSON.stringify(servers)}`,
        },
      },
    },
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

async function askPermission() {
  // 每次提问前现读配置：这样改 fake-permission.json 不用重启客户端，也不依赖 agent 的启动目录
  const { kind: permissionKind, options: permissionOptions, timeoutMs } = permissionConfig();
  const allowOptions =
    permissionOptions === "reject_only"
      ? []
      : [
          { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
          { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
        ];
  const options = [
    ...allowOptions,
    { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
  ];
  const id = 200;
  const startedAt = Date.now();
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: activeSessionId,
      toolCall: {
        toolCallId: "fake-tool-1",
        title: "fake: modify fake.txt",
        kind: permissionKind === "unknown" ? undefined : permissionKind,
        status: "pending",
        rawInput: { tool: "write" },
      },
      options,
    },
  });
  const response = await requestClient(id, timeoutMs);
  const outcome = response.timeout
    ? { timeout: true }
    : (response.result?.outcome ?? response.error ?? null);
  return { kind: permissionKind, options: options.map((o) => o.optionId), outcome, elapsedMs: Date.now() - startedAt };
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
        params: { sessionId: activeSessionId, path: request.path },
      });
      const response = await requestClient(request.id);
      const check = checkFromResponse(request.id, request.path, response);
      log(
        `request ${request.id} (${request.path}): ${check.ok ? "ok" : `rejected (${check.code})`}`,
      );
      return check;
    }),
  );

  let permission = null;
  const wantsPermission = permissionConfig().kind;
  if (wantsPermission) {
    log(`requesting permission (kind=${wantsPermission})`);
    permission = await askPermission();
    log(`permission answered: ${JSON.stringify(permission.outcome)} in ${permission.elapsedMs}ms`);
  }

  const report = { cwd: process.cwd(), checks, permission };
  fs.writeFileSync(
    path.join(process.cwd(), REPORT_FILE),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  log(`report written to ${path.join(process.cwd(), REPORT_FILE)}`);

  // 发一段正文，让「派活结果摘要」「成员回答落库」这两条路径也有东西可验
  // （原来这个假 agent 一个字都不回，摘要永远是 null，看着像功能没做）。
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: activeSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `fake: done in ${process.cwd()}` },
      },
    },
  });

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
    case "initialize": {
      log("initialize");
      const caps = capsConfig();
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: caps.load,
          ...(caps.fork ? { sessionCapabilities: { fork: {} } } : {}),
        },
        authMethods: [],
      });
      return;
    }
    case "session/new":
      log("session/new");
      adoptSessionCwd(message.params);
      dumpLifecycle("session/new", message.params);
      sessionCounter += 1;
      const sessionId = `fake-session-${sessionCounter}`;
      activeSessionId = sessionId;
      // 报一份可选模式：真 agent 里 hermes 不报，模式切换那条路径就没有可点的东西，
      // 而「切模式会不会推到别的会话」必须能真机验证（docs/data-plane.md §3）。
      reply(message.id, {
        sessionId,
        modes: {
          currentModeId: "standard",
          availableModes: [
            { id: "standard", name: "标准" },
            { id: "strict", name: "严格" },
          ],
        },
      });
      // 真 agent 在 session/new 之后主动推；稍等客户端完成归属登记，避免测试竞态。
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              availableCommands: [
                { name: "help", description: "List available commands" },
                {
                  name: "model",
                  description: "Show current model and provider, or switch models",
                  input: { hint: "model name to switch to" },
                },
              ],
            },
          },
        });
      }, 100);
      setTimeout(() => echoMcpServers(message.params, sessionId), 100);
      return;
    case "session/load": {
      log("session/load");
      adoptSessionCwd(message.params);
      dumpLifecycle("session/load", message.params);
      const loadedSessionId =
        typeof message.params?.sessionId === "string"
          ? message.params.sessionId
          : activeSessionId;
      activeSessionId = loadedSessionId;
      reply(message.id, { sessionId: loadedSessionId });
      setTimeout(() => echoMcpServers(message.params, loadedSessionId), 100);
      return;
    }
    case "session/fork": {
      log("session/fork");
      adoptSessionCwd(message.params);
      dumpLifecycle("session/fork", message.params);
      const forkedSessionId = `fake-fork-${++sessionCounter}`;
      activeSessionId = forkedSessionId;
      reply(message.id, { sessionId: forkedSessionId });
      setTimeout(() => echoMcpServers(message.params, forkedSessionId), 100);
      return;
    }
    case "session/set_mode":
      dumpRecord({
        method: "session/set_mode",
        sessionId: message.params?.sessionId ?? null,
        modeId: message.params?.modeId ?? null,
      });
      reply(message.id, {});
      return;
    case "session/prompt":
      if (promptInFlight) {
        replyError(message.id, -32600, "prompt already in flight");
        return;
      }
      promptInFlight = true;
      if (typeof message.params?.sessionId === "string") {
        activeSessionId = message.params.sessionId;
      }
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
