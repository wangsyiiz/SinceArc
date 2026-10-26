#!/usr/bin/env node

// E17 端到端流程守卫：只断言库的不变量与 DOM 数值，不截图、不做视觉判断。
// 运行侧是 Windows Node 24：通过 CDP 驱动 WebView，通过 sqlite3.exe 只读查询本地库。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_CDP = "http://127.0.0.1:9222";
const DEFAULT_SQLITE3 = "C:\\software\\platform-tools\\sqlite3.exe";
const DEFAULT_TIMEOUT_MS = 180_000;
const LOCAL_TIMEOUT_MS = 30_000;
const DB_TIMEOUT_MS = 15_000;
const POLL_MS = 150;
const LATE_TEXT_WINDOW_MS = 3_000;

const FLOW_ORDER = ["normal", "cancel", "reopen", "permission", "late-text"];

function defaultDbPath() {
  const appData = process.env.APPDATA || path.join(homedir(), "AppData", "Roaming");
  return path.join(appData, "com.sincearc.app", "sincearc.db");
}

function usage() {
  return `用法：
  node scripts/flow-check.mjs [--cdp <url>] [--db <path>] [--sqlite3 <exe>] [--only <flows>]

参数：
  --cdp <url>        WebView CDP 地址，默认 ${DEFAULT_CDP}
  --db <path>        sincearc.db 路径，默认 %APPDATA%\\com.sincearc.app\\sincearc.db
  --sqlite3 <exe>    sqlite3.exe 路径，默认 ${DEFAULT_SQLITE3}
  --only <flows>     只跑指定流程，逗号分隔：${FLOW_ORDER.join(",")}
  --with-permission  启用 permission 真机断言；默认按已知缺口输出 SKIP
  --permission-prompt <text>
                     启用 permission 时发送的 prompt

环境：Windows 侧 Node 24（全局 fetch / WebSocket 可用），应用已开 CDP。`;
}

