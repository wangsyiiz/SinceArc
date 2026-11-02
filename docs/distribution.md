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

## 11. 更新说明带双语（临时办法，2026-10-30）

### 11.1 为什么是临时办法

三条实测约束决定了这一步不可能按「正规」做法走：

1. **协议层只有一份说明**：线上 `latest.json` 的键是 `version / notes / pub_date / platforms`，
   `notes` 是单个字符串，一版发两语在协议里没有位置；
2. **客户端默认语言是英文**：`src/i18n/normalize.ts` 的 `DEFAULT_LANGUAGE = "en"`、`fallbackLng: "en"`，
   而 `CHANGELOG.md` 只有中文 —— 系统不是中文的用户，看到的更新说明一直是中文；
3. **GitHub 资产不带 CORS**：带 `Origin: https://tauri.localhost` 请求 `releases/latest/download/latest.json`，
   302 与最终响应都没有 `access-control-allow-origin`。前端 `fetch` 拿不到 GitHub 上的说明
   （现在能拿到是因为 updater 在 Rust 侧取，不受 CORS 限制）。

### 11.2 做法

- 文案源两份：`CHANGELOG.md`（中文）+ `CHANGELOG.en.md`（英文），段头都写 `## v<版本>`；
- `release.yml` 各提一段，拼成**同一份 notes**：

  ```
  ### 中文

  - …

  ### English

  - …
  ```

- 中文在前（主用户读它；英文用户多滚一段）。某语言缺段就不写那个小标题；两种都缺 → `- 见提交历史`；
- 客户端不改代码：更新说明按 markdown 渲染（§44，`desktop-ux §44`），两个 `###` 自然成两节；
- **历史段落不追译**：0.0.11 之前的旧版本保持中文单语（已发布的说明不改写）。

### 11.3 什么时候换掉

出现第三种语言时再讨论正规方案（自建端点按语言取文，或 Rust 侧取文绕过 CORS）。
在那之前，双语的代价只是每版多写一份英文，换来零部署、零依赖、零协议改动。

### 11.4 验收

- 发布后拉 `latest.json`：`notes` 里同时有 `### 中文` 与 `### English` 两段，各自的项目符号完整、
  缩进续行未被打散；
- 客户端设置页检查更新：两段都按 markdown 渲染（加粗、反引号、列表），可滚动。

## 12. 应用图标的小尺寸档（Windows 任务栏）

**现象（2026-10-30，所有者反馈）**：任务栏上的图标看着偏小。

**实测**（`src-tauri/icons/icon.ico` 各帧，量的是「标记占磁贴的比例」与亮部均值）：

| 版本 | 32px 磁贴 | 标记 | 占磁贴 | 亮部均值 |
| --- | --- | --- | --- | --- |
| 改前 | 30×30 | 15×19 | 0.50 × 0.63 | 196 |
| 改后 | 30×30 | 19×23 | 0.63 × 0.77 | 216 |

**根因**：`design/logo/d-tile-16.svg` 早就为小尺寸准备了「去辉光 + 标识放大」的变体，但它**从来没进过生成链路**。
链路是 `raster d-tile.svg → icon-1024.png → tauri icon`，`tauri icon` 只吃一张 1024 PNG，
16/24/32 帧都是它降采样来的 —— 拿到的是「标识 0.62 + 三层辉光」的版本。
辉光在 30 像素的磁贴里糊成一圈，标记本身只占磁贴一半宽，于是看起来「一小团亮斑缩在深色方块里」。

### 12.1 口径

- **16 / 24 / 32 / 48 四档**：用 `d-tile-16.svg`（**0.72 + 三层辉光**、`#ffffff` 标记、磁贴 960/1024），
  **每档按目标尺寸原生渲染**，不降采样；
- **64 / 256**：仍用 `d-tile.svg`（0.62 + 三层辉光）—— 大尺寸看得出辉光，是品牌元素；
- `32x32.png` 同步换成 0.79 的 32px 渲染；`128x128*.png`、`icon.png`、`icon.icns`、`Square*Logo` 不动
  （128 以上用辉光版本来就对，`icns`/`Square*` 在 Windows 这条线上不参与）；
- `icon.ico` 六档仍是 **32 位 PNG 帧**（与 `tauri icon` 的输出编码一致），只是帧来源按上面的分工不同 ——
  `tauri icon` 做不到「一张图管大档、另一张管小档」，所以这一支是手写 ICO 容器拼的。

### 12.2 重生成

