#!/usr/bin/env node
/**
 * E9 gh 冒烟：段 A 跑真实 `gh` 取读数，段 B 用仓库里的真 fixtures 打桩看 UI。
 *
 * 用法（先构建 dist，再把 dist 起在本地 HTTP 端口）：
 *   node scripts/smoke-gh.mjs --base http://127.0.0.1:4181/index.html \
 *     [--chromium /usr/bin/chromium] [--json out.json]
 *
 * 只读数、不截图、不做视觉判断。缺 playwright / Chromium / 参数错误时 exit(2)；
 * 任一场景 ✖ 时 exit(1)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(repoRoot, "src-tauri", "tests", "fixtures", "gh");

function usage() {
  console.log(`用法：node scripts/smoke-gh.mjs [选项]

  --base <url>        页面地址（默认 http://127.0.0.1:4181/index.html）
  --chromium <path>   Chromium 可执行文件（也可用 PW_CHROMIUM）
  --json <path>       写出结构化结果

环境变量：
  PW_MODULE           playwright 入口（ESM 不认 NODE_PATH）
  PW_CHROMIUM         Chromium 可执行文件（优先于 --chromium）`);
}

function argsError(message) {
  console.error(`参数错误：${message}`);
  usage();
  exit(2);
}

function parseArgs() {
  const out = {
    base: "http://127.0.0.1:4181/index.html",
    chromium: null,
    json: null,
  };
  const allowed = new Set(["base", "chromium", "json"]);

  for (let i = 2; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === "--help" || raw === "-h") {
      usage();
      exit(0);
    }
    if (!raw.startsWith("--")) argsError(`未知参数：${raw}`);

    let name = raw.slice(2);
    let value;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else {
      if (!allowed.has(name)) argsError(`未知参数：--${name}`);
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) argsError(`--${name} 缺少参数`);
      i += 1;
    }
    if (!allowed.has(name)) argsError(`未知参数：--${name}`);
    if (!value) argsError(`--${name} 不能为空`);
    out[name] = value;
  }

  try {
    const url = new URL(out.base);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      argsError(`--base 只接受 http(s) URL：${out.base}`);
    }
  } catch {
    argsError(`--base 不是合法 URL：${out.base}`);
  }
  return out;
}

const args = parseArgs();
const base = args.base;
const jsonOut = args.json;
const chromium = env.PW_CHROMIUM ?? args.chromium ?? "/usr/sbin/chromium-browser";
const pwModule = env.PW_MODULE ?? "playwright";

if (!existsSync(chromium)) {
  console.error(`找不到 Chromium：${chromium}（用 --chromium 或 PW_CHROMIUM 指定可执行文件）`);
  exit(2);
}

let chromiumLauncher;
try {
  ({ chromium: chromiumLauncher } = await import(pwModule));
} catch (e) {
  console.error(`缺少 playwright（试过 ${pwModule}）：npm i -D playwright 或用 PW_MODULE 指定入口`);
  console.error(String(e).slice(0, 240));
  exit(2);
}

function readFixture(rel) {
  return readFileSync(join(FIXTURE_DIR, rel), "utf8");
}

let fixtureListRaw;
let fixtureDetailRaw;
let fixtureDiffText;
try {
  fixtureListRaw = JSON.parse(readFixture("pr-list.json"));
  fixtureDetailRaw = JSON.parse(readFixture("pr-detail.json"));
  fixtureDiffText = readFixture("pr-diff.txt");
} catch (e) {
  console.error(`读 gh fixtures 失败（${FIXTURE_DIR}）：${String(e).slice(0, 240)}`);
  exit(2);
}

const results = [];
function record(scene, source, ok, reading) {
  results.push({ scene, source, ok, reading });
  console.log(`${ok ? "✔" : "✖"} ${scene} — ${source} — ${reading}`);
}

const fmtMs = (value) => `${Math.round(value)}ms`;
const fmtBytes = (value) => `${value.toLocaleString("en-US")} B`;
const firstLine = (text) =>
  (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
const excerpt = (text, limit = 320) => {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};

/** 跑一条真实命令；不经过 shell，超时与退出码都原样保留。 */
function runCommand(command, commandArgs, { extraEnv, timeout = 15_000, cwd = repoRoot } = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: null,
    env: extraEnv ? { ...env, ...extraEnv } : env,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : (result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : (result.stderr ?? "");
  return {
    rc: result.status,
    signal: result.signal,
    error: result.error ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    elapsedMs,
  };
}

const rcText = (result) => {
  if (result.timedOut) return `timeout(${result.signal ?? "killed"})`;
  if (result.rc !== null) return String(result.rc);
  return result.error?.code ?? "spawn-failed";
};

/** gh 可能不在 PATH（Windows 上文档记录的是固定路径）；只在 ENOENT 时兜底，不改变命令本身。 */
function findWindowsGh() {
  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, "GitHub CLI", "gh.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"),
    env.USERPROFILE && join(env.USERPROFILE, "scoop", "shims", "gh.exe"),
    env.USERPROFILE && join(env.USERPROFILE, "scoop", "shims", "gh.cmd"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 50711 的真实来源不是 stderr 第一行（那行是 host），而是第一句「登录失败 / token 无效」。 */
const signalLine = (text) =>
  (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /failed to log in|bad credentials|invalid/i.test(line)) ?? firstLine(text);

const diffLineText = (raw) => {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized) return [];
  const stripped = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return stripped.split("\n");
};

function prStateView(raw) {
  const state = String(raw?.state ?? "").toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN" && raw?.isDraft) return "draft";
  return "open";
}

function normalizeMergeable(value) {
  const trimmed = String(value ?? "").trim();
  return !trimmed || trimmed.toUpperCase() === "UNKNOWN" ? undefined : trimmed.toLowerCase();
}

function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "pending";
  let pending = false;
  for (const check of rollup) {
    const isStatusContext =
      String(check?.__typename ?? "").toLowerCase() === "statuscontext" ||
      (check?.status == null && check?.conclusion == null && check?.state != null);
    if (isStatusContext) {
      const state = String(check?.state ?? "").toUpperCase();
      if (state === "FAILURE" || state === "ERROR") return "failing";
      if (state === "PENDING") pending = true;
      continue;
    }
    const conclusion = String(check?.conclusion ?? "").toUpperCase();
    if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
      return "failing";
    }
    const completed = String(check?.status ?? "").toUpperCase() === "COMPLETED";
    const conclusionEmpty = check?.conclusion == null || String(check.conclusion).trim() === "";
    if (!completed || conclusionEmpty) pending = true;
  }
  return pending ? "pending" : "passing";
}

