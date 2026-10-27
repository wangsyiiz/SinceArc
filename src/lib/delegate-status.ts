import type { MessageKey } from "@/i18n/zh-CN";

export type DelegatePhase = "running" | "cancelling" | "cancelled";

export type DelegateActionCode = "stop" | "stopping" | "stopped";

/**
 * 引用条末尾的动作文案。
 *
 * `cancelled` 留在内存里是为了回答「我点了停止，到底停没停」—— `session/cancel` 只是送达，
 * 终态才算数。这条只在本次运行内有效；重启后引用条回到「只是发起记录」的样子（结果看轨迹）。
 */
export function delegateActionCode(phase: string | null | undefined): DelegateActionCode | null {
  if (phase === "running") return "stop";
  if (phase === "cancelling") return "stopping";
  if (phase === "cancelled") return "stopped";
  return null;
}

/** 取消失败原因的稳定 key；翻译由调用方完成。 */
export function delegateCancelFailureKey(code: number): MessageKey {
  switch (code) {
    case 50300:
      return "delegate.cancel.noTarget";
    case 50704:
      return "delegate.error.ended";
    default:
      return "delegate.cancel.generic";
  }
}

/**
 * 兼容 App.tsx 的旧调用点：它把返回值直接塞进已翻译的整句里。
 * App.tsx 不在本批次白名单内，暂保留中文；新代码请用 `delegateCancelFailureKey`。
 */
// i18n-ignore: App.tsx 调用点在本批次白名单外，暂时无法改为组件内 t()
export function delegateCancelFailureMessage(code: number): string {
  switch (code) {
    case 50300:
      return "目标连接已断开，这次派活没有可停的对象"; // i18n-ignore
    case 50704:
      return "这个派活已经结束或不属于当前会话"; // i18n-ignore
    default:
      return `停止失败（${code}）`; // i18n-ignore
  }
}
