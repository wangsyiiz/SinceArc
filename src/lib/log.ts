import { invoke } from "@tauri-apps/api/core";

/**
 * 客户端日志（追到 <app_data>/sincearc.log）。
 *
 * 用来回答「到底有没有回复、有没有写进库」这类事后问题：
 * 界面状态重启即失，console 在打包版里也看不到。
 * 永不抛异常 —— 日志失败不该影响业务。
 */
export function clog(tag: string, text: string) {
  void invoke("client_log", { tag, text }).catch(() => {});
}