function prDto(raw) {
  const reviewDecision = String(raw?.reviewDecision ?? "").trim();
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: prStateView(raw),
    author: {
      login: raw.author?.login ?? "",
      ...(String(raw.author?.name ?? "").trim() ? { name: String(raw.author.name).trim() } : {}),
      isBot: Boolean(raw.author?.is_bot ?? raw.author?.isBot),
    },
    head: raw.headRefName,
    base: raw.baseRefName,
    updatedAt: raw.updatedAt,
    ...(normalizeMergeable(raw.mergeable) ? { mergeable: normalizeMergeable(raw.mergeable) } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    checks: summarizeChecks(raw.statusCheckRollup),
  };
}

function prDetailDto(raw) {
  const files = Array.isArray(raw.files)
    ? raw.files.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: String(file.changeType ?? "").toLowerCase(),
      }))
    : [];
  return {
    pr: prDto(raw),
    body: raw.body ?? "",
    createdAt: raw.createdAt,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    files,
    filesTruncated: files.length !== raw.changedFiles,
  };
}

const fixtureItems = fixtureListRaw.map(prDto);
const fixtureDetail = prDetailDto(fixtureDetailRaw);
const fixtureDiffLines = diffLineText(fixtureDiffText);
const mergedItem = fixtureItems.find((item) => item.state === "merged") ?? fixtureItems[0];
const mergedRaw = fixtureListRaw.find((item) => String(item.state).toUpperCase() === "MERGED") ?? fixtureListRaw[0];
if (!mergedItem || !mergedRaw) {
  console.error("pr-list.json 为空：段 B 的合并 PR 场景没有可点的行");
  exit(2);
}

const repoPath = "C:\\source\\sincearc";
const identity = { host: "github.com", owner: "wangsyiiz", name: "SinceArc" };
const statusReady = {
  available: true,
  version: "2.103.3",
  loggedIn: true,
  ghPath: "C:\\Program Files\\GitHub CLI\\gh.exe",
  host: "github.com",
  cwdOk: true,
};
const statusLoggedOut = {
  available: true,
  version: "2.103.3",
  loggedIn: false,
  ghPath: "C:\\Program Files\\GitHub CLI\\gh.exe",
  host: null,
  cwdOk: true,
};
const statusMissing = {
  available: false,
  version: null,
  loggedIn: false,
  ghPath: null,
  host: null,
  cwdOk: true,
};

