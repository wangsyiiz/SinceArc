export type DelegatePhase = "running" | "cancelling" | "cancelled";

/**
 * 引用条末尾的动作文案。
 *
 * `cancelled` 留在内存里是为了回答「我点了停止，到底停没停」—— `session/cancel` 只是送达，
 * 终态才算数。这条只在本次运行内有效；重启后引用条回到「只是发起记录」的样子（结果看轨迹）。
 */
export function delegateActionLabel(phase: string | null | undefined): string | null {
  if (phase === "running") return "停止";
  if (phase === "cancelling") return "正在停止…";
  if (phase === "cancelled") return "已停止";
  return null;
}

/** 取消失败时给人看的原因：让界面能从「正在停止…」退出来。 */
export function delegateCancelFailureMessage(code: number): string {
  switch (code) {
    case 50300:
      return "目标连接已断开，这次派活没有可停的对象";
    case 50704:
      return "这个派活已经结束或不属于当前会话";
    default:
      return `停止失败（${code}）`;
  }
}
