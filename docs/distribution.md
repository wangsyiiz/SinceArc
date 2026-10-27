# 分发与打包（sincearc）

> 平台口径：**只做 Windows**（2026-10-27 所有者拍定）。三平台、ARM64、自动更新、代码签名都不在本轮范围，
> 见 §7「明确不做」。macOS/Linux 的配置不要去猜、不要半成品留在仓库里。

## 1. 目标机器与前提

| 项 | 取值 |
| --- | --- |
| 支持系统 | Windows 10 1809（17763）及以上 / Windows 11 |
| 架构 | **x64 only**（ARM64 不做） |
| 运行时 | WebView2 Runtime（Evergreen）。Win11 与较新的 Win10 一般自带；检测见 §3 |
| 安装权限 | 便携包**不需要**管理员；安装包（NSIS）默认按用户安装，也不提权 |
| 数据目录 | `%APPDATA%\com.sincearc.app`（`sincearc.db` 与 `logs\`），便携包**不改目录**，避免同一台机器出现两套数据 |

## 2. 产物形态

| 优先级 | 产物 | 文件 | 用途 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 便携包 | `SinceArc-<version>-win-x64.zip` | 解压即用、不写注册表；自用与给几个人装 | 本批交付 |
| P1 | 安装包（NSIS） | `SinceArc_<version>_x64-setup.exe` | 开始菜单/卸载项；给非技术用户 | **阻塞**，见 §6 |

便携包内容（只这些，不再加别的）：

```
SinceArc.exe             ← src-tauri/target/release/sincearc.exe（前端已内嵌在二进制里）
README-运行说明.txt       ← 三条：怎么启、数据在哪、没装 WebView2 怎么办
```

不带：`dist/`（已内嵌）、`.pdb`、构建脚本、`node_modules`。

## 3. WebView2：没装时要说人话

**不自建运行时检测**：Tauri 在缺 WebView2 时自己会弹一条带下载地址的提示框（框架行为，不用我们写），
所以这里只做两件不写代码的事：便携包的 `README-运行说明.txt` 写明「遇到 WebView2 提示就去
https://developer.microsoft.com/microsoft-edge/webview2/ 装 Evergreen Runtime」，安装包（P1）用
Tauri 的 `downloadBootstrapper` 在安装时联网装。

为什么不自己检测：要读注册表就得引 `winreg` 之类的依赖或写 unsafe FFI，而「删掉运行时验证文案」
是破坏性操作，无法安全真机验 —— 不做未验证的代码。这一条在 §8 里标了「未真机验」。

## 4. 签名与 SmartScreen

本轮**不签名**（没有代码签名证书，也不做 EV/普通证书采购）。后果写清楚，不粉饰：

- 双击时 SmartScreen 会拦一次「Windows 已保护你的电脑」→ 需要「更多信息 → 仍要运行」；
- 从网络/邮件下载的 zip 还可能带 Mark-of-the-Web，`Unblock-File` 或解压后右键属性解除；
- 企业内部策略可能直接禁止未签名程序 —— 这种环境只能等 §7 的签名项启动。

## 5. 版本与命名

- 版本号口径：**从 0.0.0 起**，只递增末尾位直到功能面稳定再动次版本；Git tag 用 `v0.0.0` 对应同一个号。
- 版本号单一来源：`src-tauri/tauri.conf.json` 的 `version`（当前 `0.0.0`，**从 0 起算**：首个可用预览版就是 0.0.0，不占 1.x），前端与包名都从它派生，不另设一份。
- exe 的 `ProductVersion` / `FileVersion` 由 Tauri 写入，验收时看文件属性。
- 便携包文件名带版本，同一目录不覆盖旧包（`SinceArc-0.0.0-win-x64.zip`、`SinceArc-0.0.1-win-x64.zip` 并存）。

## 6. NSIS 安装包：当前为什么做不出来

Tauri 的 NSIS 打包器在**第一次打包时**会从 GitHub 下载 `nsis-3.11.zip` 到
`%LOCALAPPDATA%\tauri\NSIS`，本机到 GitHub 不通（实测 `curl` 返回 000），缓存目录为空，所以
`tauri build`（带 bundle）会在下载这一步失败。npmmirror 也没有 tauri 的二进制镜像
（`registry.npmmirror.com/-/binary/tauri` 返回 NOT_FOUND）。

解封方式，二选一（都需要外部资源，程序这边不用改）：

1. **手动投放**：在能访问 GitHub 的机器上下载
   `https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip`，
   解压到 `%LOCALAPPDATA%\tauri\NSIS`（该目录下应能看到 `makensis.exe`），之后
   `npm run tauri -- build --bundles nsis` 即可离线打包；
2. **走代理**：让 `HTTPS_PROXY` 对 Windows 侧的打包进程生效（在 cmd 里设好再跑）。

P1 解封后要补的验收：装 → 开始菜单有项 → 卸载干清（`%APPDATA%\com.sincearc.app` 保留数据、
可勾选删除）→ 静默安装参数（`/S`）可用。

## 7. 明确不做（本轮）

| 项 | 理由 |
| --- | --- |
| macOS / Linux 包 | 所有者 2026-10-27 定：只考虑 Win |
| ARM64 | 没有目标机器可验；不带未验证的产物 |
| 代码签名 / 公证 | 无证书；后果见 §4 |
| 自动更新（tauri-plugin-updater） | 没有分发端点；先不做半套 |
| MSI / WiX | 需要 WiX 工具链（同样要下载）；企业分发需求未出现 |
| 单实例与 `sincearc .` 反向入口 | E5 epic 里的另一半，单独一张卡，不和打包混做 |

## 8. 验收（真机读数）

1. `npm run package:win` 一条命令产出 `artifacts/windows/SinceArc-<version>-win-x64.zip`；
   记录 zip 大小与 exe 大小。
2. **不依赖 vite**：把 vite dev 关掉，解压到全新目录，双击 exe → 窗口能起、能打开会话、
   能发一轮对话（证明前端确实内嵌在二进制里，不是从 5173 取页面）。
3. exe 属性里 `ProductVersion` 与 `tauri.conf.json` 的 `version` 一致。
4. 数据目录仍是 `%APPDATA%\com.sincearc.app`，解压位置换了数据还在（说明数据不跟着包走）。
5. 缺 WebView2 的分支：检测函数有单测；真机不做移除运行时的破坏性验证（写明未验）。