console.log("\n段 A · 真实后端读数（gh）");

// A1) 可用性
let ghBin = "gh";
let versionRun = runCommand(ghBin, ["--version"], { timeout: 15_000 });
// 本仓的 Windows 真机就是这种情况：where.exe gh 无输出，gh 只在固定路径里。
if (versionRun.rc === null && versionRun.error?.code === "ENOENT" && process.platform === "win32") {
  const fallback = findWindowsGh();
  if (fallback) {
    ghBin = fallback;
    versionRun = runCommand(ghBin, ["--version"], { timeout: 15_000 });
  }
}
const version = versionRun.stdout.match(/gh version\s+([0-9]+\.[0-9]+\.[0-9]+)/i)?.[1] ?? null;
// 只看退出码与版本号：某些沙箱里 spawnSync 成功时仍会挂一个 EPERM 错误对象，不能当失败。
const ghAvailable = versionRun.rc === 0;
const availabilityOk = ghAvailable && Boolean(version);
const versionFailure = firstLine(versionRun.stderr) || versionRun.error?.code || "rc≠0";
const notInstalled = versionRun.rc === null && versionRun.error?.code === "ENOENT";
record(
  "A1 gh 可用性",
  "real-gh",
  availabilityOk,
  availabilityOk
    ? `version=${version} bin=${ghBin} 耗时=${fmtMs(versionRun.elapsedMs)}`
    : `available=false ${notInstalled ? "未安装" : "未安装或不可用"} version=${version ?? "—"} bin=${ghBin} ${versionRun.timedOut ? "timeout" : `rc=${rcText(versionRun)}`} 原因="${versionFailure}" 耗时=${fmtMs(versionRun.elapsedMs)}`,
);

