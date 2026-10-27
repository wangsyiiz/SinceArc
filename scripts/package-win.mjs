/**
 * Windows 便携包（docs/distribution.md §2 P0）。
 *
 * 为什么要有这一步：`tauri build` 的 bundle 阶段要先从 GitHub 下载 NSIS，本机到 GitHub 不通
 * （§6），所以本轮产物是「release exe + 解压即用的 zip」，不写注册表、不提权。
 *
 * 用法（必须是 Windows 侧 node，构建产物是 Windows 二进制）：
 *   npm run package:win
 *
 * 依赖前提：`src-tauri/target/release/sincearc.exe` 已由 `tauri build --no-bundle` 产出。
 * 前端已经内嵌在 exe 里，所以 zip 里**不带** dist/、pdb、node_modules。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 脚本在 scripts/ 下，根目录是它的上一级（Windows 侧 node 用 fileURLToPath 才不会把盘符搞丢）
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const version = conf.version;
const exe = join(root, "src-tauri", "target", "release", "sincearc.exe");

if (!existsSync(exe)) {
  console.error(`缺少 ${exe}\n先跑：npm run tauri -- build --no-bundle`);
  process.exit(1);
}

const stage = join(root, "artifacts", "windows", `SinceArc-${version}-win-x64`);
const outZip = join(root, "artifacts", "windows", `SinceArc-${version}-win-x64.zip`);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// exe 用 SinceArc.exe（大小写按产品名），内容与 target/release/sincearc.exe 一致
const exeOut = join(stage, "SinceArc.exe");
writeFileSync(exeOut, readFileSync(exe));

writeFileSync(
  join(stage, "README-运行说明.txt"),
  [
    `SinceArc ${version}（Windows x64 便携版）`,
    "",
    "怎么启动",
    "  1. 解压到任意目录（不要在压缩包里直接双击）；",
    "  2. 双击 SinceArc.exe。首次启动 SmartScreen 可能提示「未知发布者」，",
    "     点「更多信息 → 仍要运行」（本版本未签名，见 docs/distribution.md §4）。",
    "",
    "数据在哪",
    "  %APPDATA%\\com.sincearc.app\\sincearc.db 与 logs\\ 。",
    "  数据不跟着这个文件夹走：换目录解压、删掉文件夹都不会删数据；",
    "  要彻底清干净，删上面那个目录。",
    "",
    `需要 WebView2 运行时（Win11 和较新的 Win10 自带）。`,
    "  启动时若提示缺 WebView2，去 https://developer.microsoft.com/microsoft-edge/webview2/",
    "  装 Evergreen Runtime（x64）后再启动。",
    "",
    "卸载",
    "  便携版没有安装项：删掉这个文件夹即可（数据见上）。",
    "",
  ].join("\r\n"),
  "utf8",
);

// 用 PowerShell 的 Compress-Archive：Windows 侧一定有，不额外引依赖
const ps = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${outZip}' -Force`,
  ],
  { stdio: "inherit" },
);
if (ps.status !== 0) {
  console.error("Compress-Archive 失败");
  process.exit(ps.status ?? 1);
}
rmSync(stage, { recursive: true, force: true });

const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
console.log(
  JSON.stringify(
    {
      version,
      exe: { path: exe, size: mb(statSync(exe).size) },
      zip: { path: outZip, size: mb(statSync(outZip).size) },
    },
    null,
    2,
  ),
);
