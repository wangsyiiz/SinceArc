# sincearc 标识与图标

选定的方向是 **D「s-弧」**：一条连续的 S 曲线 —— `since` 的首字母与 `arc` 是同一个形态，
左上一颗实心圆点就是 `since`（自这里起）。其余方向（A 双弧 / B 弧+点 / C 字标 a / E 弧系 / F 弦与弧 / G 刻度弧）
留在本目录作为探索记录，`preview.html` 可以逐块对比。

## 文件分工

```
d-s-arc.svg         标识本体（1024，currentColor，无底）
d-s-arc-16.svg      ≤24px 的加粗版（弧 150、点放大）
d-tile.svg          桌面图标磁贴：实色 #1a1d26 + 上缘内高光 + 三层辉光
d-tile-light.svg    浅色磁贴：纯白 + #d8d8d8 描边
d-tile-16.svg       ≤24px 磁贴：去辉光、标识放大到 0.79
d-lockup.svg        磁贴 + 字标 sincearc（字标辉光三层 22/10/4）
d-lockup-light.svg  浅色 lockup（辉光压到暗色的 1/3）
icon-1024.png       栅格化结果，作为 `tauri icon` 的输入
preview.html        对比页（本地 `python3 -m http.server` 起一个静态服务看，需同目录）
```

安装包的图标/头图/侧图不在本目录：`installerIcon` 直接复用 `src-tauri/icons/icon.ico`，
头图与侧图是 `src-tauri/icons/installer/header.bmp`、`sidebar.bmp`（由 `d-s-arc.svg` 按 4 倍渲染再缩，
规格与重生成命令见 `docs/distribution.md` §10）。

应用内只使用 **不带磁贴、不含辉光** 的标识（`src/components/BrandMark.tsx`）：
标题栏 20px、空态 28/36px。辉光属于品牌物料，chrome 按设计语言走扁平。

## 重新生成图标

```bash
# 1) SVG → 1024 PNG（本机没有 rsvg/inkscape，走 Chromium 截图，透明背景）
NODE_PATH=$(npm root -g) node raster.cjs design/logo/d-tile.svg design/logo/icon-1024.png 1024

# 2) 生成整套平台图标（含 icon.ico 的 16/24/32/48/64/256 六档）
"/mnt/c/Program Files/nodejs/node.exe" node_modules/@tauri-apps/cli/tauri.js icon design/logo/icon-1024.png

# 3) Android/iOS 产物对本项目没用，删掉
rm -rf src-tauri/icons/android src-tauri/icons/ios
```

`raster.cjs` 在 `~/.hermes/cache/scratch/raster.cjs`（临时脚本，未入库）。