```bash
# 1) 各档原生渲染（Chromium 截图、透明背景、1 倍）
for s in 16 24 32 48; do node raster-icon.cjs design/logo/d-tile-16.svg new-$s.png $s; done
for s in 64 256;     do node raster-icon.cjs design/logo/d-tile.svg    new-$s.png $s; done
# 2) 按 16/24/32/48/64/256 顺序写 ICO（每档 PNG 载荷，32bpp）
python3 -c "<见 §12.3：拼 ICONDIR + ICONDIRENTRY + PNG 载荷>"
cp new-32.png src-tauri/icons/32x32.png
```

`raster-icon.cjs` 与拼 ICO 的脚本都是**临时脚本、不入库**（与 `design/logo/README.md` 同规矩），产物入库。

### 12.3 验收

- `PIL.Image.open('icon.ico').info['sizes']` 恰好六档 16/24/32/48/64/256，全部 PNG 帧、`bpp=32`；
- 每档与对应的渲染 PNG **逐像素相等**（2026-10-30 实测六档全 True）；
- 32px 帧的标记（含辉光）占磁贴应为 **0.57 × 0.73**（无辉光 0.79 时期为 0.63 × 0.77）；
- 发版后 `SinceArc.exe` 的 RT_ICON 六档应与新 `icon.ico` 逐档相等（§10 的旧读数同样适用）；
  `setup.exe` 的 `installerIcon` 也会跟着变。

### 12.4 2026-11-02 反转：小尺寸加回辉光

所有者口径：「保持大小不变，把里面的 S 缩小一点，加上辉光」。§12.1 原本是「小尺寸去辉光 + 放大到 0.79」，
理由在 §12 的现象里（辉光在 30px 磁贴里糊成一圈）。现在改成 **0.72 + 三层辉光**：

- 标记收到 0.72，给辉光让出边缘 —— 放大版贴满磁贴时没有地方发光；
- 辉光用「加粗 + 低透明度」的叠层（150/120/96，opacity 0.10/0.18/0.28），**不用高斯模糊**：
  16px 档按比例模糊半径只有零点几像素，等于没有；叠层在降采样后才会真的亮出来；
- 实测 32px 帧：磁贴 30×30、标记（含辉光）17×22 ⇒ `0.57 × 0.73`；
- **已知取舍**：16px 档会比「去辉光」版更软。所有者接受，因为看到的是任务栏 32/48 档与商店大图。

64 / 256 两档未动（本来就有辉光），本次 ICO 里这两帧的 PNG 载荷与原文件**逐字节相同**。

## 13. MSIX 渠道（微软商店路线，2026-10-30 定）

**选路**：走**商店托管 MSIX 包**（政策里的"包提交"），不走 10.2.9 的"直链 EXE/MSI"。
理由是三条硬差别：签名责任（MSIX 由微软代签，直链要自购 CA 证书）、更新链路（Store 服务 vs
应用内自更新，后者在国内撞 GitHub 不通）、数据落点（前者变了，后者不变）。逐条条款见
`microsoft-store-publishing` 技能的 `references/store-policy-notes.md`。

### 13.1 产物与打包

`release.yml` 在出完 NSIS 之后多打一个包：

```
src-tauri/target/release/sincearc.exe  →  layout/SinceArc.exe
src-tauri/icons/{Square150x150Logo,Square44x44Logo,StoreLogo}.png → layout/Assets/
src-tauri/msix/AppxManifest.xml（替换身份/版本占位符）→ layout/AppxManifest.xml
makeappx pack /d layout /p out/SinceArc_<version>_x64.msix        （Windows SDK 自带）
```

- **未签名**：本地/测试用；商店提交时由 Store 认证流程重签（所以这条路不需要买证书）。
- **版本必须是四段**：`0.0.12` → `0.0.12.0`；升级时 MSIX 版本只能涨。
- 打包工具是 Windows SDK 的 `makeappx.exe`（runner 自带），不引第三方 CLI：CI 上少一个安装源。

### 13.2 身份从哪来（改身份不改代码）

清单里的 `Identity Name` / `Publisher` 是**包身份**，在 Partner Center 预留产品后由那边给出。
在仓库里配三个 Actions 变量即可，CI 会替换进清单：

| 变量 | 当前值（2026-11-02 起，产品已上线） |
| --- | --- |
| `MSIX_IDENTITY_NAME` | `JerryWang.SinceArc` |
| `MSIX_PUBLISHER` | `CN=113E9660-D4D7-4CB2-AC6D-2EA30A4F9E78`（**无 OID**） |
| `MSIX_PUBLISHER_DISPLAY_NAME` | `JerryWang` |

