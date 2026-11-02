# Changelog

User-facing notes for each release. `release.yml` takes the `## v<version>` section of this file
alongside the Chinese one in `CHANGELOG.md` and ships both in the same update payload
(docs/distribution.md §11). Earlier versions were Chinese-only and are not back-translated.

## v0.0.19

- **A dropped connection no longer duplicates a reply.** When a connection died mid-answer (`agent closed stdout`), the partial reply was saved; after reconnecting, the agent replayed the whole answer and it was saved a second time — the same reply appeared twice, the second copy slightly longer. The stored text is now matched by content: the replayed prefix is dropped and any tail is merged into the existing message. Records already corrupted are collapsed the next time the session is opened.
- **Unread badges now count while the window is in the background.** They only worked when the window was focused, so a turn that finished in the background left no badge.
- **The message column is no longer pinned at 768px.** It widens with the window, up to half the window width (full screen spread the text too far apart to read line by line); below 1536 it stays exactly as before.
- **Wider startup window**: 1180 → 1280.

## v0.0.18

- **Replies are credited to the right agent.** Every session used to label the agent with the *default* connection, so a Codex session showed `hermes · fedora` on its replies. The label now follows the session's own connection, retroactively for existing messages too.

## v0.0.17

- **The session list now shows what is alive**: running sessions no longer carry a small dot — a **wave drifts along the bottom border** of the row, so you can find the busy one at a glance.
- **Unread badges are yellow and vertically centred on the right edge**: red is reserved for actual errors, while unread only means "there is something new". The jump-to-unread bar also gained a ✕ to dismiss it (dismissing does not mark anything read).
- **The ⋯ button on session rows became a context menu**: the icon used to flicker down the whole column as the pointer moved; now the menu only appears on right-click, and deleting a running session stays disabled with the reason shown.
- **"New session" and its dropdown are separate controls** on the same row. The dropdown used to live inside the same shell, so a slightly off click on "New session" landed on it.
- **The small-size icon frames were retuned**: the S inside now sits at 0.72 and the glow is back (it had been dropped for legibility at small sizes).
- **"Add project" in the code view can use the system folder picker** — no more typing paths by hand; picking one adds it to the list directly.

## v0.0.16

- **The "change workspace" popover is fixed.** It had a transparent background (the background class referenced a token that does not exist, so the browser silently dropped it) and the input had no visible border. It now uses the app's frosted surface, and the input has a 1px outline with a deeper background than the panel.
- **Unread counts only accumulate while you are not looking.** They now require either the window being in the background or you being in a different session — messages arriving while you watch a session are no longer counted, so switching away and back no longer shows a red badge.
- **The jump-to-unread bar is no longer full width** — it hugs its text and sits centered, reading as a button instead of a divider.
- **The reply sound no longer fires early.** It used to chime while the agent was still working (synthesized hand-over results, member turns, and agents that report "turn finished" before continuing all triggered it). A turn's end now has to stay quiet for 1.2s before the chime plays.
- **Tab width has three stages**: 200px when there are few tabs, shrinking toward the available width as they multiply, and 120px minimum before the rest move into the overflow menu. It used to be a fixed 120px, so two tabs sat at that width with a large empty gap on the right.
- **The GitHub avatar in the title bar no longer hugs the minimize button** — 16px of padding on both sides, matching the window buttons' own inset.

## v0.0.15

- **Switch the working directory without starting a new session.** The folder at the left of the status bar above the message stream is now clickable: change it any time before your first message. Local connections open the system folder picker; WSL / SSH connections browse the remote filesystem right in the panel (drill into subfolders, go up a level, or type a path with `~`).
- **It locks after the first message** — read-only, path still copyable. By then the agent has already worked in that directory; switching it would swap its memory out from under it.
- Settings → Connections → Working directory uses the same browser, so you no longer have to type the path by hand when setting up a connection.
- **New sessions no longer create an empty session on the agent side the moment you open them.** The session is created when you send the first message, so tabs you open and close — or connections you just peek at — leave no junk behind in the agent's storage.
- One known consequence: because the session only exists after the first message, the mode picker in the status bar appears after that first message too.

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
