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
- 版本号单一来源：`src-tauri/tauri.conf.json` 的 `version`（**从 0 起算**：首个可用预览版是 0.0.0，不占 1.x；当前号看文件本身），前端与包名都从它派生，不另设一份。
- exe 的 `ProductVersion` / `FileVersion` 由 Tauri 写入，验收时看文件属性。
- 便携包文件名带版本，同一目录不覆盖旧包（`SinceArc-0.0.0-win-x64.zip`、`SinceArc-0.0.1-win-x64.zip` 并存）。
  另有一份不带版本号的稳定文件名（`SinceArc-win-x64.zip`），给 `releases/latest/download/` 用。

### 5.1 发版流程（一键打 tag）

发版只认 tag：合并到 main 不自动发版，避免每次合并都堆一个版本号。

1. 改 `src-tauri/tauri.conf.json` 的 `version`（顺手把 `package.json` 改成同一个号，CI 会校验两者一致）；
2. Actions → **tag-release** → Run workflow（**不需要填任何输入**）；
3. 该工作流从配置读版本号 → 建 `v<version>` tag 并推送 → 派发 `release.yml` 在该 tag 上构建 → 建 Release。

手动 `git tag -a v0.0.1 && git push origin v0.0.1` 依旧有效，两条路进的是同一个流水线。

守卫（都在 `release.yml` 里，不绿不出包）：

| 校验 | 不一致时 |
| --- | --- |
| `package.json` 版本 == `tauri.conf.json` 版本 | 直接失败，报两个数字 |
| tag 名 == `v` + `tauri.conf.json` 版本 | 直接失败。**这条必须有**：否则 Release 名、附件名、客户端自报版本互相打架，自动更新会认为「已是最新」而静默失效 |
| tag 已存在（远端） | `tag-release` 在推之前就失败，提醒先递增版本号 |

同一 tag 重跑是安全的：建 Release 那步是幂等的（已存在就覆盖资产与说明）。

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

## 9. 自动更新（tauri-plugin-updater）

### 9.1 通道与端点

| 通道 | Release tag | 更新端点 | 谁在用 |
| --- | --- | --- | --- |
| 正式 | `v<版本>`（非预发布） | `releases/latest/download/latest.json` | 装在机器上的客户端 |

只有正式通道：`releases/latest/download/...` 永远指向最新正式版，没有预发布/夜间版。
发版只认 tag（合并 main 不自动发版），一键打 tag 的流程见 §5.1。

### 9.2 签名与密钥

- 更新包用 **minisign**（Tauri 自带），与 Authenticode 无关；没签 Authenticode 不影响自动更新。
- 公钥写进 `tauri.conf.json` 的 `plugins.updater.pubkey`（公开，进仓库）。
- 私钥只放 GitHub Secrets：`TAURI_SIGNING_PRIVATE_KEY`（文件内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
  **私钥或口令丢了就没法再签，已装客户端再也收不到更新** —— 离线备份一份，不要只放在 GitHub。

### 9.3 latest.json 由 CI 生成

`createUpdaterArtifacts: true` 只产出 `*.sig`，`latest.json` 需要自己拼（Tauri 官方的 tauri-action 帮忙做这件事，
我们没引入该 action）。release workflow 在打包后：

1. 读 `src-tauri/target/release/bundle/nsis/*.exe.sig` 的签名内容；
2. 组装 `{"version", "notes", "pub_date", "platforms": {"windows-x86_64": {"signature", "url"}}}`，
   `url` 指向**该 tag** 下的 setup.exe（不要用 `latest`，否则历史版本会指到别人的包）；
3. 与产物一起挂到 Release。

### 9.4 客户端行为

- 设置 → 更新：显示当前版本、手动「检查更新」；有新版显示版本号与发布说明，点「下载并安装」→ 安装后重启。
- 启动时**不**静默下载，只在设置页里由用户触发检查（分发量还小，避免无谓流量与后台惊吓）。
- 失败要说人话：网络失败 / 签名校验失败 / 安装器启动失败 分开报，不要统一「更新失败」。

## 10. 安装包外观：图标 / 头图 / 侧图

