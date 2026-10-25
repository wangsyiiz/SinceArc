import type { SettingsReport as SettingsReportDto } from "../types.gen";
import type { AutoApproveLevel } from "@/lib/auto-approve";
import type { ThemeMode, ThreadSettings } from "@/types";
import { invokeCmd } from "../client";

const THEMES: readonly string[] = ["dark", "light", "system"];

/** 后端的 theme 是 `String`（它自己校验过），这里收窄成前端的三值联合，兜底 dark。 */
function asTheme(value: string): ThemeMode {
  return THEMES.includes(value) ? (value as ThemeMode) : "dark";
}

/** 后端存的是字符串（它自己校验过），这里收窄成两值联合，兜底 off —— 拿不准就不替用户答。 */
function asAutoApprove(value: string): AutoApproveLevel {
  return value === "edits" ? "edits" : "off";
}

/**
 * 读设置。返回的不只是设置，还有**读不出来的脏值说明**（后端列出的原文）。
 *
 * 脏值不阻塞启动（老库可能是别的版本写的），但不能静默跳过：
 * 调用方要把 `issues` 推进诊断面板 —— 那是用户唯一能当场看见的地方（日志另有一份）。
 */
export async function settingsLoad(): Promise<{
  settings: ThreadSettings;
  issues: string[];
}> {
  const report = await invokeCmd<SettingsReportDto>("settings_load", {});
  return {
    settings: {
      contextMessages: report.settings.contextMessages,
      theme: asTheme(report.settings.theme),
      autoApproveDefault: asAutoApprove(report.settings.autoApproveDefault),
      mcpInheritDefault: report.settings.mcpInheritDefault,
    },
    issues: report.issues,
  };
}

export function settingsSave(settings: ThreadSettings): Promise<void> {
  return invokeCmd<void>("settings_save", { settings });
}