function parseArgs(argv) {
  const options = {
    cdp: DEFAULT_CDP,
    db: defaultDbPath(),
    sqlite3: DEFAULT_SQLITE3,
    only: null,
    withPermission: false,
    permissionPrompt: "请修改当前目录下的一个文件（先请求我的确认）",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} 缺少参数值`);
      }
      index += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--cdp") {
      options.cdp = takeValue();
    } else if (arg === "--db") {
      options.db = takeValue();
    } else if (arg === "--sqlite3") {
      options.sqlite3 = takeValue();
    } else if (arg === "--only") {
      options.only = takeValue();
    } else if (arg === "--with-permission") {
      options.withPermission = true;
    } else if (arg === "--permission-prompt") {
      options.permissionPrompt = takeValue();
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  if (options.only) {
    const requested = options.only
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const unknown = requested.filter((name) => !FLOW_ORDER.includes(name));
    if (unknown.length > 0) {
      throw new Error(`--only 含未知流程：${unknown.join(",")}；可选：${FLOW_ORDER.join(",")}`);
    }
    options.selected = FLOW_ORDER.filter((name) => requested.includes(name));
  } else {
    options.selected = [...FLOW_ORDER];
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function asNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

async function waitFor(label, check, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const interval = options.interval ?? POLL_MS;
  const deadline = Date.now() + timeout;
  let last;

  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(interval);
  }

  let detail = "";
  if (options.detail) {
    try {
      detail = await options.detail(last);
    } catch (error) {
      detail = `读取超时现场失败：${errorText(error)}`;
    }
  }
  throw new Error(
    `等待 ${label}超时（${Math.ceil(timeout / 1000)}s）${detail ? `：${detail}` : ""}`,
  );
}

async function fetchJson(url, timeout = 5_000) {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node 没有全局 fetch；请用 Node 24");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function openWebSocket(url, timeout = 5_000) {
  if (typeof WebSocket === "undefined") {
    throw new Error("当前 Node 没有全局 WebSocket；请用 Node 24");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(new Error(`创建 CDP WebSocket 失败：${errorText(error)}`));
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // 忽略关闭失败；下面的报错已经足够定位。
      }
      finish(reject, new Error(`连接 CDP WebSocket 超时（${timeout / 1000}s）：${url}`));
    }, timeout);
    socket.addEventListener("open", () => finish(resolve, socket), { once: true });
    socket.addEventListener(
      "error",
      () => finish(reject, new Error(`连接 CDP WebSocket 失败：${url}`)),
      { once: true },
    );
  });
}

class CdpClient {
  constructor(socket, target) {
    this.socket = socket;
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", (event) => {
      this.failAll(
        new Error(
          `CDP 连接已关闭（code=${event.code ?? "?"}${event.reason ? `, reason=${event.reason}` : ""}）`,
        ),
      );
    });
  }

  onMessage(event) {
    let text = event.data;
    if (typeof text !== "string") {
      text = String(text);
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id === undefined) return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(
        new Error(`CDP ${pending.method} 失败：${message.error.message ?? JSON.stringify(message.error)}`),
      );
      return;
    }
    pending.resolve(message.result ?? {});
  }

  failAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeout = 10_000) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP 连接不可用，无法调用 ${method}`));
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeout / 1000}s）`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`发送 CDP ${method} 失败：${errorText(error)}`));
      }
    });
  }

  async evaluate(expression, timeout = 10_000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeout,
    );

    if (result.exceptionDetails) {
      const exception = result.exceptionDetails.exception;
      const description =
        exception?.description ?? exception?.value ?? result.exceptionDetails.text ?? "未知页面异常";
      throw new Error(`页面求值失败：${description}`);
    }
    return result.result?.value;
  }

  async js(fn, ...args) {
    if (typeof fn !== "function") {
      throw new Error("cdp.js 只接受函数");
    }
    const payload = args.map((arg) => JSON.stringify(arg)).join(",");
    return this.evaluate(`(${fn.toString()})(${payload})`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // 已经断开就无需再处理。
    }
    this.failAll(new Error("CDP 连接已关闭"));
  }
}

async function connectCdp(baseUrl) {
  const root = baseUrl.replace(/\/+$/, "");
  const errors = [];
  let targets = null;
  for (const route of ["/json", "/json/list"]) {
    try {
      const value = await fetchJson(`${root}${route}`);
      if (Array.isArray(value) && value.length > 0) {
        targets = value;
        break;
      }
    } catch (error) {
      errors.push(`${route}: ${errorText(error)}`);
    }
  }
  if (!targets) {
    throw new Error(`读取 CDP target 失败：${errors.join("；") || "没有可用 target"}`);
  }

  const pages = targets.filter((target) => target?.webSocketDebuggerUrl);
  if (pages.length === 0) {
    throw new Error("CDP target 列表里没有 webSocketDebuggerUrl");
  }
  const target =
    pages.find((item) => item.type === "page" && /tauri|sincearc/i.test(item.url ?? "")) ??
    pages.find((item) => item.type === "page") ??
    pages[0];

  const socket = await openWebSocket(target.webSocketDebuggerUrl);
  const client = new CdpClient(socket, target);
  await client.send("Runtime.enable", {}, 5_000);
  return client;
}

function createDb(dbPath, sqlite3Path) {
  if (!existsSync(dbPath)) {
    throw new Error(`数据库不存在：${dbPath}`);
  }
  if (!existsSync(sqlite3Path)) {
    throw new Error(`sqlite3 不存在：${sqlite3Path}`);
  }

  async function query(sql, timeout = DB_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const child = spawn(sqlite3Path, ["-json", dbPath, sql], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(reject, new Error(`sqlite3 查询超时（${timeout / 1000}s）：${sql.slice(0, 160)}`));
      }, timeout);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        finish(reject, new Error(`启动 sqlite3 失败：${errorText(error)}`));
      });
      child.on("close", (code) => {
        if (code !== 0) {
          finish(
            reject,
            new Error(
              `sqlite3 退出码 ${code}：${(stderr || stdout || "无输出").trim().slice(0, 1_000)}`,
            ),
          );
          return;
        }
        const text = stdout.trim();
        if (!text) {
          finish(resolve, []);
          return;
        }
        try {
          const rows = JSON.parse(text);
          if (!Array.isArray(rows)) {
            throw new Error("输出不是 JSON 数组");
          }
          finish(resolve, rows);
        } catch (error) {
          finish(reject, new Error(`解析 sqlite3 -json 输出失败：${errorText(error)}`));
        }
      });
    });
  }

  return { path: dbPath, sqlite3: sqlite3Path, query };
}

/* ---------------- 页面侧函数（会原样序列化进 WebView 执行） ---------------- */

function pageSnapshot() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const textarea = [...document.querySelectorAll("textarea")].find(visible);
  const messages = [...document.querySelectorAll("[data-message-id]")].map((el) => ({
    id: el.getAttribute("data-message-id") ?? "",
    turnId: el.getAttribute("data-turn-id") ?? "",
    agent: !!el.querySelector(".sc-prose"),
    text: (el.innerText ?? "").replace(/\s+/g, " ").slice(0, 180),
  }));
  const buttons = [...document.querySelectorAll("button")]
    .filter(visible)
    .map((el) => ({
      aria: el.getAttribute("aria-label") ?? "",
      text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      disabled: !!el.disabled,
    }))
    .filter((item) => item.aria || item.text)
    .slice(-40);
  const dialogs = [...document.querySelectorAll("dialog[open]")]
    .filter(visible)
    .map((el) => ({
      title: el.querySelector("h2")?.textContent?.trim() ?? "",
      text: (el.innerText ?? "").replace(/\s+/g, " ").slice(0, 300),
    }));

  return {
    textarea: textarea
      ? {
          value: textarea.value.slice(0, 200),
          placeholder: textarea.getAttribute("placeholder") ?? "",
          disabled: !!textarea.disabled,
        }
      : null,
    messages: messages.slice(-10),
    buttons,
    dialogs,
    bodyTail: (document.body.innerText ?? "").replace(/\s+/g, " ").slice(-1_500),
  };
}

function pageEnsureSessionsMode() {
  const nav = document.querySelector('[aria-label="一级导航"]');
  if (!nav) return { ok: false, reason: "找不到一级导航" };
  const button = [...nav.querySelectorAll("button")].find(
    (el) => (el.textContent ?? "").trim() === "会话",
  );
  if (!button) return { ok: false, reason: "一级导航里找不到「会话」" };
  if (button.getAttribute("aria-pressed") !== "true") {
    button.click();
    return { ok: true, clicked: true };
  }
  return { ok: true, clicked: false };
}

function pageClickNewSession() {
  const aside = document.querySelector("aside");
  if (!aside) return { ok: false, reason: "找不到侧栏" };
  const button = [...aside.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").replace(/\s+/g, " ").trim().startsWith("新建会话"),
  );
  if (!button) {
    return {
      ok: false,
      reason: "侧栏里找不到「新建会话」",
      buttons: [...aside.querySelectorAll("button")].map((el) =>
        (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      ),
    };
  }
  button.click();
  return { ok: true };
}

function pageTextareaState() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const textarea = [...document.querySelectorAll("textarea")].find(
    (el) => visible(el) && !el.disabled,
  );
  if (!textarea) return { ok: false };
  return {
    ok: true,
    value: textarea.value,
    placeholder: textarea.getAttribute("placeholder") ?? "",
  };
}

function pageTypeIntoComposer(value) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const textarea = [...document.querySelectorAll("textarea")].find(
    (el) => visible(el) && !el.disabled,
  );
  if (!textarea) return { ok: false, reason: "找不到可输入的 textarea" };

  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  );
  if (!descriptor?.set) return { ok: false, reason: "拿不到 textarea 原生 value setter" };

  textarea.focus();
  descriptor.set.call(textarea, value);
  const event =
    typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
      : new Event("input", { bubbles: true });
  textarea.dispatchEvent(event);
  return { ok: true, value: textarea.value };
}

function pageSendButton() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[aria-label*="发送"]')].filter(visible);
  const button =
    buttons.find((el) => (el.getAttribute("aria-label") ?? "") === "发送" && !el.disabled) ??
    buttons.find((el) => (el.getAttribute("aria-label") ?? "").includes("发送") && !el.disabled) ??
    buttons[0];
  return button
    ? {
        ok: true,
        enabled: !button.disabled,
        aria: button.getAttribute("aria-label") ?? "",
      }
    : { ok: false, enabled: false };
}

function pageClickSend() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[aria-label*="发送"]')].filter(
    (el) => visible(el) && !el.disabled,
  );
  const button =
    buttons.find((el) => (el.getAttribute("aria-label") ?? "") === "发送") ?? buttons[0];
  if (!button) return { ok: false, reason: "发送按钮不可用" };
  button.click();
  return { ok: true, aria: button.getAttribute("aria-label") ?? "" };
}

function pageStopButton() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[aria-label*="停止"]')].filter(visible);
  const button =
    buttons.find((el) => (el.getAttribute("aria-label") ?? "") === "停止") ?? buttons[0];
  return button
    ? {
        ok: true,
        enabled: !button.disabled,
        aria: button.getAttribute("aria-label") ?? "",
      }
    : { ok: false, enabled: false };
}

function pageClickStop() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button[aria-label*="停止"]')].filter(
    (el) => visible(el) && !el.disabled,
  );
  const button =
    buttons.find((el) => (el.getAttribute("aria-label") ?? "") === "停止") ?? buttons[0];
  if (!button) return { ok: false, reason: "停止按钮不可用" };
  button.click();
  return { ok: true, aria: button.getAttribute("aria-label") ?? "" };
}

function pageMessages() {
  return [...document.querySelectorAll("[data-message-id]")].map((el) => {
    const agent = !!el.querySelector(".sc-prose");
    const user = !agent && !!el.querySelector(".items-end");
    return {
      id: el.getAttribute("data-message-id") ?? "",
      turnId: el.getAttribute("data-turn-id") ?? "",
      kind: agent ? "agent" : user ? "user" : "other",
      text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    };
  });
}

function pageMessagesForTurn(turnId) {
  return [...document.querySelectorAll("[data-message-id]")]
    .filter((el) => (el.getAttribute("data-turn-id") ?? "") === turnId)
    .map((el) => {
      const agent = !!el.querySelector(".sc-prose");
      const user = !agent && !!el.querySelector(".items-end");
      return {
        id: el.getAttribute("data-message-id") ?? "",
        turnId: el.getAttribute("data-turn-id") ?? "",
        kind: agent ? "agent" : user ? "user" : "other",
        text: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      };
    });
}

function pageLatestTurnId() {
  const ids = [...document.querySelectorAll("[data-turn-id]")]
    .map((el) => el.getAttribute("data-turn-id") ?? "")
    .filter(Boolean);
  return ids.at(-1) ?? null;
}

function pageLatestAgentTurn() {
  const turns = new Map();
  [...document.querySelectorAll("[data-turn-id]")].forEach((el) => {
    const turnId = el.getAttribute("data-turn-id") ?? "";
    if (!turnId) return;
    const text = [...el.querySelectorAll(".sc-prose")]
      .map((node) => node.innerText ?? "")
      .join("\n")
      .trim();
    if (text) turns.set(turnId, { turnId, textLength: text.length });
  });
  const latest = [...turns.values()].at(-1) ?? null;
  return latest ? { ok: true, ...latest } : { ok: false };
}

function pageAgentTextForTurn(turnId) {
  return [...document.querySelectorAll("[data-turn-id]")]
    .filter((el) => (el.getAttribute("data-turn-id") ?? "") === turnId)
    .flatMap((el) => [...el.querySelectorAll(".sc-prose")].map((node) => node.innerText ?? ""))
    .join("\n");
}

function pageFailureUi() {
  const root = document.querySelector("main") ?? document.body;
  const text = root.innerText ?? "";
  const titled = [...root.querySelectorAll("[title]")]
    .map((el) => el.getAttribute("title") ?? "")
    .filter((title) => title.includes("发送失败"));
  return {
    visible: text.includes("发送失败"),
    titledCount: titled.length,
    titled: titled.slice(0, 3),
  };
}

function pageSidebarRows() {
  const aside = document.querySelector("aside");
  if (!aside) return [];
  const rows = [];
  for (const button of aside.querySelectorAll("button")) {
    const titleEl = button.querySelector(":scope > span.truncate.text-small");
    if (!titleEl) continue;
    const parent = button.parentElement;
    rows.push({
      index: rows.length,
      title: (titleEl.textContent ?? "").trim(),
      text: (button.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      active: !!parent?.classList.contains("sc-row-active"),
    });
  }
  return rows;
}

function pageClickSidebarRow(index, title) {
  const aside = document.querySelector("aside");
  if (!aside) return { ok: false, reason: "找不到侧栏" };
  const rows = [];
  for (const button of aside.querySelectorAll("button")) {
    const titleEl = button.querySelector(":scope > span.truncate.text-small");
    if (!titleEl) continue;
    rows.push({ index: rows.length, title: (titleEl.textContent ?? "").trim(), button });
  }
  let target = rows[index];
  if (!target || target.title !== title) {
    target = rows.find((row) => row.title === title);
  }
  if (!target) {
    return {
      ok: false,
      reason: `找不到侧栏会话「${title}」`,
      titles: rows.map((row) => row.title),
    };
  }
  target.button.click();
  return { ok: true, index: target.index, title: target.title };
}

function pagePermissionDialog() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const dialogs = [...document.querySelectorAll("dialog[open]")].filter(visible);
  const dialog =
    dialogs.find((el) => {
      const text = el.innerText ?? "";
      return (
        /权限|permission/i.test(text) ||
        [...el.querySelectorAll("button")].some((button) =>
          /允许|allow|approve/i.test(button.textContent ?? ""),
        )
      );
    }) ?? dialogs[0];

  if (!dialog) return { ok: false };
  const buttons = [...dialog.querySelectorAll("button")]
    .filter(visible)
    .map((button, index) => ({
      index,
      text: (button.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      disabled: !!button.disabled,
    }));
  return {
    ok: true,
    title: dialog.querySelector("h2")?.textContent?.trim() ?? "",
    text: (dialog.innerText ?? "").replace(/\s+/g, " ").slice(0, 500),
    buttons,
    allowIndex: buttons.findIndex(
      (button) => !button.disabled && /允许|allow|approve/i.test(button.text),
    ),
  };
}

function pageClickPermissionAllow() {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const dialogs = [...document.querySelectorAll("dialog[open]")].filter(visible);
  const dialog = dialogs.find((el) =>
    [...el.querySelectorAll("button")].some((button) =>
      /允许|allow|approve/i.test(button.textContent ?? ""),
    ),
  );
  if (!dialog) return { ok: false, reason: "没有带「允许」按钮的 PermissionDialog" };
  const button = [...dialog.querySelectorAll("button")]
    .filter(visible)
    .find(
      (el) =>
        !el.disabled && /允许|allow|approve/i.test((el.textContent ?? "").replace(/\s+/g, " ")),
    );
  if (!button) return { ok: false, reason: "PermissionDialog 里没有可点的「允许」" };
  const label = (button.textContent ?? "").replace(/\s+/g, " ").trim();
  button.click();
  return { ok: true, label };
}

function createUi(cdp) {
  const snapshot = () => cdp.js(pageSnapshot);

  const waitForTextarea = () =>
    waitFor(
      "textarea 可输入",
      async () => {
        const state = await cdp.js(pageTextareaState);
        return state.ok ? state : null;
      },
      {
        timeout: LOCAL_TIMEOUT_MS,
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );

  const ensureSessionsMode = async () => {
    const state = await cdp.js(pageEnsureSessionsMode);
    if (!state.ok) throw new Error(`切到会话侧栏失败：${state.reason}`);
    if (state.clicked) await sleep(120);
    return state;
  };

  const newSession = async () => {
    await ensureSessionsMode();
    const state = await cdp.js(pageClickNewSession);
    if (!state.ok) throw new Error(`新建会话失败：${state.reason}`);
    await waitForTextarea();
    return true;
  };

  const type = async (text) => {
    const state = await cdp.js(pageTypeIntoComposer, text);
    if (!state.ok) throw new Error(`写入 textarea 失败：${state.reason}`);
    if (state.value !== text) {
      throw new Error(`写入 textarea 后值不一致：期望 ${JSON.stringify(text)}，实际 ${JSON.stringify(state.value)}`);
    }
    return state;
  };

  const waitForSendEnabled = () =>
    waitFor(
      "发送按钮可用",
      async () => {
        const state = await cdp.js(pageSendButton);
        return state.ok && state.enabled ? state : null;
      },
      {
        timeout: LOCAL_TIMEOUT_MS,
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );

  const clickSend = async () => {
    const state = await cdp.js(pageClickSend);
    if (!state.ok) throw new Error(`点击发送失败：${state.reason}`);
    return state;
  };

  const send = async (text) => {
    await type(text);
    await waitForSendEnabled();
    await clickSend();
  };

  const waitForAgentTurn = (timeout = DEFAULT_TIMEOUT_MS) =>
    waitFor(
      "agent 回复",
      async () => {
        const state = await cdp.js(pageLatestAgentTurn);
        return state.ok ? state : null;
      },
      {
        timeout,
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );

  const waitForUserTurn = (timeout = DEFAULT_TIMEOUT_MS) =>
    waitFor(
      "用户消息获得 turn_id",
      async () => {
        const turnId = await cdp.js(pageLatestTurnId);
        if (!turnId) return null;
        const messages = await cdp.js(pageMessagesForTurn, turnId);
        return messages.some((message) => message.kind === "user" || message.text)
          ? { turnId }
          : null;
      },
      {
        timeout,
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );

  const waitForStopOrOutput = async (turnId) => {
    const state = await waitFor(
      "agent 输出或停止按钮",
      async () => {
        const stop = await cdp.js(pageStopButton);
        const text = await cdp.js(pageAgentTextForTurn, turnId);
        return stop.ok && stop.enabled ? { stop, textLength: text.length } : null;
      },
      {
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );
    return state;
  };

  const clickStop = async () => {
    const state = await cdp.js(pageClickStop);
    if (!state.ok) throw new Error(`点击停止失败：${state.reason}`);
    return state;
  };

  const activeSidebarRow = async () => {
    await ensureSessionsMode();
    const rows = await cdp.js(pageSidebarRows);
    return rows.find((row) => row.active) ?? null;
  };

  const sidebarRows = async () => {
    await ensureSessionsMode();
    return cdp.js(pageSidebarRows);
  };

  const clickSidebarRow = async (row) => {
    const state = await cdp.js(pageClickSidebarRow, row.index, row.title);
    if (!state.ok) throw new Error(`切换会话失败：${state.reason}`);
    return state;
  };

  const waitForActiveSidebarRow = (row) =>
    waitFor(
      `侧栏切到「${row.title}」`,
      async () => {
        const rows = await cdp.js(pageSidebarRows);
        const current =
          rows[row.index]?.active && rows[row.index]?.title === row.title
            ? rows[row.index]
            : rows.find((item) => item.active && item.title === row.title);
        return current ?? null;
      },
      {
        timeout: LOCAL_TIMEOUT_MS,
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );

  const waitForPermissionDialog = async () => {
    const state = await waitFor(
      "PermissionDialog 出现",
      async () => {
        const dialog = await cdp.js(pagePermissionDialog);
        return dialog.ok ? dialog : null;
      },
      {
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );
    if (state.allowIndex < 0) {
      throw new Error(`PermissionDialog 出现但没有「允许」按钮：${JSON.stringify(state.buttons)}`);
    }
    return state;
  };

  const clickPermissionAllow = async () => {
    const state = await cdp.js(pageClickPermissionAllow);
    if (!state.ok) throw new Error(`点击权限「允许」失败：${state.reason}`);
    return state;
  };

  const waitForPermissionDialogGone = () =>
    waitFor(
      "PermissionDialog 关闭",
      async () => {
        const dialog = await cdp.js(pagePermissionDialog);
        return dialog.ok ? null : true;
      },
      {
        timeout: LOCAL_TIMEOUT_MS,
        detail: async () => `当前 DOM 仍是 ${JSON.stringify(await snapshot())}`,
      },
    );

  return {
    snapshot,
    ensureSessionsMode,
    newSession,
    type,
    send,
    waitForTextarea,
    waitForAgentTurn,
    waitForUserTurn,
    waitForStopOrOutput,
    clickStop,
    activeSidebarRow,
    sidebarRows,
    clickSidebarRow,
    waitForActiveSidebarRow,
    messages: () => cdp.js(pageMessages),
    messagesForTurn: (turnId) => cdp.js(pageMessagesForTurn, turnId),
    latestTurnId: () => cdp.js(pageLatestTurnId),
    agentTextForTurn: (turnId) => cdp.js(pageAgentTextForTurn, turnId),
    failureUi: () => cdp.js(pageFailureUi),
    waitForPermissionDialog,
    clickPermissionAllow,
    waitForPermissionDialogGone,
  };
}

/* ---------------- 数据库断言 ---------------- */

async function turnState(db, turnId) {
  const rows = await db.query(`
    SELECT t.session_id, t.status, t.stop_reason, t.ended_at,
           (SELECT count(*) FROM atoms a
             WHERE a.turn_id = t.id AND a.channel = 'chat' AND a.kind = 'text.user') AS user_atoms,
           (SELECT count(*) FROM atoms a
             WHERE a.turn_id = t.id AND a.channel = 'chat' AND a.kind = 'text.agent') AS agent_atoms,
           (SELECT count(*) FROM atoms a
             WHERE a.turn_id = t.id AND a.channel = 'trace' AND a.kind = 'usage') AS usage_atoms,
           (SELECT count(*) FROM atoms a
             WHERE a.turn_id = t.id AND a.sealed_at IS NULL) AS open_atoms
      FROM turns t
     WHERE t.id = ${sqlString(turnId)}
     LIMIT 1`);
  if (rows.length === 0) throw new Error(`库里找不到 turn_id=${turnId}`);
  const row = rows[0];
  return {
    sessionId: row.session_id,
    status: row.status,
    stopReason: row.stop_reason,
    endedAt: row.ended_at,
    userAtoms: asNumber(row.user_atoms),
    agentAtoms: asNumber(row.agent_atoms),
    usageAtoms: asNumber(row.usage_atoms),
    openAtoms: asNumber(row.open_atoms),
    terminal: row.status !== "running" && row.status !== "waiting_approval",
  };
}

async function waitForTurnState(db, ui, turnId, predicate, label) {
  return waitFor(
    label,
    async () => {
      const state = await turnState(db, turnId);
      return predicate(state) ? state : null;
    },
    {
      detail: async () => {
        let state;
        try {
          state = await turnState(db, turnId);
        } catch (error) {
          state = { error: errorText(error) };
        }
        const dom = await ui.snapshot().catch((error) => ({ error: errorText(error) }));
        return `turn=${turnId} ${JSON.stringify(state)}；当前 DOM 仍是 ${JSON.stringify(dom)}`;
      },
    },
  );
}

async function atomCount(db, sessionId) {
  const rows = await db.query(
    `SELECT count(*) AS n FROM atoms WHERE session_id = ${sqlString(sessionId)}`,
  );
  return asNumber(rows[0]?.n);
}

async function resolveCurrentSession(db, ui) {
  const turnId = await ui.latestTurnId();
  if (turnId) {
    const rows = await db.query(`
      SELECT t.id AS turn_id, s.id, s.title, s.cwd
        FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE t.id = ${sqlString(turnId)}
       LIMIT 1`);
    if (rows.length > 0) {
      return {
        id: rows[0].id,
        title: rows[0].title,
        cwd: rows[0].cwd,
        turnId,
        source: `可见 turn ${turnId}`,
      };
    }
  }

  const active = await ui.activeSidebarRow();
  if (!active) throw new Error("无法确定当前会话：DOM 没有可见 turn，侧栏也没有选中项");

  const candidates = await db.query(`
    SELECT id, title, cwd, updated_at
      FROM sessions
     WHERE title = ${sqlString(active.title)}
     ORDER BY updated_at DESC`);
  if (candidates.length === 0) {
    throw new Error(`无法确定当前会话：侧栏「${active.title}」在 sessions 里没有同名行`);
  }
  if (candidates.length === 1) {
    return { ...candidates[0], source: "侧栏标题" };
  }

  const byCwd = candidates.filter((row) => row.cwd && active.text.includes(row.cwd));
  if (byCwd.length === 1) {
    return { ...byCwd[0], source: "侧栏标题 + cwd" };
  }
  throw new Error(
    `无法唯一确定当前会话：侧栏「${active.title}」对应 ${candidates.length} 条 sessions（${candidates
      .map((row) => row.id)
      .join(", ")}）；请先让该会话有一轮可见对话`,
  );
}

function check(key, pass, detail) {
  return { key, pass: !!pass, detail };
}

function resultFromChecks(checks) {
  const failed = checks.find((item) => !item.pass);
  if (failed) {
    return {
      status: "fail",
      reason: `${failed.key} 失败：${failed.detail ?? "断言不成立"}`,
      checks,
    };
  }
  return { status: "pass", checks };
}

function skip(reason) {
  return { status: "skip", reason, checks: [] };
}

async function globalInvariant(db) {
  const rows = await db.query(`
    SELECT count(*) AS bad
      FROM atoms a JOIN turns t ON t.id = a.turn_id
     WHERE a.sealed_at IS NULL AND t.status NOT IN ('running', 'waiting_approval')`);
  return asNumber(rows[0]?.bad);
}

async function applyGlobalInvariant(db, flowResult) {
  let bad;
  try {
    bad = await globalInvariant(db);
  } catch (error) {
    const reason = `I1 查询失败：${errorText(error)}`;
    return flowResult.status === "fail"
      ? { ...flowResult, reason: `${flowResult.reason}；${reason}` }
      : { status: "fail", checks: flowResult.checks ?? [], reason };
  }

  if (bad === 0) return flowResult;
  const reason = `I1 失败：未封口原子挂在已结束的轮上 count=${bad}`;
  return flowResult.status === "fail"
    ? { ...flowResult, reason: `${flowResult.reason}；${reason}` }
    : { status: "fail", checks: flowResult.checks ?? [], reason };
}

/* ---------------- flows ---------------- */

async function flowNormal({ db, ui }) {
  await ui.newSession();
  const prompt = "只回复两个字：收到";
  await ui.send(prompt);

  const reply = await ui.waitForAgentTurn();
  const turnId = reply.turnId;
  const domMessages = await ui.messagesForTurn(turnId);

  const state = await waitForTurnState(
    db,
    ui,
    turnId,
    (value) => value.terminal,
    "轮次收尾",
  );

  const checks = [
    check(
      "a_dom_messages",
      domMessages.length >= 2 && domMessages.some((message) => message.kind === "agent"),
      `turn=${turnId} dom_messages=${domMessages.length} agent_rows=${domMessages.filter((message) => message.kind === "agent").length}`,
    ),
    check(
      "b_db_atoms",
      state.userAtoms === 1 && state.agentAtoms >= 1 && state.usageAtoms >= 1,
      `text.user=${state.userAtoms} text.agent=${state.agentAtoms} trace.usage=${state.usageAtoms}`,
    ),
    check(
      "c_turn_sealed",
      state.status === "finished" && state.openAtoms === 0,
      `status=${state.status} open_atoms=${state.openAtoms}`,
    ),
  ];
  return resultFromChecks(checks);
}

async function flowCancel({ db, ui }) {
  await ui.newSession();
  const prompt = "写 300 字介绍 SQLite 的 WAL 模式";
  await ui.send(prompt);
  const userTurn = await ui.waitForUserTurn();
  const turnId = userTurn.turnId;
  const output = await ui.waitForStopOrOutput(turnId);
  await ui.clickStop();

  const state = await waitForTurnState(
    db,
    ui,
    turnId,
    (value) => value.terminal,
    "取消后的轮次收尾",
  );
  const failureUi = await ui.failureUi();

  const checks = [
    check(
      "a_turn_cancelled",
      state.status === "finished" && state.stopReason === "cancelled",
      `status=${state.status} stop_reason=${state.stopReason} agent_text_len=${output.textLength}`,
    ),
    check(
      "b_all_atoms_sealed",
      state.openAtoms === 0,
      `open_atoms=${state.openAtoms}`,
    ),
    check(
      "c_no_send_failure",
      !failureUi.visible && failureUi.titledCount === 0,
      `visible=${failureUi.visible} titled=${failureUi.titledCount}${failureUi.titled.length ? ` ${JSON.stringify(failureUi.titled)}` : ""}`,
    ),
  ];
  return resultFromChecks(checks);
}

async function flowReopen({ db, ui }) {
  await ui.ensureSessionsMode();
  let rows = await ui.sidebarRows();
  let original = rows.find((row) => row.active);
  if (!original) throw new Error("reopen：侧栏没有选中的会话");

  if (rows.length < 2) {
    await ui.newSession();
    const clicked = await ui.clickSidebarRow(original);
    if (!clicked.ok) throw new Error("reopen：创建第二条会话后切回原会话失败");
    await ui.waitForActiveSidebarRow(original);
    rows = await ui.sidebarRows();
    original = rows.find((row) => row.active) ?? original;
  }

  const session = await resolveCurrentSession(db, ui);
  const beforeMessages = await ui.messages();
  const beforeAtoms = await atomCount(db, session.id);
  const other = rows.find((row) => !row.active && row.index !== original.index);
  if (!other) throw new Error("reopen：侧栏没有另一条可切换的会话");

  await ui.clickSidebarRow(other);
  await ui.waitForActiveSidebarRow(other);
  await sleep(250);
  await ui.clickSidebarRow(original);
  await ui.waitForActiveSidebarRow(original);

  const afterMessages = await waitFor(
    "切回后的消息恢复",
    async () => {
      const messages = await ui.messages();
      return messages.length === beforeMessages.length ? messages : null;
    },
    {
      timeout: LOCAL_TIMEOUT_MS,
      detail: async () => `当前 DOM 仍是 ${JSON.stringify(await ui.snapshot())}`,
    },
  );
  const afterAtoms = await atomCount(db, session.id);

  const orderSame =
    afterMessages.length === beforeMessages.length &&
    afterMessages.every(
      (message, index) =>
        message.id === beforeMessages[index]?.id &&
        message.turnId === beforeMessages[index]?.turnId,
    );

  const checks = [
    check(
      "a_message_count",
      afterMessages.length === beforeMessages.length,
      `before=${beforeMessages.length} after=${afterMessages.length} session=${session.id}`,
    ),
    check(
      "b_message_order",
      orderSame,
      `before=${JSON.stringify(beforeMessages.map((message) => [message.id, message.turnId]))} after=${JSON.stringify(afterMessages.map((message) => [message.id, message.turnId]))}`,
    ),
    check(
      "c_db_atoms_unchanged",
      afterAtoms === beforeAtoms,
      `before=${beforeAtoms} after=${afterAtoms} session=${session.id} source=${session.source}`,
    ),
  ];
  return resultFromChecks(checks);
}

async function flowPermission({ db, ui, options }) {
  if (!options.withPermission) {
    return skip("真机 agent 不发起权限请求（映射与单测已覆盖）");
  }

  await ui.newSession();
  await ui.send(options.permissionPrompt);
  const userTurn = await ui.waitForUserTurn();
  const turnId = userTurn.turnId;
  const dialog = await ui.waitForPermissionDialog();
  const waiting = await turnState(db, turnId);
  const clicked = await ui.clickPermissionAllow();
  await ui.waitForPermissionDialogGone();

  const state = await waitForTurnState(
    db,
    ui,
    turnId,
    (value) => value.terminal,
    "权限放行后的轮次收尾",
  );

  const decisions = await waitFor(
    "permission_decision 落库",
    async () => {
      const rows = await db.query(`
        SELECT id, payload_json
          FROM atoms
         WHERE turn_id = ${sqlString(turnId)}
           AND channel = 'trace'
           AND kind = 'permission_decision'
           AND json_extract(payload_json, '$.verdict') = 'allow'
         LIMIT 1`);
      return rows.length > 0 ? rows[0] : null;
    },
    {
      timeout: LOCAL_TIMEOUT_MS,
      detail: async () => `turn=${turnId} 尚未看到 permission_decision(verdict=allow)`,
    },
  );

  const checks = [
    check(
      "a_permission_dialog",
      dialog.ok && waiting.status === "waiting_approval",
      `dialog=${dialog.title || "yes"} buttons=${JSON.stringify(dialog.buttons)} status=${waiting.status}`,
    ),
    check(
      "b_permission_allowed",
      clicked.ok && !!decisions.id,
      `clicked=${clicked.label} decision_atom=${decisions.id}`,
    ),
    check(
      "c_turn_resumed",
      state.status === "finished" && state.openAtoms === 0,
      `status=${state.status} open_atoms=${state.openAtoms}`,
    ),
  ];
  return resultFromChecks(checks);
}

async function agentAtomsForTurn(db, turnId) {
  return db.query(`
    SELECT id, seq, at, sealed_at
      FROM atoms
     WHERE turn_id = ${sqlString(turnId)}
       AND channel = 'chat'
       AND kind = 'text.agent'
     ORDER BY seq`);
}

async function flowLateText({ db, ui }) {
  await ui.newSession();
  await ui.send("只回复两个字：收到");
  const reply = await ui.waitForAgentTurn();
  const turnId = reply.turnId;
  const finished = await waitForTurnState(
    db,
    ui,
    turnId,
    (value) => value.terminal,
    "迟到文本观察前的轮次收尾",
  );
  if (finished.status !== "finished") {
    throw new Error(`late-text：轮次未正常结束 status=${finished.status}`);
  }

  const baselineAtoms = await agentAtomsForTurn(db, turnId);
  const baselineIds = new Set(baselineAtoms.map((row) => row.id));
  const baselineText = await ui.agentTextForTurn(turnId);
  const deadline = Date.now() + LATE_TEXT_WINDOW_MS;
  let detectedRows = [];
  let domChanged = false;

  while (Date.now() < deadline) {
    const rows = await agentAtomsForTurn(db, turnId);
    const newRows = rows.filter((row) => !baselineIds.has(row.id));
    const domText = await ui.agentTextForTurn(turnId);
    if (newRows.length > 0 || domText !== baselineText) {
      await sleep(200);
      const settledRows = await agentAtomsForTurn(db, turnId);
      detectedRows = settledRows.filter((row) => !baselineIds.has(row.id));
      domChanged = (await ui.agentTextForTurn(turnId)) !== baselineText;
      break;
    }
    await sleep(250);
  }

  if (detectedRows.length === 0 && !domChanged) {
    return skip("本轮没有触发迟到窗口");
  }

  let rowsToCheck = detectedRows;
  if (rowsToCheck.length === 0) {
    rowsToCheck = await db.query(`
      SELECT id, seq, at, sealed_at
        FROM atoms
       WHERE turn_id = ${sqlString(turnId)}
         AND channel = 'chat'
         AND kind = 'text.agent'
       ORDER BY seq DESC
       LIMIT 1`);
  }
  const unsealed = rowsToCheck.filter((row) => row.sealed_at === null || row.sealed_at === undefined);
  const checks = [
    check(
      "late_text_sealed",
      rowsToCheck.length > 0 && unsealed.length === 0,
      `dom_changed=${domChanged} rows=${JSON.stringify(rowsToCheck)}`,
    ),
  ];
  return resultFromChecks(checks);
}

const FLOW_FUNCTIONS = {
  normal: flowNormal,
  cancel: flowCancel,
  reopen: flowReopen,
  permission: flowPermission,
  "late-text": flowLateText,
};

function printChecks(name, result) {
  console.log(`\n[${name}]`);
  if (result.status === "skip") {
    console.log(`  SKIP ${result.reason}`);
    return;
  }
  for (const item of result.checks ?? []) {
    console.log(`  ${item.pass ? "PASS" : "FAIL"} ${item.key}${item.detail ? `：${item.detail}` : ""}`);
  }
}

async function run(options) {
  const db = createDb(options.db, options.sqlite3);
  const cdp = await connectCdp(options.cdp);
  const ui = createUi(cdp);
  const results = [];

  try {
    for (const name of options.selected) {
      let result;
      try {
        result = await FLOW_FUNCTIONS[name]({ db, ui, options });
      } catch (error) {
        result = { status: "fail", reason: `异常：${errorText(error)}`, checks: [] };
      }
      result = await applyGlobalInvariant(db, result);
      printChecks(name, result);
      results.push({ name, ...result });
    }
  } finally {
    cdp.close();
  }

  console.log("\n=== flow-check 汇总 ===");
  for (const result of results) {
    if (result.status === "pass") {
      const passed = result.checks.filter((item) => item.pass).length;
      console.log(`PASS ${result.name}（${passed}/${result.checks.length}）`);
    } else if (result.status === "fail") {
      console.log(`FAIL ${result.name}（${result.reason}）`);
    } else {
      console.log(`SKIP  ${result.name}  ${result.reason}`);
    }
  }

  return results.some((result) => result.status === "fail") ? 1 : 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorText(error));
    console.error("");
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    process.exitCode = await run(options);
  } catch (error) {
    console.error(`flow-check 启动失败：${errorText(error)}`);
    process.exitCode = 1;
  }
}

await main();