if (!ghAvailable) {
  const skipped = [
    ["A2 登录态", "gh auth status"],
    ["A3 列表", "gh pr list --state all --limit 30 --json …"],
    ["A4 详情", "gh pr view <merged> --json …"],
    ["A5 diff", "gh pr diff <merged>"],
    ["A6 仓库不存在", "gh pr list -R wangsyiiz/nope-xyz-123"],
    ["A7 未登录", "GH_TOKEN=bad gh auth status"],
  ];
  for (const [scene, command] of skipped) record(scene, "real-gh", false, `skip：gh 不可用（${command} 未执行）`);
} else {
  // A2) 登录态
  const authRun = runCommand(ghBin, ["auth", "status"], { timeout: 15_000 });
  const authText = `${authRun.stdout}\n${authRun.stderr}`;
  const login =
    authText.match(/Logged in to\s+\S+\s+account\s+([^\s()]+)/i)?.[1] ??
    authText.match(/Logged in to\s+\S+\s+as\s+([^\s()]+)/i)?.[1] ??
    authText.match(/account\s+([^\s()]+)/i)?.[1] ??
    null;
  const loggedIn = authRun.rc === 0;
  record(
    "A2 登录态",
    "real-gh",
    loggedIn && Boolean(login),
    `loggedIn=${loggedIn} login=${login ?? "—"} rc=${rcText(authRun)} 耗时=${fmtMs(authRun.elapsedMs)}`,
  );

  // A3) 列表
  const listFields =
    "number,title,state,isDraft,author,updatedAt,headRefName,baseRefName,url,mergeable,reviewDecision,statusCheckRollup";
  const listRun = runCommand(
    ghBin,
    ["pr", "list", "--state", "all", "--limit", "30", "--json", listFields],
    { timeout: 20_000 },
  );
  let listRaw = null;
  let listParseError = null;
  if (listRun.rc === 0) {
    try {
      listRaw = JSON.parse(listRun.stdout);
    } catch (e) {
      listParseError = String(e).slice(0, 120);
    }
  }
  const stateCounts = {};
  if (Array.isArray(listRaw)) {
    for (const item of listRaw) {
      const key = String(item.state ?? "?").toUpperCase();
      stateCounts[key] = (stateCounts[key] ?? 0) + 1;
    }
  }
  const listOk = listRun.rc === 0 && Array.isArray(listRaw);
  record(
    "A3 列表",
    "real-gh",
    listOk,
    listOk
      ? `条数=${listRaw.length} 耗时=${fmtMs(listRun.elapsedMs)} 字节=${fmtBytes(listRun.stdoutBytes)} states=${JSON.stringify(stateCounts)}`
      : `rc=${rcText(listRun)} 耗时=${fmtMs(listRun.elapsedMs)} 字节=${fmtBytes(listRun.stdoutBytes)}${listParseError ? ` 解析失败=${listParseError}` : ` stderr首行="${firstLine(listRun.stderr)}"`}`,
  );

  const selectedRaw = Array.isArray(listRaw)
    ? listRaw.find((item) => String(item.state).toUpperCase() === "MERGED") ?? listRaw[0]
    : null;
  const selectedNumber = selectedRaw?.number ?? null;
  const selectedKind = selectedRaw
    ? String(selectedRaw.state).toUpperCase() === "MERGED"
      ? "merged"
      : "fallback"
    : "—";

  // A4) 详情
  if (selectedNumber == null) {
    record("A4 详情", "real-gh", false, `skip：列表没有可用 PR${listOk ? "（0 条）" : `（${firstLine(listRun.stderr) || rcText(listRun)}）`}`);
    record("A5 diff", "real-gh", false, `skip：列表没有可用 PR${listOk ? "（0 条）" : `（${firstLine(listRun.stderr) || rcText(listRun)}）`}`);
  } else {
    const detailFields =
      "number,title,state,isDraft,mergeable,reviewDecision,author,updatedAt,createdAt,headRefName,baseRefName,url,statusCheckRollup,body,additions,deletions,changedFiles,files";
    const detailRun = runCommand(
      ghBin,
      ["pr", "view", String(selectedNumber), "--json", detailFields],
      { timeout: 20_000 },
    );
    let detailRaw = null;
    let detailParseError = null;
    if (detailRun.rc === 0) {
      try {
        detailRaw = JSON.parse(detailRun.stdout);
      } catch (e) {
        detailParseError = String(e).slice(0, 120);
      }
    }
    const detailOk = detailRun.rc === 0 && detailRaw != null;
    record(
      "A4 详情",
      "real-gh",
      detailOk,
      detailOk
        ? `#${selectedNumber}(${selectedKind}) 文件数=${Array.isArray(detailRaw.files) ? detailRaw.files.length : "—"} additions=${detailRaw.additions ?? "—"} deletions=${detailRaw.deletions ?? "—"} body字符数=${Array.from(String(detailRaw.body ?? "")).length} 耗时=${fmtMs(detailRun.elapsedMs)} 字节=${fmtBytes(detailRun.stdoutBytes)}`
        : `#${selectedNumber}(${selectedKind}) rc=${rcText(detailRun)} 耗时=${fmtMs(detailRun.elapsedMs)} 字节=${fmtBytes(detailRun.stdoutBytes)}${detailParseError ? ` 解析失败=${detailParseError}` : ` stderr首行="${firstLine(detailRun.stderr)}"`}`,
    );

    // A5) diff
    const diffRun = runCommand(ghBin, ["pr", "diff", String(selectedNumber)], { timeout: 30_000 });
    const lines = diffLineText(diffRun.stdout);
    const totalPages = lines.length === 0 ? 0 : Math.ceil(lines.length / 200);
    const diffOk = diffRun.rc === 0;
    record(
      "A5 diff",
      "real-gh",
      diffOk,
      diffOk
        ? `#${selectedNumber} 总行数=${lines.length} 字节=${fmtBytes(diffRun.stdoutBytes)} 页数=${totalPages}(每页200) 耗时=${fmtMs(diffRun.elapsedMs)}`
        : `#${selectedNumber} rc=${rcText(diffRun)} 耗时=${fmtMs(diffRun.elapsedMs)} 字节=${fmtBytes(diffRun.stdoutBytes)} stderr首行="${firstLine(diffRun.stderr)}"`,
    );
  }

  // A6) 仓库不存在
  const missingRun = runCommand(ghBin, ["pr", "list", "-R", "wangsyiiz/nope-xyz-123"], { timeout: 20_000 });
  const missingText = `${missingRun.stderr}\n${missingRun.stdout}`;
  const missingSignature = /could not resolve to a repository/i.test(missingText);
  record(
    "A6 仓库不存在",
    "real-gh",
    missingRun.rc !== 0 && missingSignature,
    `rc=${rcText(missingRun)} stderr首行="${firstLine(missingRun.stderr) || "(空)"}" 50713信号=${missingSignature} 耗时=${fmtMs(missingRun.elapsedMs)}`,
  );

  // A7) 未登录
  const badAuthRun = runCommand(ghBin, ["auth", "status"], {
    extraEnv: { GH_TOKEN: "bad" },
    timeout: 15_000,
  });
  const badAuthText = `${badAuthRun.stdout}\n${badAuthRun.stderr}`;
  const badAuthSignature = /bad credentials|failed to log in|invalid/i.test(badAuthText);
  const badAuthFirst = firstLine(badAuthRun.stderr) || firstLine(badAuthRun.stdout) || "(空)";
  const badAuthSignal = signalLine(badAuthRun.stderr) || signalLine(badAuthRun.stdout) || "(空)";
  record(
    "A7 未登录",
    "real-gh",
    badAuthRun.rc !== 0 && badAuthSignature,
    `rc=${rcText(badAuthRun)} stderr首行="${badAuthFirst}" 命中句="${badAuthSignal}" 50711信号=${badAuthSignature} 耗时=${fmtMs(badAuthRun.elapsedMs)}`,
  );
}

