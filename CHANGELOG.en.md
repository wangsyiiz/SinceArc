# Changelog

User-facing notes for each release. `release.yml` takes the `## v<version>` section of this file
alongside the Chinese one in `CHANGELOG.md` and ships both in the same update payload
(docs/distribution.md §11). Earlier versions were Chinese-only and are not back-translated.

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
