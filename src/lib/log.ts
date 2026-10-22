import { fireAndForget } from "@/lib/ipc/client";

/**
 * 客户端日志（追到 <app_data>/sincearc.log）。
 *
 * 用来回答「到底有没有回复、有没有写进库」这类事后问题：
 * 界面状态重启即失，console 在打包版里也看不到。
 * 永不抛异常 —— 日志失败不该影响业务。
 *
 * 走 `client.fireAndForget` 而不是直接 invoke：命令名与「非 Tauri 环境」的判断
 * 只允许出现在通信层（INV-10）。
 */
export function clog(tag: string, text: string) {
  fireAndForget("client_log", { tag, text });
}