三个值必须与 Partner Center 的 `Package/Identity/Name`、`Package/Identity/Publisher`、
`Package/Properties/PublisherDisplayName` 逐字一致 —— 差一个字符就是
「包身份与预留身份不匹配」或「PublisherDisplayName 不匹配」，认证直接拒（两种都实测踩过）。

**Publisher 两种口径别混**：芯里是同一个身份，只在打**本地测试包**时追加 OID 后缀
（MS 文档「Create an unsigned MSIX package」），少了它 `Add-AppxPackage -AllowUnsigned`
直接报 **0x80073D2C「发布者不在未签名命名空间」**（2026-10-30 实测）。CI 会一次出两个包，
见 §13.5；送审包**绝不能**带 OID。

身份一改，就是另一个应用：旧包要先卸载，桌面快捷方式与商店条目也是两套（数据目录不受影响，见 13.3）。

### 13.3 两个安装形态并存，数据不通

| | 便携版 / NSIS 安装包 | MSIX（商店版） |
| --- | --- | --- |
| 安装位置 | 用户选的目录 / NSIS 默认目录 | `C:\Program Files\WindowsApps\`（受保护，不可改） |
| 数据 | `%APPDATA%\com.sincearc.app\` | **同一份** `%APPDATA%\com.sincearc.app\`（实测互通，见下） |
| 更新来源 | `latest.json` + GitHub releases | Microsoft Store 服务 |
| SmartScreen | 未签名会拦 | 无（商店签名） |

**更正（2026-10-30 真机实测 + 文档复核）**：上一版这里写「MSIX 版数据会落到
`%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`」——**只对 appContainer 应用成立**。
MS 文档《Understanding how packaged desktop apps run on Windows》把该节标为
「This section applies only to virtualized apps」；我们的包是 `mediumIL`（full trust），
**不做文件重定向**，写入直接落在真实的 `%APPDATA%`。实测证据：
MSIX 版启动后 `%APPDATA%\com.sincearc.app\sincearc.db` 的 mtime 跟着变，
而 `%LOCALAPPDATA%\Packages\SinceArc.Dev_<hash>\LocalCache\Roaming\` 下只有 WebView2 自己的
`Microsoft\` 目录，没有 `com.sincearc.app`。

**副作用（必须知道）**：两个形态**共用同一个 SQLite 库和同一份 `logs\sincearc.log`**。
好消息是单实例守卫跨形态**生效**（所有者实测，2026-10-30）：实现是
`tauri-plugin-single-instance 2.5.5`，互斥标识取自应用标识 `com.sincearc.app`，
与打包形态无关 —— 所以「同时开两个形态」这件事被天然兜住了。

由此有两条使用上的坑，要写进交付说明：

1. **先跑旧版、再点新版图标 = 新版静默起不来**，只是把旧窗口聚焦过来；
   用户会以为「装的新版没生效」。换版本/换渠道后应提示先退出正在跑的实例。
2. **商店版走 Store 更新后同理**：更新是后台完成的，若旧进程还在，点图标看到的仍是旧界面 ——
   验收时先看「设置 → 关于」里的版本号，而不是界面观感。

### 13.4 商店版的更新入口跳 Store，不关按钮

两套更新机制不能同时跑（MSIX 由 Store 服务更新，内置 updater 再把 NSIS 包拉下来装进去只会打架），
但**按钮不删**：删掉后用户找不到"怎么升级"，只能猜。口径是「入口保留、动作改向」。

**编译标识**：Cargo feature `store`（默认关闭）。

```bash
cargo build --release --features store   # 商店包用的 exe
cargo tauri build --bundles nsis         # 直装版，不带该 feature
```

- 商店包里**不注册 `tauri_plugin_updater`**，前端也就不会去打 `latest.json`
  —— 顺带消掉当前日志里那三条连不上 GitHub 的 `ERROR tauri_plugin_updater`。
- 前端靠 `build_channel` 命令（返回 `store` / `direct`）判断渠道，**不引 `VITE_*` 第二份配置**：
  编译标识只允许有一个来源，否则迟早出现"后端是商店版、前端以为是直装版"。
- `store` 渠道的 UI：标题还是「更新」，说明改成"由 Microsoft Store 管理"，
  按钮文案「在 Microsoft Store 中打开」，点击调 `open_store_update` 打开
  `ms-windows-store://pdp/?productid=<产品 ID>`。
  产品 ID 由**编译期环境变量** `SINCEARC_STORE_PRODUCT_ID` 注入（Partner Center 建产品后才有）；
  未注入时退化为 `ms-windows-store://search/?query=SinceArc`，避免按钮点了没反应。
