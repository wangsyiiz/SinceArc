import assert from "node:assert/strict";
import test from "node:test";
import { blockNativeContextMenu } from "./release-ui.ts";

test("contextmenu 被 preventDefault（release 屏蔽右键菜单）", () => {
  const target = new EventTarget();
  blockNativeContextMenu(target);
  const event = new Event("contextmenu", { cancelable: true });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
});

test("只拦 contextmenu，别的事件不受影响", () => {
  const target = new EventTarget();
  blockNativeContextMenu(target);
  const event = new Event("click", { cancelable: true });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});