/** 浏览器里的 Tauri IPC 打桩：只有 gh_* 返回业务数据，其余启动链路给空结果。 */
const ipcStub = ({ status, resolve: repoResolve, list, detail, diff, diffLines }) => {
  window.__smoke = { calls: [], diffCalls: [] };

  const route = (entry) => {
    if (!entry) return undefined;
    if (!entry.ok) throw entry.error;
    return entry.value;
  };

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, cmdArgs = {}) => {
      window.__smoke.calls.push(cmd);
      if (cmd === "gh_status") return status;
      if (cmd === "gh_repo_resolve") return route(repoResolve);
      if (cmd === "gh_pr_list") return route(list);
      if (cmd === "gh_pr_detail") {
        if (window.__smoke.detailCalls === undefined) window.__smoke.detailCalls = 0;
        window.__smoke.detailCalls += 1;
        return route(detail);
      }
      if (cmd === "gh_pr_diff") {
        if (diff && !diff.ok) throw diff.error;
        const page = cmdArgs.page ?? 0;
        const pageSize = cmdArgs.pageSize ?? 200;
        window.__smoke.diffCalls.push({ page, pageSize });
        const totalLines = diffLines.length;
        const totalPages = totalLines === 0 ? 0 : Math.ceil(totalLines / pageSize);
        const start = page * pageSize;
        const lines = start >= totalLines ? [] : diffLines.slice(start, start + pageSize);
        return { lines, page, pageSize, totalLines, totalPages };
      }
      if (cmd === "settings_load") {
        return {
          settings: {
            contextMessages: 5,
            theme: "dark",
            autoApproveDefault: "off",
            mcpInheritDefault: true,
            tweenEnabled: false,
            codeTheme: "sincearc",
            language: "zh-CN",
          },
          issues: [],
        };
      }
      if (cmd === "settings_save") return null;
      if (cmd === "agent_discovery_cached" || cmd === "agent_discover") {
        return { scannedAt: 0, candidates: [], found: [], warnings: [] };
      }
      if (cmd === "messages_load") return { messages: [], hasMore: false };
      if (cmd === "session_usage") return null;
      if (cmd === "session_storage_stats") {
        return {
          atomCount: 0,
          chatCount: 0,
          traceCount: 0,
          bytes: 0,
          oldestAt: null,
          thresholdCount: 0,
          thresholdDays: 0,
          over: false,
          reasons: [],
        };
      }
      if (
        cmd === "profiles_load" ||
        cmd === "sessions_list" ||
        cmd === "mcp_catalog" ||
        cmd === "agent_users_list" ||
        cmd === "session_members" ||
        cmd === "session_trace"
      ) {
        return [];
      }
      return null;
    },
    transformCallback: (callback) => {
      const id = Math.floor(Math.random() * 1e9);
      window[`_${id}`] = callback;
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
  };
};

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText ?? "");
}

async function pageSnapshot(page) {
  try {
    return excerpt(await bodyText(page), 320);
  } catch {
    return "(页面读不到 innerText)";
  }
}

async function step(page, label, fn) {
  try {
    return await fn();
  } catch (e) {
    const text = await pageSnapshot(page);
    throw new Error(`${label}：${e instanceof Error ? e.message : String(e)}；innerText="${text}"`);
  }
}

