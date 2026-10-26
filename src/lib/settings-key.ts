import type { ThreadSettings } from "@/types";

/**
 * 设置落库的去重键。
 *
 * 只靠"值没变就不写"来避免保存回环，所以键必须覆盖**所有**会落库的字段：
 * 漏一个的后果是那个字段改了也不发保存请求，而且只在重开客户端后才露出来
 * （自动同意默认档就这么丢过一次）。新增设置项时这个函数是唯一要改的地方，
 * 单测会盯着 ThreadSettings 的每个字段。
 */
export function settingsKey(settings: ThreadSettings): string {
  return JSON.stringify([
    settings.contextMessages,
    settings.theme,
    settings.autoApproveDefault,
    settings.mcpInheritDefault,
    settings.tweenEnabled,
  ]);
}
