# Changelog

User-facing notes for each release. `release.yml` takes the `## v<version>` section of this file
alongside the Chinese one in `CHANGELOG.md` and ships both in the same update payload
(docs/distribution.md §11). Earlier versions were Chinese-only and are not back-translated.

## v0.0.14

- **Fixed a hard blocker**: the Microsoft Store build (MSIX) failed on launch with "cannot connect to localhost". The UI assets were not embedded at package time, so it tried to reach the dev server. They are embedded now, and the pipeline fails outright if that step is ever skipped — no more "installs fine, won't start" packages.
- Everything from 0.0.13 is included (store builds open Microsoft Store from the update section, markdown release notes, unread badge position, no self-spawned turn after switching sessions, "thinking" on the first message of a new session).

## v0.0.13

- **In the Microsoft Store build, the "check for updates" button now opens Microsoft Store.** Store builds are updated by the Store; previously they still fetched the update manifest from GitHub and logged an error whenever that failed.
- Store builds no longer show "you're up to date" or download progress: there is no on-demand check, updates are delivered by Microsoft Store in the background (pull them manually from Library → Get updates).
- The installer / portable builds behave exactly as before.
- The test MSIX package now installs without fuss (publisher carries the unsigned-namespace part; install it from an elevated PowerShell).

## v0.0.12

- **The unread count moved to the bottom-right of each session row** (just below the `⋯` menu). It used to sit after the title and squeezed the title once the count grew.
- **While a session is running, the spinner is vertically centred in the row** instead of hanging off the title line.
- **"Thinking" now shows on the first message of a new session.** It was sometimes closed early by a placeholder turn, so the text appeared out of nowhere.
- **Stopping a reply no longer spawns a new question-and-answer turn.** Previously the agent's tail was treated as a fresh turn, so switching back looked like the session had talked to itself.
- **An agent woken up in the background still shows up**, so the fix above does not swallow that case.
- There is now a **Microsoft Store package (MSIX)**; it is an unsigned test build and installing it needs Windows Developer Mode.

## v0.0.11

- **"Thinking" now appears on the very first message of a new session.** Previously the row was missing and the text seemed to come out of nowhere.
- **Replies belong to the question's turn again.** A reply could occasionally be filed as a separate conversation, which broke stop and follow-up; Q and A now stay in one turn.
- **Switching sessions restores your scroll position**, and composer drafts are kept per session instead of leaking into the next one.
- **Tab strip: minimum width and an overflow menu.** When tabs no longer fit, the extras move into a menu on the right instead of being squeezed together, and tabs can be pinned (pinned tabs survive a restart).
- **Session titles come from the agent's summary** instead of a truncated first message, and they persist.
- **Session list rows were reworked**: no cwd line, agent name and icon, a spinner while the session runs, and a red unread badge on the right that clears when you open it — with a button that jumps to the first unread message.
- **Release notes are rendered as markdown** in Settings → Update: bold, lists, inline code and links all format properly instead of showing raw `**`.

## v0.0.10

Chinese only (see `CHANGELOG.md`).