async function openCodeRepo(page) {
  await step(page, "切到侧栏「代码」", () =>
    page.getByRole("button", { name: "代码", exact: true }).click(),
  );
  await step(page, "点「添加项目路径」", () =>
    page.getByRole("button", { name: "添加项目路径", exact: true }).click(),
  );
  const input = page.getByPlaceholder("/home/jerry/source/项目", { exact: true });
  await step(page, "填项目路径", () => input.fill(repoPath));
  await step(page, "回车添加项目", () => input.press("Enter"));
  await step(page, "点开项目", () =>
    page.locator("aside button").filter({ hasText: /sincearc/i }).first().click(),
  );
  await step(page, "等待主区域渲染", () => page.getByRole("main").waitFor({ timeout: 10_000 }));
}

let browser;

async function runUi(scene, stub, fn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !/Failed to load resource|404/.test(text)) {
      consoleErrors.push(`console: ${text}`);
    }
  });

  try {
    await page.addInitScript(ipcStub, stub);
    await page.goto(base, { waitUntil: "load", timeout: 20_000 });
    await page.waitForTimeout(500);
    const result = await fn(page, pageErrors, consoleErrors);
    record(scene, "stub", result.ok, result.reading);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const withSnapshot = message.includes('innerText="') ? message : `${message}；innerText="${await pageSnapshot(page)}"`;
    record(scene, "stub", false, withSnapshot);
  } finally {
    await context.close();
  }
}

const stubFor = (overrides = {}) => ({
  status: overrides.status ?? statusReady,
  resolve: overrides.resolve ?? { ok: true, value: identity },
  list: overrides.list ?? { ok: true, value: { items: fixtureItems } },
  detail: overrides.detail ?? { ok: true, value: fixtureDetail },
  diff: overrides.diff ?? { ok: true },
  diffLines: fixtureDiffLines,
});

const PR_STATE_LABEL = { open: "开放", draft: "草稿", merged: "已合并", closed: "已关闭" };

try {
  browser = await chromiumLauncher.launch({
    executablePath: chromium,
    args: ["--no-sandbox"],
  });
} catch (e) {
  console.error(`启动 Chromium 失败：${String(e).slice(0, 300)}`);
  exit(2);
}

console.log("\n段 B · UI 对读数的呈现（fixtures 打桩）");

// B1) 没装 gh
await runUi("B1 没装 gh", stubFor({ status: statusMissing }), async (page) => {
  await openCodeRepo(page);
  await step(page, "等安装指引", () =>
    page.getByText("没找到 GitHub CLI（gh）", { exact: true }).waitFor({ timeout: 8_000 }),
  );
  const text = await page.getByRole("main").innerText();
  const redetect = await page.getByRole("button", { name: "重新检测", exact: true }).count();
  const winget = text.includes("winget install --id GitHub.cli");
  const scoop = text.includes("scoop install gh");
  const install = text.includes("安装：");
  const login = text.includes("登录：");
  const auth = text.includes("gh auth login");
  const step3 = text.includes("回来点「重新检测」");
  const empty = text.includes("这个项目还没有 PR");
  return {
    ok: install && login && winget && scoop && auth && step3 && redetect > 0 && !empty,
    reading: `三步=${install && login && step3} winget=${winget} scoop=${scoop} auth=${auth} 重新检测按钮=${redetect} 空列表文案=${empty}`,
  };
});

// B2) 装了没登录
await runUi("B2 装了没登录", stubFor({ status: statusLoggedOut }), async (page) => {
  await openCodeRepo(page);
  await step(page, "等登录指引", () =>
    page.getByText("gh 还没登录 GitHub", { exact: true }).waitFor({ timeout: 8_000 }),
  );
  const text = await page.getByRole("main").innerText();
  const redetect = await page.getByRole("button", { name: "重新检测", exact: true }).count();
  const auth = text.includes("gh auth login");
  const login = text.includes("登录：");
  const installTitle = text.includes("安装：");
  const winget = text.includes("winget install --id GitHub.cli");
  const scoop = text.includes("scoop install gh");
  const step3 = text.includes("回来点「重新检测」");
  return {
    ok: auth && login && !installTitle && !winget && !scoop && !step3 && redetect > 0,
    reading: `auth=${auth} 登录：=${login} 安装：=${installTitle} winget=${winget} scoop=${scoop} 第3步=${step3} 重新检测按钮=${redetect}`,
  };
});

