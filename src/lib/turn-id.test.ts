import assert from "node:assert/strict";
import test from "node:test";

import { replaceTurnId, turnIdForPersist } from "./turn-id.ts";

test("占位 turn id 会被后端返回值替换，且不会带着 turn-live- 落库", () => {
  const placeholder = "turn-live-1760000000000";
  const realId = "turn-1760000000001";
  const turns = [
    { id: placeholder, userText: "这一轮" },
    { id: "turn-old", userText: "旧轮" },
  ];

  const replaced = replaceTurnId(turns, placeholder, realId);
  assert.equal(replaced[0].id, realId);
  assert.equal(replaced[1].id, "turn-old");
  assert.equal(turnIdForPersist(replaced[0].id), realId);
  assert.equal(turnIdForPersist(placeholder), null);
});
