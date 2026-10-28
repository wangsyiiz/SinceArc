//! 通信层的唯一入口：所有 IPC 都从这里出去，业务代码不认识命令名。
//!
//! 规则（`docs/architecture.md` §6.1、INV-10）：
//! - 全仓只有这个文件和 `events.ts` 允许出现字符串命令名；
//! - 这里不做业务判断，只做「不在 Tauri 环境里」的提前判错与错误归一。

export interface CmdError {
  code: number;
  msg: string;
  key?: string;
  params?: Record<string, string>;
}

/** 后端推来的事件。tag = kind，与 Rust 的 AcpEvent 对齐 */
/**
 * 归属信息：后端按会话记录填好，前端**不许**用「当前打开的会话」去补。
 * 缺失就代表这条事件确实不属于任何界面会话（例如设置页里为成员新建的会话）。
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 调用后端命令。非 Tauri 环境（浏览器直开）给一句能看懂的话，而不是 undefined 报错。 */
export async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw { code: 50900, msg: "当前不在 Tauri 运行环境里（浏览器直开无法调用后端）" } as CmdError; // i18n-ignore: 非 Tauri 技术错误
  }
  const { invoke: raw } = await import("@tauri-apps/api/core");
  return raw<T>(cmd, args);
}

/** 内部 AgentProfile → 后端 DTO（字段名与 serde 的 camelCase 对齐） */

export function asCmdError(e: unknown): CmdError {
  if (e && typeof e === "object" && "code" in e && "msg" in e) return e as CmdError;
  return { code: 50000, msg: e instanceof Error ? e.message : String(e) };
}

/**
 * 发一条命令但不关心结果（日志这类）。
 *
 * 日志失败不该影响业务，所以吞掉 reject —— 但不能用 `.catch(() => {})` 藏住
 * 「命令名写错」这种真 bug：这里只吞网络/环境错误，代码错误仍会在开发期报错。
 */
export function fireAndForget(cmd: string, args?: Record<string, unknown>): void {
  void invokeCmd(cmd, args).catch(() => {});
}