const listRowData = (page) =>
  page.evaluate(() => {
    const buttons = [...document.querySelectorAll("main button")];
    return buttons.map((button) => ({
      text: button.innerText ?? "",
      spans: [...button.querySelectorAll("span")].map((span) => ({
        text: (span.textContent ?? "").trim(),
        className: typeof span.className === "string" ? span.className : "",
      })),
    }));
  });

// B3) 列表 5 条
await runUi("B3 列表 5 条", stubFor(), async (page) => {
  await openCodeRepo(page);
  await step(page, "等列表", () =>
    page.getByRole("main").getByText(`#${fixtureItems[fixtureItems.length - 1].number}`, { exact: false }).first().waitFor({ timeout: 10_000 }),
  );
  const data = await listRowData(page);
  const rows = data.filter((row) => /#\d+/.test(row.text) && row.text.includes("→"));
  const mainText = await page.getByRole("main").innerText();
  const identityShown = mainText.includes(`${identity.owner}/${identity.name}`);
  const allRowsOk = fixtureItems.every((item) => {
    const row = rows.find((candidate) => candidate.text.includes(`#${item.number}`));
    return Boolean(
      row &&
        row.text.includes(item.head) &&
        row.text.includes(item.base) &&
        row.text.includes("→"),
    );
  });
  const mergedRow = rows.find((row) => row.text.includes(`#${mergedItem.number}`));
  const mergedState = mergedRow?.spans.find((span) => span.text === PR_STATE_LABEL[mergedItem.state]);
  const warnToken = /text-warn-1|bg-warn-1/.test(mergedState?.className ?? "");
  return {
    ok: rows.length === fixtureItems.length && allRowsOk && warnToken && identityShown,
    reading: `PR行数=${rows.length} fixture=${fixtureItems.length} 每行#编号+head→base=${allRowsOk} merged=#${mergedItem.number} 状态class含warn=${warnToken} 身份=${identityShown ? `${identity.owner}/${identity.name}` : "未显示"}`,
  };
});

async function openMergedPr(page) {
  await openCodeRepo(page);
  await step(page, "等列表里的 merged 行", () =>
    page.getByRole("main").getByRole("button").filter({ hasText: `#${mergedItem.number}` }).first().waitFor({ timeout: 10_000 }),
  );
  await step(page, "点开 merged PR", () =>
    page.getByRole("main").getByRole("button").filter({ hasText: `#${mergedItem.number}` }).first().click(),
  );
  // 详情返回后才有的按钮：它比列表里的状态徽章更能证明详情已经渲染。
  await step(page, "等详情正文", () =>
    page.getByRole("main").getByRole("button", { name: "加入对话", exact: true }).waitFor({ timeout: 10_000 }),
  );
  await step(page, "等详情徽章", () =>
    page.getByRole("main").getByText("已合并", { exact: true }).first().waitFor({ timeout: 10_000 }),
  );
}

// B4) 已合并 PR 渲染
await runUi("B4 已合并 PR 渲染", stubFor(), async (page, pageErrors) => {
  await openMergedPr(page);
  const badge = await page.getByRole("main").getByText("已合并", { exact: true }).count();
  const detailCalls = await page.evaluate(() => window.__smoke.detailCalls ?? 0);
  return {
    ok: pageErrors.length === 0 && badge > 0 && detailCalls > 0,
    reading: `pageerror=${pageErrors.length} merged徽章=${badge} gh_pr_detail调用=${detailCalls}`,
  };
});

// B5) 详情字段
await runUi("B5 详情字段", stubFor(), async (page) => {
  await openMergedPr(page);
  await step(page, "等统计块", () =>
    page.getByText(`${fixtureDetail.changedFiles} 个文件`, { exact: false }).first().waitFor({ timeout: 8_000 }),
  );
  const text = await bodyText(page);
  const files = text.includes(`${fixtureDetail.changedFiles} 个文件`);
  const additions = text.includes(`+${fixtureDetail.additions}`);
  const deletions = text.includes(`−${fixtureDetail.deletions}`);
  return {
    ok: files && additions && deletions,
    reading: `changedFiles=${fixtureDetail.changedFiles}(命中=${files}) additions=+${fixtureDetail.additions}(命中=${additions}) deletions=−${fixtureDetail.deletions}(命中=${deletions})`,
  };
});

// B6) diff 切片
await runUi("B6 diff 切片", stubFor(), async (page) => {
  await openMergedPr(page);
  const pre = page.getByRole("main").locator("pre").first();
  await step(page, "等 diff <pre>", () => pre.waitFor({ timeout: 10_000 }));
  const totalPages = Math.ceil(fixtureDiffLines.length / 200);
  const firstLines = await pre.locator("span").count();
  const firstFooter = await page.getByText(new RegExp(`第 1 / ${totalPages} 页`)).first().textContent();
  const next = page.getByRole("main").getByRole("button", { name: /下一页/ }).first();
  const firstNextEnabled = await next.isEnabled();

  for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
    await step(page, `点「下一页」到第 ${pageIndex + 1} 页`, () => next.click());
    await step(page, `等第 ${pageIndex + 1} 页页脚`, () =>
      page.waitForFunction(
        ({ number, total }) => (document.body?.innerText ?? "").includes(`第 ${number} / ${total} 页`),
        { number: pageIndex + 1, total: totalPages },
        { timeout: 8_000 },
      ),
    );
  }

  const lastLines = await pre.locator("span").count();
  const lastNextDisabled = await next.isDisabled();
  const diffCalls = await page.evaluate(() => window.__smoke.diffCalls.map((call) => call.page));
  const pagesSeen = [...new Set(diffCalls)];
  const expectedFirst = Math.min(200, fixtureDiffLines.length);
  const expectedLast = Math.min(200, fixtureDiffLines.length - (totalPages - 1) * 200);
  const footer = firstFooter ?? "";
  const footerOk =
    footer.includes(`第 1 / ${totalPages} 页`) &&
    footer.includes(`共 ${fixtureDiffLines.length} 行`) &&
    footer.includes("每页 200 行");
  return {
    ok:
      firstLines === expectedFirst &&
      lastLines === expectedLast &&
      footerOk &&
      firstNextEnabled &&
      lastNextDisabled &&
      pagesSeen.join(",") === Array.from({ length: totalPages }, (_, index) => index).join(","),
    reading: `首页<pre>行数=${firstLines}/${expectedFirst} 末页<pre>行数=${lastLines}/${expectedLast} 页脚="${excerpt(footer, 90)}" 首页下一页可点=${firstNextEnabled} 末页下一页禁用=${lastNextDisabled} 请求页=${pagesSeen.join(",")} totalLines=${fixtureDiffLines.length} totalPages=${totalPages}`,
  };
});

