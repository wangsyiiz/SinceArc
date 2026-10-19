# SinceArc

ACP（Agent Client Protocol）桌面客户端。Tauri 2 + React 19，连接 WSL 或本机的 ACP agent。

## 当前状态

M0：工程骨架 + 前端 UI（未接线）。界面用 mock 数据渲染，后端命令只有 `app_info`。

## 目录

```
src/                 前端（Vite + React 19 + TS + Tailwind 4）
  components/        侧栏、消息、工具调用卡、权限弹窗、输入框
  mock/data.ts       演示数据（接线后删除）
src-tauri/           Rust 壳
  src/acp/launch.rs  两种启动形态：Local / Wsl（wsl.exe 中转）
  src/db/schema.sql  SQLite schema（含 workspace 预留）
```

## 开发

```powershell
npm install
npm run tauri dev      # 需要 Windows 侧 Node + Rust
```

只跑前端：`npm run dev`（http://localhost:5173）。
类型检查与构建：`npm run build`。

## 关键约定

- **协议 v1**，`unstable_protocol_v2` 不启用；所有 ACP 类型只出现在 `src-tauri/src/acp/`。
- **不用** `agent-client-protocol` 的 `process` feature：WSL 场景中间隔着 `wsl.exe`，
  进程要自己起（setsid + 记 pid），否则关窗会留下孤儿 agent。
- **workspace 是 fs 沙箱的根**，不是 UI 分组。`fs/*` 回调必须走单点校验。
- 流式 token 进 zustand，不进 React Query cache；UI 按 30–60 ms 合批。
- 消息两阶段渲染：流式纯文本，回合结束后才解析 markdown。
