//! 更新渠道（docs/distribution.md §13.4）。
//!
//! 唯一来源是后端：商店包的 exe 用 `--features store` 编出来，`build_channel` 命令如实回报。
//! 前端只做归一化 —— 拿不到/认不出（老版本后端、手抖写错）一律按直装版处理：
//! 直装版的「检查更新」至少能用，商店版的「跳商店」在非商店安装里点不出东西。

export type UpdateChannel = "store" | "direct";

/** 把后端回报的任意值归一成已知渠道。未知值 = 直装版。 */
export function normalizeUpdateChannel(raw: unknown): UpdateChannel {
  return typeof raw === "string" && raw.trim().toLowerCase() === "store" ? "store" : "direct";
}