// B7) 仓库不存在
const repoMissingError = { code: 50713, msg: "仓库不存在或没有权限" };
await runUi("B7 仓库不存在", stubFor({ list: { ok: false, error: repoMissingError } }), async (page) => {
  await openCodeRepo(page);
  await step(page, "等 50713 人话", () =>
    page.getByText(repoMissingError.msg, { exact: false }).first().waitFor({ timeout: 8_000 }),
  );
  const text = await bodyText(page);
  const human = text.includes(repoMissingError.msg);
  const empty = text.includes("这个项目还没有 PR");
  return {
    ok: human && !empty,
    reading: `50713人话=${human} 空列表文案=${empty} 文案="${repoMissingError.msg}"`,
  };
});

// B8) 不是 git 仓库
const notGitError = {
  code: 50717,
  key: "err.gh.notGitRepo",
  msg: `这个目录还不是 git 仓库：${repoPath}`,
  params: { path: repoPath },
};
await runUi("B8 不是 git 仓库", stubFor({ resolve: { ok: false, error: notGitError } }), async (page) => {
  await openCodeRepo(page);
  await step(page, "等 50717 人话", () =>
    page.getByText("还不是 git 仓库", { exact: false }).first().waitFor({ timeout: 8_000 }),
  );
  const text = await bodyText(page);
  const human = text.includes("还不是 git 仓库");
  const path = text.includes(repoPath);
  const empty = text.includes("这个项目还没有 PR");
  return {
    ok: human && path && !empty,
    reading: `不是git仓库文案=${human} 路径=${path} 空列表文案=${empty}`,
  };
});

await browser.close();

let jsonWriteFailed = false;
if (jsonOut) {
  try {
    writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  } catch (e) {
    console.error(`写 JSON 失败（${jsonOut}）：${String(e).slice(0, 200)}`);
    jsonWriteFailed = true;
  }
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
exit(failed.length === 0 && !jsonWriteFailed ? 0 : 1);
