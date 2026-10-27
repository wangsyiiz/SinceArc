//! 事件层的唯一订阅点：一条通道，按 profileId 分发。
//!
//! 版本不符、seq 跳号、没有归属，都显式留痕 —— 这三类问题的表现都一样：
//! 「界面少了一条/卡在生成态」，没有日志就只能猜。

import { invokeCmd, isTauri, type CmdError } from "./client";
import type { AcpEvent, WireEvent } from "./types";
import { clog } from "@/lib/log";

const WIRE_VERSION = 1;

const handlers = new Map<string, (e: AcpEvent, topic: string) => void>();
let subscribed: Promise<void> | null = null;
let lastSeq = 0;

/** 订阅（幂等）：整个应用生命周期只建一条 Channel。 */

function ensureSubscribed(): Promise<void> {
  if (subscribed) return subscribed;
  subscribed = (async () => {
    if (!isTauri()) {
      throw { code: 50900, msg: "当前不在 Tauri 运行环境里（浏览器直开无法调用后端）" } as CmdError;
    }
    const { Channel } = await import("@tauri-apps/api/core");
    const channel = new Channel<WireEvent>();
    channel.onmessage = (wire) => {
      if (wire.v !== WIRE_VERSION) {
        clog("WIRE-VERSION", `收到 v${wire.v}，期望 v${WIRE_VERSION}，已忽略`); // i18n-ignore: diagnostic log
        return;
      }
      // seq 跳号意味着丢过事件：显式留痕，让上层决定是否重读库对账
      if (lastSeq > 0 && wire.seq !== lastSeq + 1) {
        clog("EVENT-GAP", `${lastSeq} -> ${wire.seq}（${wire.topic}）`); // i18n-ignore: diagnostic log
      }
      lastSeq = wire.seq;
      // 无归属（例如 conn.ready）不属于任何连接，直接跳过
      if (!wire.profileId) return;
      const fn = handlers.get(wire.profileId);
      if (!fn) {
        clog("DROP-NOPROFILE", `${wire.topic} profile=${wire.profileId}`);
        return;
      }
      fn(wire.payload as AcpEvent, wire.topic);
    };
    await invokeCmd("ipc_subscribe", { channel });
  })();
  return subscribed;
}

/** 登记某个连接的处理器；同一 profile 重复登记会覆盖（重连场景）。 */

export function onAgentEvent(
  profileId: string,
  handler: (e: AcpEvent, topic: string) => void,
): Promise<void> {
  handlers.set(profileId, handler);
  return ensureSubscribed();
}
