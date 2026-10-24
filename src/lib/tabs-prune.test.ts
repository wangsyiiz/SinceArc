import test from "node:test";
import assert from "node:assert/strict";

import { nextActiveTabId, pruneSessionTabs, sessionIdForActiveTab } from "./tabs-prune.ts";
import type { Tab } from "../types.ts";

const tab = (id: string, sessionId: string): Tab => ({ id, kind: "session", title: id, sessionId });
const settings: Tab = { id: "tab-settings", kind: "settings", title: "设置" };

test("会话从列表消失后，它的标签被剪掉", () => {
  const tabs = [tab("tab-a", "a"), tab("tab-b", "b"), settings];
  const kept = pruneSessionTabs(tabs, new Set(["a"]), new Set(["a", "b"]));
  assert.deepEqual(kept.map((t) => t.id), ["tab-a", "tab-settings"]);
});

test("刚打开、还没回流到列表的标签不剪", () => {
  const tabs = [tab("tab-new", "new")];
  const kept = pruneSessionTabs(tabs, new Set(["a"]), new Set(["a"]));
  assert.deepEqual(kept.map((t) => t.id), ["tab-new"]);
});

test("非会话标签永远不剪", () => {
  const kept = pruneSessionTabs([settings], new Set(), new Set());
  assert.deepEqual(kept.map((t) => t.id), ["tab-settings"]);
});

test("剪掉的正好是当前标签时，落到右边邻居", () => {
  const before = [tab("tab-a", "a"), tab("tab-b", "b"), tab("tab-c", "c")];
  const after = [tab("tab-a", "a"), tab("tab-c", "c")];
  assert.equal(nextActiveTabId(after, "tab-b", before), "tab-c");
});

test("当前标签还在就不动", () => {
  const before = [tab("tab-a", "a"), tab("tab-b", "b")];
  assert.equal(nextActiveTabId(before, "tab-a", before), "tab-a");
});

test("关掉当前会话标签、落到右邻居时，返回邻居的 sessionId", () => {
  const before = [tab("tab-a", "a"), tab("tab-b", "b"), tab("tab-c", "c")];
  const after = [tab("tab-a", "a"), tab("tab-c", "c")];
  const activeId = nextActiveTabId(after, "tab-b", before);
  assert.equal(sessionIdForActiveTab(after, activeId), "c");
});

test("只剩非会话标签时返回 null", () => {
  assert.equal(sessionIdForActiveTab([settings], "tab-settings"), null);
});

test("一个标签都没有时返回空字符串", () => {
  assert.equal(sessionIdForActiveTab([], null), "");
});

test("激活的是设置页时返回 null", () => {
  assert.equal(sessionIdForActiveTab([tab("tab-a", "a"), settings], "tab-settings"), null);
});
