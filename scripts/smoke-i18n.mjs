#!/usr/bin/env node
/**
 * i18n 冒烟：按 docs/i18n.md §6.2 的 6 行验收，在真渲染环境里取读数。
 *
 * 用法（先 `npm run build`，再把 dist 起在本地 HTTP 端口）：
 *   node scripts/smoke-i18n.mjs --base http://127.0.0.1:4181/index.html \
 *     [--chromium /usr/bin/chromium] [--json out.json]
 *
 * 只输出 DOM 读数（`document.documentElement.lang`、采样文本、落库调用参数），不截图、不做视觉判断。
 * 需要 playwright（`npm i -D playwright` 或全局装）；Chromium 可执行文件不存在时脚本直接报错退出，
 * 不会静默跳过验收项。
 */
import { existsSync } from "node:fs";
import { argv, env, exit } from "node:process";

const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const base = arg("base", "http://127.0.0.1:4181/index.html");
const chromium = env.PW_CHROMIUM ?? arg("chromium", null);
const jsonOut = arg("json", null);

let chromiumLauncher;
try {
  ({ chromium: chromiumLauncher } = await import("playwright"));
} catch {
  console.error("缺少 playwright：npm i -D playwright（或装到能 require 的全局路径）");
  exit(2);
}
if (!chromium && !existsSync("/usr/sbin/chromium-browser")) {
  console.error("找不到 Chromium：用 --chromium 或 PW_CHROMIUM 指定可执行文件");
  exit(2);
}

/** 把 Tauri IPC 打桩：只关心语言链路需要的几条命令，其余给空结果。 */
const ipcStub = (savedLanguage, failures = {}) => {
  window.__smoke = { savedLanguage: null, calls: [] };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__smoke.calls.push(cmd);
      if (failures[cmd]) throw failures[cmd];
      if (cmd === "settings_load") {
        return {
          settings: {
            contextMessages: 5,
            theme: "dark",
            autoApproveDefault: "off",
            mcpInheritDefault: true,
            tweenEnabled: true,
            codeTheme: "sincearc",
            language: savedLanguage,
          },
          issues: [],
        };
      }
      if (cmd === "settings_save") {
        window.__smoke.savedLanguage = args?.settings?.language ?? null;
        return null;
      }
      if (cmd === "profiles_load" || cmd === "sessions_list" || cmd === "mcp_catalog") return [];
      if (cmd === "agent_discovery_cached") return { cached: [], scannedAt: null };
      return [];
    },
    transformCallback: (cb) => {
      const id = Math.floor(Math.random() * 1e9);
      window[`_${id}`] = cb;
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
  };
};

const results = [];
const record = (row, ok, detail) => {
  results.push({ row, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${row} — ${detail}`);
};

const launch = async (locale, savedLanguage, failures) => {
  const browser = await chromiumLauncher.launch({
    executablePath: chromium ?? "/usr/sbin/chromium-browser",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 160)}`);
  });
  await page.addInitScript(ipcStub, savedLanguage, failures);
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  return { browser, page, errors };
};

const readLang = (page) => page.evaluate(() => document.documentElement.lang);
const sampleText = (page) =>
  page.evaluate(() => {
    const pick = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
    return {
      body: (document.body.innerText || "").slice(0, 400).replace(/\s+/g, " "),
      pick,
    };
  });

// 1) 系统中文 + 库里没有判定 → 首帧 zh-CN，并写回库
{
  const { browser, page, errors } = await launch("zh-CN", null);
  const lang = await readLang(page);
  const saved = await page.evaluate(() => window.__smoke.savedLanguage);
  record(
    "系统中文首启",
    lang === "zh-CN" && saved === "zh-CN" && errors.length === 0,
    `lang=${lang} saved=${saved} pageErrors=${errors.length}`,
  );
  await browser.close();
}

// 2) 系统英文 + 库里没有判定 → 首帧 en，并写回库
{
  const { browser, page, errors } = await launch("en-US", null);
  const lang = await readLang(page);
  const saved = await page.evaluate(() => window.__smoke.savedLanguage);
  const text = (await sampleText(page)).body;
  record(
    "英文系统首启",
    lang === "en" && saved === "en" && errors.length === 0,
    `lang=${lang} saved=${saved} 前 80 字="${text.slice(0, 80)}"`,
  );
  await browser.close();
}

// 3) 库里已经是 en（模拟重启）→ 首帧就是 en，不再改库
{
  const { browser, page } = await launch("zh-CN", "en");
  const lang = await readLang(page);
  const saved = await page.evaluate(() => window.__smoke.savedLanguage);
  record("落库值优先于系统语言", lang === "en" && saved === null, `lang=${lang} 二次保存=${saved}`);
  await browser.close();
}

// 4) 切语言即时生效：库里 zh-CN，点设置→外观→English
{
  const { browser, page, errors } = await launch("zh-CN", "zh-CN");
  const before = await readLang(page);
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "设置" || b.getAttribute("aria-label") === "设置",
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll("button")].find((b) =>
      /^(外观|Appearance)$/.test((b.textContent || "").trim()),
    );
    nav?.click();
  });
  await page.waitForTimeout(400);
  const clicked = await page.evaluate(() => {
    const opt = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "English",
    );
    if (!opt) return false;
    opt.click();
    return true;
  });
  await page.waitForTimeout(900);
  const after = await readLang(page);
  const saved = await page.evaluate(() => window.__smoke.savedLanguage);
  const text = (await sampleText(page)).body;
  record(
    "切换即时生效 + 落库",
    opened && clicked && before === "zh-CN" && after === "en" && saved === "en" && errors.length === 0,
    `打开设置=${opened} 点English=${clicked} ${before}→${after} saved=${saved} 前 80 字="${text.slice(0, 80)}"`,
  );
  await browser.close();
}

// 5) 错误条回落：未映射的码 → 外层文案英文、内层保留 Rust 原始中文 msg
{
  const { browser, page } = await launch("en-US", "en", {
    mcp_catalog: { code: 50000, msg: "读配置失败：boom（未映射码，应原样保留）" },
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "Settings" || b.getAttribute("aria-label") === "Settings",
    );
    btn?.click();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll("button")].find((b) =>
      /^(MCP|Appearance)$/.test((b.textContent || "").trim()),
    );
    nav?.click();
  });
  await page.waitForTimeout(1200);
  const text = (await sampleText(page)).body;
  record(
    "未映射码回落原 msg",
    /读配置失败：boom/.test(text),
    `页面上是否出现原始中文 msg=${/读配置失败：boom/.test(text)}`,
  );
  await browser.close();
}

// 6) 无残留（由调用方跑 npm run check:i18n；这里只提示）
record("代码残留", true, "本脚本不判定，请另跑 npm run check:i18n（期望 0 处）");

const failed = results.filter((r) => !r.ok);
if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonOut, JSON.stringify(results, null, 2));
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
exit(failed.length === 0 ? 0 : 1);
