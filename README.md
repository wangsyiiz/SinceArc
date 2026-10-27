<p align="center">
  <img src="assets/brand/logo.png" alt="SinceArc" width="112" height="112">
</p>

<h1 align="center">SinceArc</h1>

<p align="center">
  An ACP client for Windows desktop that lifts the agent's thinking and tool calls out of the chat
  and turns them into a swimlane you can look back at.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg">
  <img alt="Version" src="https://img.shields.io/badge/version-0.0.0-orange.svg">
  <a href="https://github.com/wangsyiiz/SinceArc/actions/workflows/release.yml"><img alt="Release build" src="https://github.com/wangsyiiz/SinceArc/actions/workflows/release.yml/badge.svg"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

---

## What this is

SinceArc is a desktop client for agents speaking [ACP (Agent Client Protocol)](https://agentclientprotocol.com).
Built with Tauri 2, React 19, TypeScript and Rust; everything is stored in a local SQLite database and never uploaded.

It does one thing differently: **process is separated from prose.** Replies stay in the chat; thinking and
tool calls go into a trace panel, and the two cross-link by anchor. When something goes wrong you can look back
at *why* the agent did it, instead of scrolling through one endless message stream.

<!-- Screenshots: drop images into assets/screenshots/ and uncomment
<p align="center"><img src="assets/screenshots/main.png" width="720"></p>
-->

## Why

Most existing agent clients fold thinking, tool calls and answers into a single message stream, where process
is drowned by prose. Our four trade-offs:

1. **Process separated from prose** — the chat only says human things; the trace holds what happened;
2. **Local first** — sessions, traces and settings live in `%APPDATA%\com.sincearc.app`; nothing is uploaded;
3. **We never dispose of your data** — irreversible actions (deleting an account or a file) require explicit
   authorization; there is no "helpful" automatic cleanup;
4. **Diagnosable** — every screen's performance is measured over CDP (frame times, virtualized row counts,
   panel open latency), not asserted as "feels fast".

## Capabilities and limits

| What it does | Notes |
| --- | --- |
| Connects to ACP agents | Local processes, or processes inside WSL |
| Streaming replies | Tweened output, seal-first (aligns to full text the moment a turn ends); can be turned off in Settings |
| Markdown | Fenced code, inline code, lists, tables, links — parsed into elements, never injected as HTML |
| Syntax highlighting | Prism, five themes, inline code uses the same theme; SinceArc palette by default |
| Trace panel | Virtualized list, graph swimlanes, auto-degrades above 1500 activities, cross-jump with the chat |
| Multi-agent group chat | `@` a member to run it on its own branch in parallel, merging back to the trunk |
| Approvals | Per-kind permission requests, with "allow same kind for this turn" (in-memory, expires at turn end) |
| External links | Scheme allowlist, validated on both sides of the IPC boundary |
| Storage notice | Counts and warns only; nothing is ever deleted automatically |