- `direct` 渠道的一切保持 §9 原样。

**边界（要跟用户说清）**：商店版没有"立即检查"能力 —— 更新由 Store 后台推，
用户想手动拉只能在商店「库 → 获取更新」。所以商店版能显示的只有「当前版本」，
不显示"已是最新"，也不该出现下载进度条。

### 13.5 一次构建出两个 MSIX：送审包 / 本地测试包

同一次 CI 构建产出两个包，**只有 Publisher 差一个 OID 后缀**（清单其余部分逐字节相同）：

| 文件名 | Publisher | 用途 |
| --- | --- | --- |
| `SinceArc_<v>_x64.msix` | Partner Center 预留值 | **送审**。无 OID；本地 `Add-AppxPackage` 会报 `0x80073D2C`，这是预期，不是你装错了 |
| `SinceArc_<v>_x64-unsigned.msix` | 同上 + `, OID.2.25.311729368913984317654407730594956997722=1` | **本地测试**。管理员 PowerShell + 开发者模式可装 |

为什么不能只出一个：商店包的 `Publisher` 必须与预留值**完全一致**（多一个 OID 就是另一个身份，
认证按「身份不匹配」拒），而未签名包 `Publisher` 必须带 OID 才允许注册 —— 两个要求正好相反。

### 13.6 商店包必须内嵌前端（custom-protocol + dist）

**2026-10-31 事故**：v0.0.13 的 MSIX 装上后双击即「连接 localhost 失败」。原因是打 MSIX 那步
用的是裸 `cargo build`，没有 tauri-cli 在 `tauri build` 时自动加上的 `custom-protocol`
feature —— 少了它 `generate_context!` **根本不读 `frontendDist`**，exe 里没有前端资源，
运行时就去找 `devUrl`（`http://localhost:5173`）。makeappx 不会报任何错，包也装得上。

三条防线（都已落地）：

1. `src-tauri/Cargo.toml` 声明 `custom-protocol = ["tauri/custom-protocol"]`，
   并让 `store = ["custom-protocol"]` 连带它 —— 商店包不该有 devUrl 可连。
2. `lib.rs` 的 `compile_error!`：`feature store` 开着却没有 `custom-protocol` 时直接编译失败。
3. CI 打 MSIX 前检查 `dist/index.html` 存在；`npm run build` 由 `tauri build` 的
   `beforeBuildCommand` 负责跑，但这一刻必须确认它在。

**手工打商店包的正确姿势**（本地验证用）：

```bash
npm run build                                        # 先有 dist
cargo build --manifest-path src-tauri/Cargo.toml --release --features store --bin sincearc
```

判断内嵌成功与否：exe 体积会明显大于"没内嵌"的那份（0.0.13 是 11.4 MB，内嵌后到 15 MB 量级），
更硬的判据是双击能出界面、日志里 `build channel channel=store`。

### 13.7 本地怎么装（测试包）

未签名的 MSIX 两件事都要满足，缺一个就报错：

1. **Publisher 必须带 OID 后缀** —— 用 `_x64-unsigned.msix` 那个包，CI 已按仓库变量加好后缀；
2. **PowerShell 要以管理员身份运行** —— 带可执行内容的未签名包必须给「所有用户」安装，
   非管理员会失败（MS 文档「Create an unsigned MSIX package」明确写了这点）。

```powershell
# 开始菜单搜 PowerShell → 右键「以管理员身份运行」
# 设置 → 系统 → 开发者选项 → 开发人员模式 = 开
Add-AppxPackage -Path .\SinceArc_<v>_x64-unsigned.msix -AllowUnsigned
Get-AppxPackage -Name 'SinceArc*' | Select Name, Version, InstallLocation   # 核验
```

常见错：

| 报错 | 原因 |
| --- | --- |
| `0x80073D2C` 发布者不在未签名命名空间 | Publisher 少了 OID 后缀 |
| `0x80073D0A` / 部署被拒 | 没开开发者模式 |
| 安装成功但启动即退 | 看 `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\com.sincearc.app\logs\sincearc.log` |

替代方案（不用开发者模式）：自己签一次再装 —— 生成 `CN=SinceArc Dev` 的自签证书、导入
「受信任的根证书颁发机构」、`signtool sign /fd SHA256 /f cert.pfx /p <pw> <msix>`。
测试阶段用开发者模式更省事，证书只在真正提交商店时才需要身份对齐。

