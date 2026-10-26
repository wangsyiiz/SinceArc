import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_THREAD_SETTINGS, type ThreadSettings } from "../types.ts";
import { settingsKey } from "./settings-key.ts";

test("settingsKey 覆盖 ThreadSettings 的每个字段", () => {
  const base = settingsKey(DEFAULT_THREAD_SETTINGS);
  // 换一个和默认值不同的值：每个字段都得让键变，否则那一项改了不会落库
  const variants: Record<keyof ThreadSettings, ThreadSettings[keyof ThreadSettings]> = {
    contextMessages: DEFAULT_THREAD_SETTINGS.contextMessages + 1,
    theme: DEFAULT_THREAD_SETTINGS.theme === "dark" ? "light" : "dark",
    autoApproveDefault: DEFAULT_THREAD_SETTINGS.autoApproveDefault === "off" ? "edits" : "off",
    mcpInheritDefault: !DEFAULT_THREAD_SETTINGS.mcpInheritDefault,
    tweenEnabled: !DEFAULT_THREAD_SETTINGS.tweenEnabled,
  };
  for (const [field, value] of Object.entries(variants)) {
    const next = { ...DEFAULT_THREAD_SETTINGS, [field]: value } as ThreadSettings;
    assert.notEqual(settingsKey(next), base, `改了 ${field} 键却没变：这一项不会落库`);
  }
});