**What it does not do** (so you don't find out after installing):

- **Windows x64 only** — no macOS, no Linux, no ARM64, and no unverified artifacts;
- **No code signing** — SmartScreen will warn about an unknown publisher on first run;
- **No auto-update** — upgrades are a manual download;
- **No single-instance mode / `sincearc .` reverse entry**;
- The trace panel loads 50 turns at a time (server cap: 200), so **you cannot page back to older traces yet** —
  pagination is on the roadmap.

## Install

> The first release `v0.0.0` is not tagged yet; the path below describes what it will look like.

1. From [Releases](https://github.com/wangsyiiz/SinceArc/releases) grab `SinceArc-<version>-win-x64.zip` (portable)
   or `SinceArc_<version>_x64-setup.exe` (installer);
2. Portable: extract anywhere (do not double-click inside the zip), then run `SinceArc.exe`;
3. If SmartScreen warns, choose "More info → Run anyway" (unsigned);
4. WebView2 Runtime is required: Windows 11 and recent Windows 10 ship it. If missing, install the
   [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

Data lives in `%APPDATA%\com.sincearc.app` (`sincearc.db` and `logs\`). Deleting the program folder does **not**
delete your data; delete that directory to wipe everything. Full details in
[`docs/distribution.md`](docs/distribution.md) (Chinese).

## Build from source

Requires Windows, Node 20+, Rust stable (`rust-version = 1.77.2` or newer) and WebView2 Runtime.

```powershell
npm ci
npm run tauri -- build --no-bundle     # -> src-tauri/target/release/sincearc.exe
npm run package:win                    # -> artifacts/windows/SinceArc-<version>-win-x64.zip
```

For development:

```powershell
npm run tauri dev    # vite frontend + Rust shell (debug build loads http://localhost:5173)
npm run dev          # frontend only
```

> Run `npm install` / `npm ci` with **Windows Node**. Installing from WSL writes the Linux build of the rolldown
> native binding into the lockfile, and `vite build` then fails with `Cannot find native binding`.

Releases are built in CI: push a `v*` tag or run the `release` workflow manually; the Windows runner produces
both the portable zip and an NSIS installer. (You cannot build the installer locally — on first bundling Tauri
downloads NSIS from GitHub; see [`docs/distribution.md`](docs/distribution.md) §6.)

## Architecture

```
src/                      Frontend: React 19 + TS + Tailwind 4 (Vite; the bundle is embedded into the exe)
  lib/ipc/                Command wrappers (no command strings inside components)
  lib/virtual/            Virtual list (the only place allowed to import @tanstack/react-virtual)
  lib/highlight/          Prism adapter + theme table
  lib/markdown.ts         marked.lexer -> our own block/inline model (never emits HTML strings)
src-tauri/src/
  acp/                    ACP connection, process management (Local / WSL launch), event capture
  db/                     SQLite (atoms as the single authority + turns/sessions; numbered migrations)
  commands.rs             IPC command layer (business logic lives in Rust; the frontend only renders)
docs/                     Specifications (Chinese) — written before the code
```

Rules to know before touching code (details in [`docs/dev-rules.md`](docs/dev-rules.md), [`docs/architecture.md`](docs/architecture.md)):

- ACP types exist only under `src-tauri/src/acp/`; the frontend consumes DTOs;
- Streaming tokens go into zustand, not the React Query cache;
- Message rendering **never touches `dangerouslySetInnerHTML`**; links allow `http` / `https` / `mailto` only;
- The trace captures notification events only (thought / tool_call / mode / usage) — chat text never enters it;
- Long-list row height is content-driven; estimates feed the virtualizer, never a fixed `height`.

## Development and gates

```powershell
npm run build                                      # tsc -b && vite build
npm test                                           # node --test "src/**/*.test.ts"
cd src-tauri; cargo test --lib
cd src-tauri; cargo clippy --all-targets -- -D warnings
```

Current baseline (`0.0.0`): cargo **277** / node **228** / tsc 0 / vite ~3s.

> `kill_tree_reaps_forked_child_on_windows` times out when the machine is busy: check for leftover
> `powershell.exe` (`tasklist /FI "IMAGENAME eq powershell.exe"`) and clear them before re-running. Report both
> the full-suite and the single-test numbers instead of a blanket "all green".

## Documentation

The specs are written in Chinese; each line below links to the file.

| Document | Content |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Layers and data flow |
| [`docs/dev-rules.md`](docs/dev-rules.md) | Development prohibitions and conventions |
| [`docs/design-language.md`](docs/design-language.md) | Design language (surface steps, materials, all state transitions tweened) |
| [`docs/desktop-ux.md`](docs/desktop-ux.md) | Per-case desktop UX rules (tween, markdown, tooltip, highlighting, virtual list) |
| [`docs/message-model.md`](docs/message-model.md) | Atom → block → message → turn |
| [`docs/ipc-contract.md`](docs/ipc-contract.md) | Frontend/backend contract and error codes |
| [`docs/permissions-spec.md`](docs/permissions-spec.md) | Approvals and auto-consent |
| [`docs/distribution.md`](docs/distribution.md) | Packaging and distribution (platform scope, artifacts, signing) |
| [`docs/licensing.md`](docs/licensing.md) | Free vs. subscription boundary, three red lines |

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) (Chinese). The minimum:

1. **Spec first** — change `docs/*.md` before changing behaviour; passages marked as "kept for now" or
   "known gap" are deliberate, don't quietly fix them;
2. **One implementation, one copy** — check nobody is working the same line before you start.

Commits must be signed off (`git commit -s`, DCO); CI verifies `Signed-off-by`. Put measured numbers in the PR
description, not "tested locally".

## Roadmap

| Area | Content |
| --- | --- |
| Distribution | First tag → auto-update (tauri-plugin-updater) → website |
| Features | Projects and locations (repos / worktree isolation, E14); session-open state topology and error matrix (E15) |
| UX | Trace pagination to reach older turns, message row height floor, long-list feel (E18) |

## License

[Apache-2.0](LICENSE). Every client feature is free and open source, permanently, and works without connecting
to our servers. If subscriptions arrive later, they sell **server-side capabilities** (account sync, hosted
agents, team collaboration) — not the unlocking of code that already ships in the client. The boundary and our
self-imposed red lines are written down in [`docs/licensing.md`](docs/licensing.md).

The `SinceArc` name and logo are not licensed with the code; forks must rename and re-brand
(see [`TRADEMARK.md`](TRADEMARK.md)).

## Links

- Repository: <https://github.com/wangsyiiz/SinceArc>
- Issues: <https://github.com/wangsyiiz/SinceArc/issues>
