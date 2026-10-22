import assert from "node:assert/strict";
import test from "node:test";

import { commandsFor } from "./registry.ts";

test("未知 agentName 时按命令行兜底识别", () => {
  const commands = commandsFor(
    "some-unknown-agent",
    "npx -y @agentclientprotocol/codex-acp",
  );
  assert.ok(
    commands.some((command) => command.id === "doctor"),
    `没有按命令行认出 codex：${JSON.stringify(commands)}`,
  );
});