**问题（2026-10-27 实测）**：v0.0.1 的 `SinceArc_0.0.1_x64-setup.exe` 里的图标不是我们的。
把安装包按 PE 资源拆开、逐像素对比：

| 对象 | 实测 |
| --- | --- |
| `SinceArc.exe`（便携包里的应用本体） | 6 档 RT_ICON（16/24/32/48/64/256）与 `src-tauri/icons/icon.ico` **逐档像素全等** |
| `SinceArc_0.0.1_x64-setup.exe`（安装包） | 7 档 RT_ICON（16/32/48，多种位深）与 `icon.ico` **一档都不等**：32×32 中心像素 `#b9d9ca` vs 我们的 `#f1f1f6`，1024 个像素差 921 个；侧图是 NSIS 自带的 4 位 `modern-wizard.bmp`（调色板只有 navy/black/white，与品牌色 `#1a1d26` 无关） |

原因：`bundle.icon` 只决定**应用 exe** 的图标；NSIS 的 `MUI_ICON` 没被指定时落到 NSIS 自带的
`modern-install.ico`，跟 `bundle.icon` 无关。也就是说「安装包长得像 NSIS，不像 SinceArc」不是错觉。

**修法**：`tauri.conf.json` 的 `bundle.windows.nsis` 显式给五张图。

| 配置项 | 文件 | 规格 | 出现在哪 |
| --- | --- | --- | --- |
| `installerIcon` | `icons/icon.ico` | 16/24/32/48/64/256 多档 | setup.exe 自身（资源管理器、任务栏、卸载项） |
| `uninstallerIcon` | `icons/icon.ico` | 同上 | 卸载程序 |
| `headerImage` | `icons/installer/header.bmp` | 150×57，24 位无压缩 BMP | 每个向导页右上角 |
| `uninstallerHeaderImage` | `icons/installer/header.bmp` | 同上 | 卸载向导页右上角 |
| `sidebarImage` | `icons/installer/sidebar.bmp` | 164×314，24 位无压缩 BMP | 欢迎页 / 完成页左侧 |

外观口径（跟品牌物料一致，不另造风格）：

- 侧图：底色 `#1a1d26`（品牌磁贴底色）+ 浅色「s-弧」标识居中，**不写字标** —— NSIS 只吃 BMP，
  没有 alpha，也不保证渲染字体的机器上有 Georgia，写字会变成另一套排版。
- 头图：白底 + 深色标识，贴在白色的向导页上不显块。
- 都是 24 位无压缩 BMP：NSIS 不认 PNG，也不处理 alpha 通道。

**重生成**（一次性资产，产物入库；跟 `design/logo/README.md` 的图标同规矩：临时脚本不入库）：

```bash
# 1) 4 倍渲染 design/logo/d-s-arc.svg（HTML 里 inline 该 SVG，canvas = 目标尺寸 ×4，背景即最终底色）
PW_WIDTH=660 PW_FULL=1 pw-shot sidebar.html      sidebar-4x.png 600
PW_WIDTH=600 PW_FULL=1 pw-shot header-light.html header-4x.png 400
# 2) 缩到 164×314 / 150×57 并存 24 位 BMP
python3 -c "from PIL import Image; Image.open('sidebar-4x.png').convert('RGB').resize((164,314),Image.LANCZOS).save('src-tauri/icons/installer/sidebar.bmp','BMP')"
python3 -c "from PIL import Image; Image.open('header-4x.png').convert('RGB').resize((150,57),Image.LANCZOS).save('src-tauri/icons/installer/header.bmp','BMP')"
```

**验收（下一个版本的 setup.exe）**：拆包后 `installerIcon` 那几档 RT_ICON 应与 `icon.ico` 逐档
像素相等（v0.0.1 就是不等才发现的）；侧图与头图应与 `icons/installer/*.bmp` 字节相等 ——
注意 NSIS 包里的文件名不变（Tauri 模板把它们放在 `$PLUGINSDIR/modern-wizard.bmp`、
`modern-header.bmp`），**看内容不看名字**。看外观这件事仍归所有者，代码侧只保证「用的是我们的文件」。
