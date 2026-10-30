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

- **16 / 24 / 32 / 48 四档**：用 `d-tile-16.svg`（0.79、无辉光、`#ffffff` 标记、磁贴 960/1024），
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
- 32px 帧的标记占磁贴应为 **0.63 × 0.77**（改前 0.50 × 0.63）；
- 发版后 `SinceArc.exe` 的 RT_ICON 六档应与新 `icon.ico` 逐档相等（§10 的旧读数同样适用）；
  `setup.exe` 的 `installerIcon` 也会跟着变。

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

| 变量 | 什么时候填 | 现在的默认值（测试身份） |
| --- | --- | --- |
| `MSIX_IDENTITY_NAME` | Partner Center 的「包名/Identity Name」 | `SinceArc.Dev` |
| `MSIX_PUBLISHER` | Partner Center 的「Publisher（CN=…）」 | `CN=SinceArc Dev, OID.2.25.311729368913984317654407730594956997722=1` |
| `MSIX_PUBLISHER_DISPLAY_NAME` | 商店列表里显示的发布者名 | `SinceArc` |

**Publisher 两种口径别混**：未签名测试包必须带 OID 后缀（MS 文档「Create an unsigned MSIX package」），
少了它 `Add-AppxPackage -AllowUnsigned` 直接报 **0x80073D2C「发布者不在未签名命名空间」**（2026-10-30 实测踩到）；
商店包由 Store 重签，Publisher 取 Partner Center 给的值且**不带** OID。
身份一改，就是另一个包：旧包要先卸载，数据目录也跟着换（见 13.3）。

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

### 13.4 商店版必须关掉应用内更新（待批准，本版未改）

两套更新机制不能同时跑：MSIX 由 Store 服务更新，内置 updater 再把 NSIS 包拉下来装进去只会打架。
落地方式是构建期开关（`tauri.conf.json` 的 `plugins.updater` 在商店包里不配 endpoints，或加一个
`app.storeBuild` 标记让前端不显示"检查更新"）。**这属于配置项改动，动手前先说明理由并经所有者批准。**

### 13.5 本地怎么装（测试包）

未签名的 MSIX 两件事都要满足，缺一个就报错：

1. **Publisher 必须带 OID 后缀**（清单里已由 CI 默认值保证）；
2. **PowerShell 要以管理员身份运行** —— 带可执行内容的未签名包必须给「所有用户」安装，
   非管理员会失败（MS 文档「Create an unsigned MSIX package」明确写了这点）。

```powershell
# 开始菜单搜 PowerShell → 右键「以管理员身份运行」
# 设置 → 系统 → 开发者选项 → 开发人员模式 = 开
Add-AppxPackage -Path .\SinceArc_0.0.12_x64_unsigned.msix -AllowUnsigned
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

### 13.6 提交商店：需要什么凭证

| 做法 | 需要的凭证 | 说明 |
| --- | --- | --- |
| **手工上传**（推荐先这样） | 无（只需 Partner Center 账号浏览器登录） | 从 Release 下 `.msix`，在 Partner Center 网页上传、填清单、送审 |
| **Actions 自动上传** | ① Entra 应用注册的 `Tenant ID` / `Client ID` / `Client Secret`；② Partner Center 的 `Seller ID`；③ 产品的 `Store ID` | 三样进 GitHub Secrets；应用注册要在 Partner Center 授「Manager」角色。**不影响出包**，只影响"自动送审" |

也就是说：**CI 出 MSIX 不需要任何凭证**；要凭证的只有"自动提交商店"这一步，而它可以先不做。
另外自动上传用的是 Microsoft Store submission API（要 `StoreSubmission` 权限的 Entra 应用），
每次提交都要带包身份与版本，跟我们走的"仓库变量 → 清单"是同一套值。

### 13.7 认证风险（要提前备，不要等驳回）

- **10.3 Product is Testable**：审核员装上 SinceArc 只会看到"连接 agent"的空壳，本机没有 ACP agent
  就跑不出东西 → 可能判不可测。交付物：`Notes for certification` 写分步说明（装什么、点哪里、
  看到什么）+ 一段录屏；必要时随包放一个可离线跑通的样例配置。
- **10.4.2**：必须能快速启动并保持响应 —— 首启无 agent 时不得卡在白屏。
- 年龄分级问卷、商店文案与截图、支持联系方式：提交前一次性备齐。
