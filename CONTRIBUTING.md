# 贡献指南

感谢愿意花时间。这个仓库的规矩不多，但有几条是硬的，先读完再动手能省掉来回。

## 一、先看这两条（改代码前）

1. **规范先行**：改变行为的改动，先改 `docs/*.md`，再动代码。规范里写着「暂时就这样」「已知未收口」的地方，
   不要顺手改掉——那是有意留下的，改动要先讨论。
2. **一个实现只做一份**：开工前确认没有别人正在同一条线上做同一件事（看分支、看 issue）。
   并行做同一个功能＝双份成本。

## 二、分支与提交

分支是两层：**epic 分支**（一个功能域）→ **任务分支**（一张卡），不允许跳过层级。

```
main
 └── feat/e13            epic 分支：一个 epic 一条，从 main 切
      └── feat/e13.4-xxx 任务分支：一张卡一条，从 epic 切
           ↑ 验完合回 epic（不直接合 main）
              └── 整个 epic 的卡都完成后，epic → main 一次合入
```

- **epic 分支**：从 `main` 切，命名 `feat/e<epic 编号>`（如 `feat/e9`）。epic 分支上只允许出现「本 epic 的合入」和规范/文档先行改动，**不直接在 epic 上写实现**；
- **任务分支**：从 epic 切，命名 `feat/e<epic>-<短语>`（如 `feat/e9-gh-adapter`；同名 epic 下多张卡时带上卡号，如 `feat/e9.2-pr-list`），PR 的 **base 一律是 epic 分支**，不是 `main`；
- 任务卡验完、PR 合并进 epic 后，再开下一张卡；同一个 epic 的任务**不并行**（并行实现＝双份成本、红灯无法归因）；
- 没有 epic 归属的单点修复（`fix/<topic>`）才直接从 `main` 切、base 也写 `main`；
- 提交前确认 `git branch --show-current`；提交信息写清「为什么」和实测读数，而不是只写「改了什么」；
- **每个提交都要带 sign-off**（见下），CI 会校验。

> 2026-10-28 修订：原文只写了「从 main 切 feat/<topic>」，没区分 epic 与任务两层，
> 结果第一个 epic 的任务分支直接对 main 开 PR。改成上面两层结构，原因是 epic 内多张卡
> 需要连续验证、中间状态不该进 main（`main` 上永远是能发版的完整状态）。

## 三、DCO：每个提交都要签

本项目用 **DCO（Developer Certificate of Origin）**，不要求签 CLA。你在提交时加上 `-s`：

```bash
git commit -s -m "fix(desktop): 修掉滚动时的空白节点"
```

它会给你加一行：

```
Signed-off-by: 你的名字 <you@example.com>
```

这一行就是声明：**你有权按 Apache-2.0 提交这段代码**，并且你保留自己的著作权。
CI（`.github/workflows/dco.yml`）会逐提交校验 `Signed-off-by`，缺了会红。

> 说明一下后果，免得以后有误会：DCO 意味着社区贡献的代码永久受 Apache-2.0 约束，
> 项目方不能把「含社区贡献的部分」整体换成别的协议。这是有意的选择——换来的是贡献门槛最低。

## 四、提交前跑什么

```powershell
npm run build                                  # tsc -b && vite build
npm test                                       # node --test "src/**/*.test.ts"
cd src-tauri; cargo test --lib
cd src-tauri; cargo clippy --all-targets -- -D warnings
```

PR 描述里贴**读数**（通过数、耗时、相关真机测量），不要只写「跑过了」。

## 五、新依赖的规矩

加依赖要在 PR 里说清三件事：**为什么需要**（现有依赖为什么不够）、**体积代价**（gzip 前后）、
**许可证**（是否与 Apache-2.0 兼容）。前端 lockfile 必须用 **Windows 侧 npm** 生成：

> 在 WSL 里 `npm install` 会把 lockfile 的 rolldown 原生绑定写成 Linux 版，
> 之后 `vite build` 报 `Cannot find native binding`。请在 Windows 侧执行。

## 六、不要做的事

- 不要碰 `dangerouslySetInnerHTML`（正文来自 agent，属不可信输入）；
- 不要在组件里直接写 IPC 命令字符串（走 `src/lib/ipc/`）；
- 不要把 `@tanstack/*` 引进组件（只有 `src/lib/virtual/useVirtualList.ts` 能用）；
- 不要为了「让测试变绿」去放宽断言或改等待时间——先查原因，查不出就在 PR 里说明。

## 七、报问题

开 issue 时请带：版本号（设置页或 exe 属性）、复现步骤、期望与实际、日志
（`%APPDATA%\com.sincearc.app\logs\sincearc.log`）。涉及界面问题的，描述「你看到什么」比「应该是 bug」有用得多。