### 13.8 送审到 Microsoft Store（逐次决定，默认不送）

> **当前决定（2026-11-02）：走手工上传。** 自动化这条链路的代码已经就位并干跑验证过
> （见下），但需要一套 Entra 身份（租户 + 应用 + 密钥）才跑得起来，所有者判断
> "发版频率还不值这套一次性配置 + 一个两年过期的密钥"，所以 `submit_to_store` 一律 false，
> 每次发版按 §13.10 的清单手工传。要开自动化时，照本节配 4 个 secret + 1 个变量即可，代码不用改。

**每次提交都要重新认证**：包体一变就是一次新提交，认证通常几小时到 1–2 天。所以送审不是
"发版流水线的默认动作"，而是**这一次发布时由人勾选**：

```bash
gh workflow run tag-release.yml -f submit_to_store=true     # 这次也送商店
gh workflow run tag-release.yml                            # 只发 GitHub Release
```

- `tag-release` 把这个开关原样透传给 `release.yml`（`submit_to_store` 布尔输入，默认 `false`）。
- **不做常驻仓库变量开关**：那种开关总有人忘了关，一次手滑就把内部版本推给全体用户。
- 送审步骤 `continue-on-error: true` —— 商店那条线失败不该把「Release 已发出」拖红，
  但会在 run 摘要留 warning 注解，别忽略。

**需要的配置**

| 名字 | 类型 | 从哪拿 |
| --- | --- | --- |
| `PARTNER_CENTER_TENANT_ID` | Secret | Entra → Identity → Overview |
| `PARTNER_CENTER_CLIENT_ID` | Secret | Entra → App registrations |
| `PARTNER_CENTER_CLIENT_SECRET` | Secret | 同上 → Certificates & secrets |
| `PARTNER_CENTER_SELLER_ID` | Secret | Partner Center → Account settings → Identifiers |
| `STORE_PRODUCT_ID` | Variable | 产品概览页，`9N…` 开头 |

外加一步容易漏的：Partner Center → Account settings → User management →
**Microsoft Entra applications** 里把这个应用加进去并授 **Manager** 角色，否则 `msstore` 直接 401。

**边界**

- 官方文档写明：GitHub Actions 上传**只支持免费产品**（付费产品后续支持）；
- 产品必须**已发布上线**，首次提交只能走网页；
- 版本必须严格递增（`0.0.15.0` > `0.0.14.0`），服务端会校验，被拒时日志里有原话；
- `Client Secret` 有有效期（Entra 默认 24 个月），过期后这一步会失败 —— 这也是它不能拖红整个发版的原因之一。

### 13.9 认证风险（要提前备，不要等驳回）

- **10.3 Product is Testable**：审核员装上 SinceArc 只会看到"连接 agent"的空壳，本机没有 ACP agent
  就跑不出东西 → 可能判不可测。交付物：`Notes for certification` 写分步说明（装什么、点哪里、
  看到什么）+ 一段录屏；必要时随包放一个可离线跑通的样例配置。
- **10.4.2**：必须能快速启动并保持响应 —— 首启无 agent 时不得卡在白屏。
- 年龄分级问卷、商店文案与截图、支持联系方式：提交前一次性备齐。

### 13.10 手工送审清单（当前采用的方式）

发一个商店版本，六步，五分钟：

1. **版本号 +1**：`src-tauri/tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml` 三处同步
   （第四段固定 `0`，`0.0.15.0` 即可，`0.0.15.1` 会被拒）。然后用 tag-release 发版。
2. **等构建绿**，从 GitHub Release 下载 **`SinceArc_<v>_x64.msix`** —— 注意是这一个，
   **不是** `-unsigned` 那个（带 OID 的是本地测试包，商店必拒）。
3. Partner Center → **Apps and games** → SinceArc → **新提交** → 上传该 `.msix`。
4. **Submission options → Restricted capabilities**：填 `runFullTrust` 的理由，
   用 §13.9 后面那段短版（三句：起外部 CLI、读写用户选定目录、不提权/服务/驱动）。
5. **Notes for certification**：写清"本应用需要先安装一个 ACP agent 才能用"，
   给可复现步骤 —— 这是 10.3 可测性唯一能被救的地方。
6. 提交，等认证（几小时到 1–2 天），通过后自动发布。

**别踩的三条**：版本没递增会被拒；包体上传后不能改（改了就是新提交、重新认证）；
认证期的热修走直装渠道（zip / setup.exe），不要指望商店。
